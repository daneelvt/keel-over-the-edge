// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"math/bits"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/view"
)

// A connection's area of interest: the other boats near its eye, found in
// the frame's grid by the view's rule (package view): its own boat, or its
// owner's free camera while it roams. Within the view's near band a boat
// is sampled by every snapshot; beyond, in the far band, it is sampled by
// every FarEvery-th, on snapshots chosen by the connection's ID so that the
// far band's work is spread evenly. All are starting values.
const (
	ViewEnter = view.Enter // m
	ViewKeep  = view.Keep
	NearEnter = view.NearEnter
	NearKeep  = view.NearKeep
	FarEvery  = 3
)

// farSampled says whether connection id's snapshot of tick samples the far
// band: snapshots go out on even ticks.
func farSampled(id uint64, tick int64) bool {
	return (uint64(tick/2)+id)%FarEvery == 0
}

// aoi is an encoder's scratch for finding views, sized to the world once.
type aoi struct {
	kept  []uint8 // per frame slot: its view slot plus 1 in the base, while finding one view
	cands []view.Candidate
}

func (a *aoi) init(capacity int) {
	a.kept = make([]uint8, capacity)
	a.cands = make([]view.Candidate, 0, capacity)
}

// find fills next with the view about (x, y), the eye of the connection
// whose boat is in slot own of f, from base (nil for none), and returns
// which slots enter, and which the snapshot samples. Its own boat is in no
// view, nor is a boat its owner's tools keep unseen. Boats the base holds
// keep their view slots; boats entering take the lowest free, replacing any
// boat that left there.
func (a *aoi) find(f *bus.Frame, own int32, x, y float64, base, next *connView, id uint64) (enter, sample uint64) {
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

	// The boats in the view, the nearest of them.
	a.cands = view.Candidates(f, own, x, y, a.kept, a.cands[:0])
	cands := a.cands

	// Boats the base holds stay in their slots; the rest take the free.
	next.view.Used = 0
	for i := range cands {
		if k := cands[i].Kept; k != 0 {
			next.view.Used |= 1 << (k - 1)
		}
	}
	farTick := farSampled(id, f.Tick)
	near2, nearKeep2 := NearEnter*NearEnter, NearKeep*NearKeep
	for i := range cands {
		c := &cands[i]
		s := c.Slot
		vs := int(c.Kept) - 1
		kept := vs >= 0
		if !kept {
			vs = bits.TrailingZeros64(^next.view.Used)
			next.view.Used |= 1 << vs
			enter |= 1 << vs
		}
		wasNear := kept && !baseView.Boats[vs].Far()
		near := c.D2 <= near2 || wasNear && c.D2 <= nearKeep2
		next.slot[vs], next.boat[vs] = s, f.Boat[s]
		// A far boat is sampled on its band's snapshots, and whenever it
		// enters or crosses into the band; between them it stays as the
		// client last saw it.
		if kept && !near && !wasNear && !farTick {
			next.view.Boats[vs] = baseView.Boats[vs]
			continue
		}
		protocol.Quantise(&f.State[s], f.Kind[s], f.Sail[s], !near, &next.view.Boats[vs])
		if f.Voyage[s].Falling() {
			next.view.Boats[vs].Flags |= protocol.Falling
		}
		if f.Machine[s] {
			next.view.Boats[vs].Flags |= protocol.Machine
		}
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
