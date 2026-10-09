// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"bytes"
	"math"
	"math/rand/v2"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// scatter places a world's boats at random over a square wider than the
// grid's, so that some lie beyond it, and some on cells' edges.
func scatter(t *testing.T, w *World, seed uint64) {
	t.Helper()
	rng := rand.New(rand.NewPCG(seed, seed))
	q := w.Bus().Commands.Developer()
	for i, s := range w.Latest().Live {
		var st physics.State
		switch i % 5 {
		case 0: // on a cell's corner
			st.X = float64((rng.IntN(300) - 150) * physics.CellSize)
			st.Y = float64((rng.IntN(300) - 150) * physics.CellSize)
		default:
			st.X = (rng.Float64() - 0.5) * 20_000
			st.Y = (rng.Float64() - 0.5) * 20_000
		}
		st.Heading = (rng.Float64() - 0.5) * 2 * math.Pi
		st.Surge = 2
		if i%7 == 0 {
			// A crowd.
			st.X, st.Y = 100+rng.Float64()*50, -300+rng.Float64()*50
		}
		q.TrySend(bus.Command{Op: bus.Place, Boat: w.Latest().Boat[s], State: st})
	}
	w.Tick()
}

// TestGridFindsWhatAScanFinds: every cell within a radius of a point holds,
// together, every boat within that radius that a scan of every boat
// finds; and each cell's boats are in ascending slot order.
func TestGridFindsWhatAScanFinds(t *testing.T) {
	w := newWorld(t, 2048, 4)
	fill(t, w, 2000, 1)
	scatter(t, w, 7)
	f := w.Latest()
	g := &f.Grid
	if int(g.Start[bus.Cells]) != len(f.Live) || len(g.Slots) != len(f.Live) {
		t.Fatalf("the grid holds %d boats of %d", g.Start[bus.Cells], len(f.Live))
	}
	for c := range int32(bus.Cells) {
		cell := g.Boats(c)
		if !slices.IsSorted(cell) {
			t.Fatalf("cell %d: %v", c, cell)
		}
		for _, s := range cell {
			if physics.Cell(f.State[s].X, f.State[s].Y) != c || g.Cell[s] != c {
				t.Fatalf("slot %d in cell %d", s, c)
			}
		}
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for range 200 {
		x, y := (rng.Float64()-0.5)*18_000, (rng.Float64()-0.5)*18_000
		r := 50 + rng.Float64()*1000
		var scan, found []int32
		for _, s := range f.Live {
			if math.Hypot(f.State[s].X-x, f.State[s].Y-y) <= r {
				scan = append(scan, s)
			}
		}
		for row := physics.CellOf(y - r); row <= physics.CellOf(y+r); row++ {
			for col := physics.CellOf(x - r); col <= physics.CellOf(x+r); col++ {
				for _, s := range g.Boats(row*physics.GridCells + col) {
					if math.Hypot(f.State[s].X-x, f.State[s].Y-y) <= r {
						found = append(found, s)
					}
				}
			}
		}
		slices.Sort(found)
		if !slices.Equal(scan, found) {
			t.Fatalf("within %.0f m of (%.0f, %.0f): a scan finds %v, the grid %v", r, x, y, scan, found)
		}
	}
}

// TestGridAndSailsWithAnyWorkers: the grid and the sail bytes are the same
// however many goroutines step the boats.
func TestGridAndSailsWithAnyWorkers(t *testing.T) {
	var grid, sails []byte
	for _, n := range []int{1, 8} {
		w := newWorld(t, 2048, n)
		fill(t, w, 1000, 3)
		scatter(t, w, 3)
		sail(w, 30, 4)
		f := w.Latest()
		var g, sb []byte
		for _, v := range f.Grid.Start {
			g = append(g, byte(v), byte(v>>8))
		}
		for _, s := range f.Grid.Slots {
			g = append(g, byte(s), byte(s>>8))
		}
		for _, s := range f.Live {
			sb = append(sb, f.Sail[s])
		}
		if grid == nil {
			grid, sails = g, sb
			continue
		}
		if !bytes.Equal(g, grid) || !bytes.Equal(sb, sails) {
			t.Fatalf("%d workers: another grid or other sails than one worker's", n)
		}
	}
	// The boats sail: some sails draw, some luff.
	var drawing, luffing int
	for _, b := range sails {
		if b>>4&3 == physics.FlowAttached {
			drawing++
		}
		if b>>4&3 == physics.FlowLuffing {
			luffing++
		}
	}
	if drawing == 0 || luffing == 0 {
		t.Fatalf("%d sails draw and %d luff: %v", drawing, luffing, sails[:20])
	}
}

// TestGridOfALoadedWorld: a world loaded from a snapshot has its grid
// before its first tick.
func TestGridOfALoadedWorld(t *testing.T) {
	w := scatteredWorld(t)
	w2 := limitedWorld(t, 300, 1, 210)
	if err := w2.Load(AppendSnapshot(nil, w.Latest())); err != nil {
		t.Fatal(err)
	}
	f, g := w.Latest(), w2.Latest()
	if !slices.Equal(f.Grid.Slots, g.Grid.Slots) || !slices.Equal(f.Grid.Start, g.Grid.Start) {
		t.Fatal("the loaded world's grid differs")
	}
}

// BenchmarkGrid is the grid's share of a tick of 1,000 boats.
func BenchmarkGrid(b *testing.B) {
	w := newWorld(b, Capacity, 1)
	fill(b, w, 1000, 1)
	f := w.Latest()
	for b.Loop() {
		buildGrid(f)
	}
}
