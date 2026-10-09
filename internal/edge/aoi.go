// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"math/bits"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
)

// A connection's area of interest: the other boats near its own, found in
// the frame's grid. A boat comes into view within ViewEnter of the player's
// boat and stays until beyond ViewKeep; of those, the ViewSlots nearest are
// kept. Within NearEnter a boat is in the near band, sampled by every
// snapshot, and stays near until beyond NearKeep; beyond, in the far band,
// it is sampled by every FarEvery-th, on snapshots chosen by the
// connection's ID so that the far band's work is spread evenly. The
// margins keep a boat at an edge from flickering in and out, or between
// the bands. All are starting values.
const (
	ViewEnter = 700.0 // m
	ViewKeep  = 750.0
	NearEnter = 300.0
	NearKeep  = 330.0
	FarEvery  = 3
)

// farSampled says whether connection id's snapshot of tick samples the far
// band: snapshots go out on even ticks.
func farSampled(id uint64, tick int64) bool {
	return (uint64(tick/2)+id)%FarEvery == 0
}

// candidate is a boat that may be in view, and its squared distance.
type candidate struct {
	slot int32
	d2   float64
	kept uint8 // its view slot plus 1 if the base holds it, else 0
}

// less orders candidates by distance, then slot, so the nearest are the
// same whatever order the grid gave them in.
func (a *candidate) less(b *candidate) bool {
	return a.d2 < b.d2 || a.d2 == b.d2 && a.slot < b.slot
}

// aoi is an encoder's scratch for finding views, sized to the world once.
type aoi struct {
	kept  []uint8 // per frame slot: its view slot plus 1 in the base, while finding one view
	cands []candidate
}

func (a *aoi) init(capacity int) {
	a.kept = make([]uint8, capacity)
	a.cands = make([]candidate, 0, capacity)
}

// find fills next with the view of the boat in slot own of f, from base
// (nil for none), and returns which slots enter, and which the snapshot
// samples. Boats the base holds keep their view slots; boats entering take
// the lowest free, replacing any boat that left there.
func (a *aoi) find(f *bus.Frame, own int32, base, next *connView, id uint64) (enter, sample uint64) {
	x, y := f.State[own].X, f.State[own].Y
	var baseView *protocol.View
	if base != nil {
		baseView = &base.view
		for m := base.view.Used; m != 0; m &= m - 1 {
			vs := bits.TrailingZeros64(m)
			s := base.slot[vs]
			if f.Occupied[s] && f.Boat[s] == base.boat[vs] {
				a.kept[s] = uint8(vs + 1)
			}
		}
	}

	// The boats in the cells around, within reach.
	a.cands = a.cands[:0]
	g := &f.Grid
	enter2, keep2 := ViewEnter*ViewEnter, ViewKeep*ViewKeep
	r0, r1 := physics.CellOf(y-ViewKeep), physics.CellOf(y+ViewKeep)
	c0, c1 := physics.CellOf(x-ViewKeep), physics.CellOf(x+ViewKeep)
	for row := r0; row <= r1; row++ {
		at := row * physics.GridCells
		start, end := g.Start[at+c0], g.Start[at+c1+1]
		for _, s := range g.Slots[start:end] {
			if s == own {
				continue
			}
			dx, dy := f.State[s].X-x, f.State[s].Y-y
			d2 := dx*dx + dy*dy
			if k := a.kept[s]; d2 <= enter2 || k != 0 && d2 <= keep2 {
				a.cands = append(a.cands, candidate{slot: s, d2: d2, kept: k})
			}
		}
	}
	cands := a.cands
	if len(cands) > protocol.ViewSlots {
		nearest(cands, protocol.ViewSlots)
		cands = cands[:protocol.ViewSlots]
	}

	// Boats the base holds stay in their slots; the rest take the free.
	next.view.Used = 0
	for i := range cands {
		if k := cands[i].kept; k != 0 {
			next.view.Used |= 1 << (k - 1)
		}
	}
	farTick := farSampled(id, f.Tick)
	near2, nearKeep2 := NearEnter*NearEnter, NearKeep*NearKeep
	for i := range cands {
		c := &cands[i]
		s := c.slot
		vs := int(c.kept) - 1
		kept := vs >= 0
		if !kept {
			vs = bits.TrailingZeros64(^next.view.Used)
			next.view.Used |= 1 << vs
			enter |= 1 << vs
		}
		wasNear := kept && !baseView.Boats[vs].Far()
		near := c.d2 <= near2 || wasNear && c.d2 <= nearKeep2
		next.slot[vs], next.boat[vs] = s, f.Boat[s]
		// A far boat is sampled on its band's snapshots, and whenever it
		// enters or crosses into the band; between them it stays as the
		// client last saw it.
		if kept && !near && !wasNear && !farTick {
			next.view.Boats[vs] = baseView.Boats[vs]
			continue
		}
		protocol.Quantise(&f.State[s], f.Kind[s], f.Sail[s], !near, &next.view.Boats[vs])
		sample |= 1 << vs
	}
	for m := next.view.Used ^ ^uint64(0); m != 0; m &= m - 1 {
		next.view.Boats[bits.TrailingZeros64(m)] = protocol.Boat{}
	}
	if base != nil {
		for m := base.view.Used; m != 0; m &= m - 1 {
			a.kept[base.slot[bits.TrailingZeros64(m)]] = 0
		}
	}
	return enter, sample
}

// nearest moves the k nearest of cs to its front, in no order: Hoare's
// selection (quickselect), with the middle element as its pivot.
func nearest(cs []candidate, k int) {
	lo, hi := 0, len(cs)-1
	for lo < hi {
		p := cs[lo+(hi-lo)/2]
		i, j := lo, hi
		for i <= j {
			for cs[i].less(&p) {
				i++
			}
			for p.less(&cs[j]) {
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
