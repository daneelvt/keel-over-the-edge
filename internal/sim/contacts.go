// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Encounters: after the physics and the grid, on the ticking goroutine, the
// boats near each other are found in the grid, each pair once, and taken in
// the order of their slots: the lower first, then the higher. For each
// pair the Articles say which keeps clear; a pair whose keep-clear boat
// changes remembers when and by whose action. Hulls that touch are
// contacts, resolved together; a pair's first contact after being apart
// for the encounters' apart ticks is a bump, judged by the Articles with
// the pair's memory as it stood before it. Boats a contact moved have their
// wind and wake worked out again, and the grid is built again, so that
// what the next tick reads is what a world restored from this frame would
// build.

// candidate is two slots near enough to be a pair.
type candidate struct{ a, b int32 }

// forward are the cells after a cell, east, north-west, north and
// north-east, by column and row: with the cell itself, each pair of cells
// within one of each other is met once.
var forward = [4][2]int32{{1, 0}, {-1, 1}, {0, 1}, {1, 1}}

// contacts finds the next frame's pairs, contacts and bumps.
func (w *World) contacts() {
	f := w.next
	if w.enc == nil {
		return
	}
	w.candidates = w.candidates[:0]
	g := &f.Grid
	for _, s := range f.Live {
		c := g.Cell[s]
		col, row := c%physics.GridCells, c/physics.GridCells
		for _, o := range g.Boats(c) {
			if o > s {
				w.near(s, o)
			}
		}
		for _, d := range forward {
			cc, rr := col+d[0], row+d[1]
			if cc < 0 || cc >= physics.GridCells || rr < 0 || rr >= physics.GridCells {
				continue
			}
			for _, o := range g.Boats(rr*physics.GridCells + cc) {
				w.near(s, o)
			}
		}
	}
	slices.SortFunc(w.candidates, func(x, y candidate) int {
		if x.a != y.a {
			return int(x.a - y.a)
		}
		return int(x.b - y.b)
	})

	prev := w.cur.Pairs
	f.Pairs = f.Pairs[:0]
	w.touching = w.touching[:0]
	w.touched = w.touched[:0]
	apart := w.enc.Apart()
	j := 0
	for _, c := range w.candidates {
		for j < len(prev) && (prev[j].A < c.a || prev[j].A == c.a && prev[j].B < c.b) {
			j++
		}
		p := bus.Pair{A: c.a, B: c.b, BoatA: f.Boat[c.a], BoatB: f.Boat[c.b], Touched: f.Tick - apart - 1}
		known := j < len(prev) && prev[j].A == c.a && prev[j].B == c.b && prev[j].BoatA == p.BoatA && prev[j].BoatB == p.BoatB &&
			!w.placed(c.a) && !w.placed(c.b)
		if known {
			p = prev[j]
		}
		w.encounter(&w.meeting, f, c.a, c.b)
		pa, pb := &w.kinds[f.Kind[c.a]], &w.kinds[f.Kind[c.b]]
		now := physics.Relate(&w.meeting, pa, pb)
		// The relation as the pair knew it before this tick.
		before := physics.Verdict{Keeper: float64(p.Keeper), Article: float64(p.Article)}
		if !known {
			before = now
		}
		w.meeting.Since, w.meeting.By = float64(f.Tick-p.Since), float64(p.By)

		t := physics.Touching{A: &f.State[c.a], B: &f.State[c.b], PA: pa, PB: pb}
		if w.hulls.Touch(t.A, t.B, pa, pb, &t.C) {
			if f.Tick-p.Touched > apart {
				w.bump(f, &p, &t.C, physics.Fault(before, &w.meeting, w.enc))
			}
			p.Touched = f.Tick
			w.touching = append(w.touching, t)
			w.touched = append(w.touched, c)
		}
		switch {
		case !known:
			// Boats that have just come near have had no right of way
			// over each other to acquire: no one's action began it.
			p.By, p.Since = physics.Neither, f.Tick
		case uint8(now.Keeper) != p.Keeper:
			p.By = uint8(physics.ActionOf(float64(p.Keeper), float64(p.Article), &now, &w.meeting, w.enc))
			p.Since = f.Tick
		}
		p.Keeper, p.Article = uint8(now.Keeper), uint8(now.Article)
		f.Pairs = append(f.Pairs, p)
	}
	if len(w.touching) == 0 {
		return
	}
	physics.Resolve(w.touching, w.enc)
	for _, c := range w.touched {
		w.settle(f, c.a)
		w.settle(f, c.b)
	}
	buildGrid(f)
}

