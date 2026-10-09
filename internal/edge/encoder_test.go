// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"fmt"
	"log/slog"
	"math"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

func TestMailbox(t *testing.T) {
	var m mailbox
	m.init()
	put := func(s string, tick int64) bool {
		b, v := m.fill()
		v.tick, v.valid = tick, true
		return m.post(copy(b[:cap(b)], s))
	}
	if b, _ := m.take(); b != nil {
		t.Fatal("an empty mailbox gave a snapshot")
	}
	if m.base() != nil {
		t.Fatal("a base before any snapshot was taken")
	}
	if put("first", 2) {
		t.Fatal("the first post replaced one")
	}
	if m.base() != nil {
		t.Fatal("a snapshot posted but not taken is a base")
	}
	if !put("second", 4) {
		t.Fatal("a post before the take did not replace the waiting snapshot")
	}
	if b, tick := m.take(); string(b) != "second" || tick != 4 {
		t.Fatalf("took %q of tick %d", b, tick)
	}
	if b, _ := m.take(); b != nil {
		t.Fatal("a snapshot was taken twice")
	}
	if base := m.base(); base == nil || base.tick != 4 {
		t.Fatalf("the base is %+v, not the snapshot taken", base)
	}
	// While one is being sent, two more are filled in turn: the one being
	// sent is never written, and stays the base until another is taken.
	if b, _ := m.take(); b != nil {
		t.Fatal("nothing was waiting")
	}
	put("third", 6)
	sending, _ := m.take()
	put("fourth", 8)
	if string(sending) != "third" || m.base().tick != 6 {
		t.Fatalf("the buffer being sent became %q; the base is of tick %d", sending, m.base().tick)
	}
	put("fifth", 10) // replaces the fourth, never sent
	if m.base().tick != 6 {
		t.Fatal("a snapshot never taken became the base")
	}
	m.restart()
	if m.base() != nil {
		t.Fatal("a base after a restart")
	}
}

// world makes a world of n boats on the start grid, 20 m apart, and an
// edge on it with encoders, and the frame after a tick.
func world(t testing.TB, n, encoders int) (*sim.World, *Edge) {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	p := catalog.PhysicsParams(&cat.Boats[0])
	var kind physics.Prepared
	physics.Prepare(&p, &kind)
	w, err := sim.New(sim.Config{Kinds: []physics.Prepared{kind}, Workers: 4, Tick: 1000})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	e := New(Config{Bus: w.Bus(), Metrics: obs.NewMetrics("test", "test"), Log: slog.New(slog.DiscardHandler), Encoders: encoders})
	for i := range n {
		var a bus.Account
		a[14], a[15] = byte(i>>8), byte(i)
		w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Join, Account: a, Conn: uint64(i + 1)})
	}
	w.Tick()
	if len(w.Latest().Live) != n {
		t.Fatalf("%d boats", len(w.Latest().Live))
	}
	return w, e
}

// sailing hands every boat of w's latest frame a connection, sailing, and
// gives them to the edge's encoders in turn.
func sailing(w *sim.World, e *Edge) []*conn {
	f := w.Latest()
	conns := make([]*conn, len(f.Live))
	for i, s := range f.Live {
		c := &conn{e: e, id: uint64(i + 1), slot: s, gen: f.Gen[s], boat: f.Boat[s]}
		c.margin.init()
		c.box.init()
		conns[i] = c
		enc := e.encs[i%len(e.encs)]
		enc.active = append(enc.active, c)
		enc.load.Add(1)
	}
	return conns
}

// TestEncoderAllocatesNothing: a frame encoded for a thousand connections
// by several encoders, each connection with 64 boats in view and words held
// for their tick, allocates nothing; every frame the encoders acquire they
// release; and every snapshot decodes, against its base, to the view the
// boats' states give.
func TestEncoderAllocatesNothing(t *testing.T) {
	const n = 1000
	w, e := world(t, n, 4)
	conns := sailing(w, e)
	views := make([]client.Views, n)
	tick := func() {
		next := w.Now() + 1
		for i, c := range conns {
			if i%3 == 0 {
				c.wmu.Lock()
				c.held[(c.first+c.nheld)%heldWords] = bus.Pack(uint32(next+2), uint16(i%1024), 512, c.gen)
				c.nheld++
				c.waiting.Store(int32(c.nheld))
				c.wmu.Unlock()
				c.margin.record(int16(i % 7))
			}
		}
		w.Tick()
		e.Record(w.Latest())
		for _, enc := range e.encs {
			enc.frame()
		}
	}
	// The writer's side: each snapshot taken, as if sent, and decoded.
	take := func(check bool) {
		f := w.Latest()
		for i, c := range conns {
			b, _ := c.box.take()
			if b == nil || !check {
				continue
			}
			var sn protocol.Snapshot
			if err := protocol.ReadSnapshot(b, &sn); err != nil {
				t.Fatal(err)
			}
			v, _, err := views[i].Decode(b, &sn)
			if err != nil {
				t.Fatalf("connection %d, tick %d: %v", i, sn.Tick, err)
			}
			if sn.Tick == f.Tick {
				checkView(t, f, c.slot, v, sn.Flags)
			}
		}
	}
	for range 20 {
		tick()
		take(true)
	}
	if got := conns[0].box.views[conns[0].box.sending].view.Len(); got != protocol.ViewSlots {
		t.Fatalf("%d boats in view", got)
	}
	if a := testing.AllocsPerRun(100, func() { tick(); take(false) }); a != 0 {
		t.Fatalf("a frame allocates %v times", a)
	}
	if got := w.Bus().Frames.Allocated(); got != 0 {
		t.Fatalf("%d frames made: one acquired was never released", got)
	}
	// Held words were applied at their tick.
	if l := w.Latest(); l.Control[conns[0].slot].Seq() > uint32(l.Tick) {
		t.Fatal("a word applied before its tick")
	}
}

