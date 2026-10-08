// SPDX-License-Identifier: AGPL-3.0-only

// Package replay records what the simulation applied, tick by tick, and
// replays it. With a deterministic simulation the inputs alone reproduce a
// run, so the input log holds only what is not deterministic: which control
// words and commands each tick applied, which depends on when they arrived.
//
// A log is a header and segments. Each segment opens with a snapshot of the
// whole world, so a replay can start at any segment; then come the ticks at
// which anything was applied, and every second a digest of the world, so a
// replay that goes wrong says where, to within a second. (Factorio checks
// its replays and multiplayer games the same way, with a checksum of the
// game's state.)
package replay

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// The format:
//
//	magic                   "KEELLOG\n"
//	header                  a record of kind 'H'
//	records                 one after another
//
// A record is its kind in one byte, the length of its payload as a uvarint,
// and the payload. Integers in payloads are varints (encoding/binary),
// floats and control words their little-endian bits:
//
//	H header    format version, build, catalog, physics layout, capacity,
//	            epoch (Unix seconds, nanoseconds); strings as a uvarint length and bytes
//	S snapshot  tick, then sim's snapshot of the world after it: a segment starts
//	T tick      tick, ticks skipped before it, the control words applied
//	            (count, then slot and word for each), the commands applied in order with
//	            their results (count, then each: op, its fields, result, slot, boat, generation)
//	D digest    tick, sim.Digest of the world after it, 8 bytes
//	X broken    the first tick whose records were lost: the segment holds
//	            nothing reliable from that tick on
const (
	magic         = "KEELLOG\n"
	formatVersion = 1

	kindHeader   = 'H'
	kindSnapshot = 'S'
	kindTick     = 'T'
	kindDigest   = 'D'
	kindBroken   = 'X'
)

// Header says what made a log. A log replays faithfully only under the same
// build, catalog and physics layout.
type Header struct {
	Build    string
	Catalog  string
	Layout   uint32
	Capacity int
	Epoch    time.Time
}

// AppendHeader appends the magic and the header record to dst.
func AppendHeader(dst []byte, h Header) []byte {
	var p []byte
	p = binary.AppendUvarint(p, formatVersion)
	p = appendString(p, h.Build)
	p = appendString(p, h.Catalog)
	p = binary.AppendUvarint(p, uint64(h.Layout))
	p = binary.AppendUvarint(p, uint64(h.Capacity))
	p = binary.AppendVarint(p, h.Epoch.Unix())
	p = binary.AppendUvarint(p, uint64(h.Epoch.Nanosecond()))
	dst = append(dst, magic...)
	return appendRecord(dst, kindHeader, p)
}

func appendString(dst []byte, s string) []byte {
	dst = binary.AppendUvarint(dst, uint64(len(s)))
	return append(dst, s...)
}

func appendRecord(dst []byte, kind byte, payload []byte) []byte {
	dst = append(dst, kind)
	dst = binary.AppendUvarint(dst, uint64(len(payload)))
	return append(dst, payload...)
}

// beginRecord starts a record whose payload is appended after it; endRecord
// then fills in the length. The length is written in the most bytes a
// uvarint of a payload's length can take, so the payload need not move.
const lenBytes = 5 // up to 4 GB

func beginRecord(dst []byte, kind byte) ([]byte, int) {
	dst = append(dst, kind)
	at := len(dst)
	return append(dst, make([]byte, lenBytes)...), at
}

func endRecord(dst []byte, at int) []byte {
	n := uint64(len(dst) - at - lenBytes)
	// A padded uvarint: every byte but the last has its continuation bit.
	for i := range lenBytes - 1 {
		dst[at+i] = byte(n) | 0x80
		n >>= 7
	}
	dst[at+lenBytes-1] = byte(n)
	return dst
}

// appendTick appends f's tick record: what the tick that made f applied.
func appendTick(dst []byte, f *bus.Frame) []byte {
	dst, at := beginRecord(dst, kindTick)
	dst = binary.AppendVarint(dst, f.Tick)
	dst = binary.AppendUvarint(dst, uint64(f.Skipped))
	dst = binary.AppendUvarint(dst, uint64(len(f.Changed)))
	for _, sw := range f.Changed {
		dst = binary.AppendUvarint(dst, uint64(sw.Slot))
		dst = binary.LittleEndian.AppendUint64(dst, uint64(sw.Word))
	}
	dst = binary.AppendUvarint(dst, uint64(len(f.Events)))
	for i := range f.Events {
		dst = appendEvent(dst, &f.Events[i])
	}
	return endRecord(dst, at)
}

