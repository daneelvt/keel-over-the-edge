// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The world is cut into square cells, CellSize on a side, so that the boats
// near a place are found without looking at every boat: a uniform grid
// (Ericson, Real-Time Collision Detection, 2005, 7.1). It covers a square of
// GridCells cells on a side centred on the world's centre, wider than the
// disk; a position beyond it falls in the edge cell nearest it.
const (
	CellSize  = 1 << cellShift // m
	GridCells = 264            // on a side: ±8,448 m
	cellShift = 6
)

// CellOf is the column of the grid holding x, or the row holding y: 0 at the
// square's west (south) edge, GridCells − 1 at its east (north). The floor of
// a float and an integer's shift are exact, so every machine puts a boat in
// the same cell; NaN falls in the middle.
func CellOf(v float64) int32 {
	c := toInt32(math.Floor(v))>>cellShift + GridCells/2
	return min(max(c, 0), GridCells-1)
}

// Cell is the index of the grid cell holding position (x, y): its row times
// GridCells plus its column.
func Cell(x, y float64) int32 {
	return CellOf(y)*GridCells + CellOf(x)
}

// SailByte packs what a step's Out says of the sail for drawing it on
// another player's screen, where neither can be told from the state: the
// sailor's flattening in bits 0–3 (0 … 15 for 0 … 1), the foot strip's flow
// in bits 4–5 and the head strip's in bits 6–7 (FlowLuffing … FlowAback).
func SailByte(o *Out) uint8 {
	flat := toInt32(math.Floor(float64(clamp(o.Flattening, 0, 1)*15) + 0.5))
	foot := toInt32(clamp(o.FootFlow, 0, 3))
	head := toInt32(clamp(o.HeadFlow, 0, 3))
	return uint8(flat | foot<<4 | head<<6)
}
