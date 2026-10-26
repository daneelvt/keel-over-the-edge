// SPDX-License-Identifier: AGPL-3.0-only

// Package view is what of the other boats a sailor's eye is given: those
// near it in the frame's grid, by the same rule for a phone's connection
// and a machine sailor's lookout report, so that a report never tells of a
// boat its phone would not be sent. A boat comes into view within Enter of
// the eye and stays until beyond Keep; of those, the Slots nearest are
// kept; its own boat is in no view, nor is one the owner's tools keep
// unseen. The margin keeps a boat at the edge from flickering in and out.
package view

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The view's reach, m: a boat comes into view within Enter and stays to
// Keep. Within NearEnter a boat is near, and stays near to NearKeep.
// Starting values.
const (
	Enter     = 700.0
	Keep      = 750.0
	NearEnter = 300.0
	NearKeep  = 330.0
)

// Slots is the most boats a view holds.
const Slots = 64

// Candidate is a boat that may be in a view: its slot, its squared
// distance from the eye, m², and its view slot plus 1 if the eye's last
// view held it, else 0.
type Candidate struct {
	Slot int32
	D2   float64
	Kept uint8
}

// Less orders candidates by distance, then slot, so the nearest are the
// same whatever order the grid gave them in.
func (a *Candidate) Less(b *Candidate) bool {
	return a.D2 < b.D2 || a.D2 == b.D2 && a.Slot < b.Slot
}

// Candidates appends to out the boats of f in view of an eye at (x, y),
// the eye of slot own's boat (−1 for none): those within Enter, and those
// the last view held within Keep, which kept gives by slot as their view
// slot plus 1; then keeps the Slots nearest, in no order. kept is nil for
// an eye with no last view.
func Candidates(f *bus.Frame, own int32, x, y float64, kept []uint8, out []Candidate) []Candidate {
	g := &f.Grid
	enter2, keep2 := Enter*Enter, Keep*Keep
	r0, r1 := physics.CellOf(y-Keep), physics.CellOf(y+Keep)
	c0, c1 := physics.CellOf(x-Keep), physics.CellOf(x+Keep)
	for row := r0; row <= r1; row++ {
		at := row * physics.GridCells
		start, end := g.Start[at+c0], g.Start[at+c1+1]
		for _, s := range g.Slots[start:end] {
			if s == own || f.Unseen[s] {
				continue
			}
			dx, dy := f.State[s].X-x, f.State[s].Y-y
			d2 := dx*dx + dy*dy
			var k uint8
			if kept != nil {
				k = kept[s]
			}
			if d2 <= enter2 || k != 0 && d2 <= keep2 {
				out = append(out, Candidate{Slot: s, D2: d2, Kept: k})
			}
		}
	}
	if len(out) > Slots {
		Nearest(out, Slots)
		out = out[:Slots]
	}
	return out
}

// Nearest moves the k nearest of cs to its front, in no order: Hoare's
// selection (quickselect), with the middle element as its pivot.
func Nearest(cs []Candidate, k int) {
	lo, hi := 0, len(cs)-1
	for lo < hi {
		p := cs[lo+(hi-lo)/2]
		i, j := lo, hi
		for i <= j {
			for cs[i].Less(&p) {
				i++
			}
			for p.Less(&cs[j]) {
				j--
			}
			if i <= j {
				cs[i], cs[j] = cs[j], cs[i]
				i++
				j--
			}
		}
		switch {
		case k-1 <= j:
			hi = j
		case k-1 >= i:
			lo = i
		default:
			return
		}
	}
}
