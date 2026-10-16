// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The raster: every hexagon of every chunk from the islands that reach it.
// Where two islands' grids meet, the higher ground wins: land over the sea
// bed, and the shallower of two beds. Beyond every island's reach the bed
// is the deep, covered with the first surface. A chunk wholly outside the
// disk holds nothing.

// chunkOutside reports whether chunk n lies wholly outside the disk of the
// radius given: its nearest hexagon's centre is further than the radius
// and a hexagon's.
func chunkOutside(n int32, radius float64) bool {
	c0, j0 := physics.ChunkCorner(n)
	x0, _ := physics.CellCentre(c0, 0)
	x1, _ := physics.CellCentre(c0+physics.ChunkColumns-1, 0)
	_, y0 := physics.CellCentre(0, j0)
	_, y1 := physics.CellCentre(1, j0+physics.ChunkRows-1)
	nx := clamp(0, x0, x1)
	ny := clamp(0, y0, y1)
	return hypot(nx, ny) > radius+physics.HexAcross
}

// raster makes chunk n's ground from the islands; nil if it lies wholly
// outside the disk.
func (c *config) raster(n int32, islands []*made) *physics.GroundChunk {
	if chunkOutside(n, c.disk) {
		return nil
	}
	ch := new(physics.GroundChunk)
	deep := int16(-round(float64(c.seabed.Deep * 10)))
	for i := range ch.Elevation {
		ch.Elevation[i] = deep
	}
	c0, j0 := physics.ChunkCorner(n)
	for _, m := range islands {
		g := &m.grid
		ca, cb := max(c0, g.c0), min(c0+physics.ChunkColumns, g.c0+g.w)
		ja, jb := max(j0, g.j0), min(j0+physics.ChunkRows, g.j0+g.h)
		for col := ca; col < cb; col++ {
			from := (col-g.c0)*g.h - g.j0
			to := (col-c0)*physics.ChunkRows - j0
			for row := ja; row < jb; row++ {
				if e := g.elev[from+row]; e > ch.Elevation[to+row] {
					ch.Elevation[to+row] = e
					ch.Surface[to+row] = g.surf[from+row]
				}
			}
		}
	}
	return ch
}

// rasterAll makes every chunk of the world.
func (c *config) rasterAll(islands []*made) *physics.Ground {
	g := new(physics.Ground)
	for n := range int32(physics.ChunkCount) {
		g.Chunks[n] = c.raster(n, islands)
	}
	return g
}

// elevationAt is the ground's elevation at column c and row j, in
// decimetres: the deep off the grid or in a chunk not held.
func elevationAt(g *physics.Ground, c, j int32) int16 {
	n, i, ok := physics.ChunkOf(c, j)
	if !ok || g.Chunks[n] == nil {
		return physics.DeepWater
	}
	return g.Chunks[n].Elevation[i]
}

// landAt reports whether the hexagon that holds (x, y) is land.
func landAt(g *physics.Ground, x, y float64) bool {
	q, r := physics.HexAt(x, y)
	c, j := physics.HexCell(q, r)
	return elevationAt(g, c, j) > 0
}

// coarse is a grid of the world in squares coarseCell metres on a side,
// each saying whether it holds land and how far its centre is from the
// nearest square that does: what lets a march over open water take long
// strides.
type coarse struct {
	side int32
	land []bool
	dist []float64 // m
}

// coarseCell is a coarse square's side, m.
const coarseCell = 32

// coarseHalf is half the coarse grid's side, m: it covers the hexagons'
// grid.
const coarseHalf = 8512

func newCoarse(g *physics.Ground) *coarse {
	side := int32(2 * coarseHalf / coarseCell)
	k := &coarse{side: side, land: make([]bool, side*side), dist: make([]float64, side*side)}
	for n := range int32(physics.ChunkCount) {
		ch := g.Chunks[n]
		if ch == nil {
			continue
		}
		c0, j0 := physics.ChunkCorner(n)
		for i := range int32(physics.ChunkHexes) {
			if ch.Elevation[i] <= 0 {
				continue
			}
			x, y := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
			if s, ok := k.index(x, y); ok {
				k.land[s] = true
			}
		}
	}
	// A chamfer distance transform: two passes, with the steps to the
	// four and the diagonal neighbours (Borgefors 1986), in metres.
	for i := range k.dist {
		k.dist[i] = math.Inf(1)
		if k.land[i] {
			k.dist[i] = 0
		}
	}
	diag := float64(coarseCell * math.Sqrt2)
	relax := func(i, j int32, d float64) {
		if j >= 0 && j < side*side && k.dist[j]+d < k.dist[i] {
			k.dist[i] = k.dist[j] + d
		}
	}
	for a := range side {
		for b := range side {
			i := a*side + b
			if b > 0 {
				relax(i, i-1, coarseCell)
			}
			if a > 0 {
				relax(i, i-side, coarseCell)
				if b > 0 {
					relax(i, i-side-1, diag)
				}
				if b < side-1 {
					relax(i, i-side+1, diag)
				}
			}
		}
	}
	for a := side - 1; a >= 0; a-- {
		for b := side - 1; b >= 0; b-- {
			i := a*side + b
			if b < side-1 {
				relax(i, i+1, coarseCell)
			}
			if a < side-1 {
				relax(i, i+side, coarseCell)
				if b < side-1 {
					relax(i, i+side+1, diag)
				}
				if b > 0 {
					relax(i, i+side-1, diag)
				}
			}
		}
	}
	return k
}

// index is the square that holds (x, y).
func (k *coarse) index(x, y float64) (int32, bool) {
	a := floor((x + coarseHalf) / coarseCell)
	b := floor((y + coarseHalf) / coarseCell)
	if a < 0 || b < 0 || a >= k.side || b >= k.side {
		return 0, false
	}
	return a*k.side + b, true
}

// clearance is how far (x, y) is sure to be from any land: the distance
// from its square's centre to the nearest square with land, less the
// squares' diagonal. Off the grid there is no land.
func (k *coarse) clearance(x, y float64) float64 {
	s, ok := k.index(x, y)
	if !ok {
		return math.Inf(1)
	}
	return k.dist[s] - float64(coarseCell*math.Sqrt2)
}