func appendEvent(dst []byte, e *bus.Event) []byte {
	dst = append(dst, byte(e.Op))
	switch e.Op {
	case bus.Join:
		dst = binary.AppendUvarint(dst, e.Account)
	case bus.Leave:
		dst = binary.AppendUvarint(dst, e.Boat)
	case bus.SetWind:
		dst = appendF64(dst, e.Wind.Speed)
		dst = appendF64(dst, e.Wind.From)
	case bus.Place:
		dst = binary.AppendUvarint(dst, e.Boat)
		for _, v := range sim.StateFields(&e.State) {
			dst = appendF64(dst, *v)
		}
	}
	dst = append(dst, byte(e.Reply.Result))
	dst = binary.AppendVarint(dst, int64(e.Reply.Slot))
	dst = binary.AppendUvarint(dst, e.Reply.Boat)
	return binary.AppendUvarint(dst, uint64(e.Reply.Gen))
}

func appendF64(dst []byte, v float64) []byte {
	return binary.LittleEndian.AppendUint64(dst, math.Float64bits(v))
}

// appendSnapshot appends a snapshot record of f, starting a segment.
func appendSnapshot(dst []byte, f *bus.Frame) []byte {
	dst, at := beginRecord(dst, kindSnapshot)
	dst = binary.AppendVarint(dst, f.Tick)
	dst = sim.AppendSnapshot(dst, f)
	return endRecord(dst, at)
}

func appendDigest(dst []byte, tick int64, digest uint64) []byte {
	dst, at := beginRecord(dst, kindDigest)
	dst = binary.AppendVarint(dst, tick)
	dst = binary.LittleEndian.AppendUint64(dst, digest)
	return endRecord(dst, at)
}

func appendBroken(dst []byte, tick int64) []byte {
	dst, at := beginRecord(dst, kindBroken)
	dst = binary.AppendVarint(dst, tick)
	return endRecord(dst, at)
}

// A Record is one tick's inputs, or a digest.
type Record struct {
	Kind    byte  // kindTick or kindDigest
	Tick    int64 // the tick
	Skipped int64
	Changed []bus.SlotWord
	Events  []bus.Event
	Digest  uint64
}

// A Segment is a snapshot and what followed it.
type Segment struct {
	Tick     int64  // the snapshot's tick
	Snapshot []byte // sim's snapshot
	Records  []Record
	// BrokenAt is the first tick whose records were lost, or −1: nothing in
	// the segment from that tick on can be trusted.
	BrokenAt int64
}

// File is a log read.
type File struct {
	Header   Header
	Segments []Segment
}

// ErrTruncated means the log ends partway through a record. Everything
// before that record has been read.
var ErrTruncated = errors.New("replay: the log ends partway through a record")

// Read reads a log. A log cut short, as one being written or a download
// cut off, is read as far as it is whole, and the error is ErrTruncated.
// Any other error means it is not a log, or is damaged.
func Read(data []byte) (*File, error) {
	if len(data) < len(magic) {
		return nil, ErrTruncated
	}
	if string(data[:len(magic)]) != magic {
		return nil, errors.New("replay: not an input log")
	}
	data = data[len(magic):]
	f := &File{}
	first := true
	for len(data) > 0 {
		kind := data[0]
		n, k := binary.Uvarint(data[1:])
		switch {
		case k < 0:
			return f, errors.New("replay: a record's length is out of range")
		case k == 0 || n > uint64(len(data)-1-k):
			return f, ErrTruncated
		}
		end := 1 + k + int(n)
		p := &payload{b: data[1+k : end]}
		data = data[end:]
		if first != (kind == kindHeader) {
			return f, errors.New("replay: the header is not the first record")
		}
		first = false
		if err := f.add(kind, p); err != nil {
			return f, err
		}
	}
	if first {
		return f, ErrTruncated
	}
	return f, nil
}