// checkView checks that v is the view of the boat in slot own of f: boats
// within the area, at most 64 and those the nearest, each quantised from
// its state, unless far and not sampled.
func checkView(t *testing.T, f *bus.Frame, own int32, v *protocol.View, flags uint8) {
	t.Helper()
	x, y := f.State[own].X, f.State[own].Y
	byID := map[[2]int32]int32{} // quantised position to slot
	var within []float64
	for _, s := range f.Live {
		if s == own {
			continue
		}
		d := math.Hypot(f.State[s].X-x, f.State[s].Y-y)
		if d <= ViewKeep {
			within = append(within, d)
		}
		var q protocol.Boat
		protocol.Quantise(&f.State[s], f.Kind[s], f.Sail[s], false, &q)
		byID[[2]int32{q.X, q.Y}] = s
	}
	for slot := range protocol.ViewSlots {
		if !v.Has(slot) {
			continue
		}
		q := v.Boats[slot]
		s, ok := byID[[2]int32{q.X, q.Y}]
		if !ok {
			if q.Far() && flags&protocol.FarSampled == 0 {
				continue // a far boat not sampled: where it was
			}
			t.Fatalf("view slot %d: a boat at %d, %d, where none is", slot, q.X, q.Y)
		}
		d := math.Hypot(f.State[s].X-x, f.State[s].Y-y)
		if s == own || d > ViewKeep {
			t.Fatalf("view slot %d: slot %d, %.0f m off", slot, s, d)
		}
		var want protocol.Boat
		protocol.Quantise(&f.State[s], f.Kind[s], f.Sail[s], q.Far(), &want)
		if q != want {
			t.Fatalf("view slot %d: %+v, the frame's %+v", slot, q, want)
		}
	}
	if len(within) <= protocol.ViewSlots && v.Len() < len(within) {
		// Boats between ViewEnter and ViewKeep that never came in are fine.
		n := 0
		for _, d := range within {
			if d <= ViewEnter {
				n++
			}
		}
		if v.Len() < n {
			t.Fatalf("%d boats in view of %d within %v m", v.Len(), n, ViewEnter)
		}
	}
}

func TestNearestKeepsTheNearest(t *testing.T) {
	for n := range 200 {
		cs := make([]candidate, n)
		for i := range cs {
			cs[i] = candidate{slot: int32(i), d2: float64((i * 7919) % 97)}
		}
		k := min(n, 64)
		nearest(cs, k)
		worst := -1.0
		for _, c := range cs[:k] {
			worst = max(worst, c.d2)
		}
		for _, c := range cs[k:] {
			if c.d2 < worst {
				t.Fatalf("%d candidates: %v left out while %v kept", n, c.d2, worst)
			}
		}
	}
}

// aoiWorld is a world with the player's boat at the centre and one other,
// placed at will, for the area's rules.
type aoiWorld struct {
	w     *sim.World
	e     *Edge
	c     *conn
	other uint64
	views client.Views
	last  *protocol.View
	flags uint8
}

func newAOIWorld(t *testing.T) *aoiWorld {
	w, e := world(t, 2, 1)
	conns := sailing(w, e)
	a := &aoiWorld{w: w, e: e, c: conns[0], other: w.Latest().Boat[1]}
	a.place(0, 0, 0)
	return a
}

// place puts boat 2 at (x, y) from the player's at the centre, ticks, and
// encodes.
func (a *aoiWorld) place(x, y float64, ticks int) {
	q := a.w.Bus().Commands.Developer()
	q.TrySend(bus.Command{Op: bus.Place, Boat: 1, State: physics.State{SailorMode: 0}})
	q.TrySend(bus.Command{Op: bus.Place, Boat: a.other, State: physics.State{X: x, Y: y, Heading: math.Pi}})
	a.step()
	for range ticks {
		a.step()
	}
}

func (a *aoiWorld) step() {
	a.w.Tick()
	a.e.Record(a.w.Latest())
	a.e.encs[0].frame()
	if b, _ := a.c.box.take(); b != nil {
		var sn protocol.Snapshot
		if err := protocol.ReadSnapshot(b, &sn); err != nil {
			panic(err)
		}
		v, _, err := a.views.Decode(b, &sn)
		if err != nil {
			panic(err)
		}
		a.last, a.flags = v, sn.Flags
	}
}

