// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import "github.com/daneelvt/keel-over-the-edge/internal/physics"

// In port: the water of a town's harbour, where later the questions "at a
// port?" are answered (a boat swapped, a sailor's return, a race's start
// and finish), made once here. Port Royal's is its basin and narrows; a
// port's, the water within reach of its quay and piers; a village's, of its
// jetty. Each is kept as discs, so that the page answers it from the discs
// its chunks carry, with the same arithmetic.

// InPort is the town whose harbour (x, y) is in, or -1: water within one
// of its discs.
func (b *Bundle) InPort(x, y float64) int32 {
	if e, _ := b.Ground.At(x, y); e > 0 {
		return -1
	}
	for _, t := range b.Towns {
		if inDiscs(t.Harbour, x, y) {
			return t.Number
		}
	}
	return -1
}

// inDiscs reports whether (x, y) is within any of the discs: the squared
// distance to a disc's centre no more than its radius squared, in the
// order of operations the page's own test uses.
func inDiscs(discs []Disc, x, y float64) bool {
	for _, d := range discs {
		dx, dy := x-d.X, y-d.Y
		if float64(dx*dx)+float64(dy*dy) <= float64(d.R*d.R) {
			return true
		}
	}
	return false
}

// InPortGround is whether (x, y) is in port by the discs given and the
// ground: what a page holding only some chunks can answer.
func InPortGround(g *physics.Ground, discs []Disc, x, y float64) bool {
	if e, _ := g.At(x, y); e > 0 {
		return false
	}
	return inDiscs(discs, x, y)
}

// Tops are the buildings' tops: each one's middle and how high it stands,
// m above the sea.
func (b *Bundle) Tops() [][3]float64 {
	out := make([][3]float64, 0, len(b.Buildings))
	for _, bd := range b.Buildings {
		out = append(out, [3]float64{bd.X, bd.Y, bd.Top})
	}
	return out
}
