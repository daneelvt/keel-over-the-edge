// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

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

// Tops are what stands higher than its ground, each where it stands and
// how high, m above the sea: the buildings' tops, the roofs' over their rock
// awash, and in each cell of the shelter's grid its plants' highest canopy
// where it stands above the cell's highest ground, by the catalog's
// surfaces: a wood rises over the horizon before its island does.
func (b *Bundle) Tops(cat *catalog.Catalog) [][3]float64 {
	out := make([][3]float64, 0, len(b.Buildings)+len(b.Roofs))
	for _, bd := range b.Buildings {
		out = append(out, [3]float64{bd.X, bd.Y, bd.Top})
	}
	for _, r := range b.Roofs {
		x, y := physics.CellCentre(r.C, r.J)
		out = append(out, [3]float64{x, y, float64(r.Top) / 10})
	}
	var canopy [physics.GroundSurfaces]float64
	for i, s := range cat.World.Surfaces {
		if i < physics.GroundSurfaces {
			canopy[i] = s.Canopy
		}
	}
	for n := range int32(physics.ChunkCount) {
		ch := b.Ground.Chunks[n]
		if ch == nil {
			continue
		}
		var ground, wood [physics.ShelterCells]float64
		for i := range int32(physics.ChunkHexes) {
			e := ch.Elevation[i]
			if e <= 0 {
				continue
			}
			k := (i/physics.ChunkRows/physics.ShelterCell)*physics.ShelterRows + (i%physics.ChunkRows)/physics.ShelterCell
			h := float64(e) / 10
			ground[k] = max(ground[k], h)
			if c := canopy[ch.Surface[i]]; c > 0 {
				wood[k] = max(wood[k], h+c)
			}
		}
		c0, j0 := physics.ChunkCorner(n)
		for k := range int32(physics.ShelterCells) {
			if wood[k] > ground[k] {
				x, y := physics.ShelterCellCentre(c0/physics.ShelterCell+k/physics.ShelterRows, j0/physics.ShelterCell+k%physics.ShelterRows)
				out = append(out, [3]float64{x, y, wood[k]})
			}
		}
	}
	return out
}