// seen is the other boat's band, if it is in view.
func (a *aoiWorld) seen() string {
	if a.last == nil || a.last.Len() == 0 {
		return "out"
	}
	for slot := range protocol.ViewSlots {
		if a.last.Has(slot) {
			if a.last.Boats[slot].Far() {
				return "far"
			}
			return "near"
		}
	}
	return "out"
}

// TestAreaAndBands: a boat comes into view within 700 m and stays until
// beyond 750 m; is near within 300 m and stays near until beyond 330 m;
// and the player's own boat is never in view.
func TestAreaAndBands(t *testing.T) {
	a := newAOIWorld(t)
	for _, step := range []struct {
		d    float64
		want string
	}{
		{800, "out"}, {720, "out"}, {690, "far"}, {740, "far"}, {705, "far"}, {760, "out"}, {720, "out"},
		{690, "far"}, {310, "far"}, {290, "near"}, {320, "near"}, {329, "near"}, {340, "far"}, {310, "far"},
		{0.5, "near"},
	} {
		// Boats placed still, then a few ticks for a far snapshot.
		a.place(0, step.d, 6)
		if got := a.seen(); got != step.want {
			t.Fatalf("at %.1f m: %s, want %s", step.d, got, step.want)
		}
	}
}

// TestFarBandStaggered: a far boat is sampled by every third snapshot, on
// snapshots that depend on the connection's ID, so that a third of the
// connections sample their far band on each.
func TestFarBandStaggered(t *testing.T) {
	counts := [FarEvery]int{}
	for id := range uint64(300) {
		n := 0
		for tick := int64(1000); tick < 1012; tick += 2 {
			if farSampled(id, tick) {
				n++
				counts[(tick-1000)/2%FarEvery]++
			}
		}
		if n != 2 {
			t.Fatalf("connection %d samples its far band %d times in 6 snapshots", id, n)
		}
	}
	if counts[0] != counts[1] || counts[1] != counts[2] {
		t.Fatalf("far samples by snapshot: %v", counts)
	}
}

// BenchmarkEncode is the encoders' time for a frame of 100, 500 and 1,000
// connections, each with 64 boats in view.
func BenchmarkEncode(b *testing.B) {
	for _, n := range []int{100, 500, 1000} {
		for _, encoders := range []int{1, 8} {
			b.Run(fmt.Sprintf("%d/%d", n, encoders), func(b *testing.B) {
				w, e := world(b, max(n, 200), encoders)
				all := sailing(w, e)
				conns := all[:n]
				for _, enc := range e.encs {
					enc.active = enc.active[:0]
				}
				for i, c := range conns {
					enc := e.encs[i%len(e.encs)]
					enc.active = append(enc.active, c)
				}
				f := w.Latest()
				done := make(chan struct{}, len(e.encs))
				var size int
				b.ReportAllocs()
				for b.Loop() {
					for _, enc := range e.encs {
						go func() {
							for _, c := range enc.active {
								enc.encode(c, f)
							}
							done <- struct{}{}
						}()
					}
					for range e.encs {
						<-done
					}
					for _, c := range conns {
						buf, _ := c.box.take()
						size += len(buf)
					}
				}
				b.ReportMetric(float64(time.Duration(b.Elapsed().Nanoseconds()/int64(b.N)))/float64(n), "ns/conn")
				b.ReportMetric(float64(size)/float64(b.N*n), "bytes/snapshot")
			})
		}
	}
}

// BenchmarkEncodeSteady is the encoders' time for a frame in steady state:
// the boats sail, each snapshot a delta against the one before, which the
// writer took; 100, 500 and 1,000 connections, each with 64 boats in view,
// on one encoder and on eight.
func BenchmarkEncodeSteady(b *testing.B) {
	for _, n := range []int{100, 500, 1000} {
		for _, encoders := range []int{1, 8} {
			b.Run(fmt.Sprintf("%d/%d", n, encoders), func(b *testing.B) {
				w, e := world(b, n, encoders)
				conns := sailing(w, e)
				done := make(chan struct{}, len(e.encs))
				var size, snapshots int
				round := func() {
					for _, enc := range e.encs {
						go func() {
							f := e.cfg.Bus.Frames.Acquire()
							for _, c := range enc.active {
								enc.encode(c, f)
							}
							f.Release()
							done <- struct{}{}
						}()
					}
					for range e.encs {
						<-done
					}
				}
				// The boats sail between rounds, the controls moving.
				step := func() {
					b.StopTimer()
					f := w.Latest()
					for i, s := range f.Live {
						w.Bus().Controls.Store(s, bus.Pack(uint32(f.Tick+1), uint16((i*37+int(f.Tick))%1025), 600, f.Gen[s]))
					}
					w.Tick()
					w.Tick()
					for _, c := range conns {
						buf, _ := c.box.take()
						size += len(buf)
						snapshots++
					}
					b.StartTimer()
				}
				for range 20 {
					step()
					round()
				}
				size, snapshots = 0, 0
				b.ReportAllocs()
				for b.Loop() {
					step()
					round()
				}
				b.ReportMetric(float64(size)/float64(max(snapshots, 1)), "bytes/snapshot")
			})
		}
	}
}
