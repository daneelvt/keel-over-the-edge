// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// testEdge is the catalog's edge: five seconds' fall, approaches survived
// 20 m back out of the mist band.
var testEdge = Edge{Fall: 150, Clear: 20}

// edgeWorld is a world with an edge, of ghosts or of boats that meet.
func edgeWorld(t testing.TB, meet bool) *World {
	t.Helper()
	cfg := Config{Capacity: 16, Kinds: kinds(t), Workers: 2, Tick: 100, Grace: 5, Edge: &testEdge}
	if meet {
		cfg.Encounters = encounters(t)
	}
	w, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w
}

// placeAtEdge puts boat at (x, y) heading heading at surge m/s, and ticks.
func placeAtEdge(t testing.TB, w *World, boat uint64, x, y, heading, surge float64) {
	t.Helper()
	do(t, w, bus.Command{Op: bus.Place, Boat: boat, State: physics.State{X: x, Y: y, Heading: heading, Surge: surge, SheetLimit: 0.6}})
}

// edges are the events at the edge of the latest frame.
func edges(w *World) []bus.EdgeEvent { return slices.Clone(w.Latest().Edges) }

// overTheLip sails boat in slot s, placed just inside the lip, until it
// goes over, and returns the tick it did.
func overTheLip(t testing.TB, w *World, boat uint64, s int32) int64 {
	t.Helper()
	placeAtEdge(t, w, boat, 8333.5, 0, math.Pi/2, 3)
	for range 60 {
		before := w.Latest().State[s]
		w.Tick()
		f := w.Latest()
		if !f.Voyage[s].Falling() {
			continue
		}
		st := f.State[s]
		if b, a := math.Hypot(before.X, before.Y), math.Hypot(st.X, st.Y); !(b < 8334) || !(a >= 8334) {
			t.Fatalf("went over at tick %d from %.4f m to %.4f m from the centre", f.Tick, b, a)
		}
		if f.Voyage[s].Over != f.Tick {
			t.Fatalf("over at tick %d, the frame says %d", f.Tick, f.Voyage[s].Over)
		}
		return f.Tick
	}
	t.Fatal("the boat never went over")
	return 0
}

// A boat whose centre crosses the lip is over on that tick, and an event
// says where. It falls for 150 ticks without moving; then it lies at the
// start, at rest, the same boat in the same slot, on a new voyage.
func TestOverTheLip(t *testing.T) {
	w := edgeWorld(t, false)
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1})
	s, boat := r.Slot, r.Boat
	over := overTheLip(t, w, boat, s)
	f := w.Latest()
	held := f.State[s]
	ev := edges(w)
	if len(ev) != 1 || ev[0].Kind != bus.EdgeOver || ev[0].Boat != boat || ev[0].Owner != acct(1) || ev[0].X != held.X || ev[0].Y != held.Y || ev[0].Tick != over {
		t.Fatalf("going over: %+v", ev)
	}
	for w.Now() < over+testEdge.Fall-1 {
		w.Tick()
		f := w.Latest()
		if f.State[s] != held || !f.Voyage[s].Falling() || len(f.Edges) != 0 {
			t.Fatalf("tick %d of the fall: %+v, %+v", f.Tick-over, f.State[s], f.Voyage[s])
		}
	}
	// It starts again in the tick's inputs, and that tick's step sails it.
	w.Tick()
	f = w.Latest()
	start := spawnAt(int64(s))
	want := stepped(t, start, f.Control[s], windAt(w, f, start.X, start.Y))
	if f.Tick != over+testEdge.Fall || f.Voyage[s] != (bus.Voyage{}) || f.State[s] != want || f.Boat[s] != boat || !f.Occupied[s] {
		t.Fatalf("at tick %d after going over: boat %d, %+v, %+v; one step from the start is %+v", f.Tick-over, f.Boat[s], f.State[s], f.Voyage[s], want)
	}
}

