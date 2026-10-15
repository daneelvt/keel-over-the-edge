// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The world's hexagonal lattice: hexagons HexAcross metres across the flats
// with corners pointing east and west, one of them centred on the world's
// centre, named by axial coordinates (q, r) (Red Blob Games, "Hexagonal
// Grids", flat-top orientation). Hexagon (q, r)'s centre is at
//
//	x = 1.5 R q,  y = HexAcross (r + q/2),  R = HexAcross / √3
//
// The sea's tiles are drawn on it, and the land is made of it: every hexagon
// of the world has one height, or one depth.
//
// For storing, a hexagon is also named by its column and row on a grid of
// HexColumns by HexRows: a column is a line of hexagons from south to north,
// and odd columns sit half a hexagon north of even ones. The grid is cut
// into ChunkSide by ChunkSide chunks of ChunkColumns by ChunkRows hexagons,
// numbered row by row from the south-west, each holding a hexagon's values
// column by column.

const (
	// HexAcross is a hexagon's width across its flats, m.
	HexAcross = 4
	// ChunkColumns and ChunkRows are a chunk's size, in hexagons: about
	// 1,053 m by 1,056 m.
	ChunkColumns = 304
	ChunkRows    = 264
	// ChunkHexes is how many hexagons a chunk holds.
	ChunkHexes = ChunkColumns * ChunkRows
	// ChunkSide is how many chunks the grid has on a side, and ChunkCount
	// how many in all.
	ChunkSide  = 16
	ChunkCount = ChunkSide * ChunkSide
	// HexColumns and HexRows are the grid's size: it covers the disk with
	// a margin.
	HexColumns = ChunkSide * ChunkColumns
	HexRows    = ChunkSide * ChunkRows
	// columnZero and rowZero are the column and row of the centre's
	// hexagon.
	columnZero = HexColumns / 2
	rowZero    = HexRows / 2
)

// hexRadius is the distance from a hexagon's centre to a corner, and
// hexStep the distance between the centres of neighbouring columns: as the
// client's drawing computes them.
var (
	hexRadius = HexAcross / math.Sqrt(3)
	hexStep   = float64(1.5 * hexRadius)
)

// HexCentre is where hexagon (q, r)'s centre is, m east and north of the
// world's centre.
func HexCentre(q, r int32) (x, y float64) {
	return float64(hexStep * float64(q)), HexAcross * (float64(r) + float64(q)/2)
}

// HexAt is the hexagon that holds the point (x, y): the one whose centre is
// nearest, which on a hexagonal lattice is the one whose hexagon holds it.
// Only the two columns either side of the point can, and in each only the
// hexagon whose centre is nearest north and south; of the two, the nearer.
// Every operation is rounded exactly, so a point on an edge or a corner goes
// to the same hexagon on every machine: to the western column on a tie, and
// within a column to the northern hexagon.
func HexAt(x, y float64) (q, r int32) {
	q = toInt32(math.Floor(x / hexStep))
	var best float64
	for i := range int32(2) {
		cq := q + i
		half := float64(cq) / 2
		cr := toInt32(math.Floor((y/HexAcross - half) + 0.5))
		dx := x - float64(hexStep*float64(cq))
		dy := y - float64(HexAcross*(float64(cr)+half))
		d := float64(dx*dx) + float64(dy*dy)
		if i == 0 || d < best {
			best, r = d, cr
			if i == 1 {
				q = cq
			}
		}
	}
	return q, r
}

// HexCell is hexagon (q, r)'s column and row on the grid; they may lie
// off it.
func HexCell(q, r int32) (c, j int32) {
	return q + columnZero, r + q>>1 + rowZero
}

// CellHex is the hexagon at column c and row j of the grid.
func CellHex(c, j int32) (q, r int32) {
	q = c - columnZero
	return q, j - rowZero - q>>1
}

// CellCentre is where the centre of the hexagon at column c and row j is.
func CellCentre(c, j int32) (x, y float64) {
	return HexCentre(CellHex(c, j))
}

// ChunkOf is the chunk that holds column c and row j, and the hexagon's
// index in it; ok is false off the grid.
func ChunkOf(c, j int32) (chunk, index int32, ok bool) {
	if c < 0 || j < 0 || c >= HexColumns || j >= HexRows {
		return 0, 0, false
	}
	return (j/ChunkRows)*ChunkSide + c/ChunkColumns, (c%ChunkColumns)*ChunkRows + j%ChunkRows, true
}

// ChunkCorner is the first column and row of a chunk: its south-western
// hexagon.
func ChunkCorner(chunk int32) (c, j int32) {
	return (chunk % ChunkSide) * ChunkColumns, (chunk / ChunkSide) * ChunkRows
}
