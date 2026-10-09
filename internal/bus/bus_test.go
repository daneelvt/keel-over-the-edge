// SPDX-License-Identifier: AGPL-3.0-only

package bus

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPackRoundTrips(t *testing.T) {
	for _, seq := range []uint32{0, 1, 1 << 31, math.MaxUint32} {
		for _, helm := range []uint16{0, 1, 511, 512, 513, 1023, 1024} {
			for _, sheet := range []uint16{0, 1, 512, 1023, 1024} {
				for _, gen := range []uint16{0, 1, 512, GenMask} {
					w := Pack(seq, helm, sheet, gen)
					if w.Seq() != seq || w.HelmIndex() != helm || w.SheetIndex() != sheet || w.Gen() != gen {
						t.Fatalf("Pack(%d, %d, %d, %d) reads back as %d, %d, %d, %d",
							seq, helm, sheet, gen, w.Seq(), w.HelmIndex(), w.SheetIndex(), w.Gen())
					}
				}
			}
		}
	}
}

func TestPackClamps(t *testing.T) {
	w := Pack(7, 2000, 1025, GenMask+3)
	if w.HelmIndex() != Steps || w.SheetIndex() != Steps || w.Gen() != 2 || w.Seq() != 7 {
		t.Fatalf("got %d, %d, %d, %d", w.HelmIndex(), w.SheetIndex(), w.Gen(), w.Seq())
	}
	// A word made by hand with an index past Steps still decodes in range.
	raw := Word(indexMask<<(indexBits+genBits) | indexMask<<genBits)
	if raw.Helm() != 1 || raw.Sheet() != 1 {
		t.Fatalf("helm %v, sheet %v", raw.Helm(), raw.Sheet())
	}
}

// The decoded controls are bit for bit the values the client's quantise
// gives on the same steps. testdata/quantise.json is written by Node from
// the client's own code; client/src/input/quantise.test.ts checks it is
// still what that code gives.
func TestDecodeMatchesClient(t *testing.T) {
	var table struct{ Helm, Sheet []string }
	data, err := os.ReadFile("testdata/quantise.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Helm) != Steps+1 || len(table.Sheet) != Steps+1 {
		t.Fatalf("the table has %d and %d values", len(table.Helm), len(table.Sheet))
	}
	for k := range uint16(Steps + 1) {
		w := Pack(0, k, k, 0)
		for _, c := range []struct {
			name string
			got  float64
			want string
		}{{"helm", w.Helm(), table.Helm[k]}, {"sheet", w.Sheet(), table.Sheet[k]}} {
			want, err := strconv.ParseUint(c.want, 0, 64)
			if err != nil {
				t.Fatal(err)
			}
			if math.Float64bits(c.got) != want {
				t.Errorf("%s at step %d: %v (%#016x), the client has %v (%s)", c.name, k, c.got, math.Float64bits(c.got), math.Float64frombits(want), c.want)
			}
		}
	}
}

func TestControls(t *testing.T) {
	c := NewControls(3)
	w := Pack(5, 100, 200, 3)
	c.Store(2, w)
	if c.Load(2) != w || c.Load(0) != 0 || c.Len() != 3 {
		t.Fatal("a slot does not hold its word")
	}
}

func TestTrySendBusy(t *testing.T) {
	q := NewQueue()
	s := q.Players()
	for i := range QueueSize {
		if err := s.TrySend(Command{Op: Join, Conn: uint64(i)}); err != nil {
			t.Fatalf("command %d: %v", i, err)
		}
	}
	done := make(chan error)
	go func() { done <- s.TrySend(Command{Op: Join}) }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrBusy) {
			t.Fatalf("a full queue answered %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("TrySend blocked on a full queue")
	}
	if q.Refused() != 1 {
		t.Fatalf("refused %d", q.Refused())
	}
	if c, ok := q.Receive(); !ok || c.Conn != 0 {
		t.Fatalf("Receive gave %+v, %v", c, ok)
	}
}

func TestDeveloperCommands(t *testing.T) {
	q := NewQueue()
	for _, op := range []Op{SetWind, Place} {
		if err := q.Players().TrySend(Command{Op: op}); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("a player's %s: %v", op, err)
		}
		if err := q.Developer().TrySend(Command{Op: op}); err != nil {
			t.Errorf("a developer's %s: %v", op, err)
		}
	}
	for _, op := range []Op{Join, Leave, Disconnect} {
		if err := q.Players().TrySend(Command{Op: op}); err != nil {
			t.Errorf("a player's %s: %v", op, err)
		}
	}
	if err := q.Developer().TrySend(Command{}); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("a command with no op: %v", err)
	}
	// Hold is the server's own: a developer may send it too, a player never;
	// the server's sender sends nothing else.
	if err := q.Players().TrySend(Command{Op: Hold, Held: true}); !errors.Is(err, ErrNotAllowed) {
		t.Errorf("a player's hold: %v", err)
	}
	for _, s := range []Sender{q.Server(), q.Developer()} {
		if err := s.TrySend(Command{Op: Hold, Held: true}); err != nil {
			t.Errorf("a hold: %v", err)
		}
	}
	for _, op := range []Op{Join, Leave, Disconnect, SetWind, Place} {
		if err := q.Server().TrySend(Command{Op: op}); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("the server's %s: %v", op, err)
		}
	}
	if _, ok := q.Receive(); !ok {
		t.Fatal("nothing queued")
	}
}