// Nothing touches a boat that is falling, and it casts no shadow: a boat
// sailing through where it hangs sails as it would alone.
func TestFallingTouchesNothing(t *testing.T) {
	w := edgeWorld(t, true)
	a := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	b := do(t, w, bus.Command{Op: bus.Join, Account: acct(2)})
	overTheLip(t, w, a.Boat, a.Slot)
	hung := w.Latest().State[a.Slot]
	if w.Latest().Wake[a.Slot].Height != 0 {
		t.Fatal("a boat over the lip casts a shadow")
	}
	// Into its stern, inside the lip.
	placeAtEdge(t, w, b.Boat, hung.X-1.5, 0.3, 0, 1)
	for range 60 {
		f := w.Latest()
		before, word := f.State[b.Slot], f.Control[b.Slot]
		e := windAt(w, f, before.X, before.Y)
		w.Tick()
		f = w.Latest()
		if want := stepped(t, before, word, windAt(w, f, before.X, before.Y)); f.State[b.Slot] != want {
			t.Fatalf("tick %d: the boat beside the falling one sails %+v, alone %+v (wind %+v)", f.Tick, f.State[b.Slot], want, e)
		}
		if len(f.Bumps) != 0 || len(f.Pairs) != 0 || f.State[a.Slot] != hung {
			t.Fatalf("tick %d: bumps %v, pairs %v", f.Tick, f.Bumps, f.Pairs)
		}
	}
}

// An approach survived by sailing back out of the mist band is recorded
// once, as the voyage ends, with its least distance and where it was.
func TestApproachSurvived(t *testing.T) {
	w := edgeWorld(t, false)
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	placeAtEdge(t, w, r.Boat, 0, 8234, -math.Pi/2, 0)
	if v := w.Latest().Voyage[r.Slot]; !v.Approaching || math.Abs(v.Least-100) > 0.1 {
		t.Fatalf("100 m inside the lip: %+v", v)
	}
	placeAtEdge(t, w, r.Boat, 0, 8300, -math.Pi/2, 0)
	nearest := w.Latest().State[r.Slot]
	placeAtEdge(t, w, r.Boat, 0, 8240, -math.Pi/2, 0)
	// Still in the band, then out of it, but not yet clear of it.
	placeAtEdge(t, w, r.Boat, 0, 7770, -math.Pi/2, 0)
	if v := w.Latest().Voyage[r.Slot]; !v.Approaching || v.Survived {
		t.Fatalf("just out of the band: %+v", v)
	}
	placeAtEdge(t, w, r.Boat, 0, 7700, -math.Pi/2, 0)
	v := w.Latest().Voyage[r.Slot]
	want := physics.EdgeDistance(w.weather.Prepared, nearest.X, nearest.Y)
	if v.Approaching || !v.Survived || v.Best != want || v.BestX != nearest.X || v.BestY != nearest.Y {
		t.Fatalf("clear of the band: %+v, want the least %v at (%v, %v)", v, want, nearest.X, nearest.Y)
	}
	if len(edges(w)) != 0 {
		t.Fatalf("events before the voyage ends: %+v", edges(w))
	}
	do(t, w, bus.Command{Op: bus.Leave, Boat: r.Boat})
	ev := edges(w)
	if len(ev) != 1 || ev[0].Kind != bus.EdgeApproach || ev[0].Distance != want || ev[0].X != nearest.X || ev[0].Y != nearest.Y || ev[0].Boat != r.Boat {
		t.Fatalf("leaving: %+v", ev)
	}
}

// An approach that ends over the lip is not survived; one before it in
// the same voyage is, and is what the voyage records.
func TestApproachEndingOver(t *testing.T) {
	w := edgeWorld(t, false)
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	placeAtEdge(t, w, r.Boat, 0, 8300, -math.Pi/2, 0)
	first := physics.EdgeDistance(w.weather.Prepared, w.Latest().State[r.Slot].X, w.Latest().State[r.Slot].Y)
	placeAtEdge(t, w, r.Boat, 0, 7700, -math.Pi/2, 0)
	placeAtEdge(t, w, r.Boat, 0, 8325, -math.Pi/2, 0)
	overTheLip(t, w, r.Boat, r.Slot)
	ev := edges(w)
	if len(ev) != 2 || ev[0].Kind != bus.EdgeOver || ev[1].Kind != bus.EdgeApproach || ev[1].Distance != first {
		t.Fatalf("going over after a survived approach: %+v, want the first's %v", ev, first)
	}
	// The voyage that ended over the lip records nothing more when the
	// boat leaves while falling.
	do(t, w, bus.Command{Op: bus.Leave, Boat: r.Boat})
	if ev := edges(w); len(ev) != 0 {
		t.Fatalf("leaving while falling: %+v", ev)
	}
}

