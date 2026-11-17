// SPDX-License-Identifier: AGPL-3.0-only

package status

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/chart"
)

// An island's coast, as the website's map draws it: the outline of its
// model's land, each cell a rectangle about its centre as the chart paints
// it, traced round with the land on its left (outer rings anticlockwise,
// a lake's ring clockwise), its corners cut at the middle of each side,
// simplified to within Grain and rounded to it. A ring that rounds to less
// than three points is left out.
//
// A ring is written in steps of Grain: its first point's east and north,
// then for each point after, how many steps east and north it is from the
// one before. The ring closes back to its first point.

// Grain is what the map's land is rounded to, m.
const Grain = 25

// coastOf is the coast of an island's model, its rings as the map has
// them.
func coastOf(payload []byte) ([][]int, error) {
	h, heights, _, err := chart.ReadModel(payload)
	if err != nil {
		return nil, err
	}
	cols, rows := h.Columns, h.Rows
	land := func(c, r int) bool {
		return c >= 0 && r >= 0 && c < cols && r < rows && heights[r*cols+c] > 0
	}
	// Each side of a land cell with sea beyond it, from corner to corner,
	// the land on its left; corners are (c, r) of the cell north-east of
	// them, on a grid one wider and taller than the cells'.
	out := map[corner][]corner{}
	var starts []corner
	add := func(a, b corner) {
		if len(out[a]) == 0 {
			starts = append(starts, a)
		}
		out[a] = append(out[a], b)
	}
	for r := range rows {
		for c := range cols {
			if !land(c, r) {
				continue
			}
			if !land(c, r-1) { // south side, eastward
				add(corner{c, r}, corner{c + 1, r})
			}
			if !land(c+1, r) { // east side, northward
				add(corner{c + 1, r}, corner{c + 1, r + 1})
			}
			if !land(c, r+1) { // north side, westward
				add(corner{c + 1, r + 1}, corner{c, r + 1})
			}
			if !land(c-1, r) { // west side, southward
				add(corner{c, r + 1}, corner{c, r})
			}
		}
	}
	// Join the sides into rings. Where two pieces of land touch at a
	// corner alone, the ring turns left, keeping the two apart.
	var rings [][]corner
	for _, start := range starts {
		if len(out[start]) == 0 {
			continue
		}
		ring := []corner{start}
		prev, at := start, start
		for {
			bs := out[at]
			k := 0
			if len(bs) > 1 {
				k = leftmost(prev, at, bs)
			}
			next := bs[k]
			out[at] = append(bs[:k], bs[k+1:]...)
			prev, at = at, next
			if at == start {
				break
			}
			ring = append(ring, at)
		}
		rings = append(rings, ring)
	}
	var coast [][]int
	for _, ring := range rings {
		// The middle of each side.
		pts := make([][2]float64, len(ring))
		for i, a := range ring {
			b := ring[(i+1)%len(ring)]
			pts[i] = [2]float64{
				h.X + (float64(a.c+b.c)/2-0.5)*h.DX,
				h.Y + (float64(a.r+b.r)/2-0.5)*h.DY,
			}
		}
		pts = simplify(pts, Grain)
		var flat []int
		for _, p := range pts {
			e, n := roundTo(p[0], Grain), roundTo(p[1], Grain)
			if k := len(flat); k >= 2 && flat[k-2] == e && flat[k-1] == n {
				continue
			}
			flat = append(flat, e, n)
		}
		if k := len(flat); k >= 4 && flat[0] == flat[k-2] && flat[1] == flat[k-1] {
			flat = flat[:k-2]
		}
		if len(flat) < 6 {
			continue
		}
		// In steps, each point from the one before.
		steps := make([]int, len(flat))
		for k := range flat {
			steps[k] = flat[k] / Grain
			if k >= 2 {
				steps[k] = (flat[k] - flat[k-2]) / Grain
			}
		}
		coast = append(coast, steps)
	}
	return coast, nil
}

// corner is a corner of the model's cells: (c, r) is the cell north-east
// of it.
type corner struct{ c, r int }

// leftmost is which of the ways on from at turns most to the left, coming
// from prev.
func leftmost(prev, at corner, ways []corner) int {
	dc, dr := at.c-prev.c, at.r-prev.r
	best, k := -2, 0
	for i, w := range ways {
		ec, er := w.c-at.c, w.r-at.r
		// Left is +1, straight 0, right −1.
		turn := dc*er - dr*ec
		if turn > best {
			best, k = turn, i
		}
	}
	return k
}

// simplify is a closed ring with points nearer than tol to the line
// through their neighbours left out (Douglas and Peucker's), split at its
// first point and the point furthest from it.
func simplify(ring [][2]float64, tol float64) [][2]float64 {
	n := len(ring)
	if n < 4 {
		return ring
	}
	far, d := 0, -1.0
	for i, p := range ring {
		if q := sq(p[0]-ring[0][0]) + sq(p[1]-ring[0][1]); q > d {
			far, d = i, q
		}
	}
	keep := make([]bool, n)
	keep[0], keep[far] = true, true
	line := append(append([][2]float64{}, ring...), ring[0])
	mark(line, 0, far, tol, keep)
	mark(line, far, n, tol, keep)
	var out [][2]float64
	for i, p := range ring {
		if keep[i] {
			out = append(out, p)
		}
	}
	return out
}

// mark keeps the points of line between a and b that the line from a to
// b passes further than tol from.
func mark(line [][2]float64, a, b int, tol float64, keep []bool) {
	if b-a < 2 {
		return
	}
	ax, ay := line[a][0], line[a][1]
	bx, by := line[b][0], line[b][1]
	dx, dy := bx-ax, by-ay
	l := math.Sqrt(dx*dx + dy*dy)
	far, d := -1, tol
	for i := a + 1; i < b; i++ {
		px, py := line[i][0]-ax, line[i][1]-ay
		var q float64
		if l == 0 {
			q = math.Sqrt(px*px + py*py)
		} else {
			q = math.Abs(px*dy-py*dx) / l
		}
		if q > d {
			far, d = i, q
		}
	}
	if far < 0 {
		return
	}
	keep[far] = true
	mark(line, a, far, tol, keep)
	mark(line, far, b, tol, keep)
}

func sq(v float64) float64 { return v * v }

// roundTo is v rounded to the nearest step.
func roundTo(v float64, step int) int {
	return int(math.Round(v/float64(step))) * step
}