// placed reports whether a command put boat s where it is this tick: its
// pairs start afresh, as boats that have just come near, since nothing they
// did brought them there.
func (w *World) placed(s int32) bool {
	f := w.next
	for i := range f.Events {
		if e := &f.Events[i]; e.Op == bus.Place && e.Reply.Result == bus.Done && e.Reply.Slot == s {
			return true
		}
	}
	return false
}

// near makes slots s and o a candidate if their boats are near enough.
func (w *World) near(s, o int32) {
	f := w.next
	if physics.Near(&f.State[s], &f.State[o], &w.kinds[f.Kind[s]], &w.kinds[f.Kind[o]], w.enc) {
		a, b := min(s, o), max(s, o)
		w.candidates = append(w.candidates, candidate{a, b})
	}
}

// encounter fills e with the boats in slots a and b of f, as the Articles
// read them.
func (w *World) encounter(e *physics.Encounter, f *bus.Frame, a, b int32) {
	for i, s := range [2]int32{a, b} {
		st, c := &f.State[s], &f.Course[s]
		e.X[i], e.Y[i], e.Heading[i] = st.X, st.Y, st.Heading
		e.Heel[i], e.Boom[i], e.SailorMode[i] = st.Heel, st.Boom, st.SailorMode
		e.WindFrom[i] = f.Wind[s].WindFrom
		e.Tack[i], e.Tacking[i], e.Settled[i], e.Course[i] = c.Tack, c.Tacking, c.Settled, c.Course
	}
}

// bump records a bump of pair p at contact c with verdict v.
func (w *World) bump(f *bus.Frame, p *bus.Pair, c *physics.Contact, v physics.Verdict) {
	f.Bumps = append(f.Bumps, bus.Bump{
		Tick: f.Tick, A: p.A, B: p.B, BoatA: p.BoatA, BoatB: p.BoatB,
		OwnerA: f.Owner[p.A], OwnerB: f.Owner[p.B],
		X: c.X, Y: c.Y, Closing: c.Closing,
		Fault: uint8(v.Fault), Article: uint8(v.FaultArticle),
	})
}

// settle works out boat s's true wind at its place at f's tick and the wake
// it leaves: after its step, after a contact moved it, and for every boat
// of a world restored.
func (w *World) settle(f *bus.Frame, s int32) {
	st := &f.State[s]
	f.Wind[s] = physics.WindAt(&w.wind, st.X, st.Y)
	if w.enc != nil {
		f.Wake[s] = physics.WakeOf(st, &f.Wind[s], &w.kinds[f.Kind[s]], w.enc)
	}
}

// shadow changes e, the wind at boat s about to step at (x, y), by the
// wakes the boats near it left in the current frame.
func (w *World) shadow(src *physics.Sources, e *physics.Env, s int32, x, y float64) {
	cur := w.cur
	src.Reset()
	c := physics.Cell(x, y)
	col, row := c%physics.GridCells, c/physics.GridCells
	r := w.reachCells
	for rr := max(row-r, 0); rr <= min(row+r, physics.GridCells-1); rr++ {
		for cc := max(col-r, 0); cc <= min(col+r, physics.GridCells-1); cc++ {
			for _, o := range cur.Grid.Boats(rr*physics.GridCells + cc) {
				if o != s {
					src.Consider(&cur.Wake[o], o, x, y, w.enc)
				}
			}
		}
	}
	physics.ShadowAt(e, x, y, src, w.enc)
}