// TestDue holds a word for its tick, but not when it is late or too far
// ahead, and across the wrap of the low 32 bits.
func TestDue(t *testing.T) {
	for _, tc := range []struct {
		seq  uint32
		tick int64
		want bool
	}{
		{100, 100, true},             // its tick
		{100, 101, true},             // late
		{100, 99, false},             // a tick ahead
		{100, 100 - MaxAhead, false}, // as far ahead as held
		{100, 99 - MaxAhead, true},   // further: at once
		{0, 1 << 40, true},           // a word of tick 2⁴⁰, its tick
		{5, 1<<32 - 3, false},        // 8 ticks ahead, across the wrap
		{1<<32 - 3, 1<<32 + 5, true}, // 8 ticks late, across the wrap
		{2, 1<<33 + 1, false},        // the high bits are ignored
	} {
		if got := Due(tc.seq, tc.tick); got != tc.want {
			t.Errorf("Due(%d, %d) = %v", tc.seq, tc.tick, got)
		}
	}
}

func TestAccountString(t *testing.T) {
	a := Account{0x01, 0x99, 0xc2, 0xa4, 0x5f, 0x7e, 0x7c, 0x3a, 0x9d, 0x0e, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc}
	if got := a.String(); got != "0199c2a4-5f7e-7c3a-9d0e-123456789abc" {
		t.Fatal(got)
	}
}

func TestNames(t *testing.T) {
	for _, op := range Ops {
		if op.String() == "unknown" {
			t.Errorf("op %d has no name", op)
		}
	}
	for _, r := range Results {
		if r.String() == "unknown" {
			t.Errorf("result %d has no name", r)
		}
	}
	if Op(0).String() != "unknown" || Result(99).String() != "unknown" {
		t.Error("an unknown value has a name")
	}
}

// TestFramesStress publishes frames as fast as possible while readers
// acquire them, check every word of each, and release them. A frame
// rewritten while a reader held it would show words from two ticks.
func TestFramesStress(t *testing.T) {
	const (
		readers  = 8
		capacity = 64
	)
	run := 500 * time.Millisecond
	if testing.Short() {
		run = 100 * time.Millisecond
	}
	fs := NewFrames(capacity)
	var stop atomic.Bool
	var reads, torn atomic.Int64
	var wg sync.WaitGroup
	for range readers {
		wg.Go(func() {
			for !stop.Load() {
				f := fs.Acquire()
				for s := range capacity {
					if f.Boat[s] != uint64(f.Tick) || f.Control[s] != Word(f.Tick) || f.State[s].X != float64(f.Tick) {
						torn.Add(1)
						break
					}
				}
				f.Release()
				reads.Add(1)
			}
		})
	}
	deadline := time.Now().Add(run)
	var published int64
	for tick := int64(1); time.Now().Before(deadline); tick++ {
		f := fs.Next()
		f.Tick = tick
		for s := range capacity {
			f.Boat[s] = uint64(tick)
			f.Control[s] = Word(tick)
			f.State[s].X = float64(tick)
		}
		fs.Publish(f)
		published++
	}
	stop.Store(true)
	wg.Wait()
	if torn.Load() > 0 {
		t.Fatalf("%d torn reads in %d", torn.Load(), reads.Load())
	}
	// Each reader holds at most one frame; with the current frame and the
	// one being written, that is all a pool ever needs.
	if n := fs.Pooled(); n > readers+2 {
		t.Fatalf("the pool grew to %d frames for %d readers", n, readers)
	}
	if uint64(fs.Pooled()-PoolSize) != fs.Allocated() {
		t.Fatalf("pool of %d, %d allocated", fs.Pooled(), fs.Allocated())
	}
	t.Logf("%d frames published, %d reads, pool of %d", published, reads.Load(), fs.Pooled())
}

func TestNextSkipsHeldAndCurrent(t *testing.T) {
	fs := NewFrames(1)
	held := fs.Acquire()
	for range 10 {
		f := fs.Next()
		if f == held || f == fs.Latest() {
			t.Fatal("Next returned a frame in use")
		}
		fs.Publish(f)
	}
	held.Release()
	if fs.Allocated() != 0 {
		t.Fatalf("allocated %d frames with one reader", fs.Allocated())
	}
}