// A voyage that ends in the band, leaving or expiring, survives its
// approach.
func TestApproachEndsAfloat(t *testing.T) {
	w := edgeWorld(t, false)
	a := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1})
	b := do(t, w, bus.Command{Op: bus.Join, Account: acct(2), Conn: 2})
	placeAtEdge(t, w, a.Boat, 0, 8300, -math.Pi/2, 0)
	placeAtEdge(t, w, b.Boat, 0, -8200, math.Pi/2, 0)
	do(t, w, bus.Command{Op: bus.Leave, Boat: a.Boat})
	if ev := edges(w); len(ev) != 1 || ev[0].Kind != bus.EdgeApproach || ev[0].Boat != a.Boat || math.Abs(ev[0].Distance-34) > 0.1 {
		t.Fatalf("leaving in the band: %+v", ev)
	}
	do(t, w, bus.Command{Op: bus.Disconnect, Boat: b.Boat, Conn: 2})
	for range 10 {
		w.Tick()
		if ev := edges(w); len(ev) > 0 {
			if len(ev) != 1 || ev[0].Kind != bus.EdgeApproach || ev[0].Boat != b.Boat || math.Abs(ev[0].Distance-134) > 1 {
				t.Fatalf("expiring in the band: %+v", ev)
			}
			return
		}
	}
	t.Fatal("expiring in the band recorded nothing")
}

// A world restored while a boat falls has it start again at the start; one
// restored mid-approach keeps the approach.
func TestRestoreAtTheEdge(t *testing.T) {
	w := edgeWorld(t, false)
	a := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	b := do(t, w, bus.Command{Op: bus.Join, Account: acct(2)})
	placeAtEdge(t, w, b.Boat, 0, 8300, -math.Pi/2, 0)
	overTheLip(t, w, a.Boat, a.Slot)
	snap := AppendSnapshot(nil, w.Latest())
	approach := w.Latest().Voyage[b.Slot]

	w2 := edgeWorld(t, false)
	r, err := w2.Restore(snap, w.Now()+1000)
	if err != nil {
		t.Fatal(err)
	}
	f := w2.Latest()
	if r.Fallen != 1 || f.Voyage[a.Slot] != (bus.Voyage{}) || f.State[a.Slot] != spawnAt(int64(a.Slot)) {
		t.Fatalf("restored mid-fall: %+v, %+v, %+v", r, f.Voyage[a.Slot], f.State[a.Slot])
	}
	if f.Voyage[b.Slot] != approach || !approach.Approaching {
		t.Fatalf("restored mid-approach: %+v, was %+v", f.Voyage[b.Slot], approach)
	}
}

// A voyage at the edge goes through a snapshot whole, and counts in the
// digest; a voyage with nothing in it does not change the digest.
func TestVoyageInTheSnapshot(t *testing.T) {
	w := edgeWorld(t, false)
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	plain := Digest(w.Latest())
	f := w.Latest()
	f.Voyage[r.Slot] = bus.Voyage{}
	if Digest(f) != plain {
		t.Fatal("an empty voyage changes the digest")
	}
	for _, v := range []bus.Voyage{
		{Over: 12345},
		{Approaching: true, Least: 33.25, X: 1, Y: 8300},
		{Survived: true, Best: 0.5, BestX: -3, BestY: 8333},
		{Approaching: true, Least: 200, X: 2, Y: 8134, Survived: true, Best: 12, BestX: 4, BestY: 8322},
	} {
		f.Voyage[r.Slot] = v
		if Digest(f) == plain {
			t.Errorf("%+v: the digest is the empty voyage's", v)
		}
		g := bus.NewFrame(f.Capacity())
		if err := ReadSnapshot(AppendSnapshot(nil, f), g); err != nil {
			t.Fatal(err)
		}
		if g.Voyage[r.Slot] != v {
			t.Errorf("through a snapshot %+v became %+v", v, g.Voyage[r.Slot])
		}
	}
}

// The rules phase allocates nothing, with boats in the band and going
// over.
func TestRulesAllocateNothing(t *testing.T) {
	w := edgeWorld(t, false)
	for i := range 8 {
		r := do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1))})
		placeAtEdge(t, w, r.Boat, float64(i), 8330-float64(40*i), 0, 2)
	}
	w.Tick()
	w.cur, w.next = w.Latest(), w.Latest()
	defer func() { w.cur, w.next = nil, nil }()
	if n := testing.AllocsPerRun(100, w.rules); n != 0 {
		t.Errorf("the rules phase allocates %v times", n)
	}
}

func BenchmarkRules(b *testing.B) {
	w := edgeWorld(b, false)
	for i := range 16 {
		r := do(b, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1))})
		placeAtEdge(b, w, r.Boat, float64(30*i), 7000+float64(80*i), 0, 2)
	}
	w.cur, w.next = w.Latest(), w.Latest()
	for b.Loop() {
		w.rules()
	}
	w.cur, w.next = nil, nil
}