func (f *File) add(kind byte, p *payload) error {
	var seg *Segment
	if n := len(f.Segments); n > 0 {
		seg = &f.Segments[n-1]
	}
	switch kind {
	case kindHeader:
		if v := p.uvarint(); p.err == nil && v != formatVersion {
			return fmt.Errorf("replay: format version %d, not %d", v, formatVersion)
		}
		f.Header.Build = p.string()
		f.Header.Catalog = p.string()
		f.Header.Layout = uint32(p.uvarint())
		f.Header.Capacity = int(p.count(1 << 31))
		sec := p.varint()
		nsec := p.uvarint()
		if p.err == nil && nsec >= 1e9 {
			p.err = errors.New("nanoseconds out of range")
		}
		f.Header.Epoch = time.Unix(sec, int64(nsec)).UTC()
		if p.err == nil && f.Header.Capacity < 1 {
			p.err = errors.New("no capacity")
		}
	case kindSnapshot:
		tick := p.varint()
		f.Segments = append(f.Segments, Segment{Tick: tick, Snapshot: p.rest(), BrokenAt: -1})
	case kindTick:
		if seg == nil {
			return errors.New("replay: a tick before the first snapshot")
		}
		r := Record{Kind: kindTick, Tick: p.varint(), Skipped: int64(p.count(math.MaxInt64))}
		// Counts are bounded by the bytes left, so a damaged count cannot
		// make the reader allocate more than the log could hold.
		r.Changed = make([]bus.SlotWord, p.count(min(uint64(f.Header.Capacity), uint64(len(p.b)/9))))
		for i := range r.Changed {
			r.Changed[i] = bus.SlotWord{Slot: int32(p.count(uint64(f.Header.Capacity) - 1)), Word: bus.Word(p.u64())}
		}
		r.Events = make([]bus.Event, p.count(uint64(len(p.b)/6)))
		for i := range r.Events {
			p.event(&r.Events[i])
		}
		seg.Records = append(seg.Records, r)
	case kindDigest:
		if seg == nil {
			return errors.New("replay: a digest before the first snapshot")
		}
		seg.Records = append(seg.Records, Record{Kind: kindDigest, Tick: p.varint(), Digest: p.u64()})
	case kindBroken:
		if seg == nil {
			return errors.New("replay: a break before the first snapshot")
		}
		seg.BrokenAt = p.varint()
	default:
		// A kind from a later format: skip it.
		return nil
	}
	if p.err == nil && len(p.b) > 0 {
		p.err = errors.New("data after the record's end")
	}
	if p.err != nil {
		return fmt.Errorf("replay: a record of kind %q: %w", kind, p.err)
	}
	return nil
}

// payload reads a record's payload, keeping the first error.
type payload struct {
	b   []byte
	err error
}

var errShort = io.ErrUnexpectedEOF

func (p *payload) uvarint() uint64 {
	if p.err != nil {
		return 0
	}
	v, n := binary.Uvarint(p.b)
	if n <= 0 {
		p.err = errShort
		return 0
	}
	p.b = p.b[n:]
	return v
}

func (p *payload) varint() int64 {
	if p.err != nil {
		return 0
	}
	v, n := binary.Varint(p.b)
	if n <= 0 {
		p.err = errShort
		return 0
	}
	p.b = p.b[n:]
	return v
}

func (p *payload) u64() uint64 {
	if p.err != nil {
		return 0
	}
	if len(p.b) < 8 {
		p.err = errShort
		return 0
	}
	v := binary.LittleEndian.Uint64(p.b)
	p.b = p.b[8:]
	return v
}

func (p *payload) byte() byte {
	if p.err != nil {
		return 0
	}
	if len(p.b) < 1 {
		p.err = errShort
		return 0
	}
	v := p.b[0]
	p.b = p.b[1:]
	return v
}

func (p *payload) f64() float64 { return math.Float64frombits(p.u64()) }

// count reads a number of at most limit.
func (p *payload) count(limit uint64) uint64 {
	n := p.uvarint()
	if p.err == nil && n > limit {
		p.err = fmt.Errorf("%d is out of range", n)
	}
	if p.err != nil {
		return 0
	}
	return n
}

func (p *payload) string() string {
	n := p.uvarint()
	if p.err == nil && n > uint64(len(p.b)) {
		p.err = errShort
	}
	if p.err != nil {
		return ""
	}
	s := string(p.b[:n])
	p.b = p.b[n:]
	return s
}

func (p *payload) rest() []byte {
	b := p.b
	p.b = nil
	return b
}

func (p *payload) event(e *bus.Event) {
	e.Op = bus.Op(p.byte())
	switch e.Op {
	case bus.Join:
		e.Account = p.uvarint()
	case bus.Leave:
		e.Boat = p.uvarint()
	case bus.SetWind:
		e.Wind = bus.Wind{Speed: p.f64(), From: p.f64()}
	case bus.Place:
		e.Boat = p.uvarint()
		for _, v := range sim.StateFields(&e.State) {
			*v = p.f64()
		}
	default:
		if p.err == nil {
			p.err = fmt.Errorf("unknown command %d", e.Op)
		}
		return
	}
	e.Reply.Result = bus.Result(p.byte())
	slot := p.varint()
	if p.err == nil && (slot < -1 || slot > math.MaxInt32) {
		p.err = fmt.Errorf("slot %d", slot)
	}
	e.Reply.Slot = int32(slot)
	e.Reply.Boat = p.uvarint()
	e.Reply.Gen = uint16(p.count(bus.GenMask))
}

// Commands are the commands of a tick record's events, to apply again.
func (r *Record) Commands() []bus.Command {
	cs := make([]bus.Command, len(r.Events))
	for i := range r.Events {
		cs[i] = r.Events[i].Command
	}
	return cs
}
