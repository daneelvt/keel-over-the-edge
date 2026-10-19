// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
)

// testReefs is a sight table of reefs awash, seen within 150 m, at the
// points given, over open sea; the last is charted with the first.
func testReefs(points ...[2]float64) *sight.Table {
	in := &sight.Input{
		Ground: &physics.Ground{Prepared: new(physics.GroundPrepared)}, Eyes: []float64{2},
		Dome: 2500, Rays: 48, Grid: 500, Threshold: 2e-7,
		Visibility: physics.Visibility{Band: 7778, Lip: 8334, Clear: 8334, Range: 300},
	}
	for i, p := range points {
		in.Subjects = append(in.Subjects, sight.Subject{Kind: sight.Place, Number: int32(i), Island: -1, X: p[0], Y: p[1], Seen: sight.Awash, Reach: 150})
	}
	in.Subjects = append(in.Subjects, sight.Subject{Kind: sight.Feature, Number: 0, Island: 0, Seen: sight.Hidden})
	return sight.Build(in)
}

// chartWorld is a world whose lookouts look every every ticks for the
// reefs at points.
func chartWorld(t testing.TB, every int64, edge bool, points ...[2]float64) *World {
	t.Helper()
	cfg := Config{Capacity: 64, Kinds: kinds(t), Workers: 2, Tick: 100, Grace: 5,
		Sight: &Sight{Table: testReefs(points...), Every: every, Lookouts: []float64{2}}}
	if edge {
		cfg.Edge = &testEdge
	}
	w, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w
}

// charted are the latest frame's chartings.
func charted(w *World) []bus.Charted { return slices.Clone(w.Latest().Charted) }

// still puts boat at rest at (x, y), heading north, and ticks.
func still(t testing.TB, w *World, boat uint64, x, y float64) {
	t.Helper()
	do(t, w, bus.Command{Op: bus.Place, Boat: boat, State: physics.State{X: x, Y: y}})
}

// TestNearerCredited: of two boats that sight a reef in one tick, the nearer
// charts it; of two as near, the one of the lower number; and what is
// charted with it is charted with it, from the same boat.
func TestNearerCredited(t *testing.T) {
	w := chartWorld(t, 1, false, [2]float64{0, 3000}, [2]float64{0, -3000})
	a := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	b := do(t, w, bus.Command{Op: bus.Join, Account: acct(2)})
	still(t, w, a.Boat, 0, 2000)
	still(t, w, b.Boat, 0, -2000)
	if got := charted(w); len(got) != 0 {
		t.Fatalf("charted from afar: %+v", got)
	}
	send(t, w, bus.Command{Op: bus.Place, Boat: a.Boat, State: physics.State{X: 0, Y: 3100}})
	send(t, w, bus.Command{Op: bus.Place, Boat: b.Boat, State: physics.State{X: 0, Y: 3050}})
	w.Tick()
	got := charted(w)
	if len(got) != 2 || got[0].Subject != 0 || got[0].Boat != b.Boat || got[0].With != -1 ||
		got[1].Subject != 2 || got[1].With != 0 || got[1].Boat != b.Boat {
		t.Fatalf("charted %+v; want the reef by boat %d, and the feature with it", got, b.Boat)
	}
	// As near, the lower number: a.
	send(t, w, bus.Command{Op: bus.Place, Boat: a.Boat, State: physics.State{X: 100, Y: -3000}})
	send(t, w, bus.Command{Op: bus.Place, Boat: b.Boat, State: physics.State{X: -100, Y: -3000}})
	w.Tick()
	if got := charted(w); len(got) != 1 || got[0].Subject != 1 || got[0].Boat != a.Boat {
		t.Fatalf("charted %+v; want the second reef by boat %d", got, a.Boat)
	}
	// Each once.
	for range 30 {
		w.Tick()
		if got := charted(w); len(got) != 0 {
			t.Fatalf("charted again: %+v", got)
		}
	}
	if !w.IsCharted(0) || !w.IsCharted(1) || !w.IsCharted(2) {
		t.Error("not marked charted")
	}
}

// TestLookoutsTakeTurns: each boat looks once in Every ticks, in turn by its
// number, so a boat at a reef charts it within Every ticks.
func TestLookoutsTakeTurns(t *testing.T) {
	w := chartWorld(t, 15, false, [2]float64{500, 500})
	a := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	still(t, w, a.Boat, 500, 400)
	for i := range 16 {
		if got := charted(w); len(got) > 0 {
			if (int64(a.Boat)+got[0].Tick)%15 != 0 {
				t.Fatalf("looked at tick %d", got[0].Tick)
			}
			return
		}
		if i < 15 {
			w.Tick()
		}
	}
	t.Fatal("not charted within 15 ticks")
}

// TestNoChartingPlaced: a boat placed by the owner's tools, one staying
// while its owner's free camera roams, and one falling over the lip chart
// nothing.
func TestNoChartingPlaced(t *testing.T) {
	w := chartWorld(t, 1, true, [2]float64{1000, 0}, [2]float64{-1000, 0}, [2]float64{8300, 0})
	a := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	b := do(t, w, bus.Command{Op: bus.Join, Account: acct(2)})
	c := do(t, w, bus.Command{Op: bus.Join, Account: acct(3)})
	still(t, w, a.Boat, 0, 2000)
	still(t, w, b.Boat, 0, -2000)
	owned(t, w, bus.Command{Op: bus.Teleport, Boat: a.Boat, State: physics.State{X: 1000, Y: 50}})
	owned(t, w, bus.Command{Op: bus.Stay, Boat: b.Boat, On: true})
	still(t, w, b.Boat, -1000, 50)
	overTheLip(t, w, c.Boat, c.Slot)
	for range 30 {
		w.Tick()
		for _, ch := range charted(w) {
			t.Errorf("charted %+v", ch)
		}
	}
}

// TestChartingReplays: two worlds given the same boats and the same
// controls chart the same subjects at the same ticks, by the same boats.
func TestChartingReplays(t *testing.T) {
	var points [][2]float64
	// About the spawn grid south of the centre, where the boats sail.
	for i := range 40 {
		a := float64(i) * 0.7
		points = append(points, [2]float64{math.Sin(a) * float64(100+i*20), -20 + math.Cos(a)*float64(100+i*20)})
	}
	run := func() []bus.Charted {
		w := chartWorld(t, 15, false, points...)
		q := w.Bus().Commands.Developer()
		for i := range 40 {
			if err := q.TrySend(bus.Command{Op: bus.Join, Account: acct(uint64(i + 1)), Conn: uint64(i + 1)}); err != nil {
				t.Fatal(err)
			}
		}
		var out []bus.Charted
		for i := range 600 {
			sail(w, 1, uint64(i))
			out = append(out, charted(w)...)
		}
		return out
	}
	a, b := run(), run()
	if len(a) == 0 {
		t.Fatal("nothing charted")
	}
	if !slices.Equal(a, b) {
		t.Fatalf("the worlds charted differently:\n%+v\n%+v", a, b)
	}
}

// TestSightingAllocatesNothing: a tick with boats looking allocates nothing.
func TestSightingAllocatesNothing(t *testing.T) {
	w := chartWorld(t, 1, false, [2]float64{0, 0}, [2]float64{300, 0})
	fill(t, w, 30, 3)
	for range 5 {
		w.Tick()
	}
	if n := testing.AllocsPerRun(50, w.Tick); n != 0 {
		t.Errorf("%v allocations a tick", n)
	}
}
