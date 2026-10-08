// SPDX-License-Identifier: AGPL-3.0-only

package replay

import (
	"bufio"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

const (
	// SegmentTicks is how many ticks a segment covers: 30 s.
	SegmentTicks = 900
	// DigestEvery is how often the log records a digest of the world: 1 s.
	DigestEvery = 30
	// Backlog is how many records may wait for the writer: 10 s of ticks.
	// A tick never waits for the writer; past this, records are lost.
	Backlog = 300
	// RingSegments is how many segments, the one being written included,
	// the log keeps in memory for /debug/replay: the last 1.5 to 2 minutes.
	RingSegments = 4
	// FileSegments is how many segments go in a file before the next.
	FileSegments = 20
)

// Config sets up a log.
type Config struct {
	Frames *bus.Frames // the world's, to hold frames for snapshots and digests
	Header Header
	// Dir, if not "", is where the log is written as well as kept in
	// memory, in files of FileSegments segments.
	Dir string
	Log *slog.Logger
	// Now names files; time.Now if nil.
	Now func() time.Time
}

// Log records a world's ticks. Record is called by the tick and never waits;
// Run, on a goroutine of its own, encodes and stores what Record hands it.
type Log struct {
	cfg    Config
	header []byte

	// The tick's side.
	items        chan item
	free         chan []byte // tick records' buffers, recycled
	segment      int64       // the segment being recorded, by tick ÷ SegmentTicks
	needSnapshot bool
	brokenAt     int64 // first tick whose record was lost since the last snapshot, or −1

	// The writer's side.
	mu   sync.Mutex // guards ring
	ring [][]byte   // segments, oldest first; the last is being written
	file *os.File
	buf  *bufio.Writer
	// fileSegments counts the segments in the current file.
	fileSegments int
	scratch      []byte // records are encoded here, then copied

	bytes, segments, dropped atomic.Uint64
}

type item struct {
	kind     byte
	buf      []byte     // kindTick: the record
	frame    *bus.Frame // kindSnapshot, kindDigest: held, for the writer to release
	brokenAt int64      // kindSnapshot: the previous segment broke at this tick, or −1
}

// tickBuffer is a tick record buffer's starting size: enough for a few
// hundred control words; a buffer that needs more grows once and keeps it.
const tickBuffer = 4 << 10

// New makes a log. Run must be running for it to store anything.
func New(cfg Config) *Log {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	l := &Log{
		cfg:          cfg,
		header:       AppendHeader(nil, cfg.Header),
		items:        make(chan item, Backlog),
		free:         make(chan []byte, Backlog),
		needSnapshot: true,
		brokenAt:     -1,
	}
	for range Backlog {
		l.free <- make([]byte, 0, tickBuffer)
	}
	return l
}

// Record records the tick that made f, which has just been published. It
// never blocks: if the writer is too far behind, the record is lost, the
// segment is marked broken, and a new segment starts as soon as there is
// room.
//
// A tick that starts a segment ends the one before first: a replay coming
// from that segment needs the tick's inputs to reach the new snapshot.
func (l *Log) Record(f *bus.Frame) {
	if !l.needSnapshot {
		l.recordTick(f)
	}
	if seg := floorDiv(f.Tick, SegmentTicks); l.needSnapshot || seg != l.segment {
		fr := l.cfg.Frames.Acquire()
		if !l.send(item{kind: kindSnapshot, frame: fr, brokenAt: l.brokenAt}) {
			fr.Release()
			l.lose(f.Tick)
			return
		}
		l.segment, l.needSnapshot, l.brokenAt = seg, false, -1
	}
}

// recordTick records what the tick applied, if anything, and a digest every
// DigestEvery ticks.
func (l *Log) recordTick(f *bus.Frame) {
	if len(f.Changed) > 0 || len(f.Events) > 0 || f.Skipped > 0 {
		var buf []byte
		select {
		case buf = <-l.free:
		default:
			l.lose(f.Tick)
			return
		}
		buf = appendTick(buf[:0], f)
		if !l.send(item{kind: kindTick, buf: buf}) {
			l.free <- buf
			l.lose(f.Tick)
			return
		}
	}
	if f.Tick%DigestEvery == 0 {
		fr := l.cfg.Frames.Acquire()
		if !l.send(item{kind: kindDigest, frame: fr}) {
			fr.Release()
			l.lose(f.Tick)
		}
	}
}

func (l *Log) send(it item) bool {
	select {
	case l.items <- it:
		return true
	default:
		return false
	}
}

func (l *Log) lose(tick int64) {
	l.dropped.Add(1)
	if l.brokenAt < 0 {
		l.brokenAt = tick
	}
	l.needSnapshot = true
}

// Close records a last digest of the latest frame, so the log ends with the
// state the world ended in, and tells Run to finish. The world must have
// stopped ticking.
func (l *Log) Close() {
	if !l.needSnapshot {
		fr := l.cfg.Frames.Acquire()
		l.items <- item{kind: kindDigest, frame: fr}
	}
	close(l.items)
}

// Run stores what Record hands it until Close, then flushes and closes the
// file. It does not recover from panics: a bug here should stop the server.
func (l *Log) Run() error {
	var err error
	for it := range l.items {
		if e := l.store(it); e != nil && err == nil {
			err = e
			l.cfg.Log.Error("input log: could not write the file; keeping the log in memory only", "err", e)
			l.closeFile()
			l.cfg.Dir = ""
		}
	}
	if e := l.closeFile(); e != nil && err == nil {
		err = e
	}
	return err
}

func (l *Log) store(it item) error {
	var rec []byte
	switch it.kind {
	case kindSnapshot:
		if it.brokenAt >= 0 {
			if err := l.append(appendBroken(l.scratch[:0], it.brokenAt)); err != nil {
				return err
			}
		}
		rec = appendSnapshot(l.scratch[:0], it.frame)
		tick := it.frame.Tick
		it.frame.Release()
		l.segments.Add(1)
		if err := l.startSegment(tick); err != nil {
			return err
		}
	case kindTick:
		defer func() { l.free <- it.buf }()
		return l.append(it.buf)
	case kindDigest:
		rec = appendDigest(l.scratch[:0], it.frame.Tick, sim.Digest(it.frame))
		it.frame.Release()
	}
	l.scratch = rec
	return l.append(rec)
}

// startSegment starts a segment in the ring and, every FileSegments, a file.
func (l *Log) startSegment(tick int64) error {
	l.mu.Lock()
	var seg []byte
	if len(l.ring) == RingSegments {
		seg = l.ring[0][:0]
		l.ring = append(l.ring[:0], l.ring[1:]...)
	}
	l.ring = append(l.ring, seg)
	l.mu.Unlock()

	if l.cfg.Dir == "" {
		return nil
	}
	if l.file != nil && l.fileSegments < FileSegments {
		l.fileSegments++
		return l.buf.Flush()
	}
	if err := l.closeFile(); err != nil {
		return err
	}
	if err := os.MkdirAll(l.cfg.Dir, 0o755); err != nil {
		return err
	}
	name := filepath.Join(l.cfg.Dir, fmt.Sprintf("keel-%s-tick%d.log", l.cfg.Now().UTC().Format("20060102T150405Z"), tick))
	f, err := os.Create(name)
	if err != nil {
		return err
	}
	l.file, l.buf, l.fileSegments = f, bufio.NewWriterSize(f, 64<<10), 1
	_, err = l.buf.Write(l.header)
	return err
}

// append adds a record to the segment being written, and to the file.
func (l *Log) append(rec []byte) error {
	l.mu.Lock()
	if n := len(l.ring); n > 0 {
		l.ring[n-1] = append(l.ring[n-1], rec...)
	}
	l.mu.Unlock()
	l.bytes.Add(uint64(len(rec)))
	if l.buf == nil {
		return nil
	}
	_, err := l.buf.Write(rec)
	return err
}

func (l *Log) closeFile() error {
	if l.file == nil {
		return nil
	}
	err := l.buf.Flush()
	if cerr := l.file.Close(); err == nil {
		err = cerr
	}
	l.file, l.buf = nil, nil
	return err
}

// Snapshot returns the segments in memory as a log: the last 1.5 to 2
// minutes.
func (l *Log) Snapshot() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := len(l.header)
	for _, seg := range l.ring {
		n += len(seg)
	}
	out := make([]byte, 0, n)
	out = append(out, l.header...)
	for _, seg := range l.ring {
		out = append(out, seg...)
	}
	return out
}

// ServeHTTP downloads the segments in memory as a log, for keel replay.
func (l *Log) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	data := l.Snapshot()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="keel-%s.log"`, l.cfg.Now().UTC().Format("20060102T150405Z")))
	_, _ = w.Write(data)
}

// Bytes counts the bytes recorded.
func (l *Log) Bytes() uint64 { return l.bytes.Load() }

// Segments counts the segments started.
func (l *Log) Segments() uint64 { return l.segments.Load() }

// Dropped counts the records lost because the writer was behind.
func (l *Log) Dropped() uint64 { return l.dropped.Load() }

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b < 0 {
		q--
	}
	return q
}
