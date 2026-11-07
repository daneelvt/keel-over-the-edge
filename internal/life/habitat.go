// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A point's habitat is read where an encounter is drawn: its depth from
// the ground, and from a field built once as the world loads whether it
// is within reach of a town, a reef or a lagoon, or a colony. Real
// animals live where they feed, and seabirds range further than this
// world is wide (brown boobies from Anguilla make trips of 125 ± 54 km,
// Soanes and others 2016), so where a bird is met depends on its habitat
// and how it flies, not on how far its colony is.

// Places are what the habitat is built from, m east and north of the
// world's centre: its towns' waterfronts, its reefs' and lagoons' places
// with half each one's length, its colonies, and its islands' centres.
type Places struct {
	Towns    [][2]float64
	Reefs    []Reach
	Colonies [][2]float64
	Islands  [][2]float64
}

// Reach is a place that reaches some way about it: a reef's crest runs
// Half m either side of its place.
type Reach struct {
	X, Y, Half float64
}

// The field's flags.
const (
	nearHarbour uint8 = 1 << iota
	nearReef
	nearColony
)

// Habitat is a world's habitat.
type Habitat struct {
	p        *Params
	ground   *physics.Ground
	places   Places
	disk     float64
	n        int32 // cells a side
	side     float64
	field    []uint8
	outerSq  float64
	homeless bool // no colony and no island to fly home to
}

// NewHabitat builds a world's habitat from its ground (nil for open sea
// everywhere), its places and the radius of its disk, m.
func NewHabitat(p *Params, ground *physics.Ground, places Places, disk float64) *Habitat {
	h := &Habitat{p: p, ground: ground, places: places, disk: disk, side: p.Field}
	h.n = int32(math.Ceil(float64(2*disk) / p.Field))
	h.field = make([]uint8, int(h.n)*int(h.n))
	h.outerSq = float64(p.OuterFrom * p.OuterFrom)
	for _, t := range places.Towns {
		h.stamp(t[0], t[1], p.HarbourIn, nearHarbour)
	}
	for _, r := range places.Reefs {
		h.stamp(r.X, r.Y, p.ReefIn+r.Half, nearReef)
	}
	for _, c := range places.Colonies {
		h.stamp(c[0], c[1], p.ColonyIn, nearColony)
	}
	h.homeless = len(places.Colonies) == 0 && len(places.Islands) == 0
	return h
}

// stamp sets flag on every cell whose centre is within r of (x, y).
func (h *Habitat) stamp(x, y, r float64, flag uint8) {
	i0, j0 := h.cellOf(x-r, y-r)
	i1, j1 := h.cellOf(x+r, y+r)
	r2 := float64(r * r)
	for j := max(j0, 0); j <= min(j1, h.n-1); j++ {
		for i := max(i0, 0); i <= min(i1, h.n-1); i++ {
			cx, cy := h.centre(i, j)
			dx, dy := cx-x, cy-y
			if float64(dx*dx)+float64(dy*dy) <= r2 {
				h.field[j*h.n+i] |= flag
			}
		}
	}
}

// cellOf is the field's cell (x, y) is in, which may lie outside it.
func (h *Habitat) cellOf(x, y float64) (i, j int32) {
	return int32(math.Floor((x + h.disk) / h.side)), int32(math.Floor((y + h.disk) / h.side))
}

// centre is the middle of the field's cell (i, j).
func (h *Habitat) centre(i, j int32) (x, y float64) {
	return float64(float64(float64(i)+0.5)*h.side) - h.disk, float64(float64(float64(j)+0.5)*h.side) - h.disk
}

// flags are the field's flags at (x, y), none outside it.
func (h *Habitat) flags(x, y float64) uint8 {
	i, j := h.cellOf(x, y)
	if i < 0 || j < 0 || i >= h.n || j >= h.n {
		return 0
	}
	return h.field[j*h.n+i]
}

// At is the habitat at (x, y), and whether a colony is near: Land on land
// or beyond the disk.
func (h *Habitat) At(x, y float64) (habitat int, colony bool) {
	r2 := float64(x*x) + float64(y*y)
	if r2 >= float64(h.disk*h.disk) {
		return Land, false
	}
	depth := -physics.DeepWater * 0.1
	if h.ground != nil {
		e, _ := h.ground.At(x, y)
		if e >= 0 {
			return Land, false
		}
		depth = -e
	}
	f := h.flags(x, y)
	colony = f&nearColony != 0
	switch {
	case f&nearHarbour != 0:
		return Harbour, colony
	case f&nearReef != 0:
		return Reef, colony
	case r2 >= h.outerSq:
		return Outer, colony
	case depth < h.p.ShelfIn:
		return Shelf, colony
	}
	return Deep, colony
}

// Weight is a kind's weight by its habitat at (x, y): nothing on land.
func (h *Habitat) Weight(k *Kind, x, y float64) float64 {
	at, colony := h.At(x, y)
	if at == Land {
		return 0
	}
	w := k.Habitat[at]
	if colony {
		w = float64(w * k.NearColony)
	}
	return w
}

// Home is the way home from (x, y), rad clockwise from north: to the
// nearest colony, or the nearest island's centre where there is none; ok
// is false where there is neither.
func (h *Habitat) Home(x, y float64) (heading float64, ok bool) {
	if h.homeless {
		return 0, false
	}
	list := h.places.Colonies
	if len(list) == 0 {
		list = h.places.Islands
	}
	best, bx, by := math.Inf(1), 0.0, 0.0
	for _, c := range list {
		dx, dy := c[0]-x, c[1]-y
		if d := float64(dx*dx) + float64(dy*dy); d < best {
			best, bx, by = d, dx, dy
		}
	}
	return physics.Atan2(bx, by), true
}
