// SPDX-License-Identifier: AGPL-3.0-only

package replay

import (
	"bytes"
	"errors"
	"log/slog"
	"math/rand/v2"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

func kinds(t testing.TB) []physics.Prepared {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	ks := make([]physics.Prepared, len(cat.Boats))
	for i := range cat.Boats {
		p := catalog.PhysicsParams(&cat.Boats[i])
		physics.Prepare(&p, &ks[i])
	}
	return ks
}

const testCapacity = 64

// session is a world being recorded.
type session struct {
	w    *sim.World
	log  *Log
	done chan error
	rng  *rand.Rand
	next uint64 // the next account to join, and its connection
}

// account is a test's account n.
func account(n uint64) bus.Account {
	var a bus.Account
	for k := range 8 {
		a[15-k] = byte(n >> (8 * k))
	}
	return a
}

// testGrace is the sessions' grace: short, so boats' graces end in a test.
const testGrace = 120

func newSession(t testing.TB, dir string, run bool) *session {
	t.Helper()
	w, err := sim.New(sim.Config{Capacity: testCapacity, Kinds: kinds(t), Workers: 2, Tick: 1000, Grace: testGrace})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	l := New(Config{
		Frames: w.Bus().Frames,
		Header: Header{Build: "test", Catalog: catalog.Version, Layout: physics.LayoutVersion, Capacity: testCapacity, Epoch: time.Unix(1767225600, 0), Grace: testGrace},
		Dir:    dir,
		Log:    slog.New(slog.DiscardHandler),
		Now:    func() time.Time { return time.Date(2026, 10, 8, 9, 0, 0, 0, time.UTC) },
	})
	w.Record(l)
	s := &session{w: w, log: l, done: make(chan error, 1), rng: rand.New(rand.NewPCG(7, 7)), next: 1}
	if run {
		s.start()
	}
	return s
}

func (s *session) start() { go func() { s.done <- s.log.Run() }() }

// sail runs ticks with sailors joining, leaving, disconnecting (their boats
// leaving when their grace ends, unless they join again), steering and
// trimming, the wind changing and a boat placed now and then.
func (s *session) sail(ticks int) {
	q := s.w.Bus().Commands.Developer()
	for range ticks {
		f := s.w.Latest()
		switch r := s.rng.IntN(100); {
		case r < 4 && len(f.Live) < testCapacity-4:
			q.TrySend(bus.Command{Op: bus.Join, Account: account(s.next), Conn: s.next})
			s.next++
		case r < 5 && len(f.Live) > 0 && s.rng.IntN(2) == 0:
			sl := f.Live[s.rng.IntN(len(f.Live))]
			q.TrySend(bus.Command{Op: bus.Disconnect, Boat: f.Boat[sl], Conn: f.Conn[sl]})
		case r < 5 && len(f.Live) > 0 && s.rng.IntN(2) == 0:
			// A sailor back on a new connection.
			sl := f.Live[s.rng.IntN(len(f.Live))]
			q.TrySend(bus.Command{Op: bus.Join, Account: f.Owner[sl], Conn: s.next})
			s.next++
		case r < 5 && len(f.Live) > 0:
			q.TrySend(bus.Command{Op: bus.Leave, Boat: f.Boat[f.Live[s.rng.IntN(len(f.Live))]]})
		case r < 6:
			q.TrySend(bus.Command{Op: bus.SetWind, Wind: bus.Wind{Speed: 2 + 8*s.rng.Float64(), From: s.rng.Float64()}})
		case r < 7 && len(f.Live) > 0:
			q.TrySend(bus.Command{Op: bus.Place, Boat: f.Boat[f.Live[0]], State: physics.State{X: 3, Heading: 1}})
		}
		for _, sl := range f.Live {
			if s.rng.IntN(20) == 0 {
				s.w.Bus().Controls.Store(sl, bus.Pack(uint32(f.Tick), uint16(s.rng.IntN(1025)), uint16(s.rng.IntN(1025)), f.Gen[sl]))
			}
		}
		s.w.Tick()
	}
}

func (s *session) close(t testing.TB) {
	t.Helper()
	s.log.Close()
	if err := <-s.done; err != nil {
		t.Fatal(err)
	}
}

func replayed(t testing.TB, data []byte, workers int) Result {
	t.Helper()
	f, err := Read(data)
	if err != nil {
		t.Fatal(err)
	}
	res, err := Run(f, Options{Kinds: kinds(t), Workers: workers})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestRoundTrip(t *testing.T) {
	s := newSession(t, "", true)
	s.sail(2000)
	s.close(t)
	data := s.log.Snapshot()
	f, err := Read(data)
	if err != nil {
		t.Fatal(err)
	}
	if f.Header.Build != "test" || f.Header.Catalog != catalog.Version || f.Header.Layout != physics.LayoutVersion ||
		f.Header.Capacity != testCapacity || !f.Header.Epoch.Equal(time.Unix(1767225600, 0)) || f.Header.Grace != testGrace {
		t.Fatalf("header %+v", f.Header)
	}
	if len(f.Segments) != 3 || f.Segments[0].Tick != 1001 || f.Segments[1].Tick != 1800 || f.Segments[2].Tick != 2700 {
		t.Fatalf("%d segments", len(f.Segments))
	}
	var ticks, digests, events int
	results := map[bus.Result]int{}
	for _, seg := range f.Segments {
		for _, r := range seg.Records {
			switch r.Kind {
			case kindTick:
				ticks++
				events += len(r.Events)
				for _, e := range r.Events {
					results[e.Reply.Result]++
					if e.Reply.Tick != r.Tick {
						t.Fatalf("an event of tick %d read as of tick %d", r.Tick, e.Reply.Tick)
					}
				}
			case kindDigest:
				digests++
			}
		}
	}
	if ticks == 0 || digests < 60 || events == 0 {
		t.Fatalf("%d tick records, %d events, %d digests", ticks, events, digests)
	}
	// Graces began, ended, and were cut short by a sailor's return.
	if results[bus.Expired] == 0 || results[bus.Rejoined] == 0 || results[bus.Done] == 0 {
		t.Fatalf("results %v", results)
	}
	res := replayed(t, data, 1)
	if res.Diverged != nil {
		t.Fatal(res.Diverged)
	}
	if res.From != 1001 || res.To != 3000 || res.Digests != digests || res.Snapshots != 2 {
		t.Fatalf("%+v", res)
	}
	if s.log.Bytes() == 0 || s.log.Segments() != 3 || s.log.Dropped() != 0 {
		t.Fatalf("bytes %d, segments %d, dropped %d", s.log.Bytes(), s.log.Segments(), s.log.Dropped())
	}
}

func TestEveryTruncation(t *testing.T) {
	s := newSession(t, "", true)
	s.sail(1000)
	s.close(t)
	data := s.log.Snapshot()
	full, err := Read(data)
	if err != nil {
		t.Fatal(err)
	}
	records := func(f *File) (n int) {
		for _, seg := range f.Segments {
			n += 1 + len(seg.Records)
		}
		return n
	}
	whole := 0
	for n := range len(data) {
		f, err := Read(data[:n])
		if err == nil {
			whole++
		} else if !errors.Is(err, ErrTruncated) {
			t.Fatalf("cut at %d of %d: %v", n, len(data), err)
		}
		if f != nil && records(f) > records(full) {
			t.Fatalf("cut at %d, more records than the whole", n)
		}
	}
	// Each record boundary reads whole: the header's, then each record's.
	if whole != records(full) {
		t.Fatalf("%d prefixes read whole, %d records", whole, records(full))
	}
}

func TestDroppedRecordsBreakTheSegment(t *testing.T) {
	s := newSession(t, "", false)
	// The writer is not running: the backlog fills and records are lost.
	s.sail(800)
	if s.log.Dropped() == 0 {
		t.Fatal("nothing was dropped")
	}
	s.start()
	// Once the writer has caught up, the very next tick starts a segment.
	for len(s.log.items) > 0 {
		runtime.Gosched()
	}
	s.sail(1200)
	s.close(t)
	data := s.log.Snapshot()
	f, err := Read(data)
	if err != nil {
		t.Fatal(err)
	}
	broken := f.Segments[0].BrokenAt
	if broken < 0 {
		t.Fatal("the first segment is not marked broken")
	}
	if f.Segments[1].Tick != 1801 || broken > 1801 {
		t.Fatalf("broken at %d; the next segment starts at %d, not 1801", broken, f.Segments[1].Tick)
	}
	res := replayed(t, data, 2)
	if res.Diverged != nil {
		t.Fatal(res.Diverged)
	}
	if res.To != 3000 {
		t.Fatalf("replayed to %d", res.To)
	}
}

func TestRingKeepsFourSegments(t *testing.T) {
	s := newSession(t, "", true)
	s.sail(6 * SegmentTicks)
	s.close(t)
	f, err := Read(s.log.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Segments) != RingSegments || f.Segments[0].Tick != 3600 {
		t.Fatalf("%d segments, the first at %d", len(f.Segments), f.Segments[0].Tick)
	}
	if res := replayed(t, s.log.Snapshot(), 3); res.Diverged != nil || res.To != 6400 {
		t.Fatalf("%+v", res)
	}
}

func TestFiles(t *testing.T) {
	dir := t.TempDir()
	s := newSession(t, dir, true)
	s.sail((FileSegments + 3) * SegmentTicks)
	s.close(t)
	names, err := filepath.Glob(filepath.Join(dir, "keel-*.log"))
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 || filepath.Base(names[0]) != "keel-20261008T090000Z-tick1001.log" {
		t.Fatalf("files %v", names)
	}
	total := int64(0)
	for _, name := range names {
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		total += int64(len(data))
		if res := replayed(t, data, 4); res.Diverged != nil {
			t.Fatalf("%s: %v", name, res.Diverged)
		}
	}
	if want := int64(s.log.Bytes()) + 2*int64(len(s.log.header)); total != want {
		t.Fatalf("files hold %d bytes, the log %d", total, want)
	}
}

func TestPlantedChangeIsFound(t *testing.T) {
	s := newSession(t, "", true)
	s.sail(1500)
	s.close(t)
	f, err := Read(s.log.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	// Flip one bit of the helm in a control word the log recorded.
	var at int64 = -1
	for i := range f.Segments[0].Records {
		r := &f.Segments[0].Records[i]
		if r.Kind == kindTick && len(r.Changed) > 0 && r.Tick > 1200 {
			r.Changed[0].Word ^= 1 << 22
			at = r.Tick
			break
		}
	}
	if at < 0 {
		t.Fatal("no control word to change")
	}
	res, err := Run(f, Options{Kinds: kinds(t), Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	// Found at the first digest after the change: within a second.
	want := (at + DigestEvery - 1) / DigestEvery * DigestEvery
	if res.Diverged == nil || res.Diverged.Tick != want {
		t.Fatalf("changed at tick %d; the replay reports %v, want tick %d", at, res.Diverged, want)
	}
}

func TestReplayTwiceIsIdentical(t *testing.T) {
	s := newSession(t, "", true)
	s.sail(1000)
	s.close(t)
	var ends [2][]byte
	for i := range ends {
		f, err := Read(s.log.Snapshot())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Run(f, Options{Kinds: kinds(t), Workers: 1 + 4*i, At: func(fr *bus.Frame) {
			ends[i] = sim.AppendSnapshot(ends[i][:0], fr)
		}}); err != nil {
			t.Fatal(err)
		}
	}
	if len(ends[0]) == 0 || !bytes.Equal(ends[0], ends[1]) {
		t.Fatal("two replays ended in different worlds")
	}
	// And the world the live session ended in.
	if live := sim.AppendSnapshot(nil, s.w.Latest()); !bytes.Equal(ends[0], live) {
		t.Fatal("the replay ended in a different world from the live one")
	}
}

func TestNotALog(t *testing.T) {
	for _, data := range [][]byte{[]byte("hello, world"), []byte("KEELLOG\nT\x01x")} {
		if _, err := Read(data); err == nil || errors.Is(err, ErrTruncated) {
			t.Errorf("%q: %v", data, err)
		}
	}
	if _, err := Read([]byte("KEEL")); !errors.Is(err, ErrTruncated) {
		t.Error("a cut magic")
	}
}

func FuzzRead(f *testing.F) {
	s := newSession(f, "", true)
	s.sail(300)
	s.close(f)
	f.Add(s.log.Snapshot())
	f.Add(AppendHeader(nil, Header{Capacity: 1}))
	f.Fuzz(func(t *testing.T, data []byte) {
		lf, err := Read(data)
		if err != nil && lf == nil {
			return
		}
		// Whatever reads must replay without a panic, if it has a segment.
		if lf != nil && len(lf.Segments) > 0 && lf.Header.Capacity <= 4096 && len(data) < 1<<16 {
			lf.Segments = lf.Segments[:1]
			if len(lf.Segments[0].Records) > 50 {
				lf.Segments[0].Records = lf.Segments[0].Records[:50]
			}
			for _, r := range lf.Segments[0].Records {
				if r.Tick-lf.Segments[0].Tick > 1000 || r.Skipped > 1000 {
					return
				}
			}
			_, _ = Run(lf, Options{Kinds: kinds(t), Workers: 1})
		}
	})
}
