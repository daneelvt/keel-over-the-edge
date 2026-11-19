// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The way a course sails: the shortest on the coarse grid, through squares
// clear of land and of water too shallow for the deepest boat by a margin,
// never into the mist nor into a port, by A* with eight neighbours and
// whole-number costs, so that every machine finds the same way. A course
// that rounds an island has a cut, a half-line from the island's centre
// away from the course, which its way must cross once and the right way
// round: the shortest way that does goes round the island once, leaving it
// to its side. The way found is pulled taut, square to square, wherever a
// straight line between them stays clear and crosses the cuts as the way
// did.

// wayGrid is the world on the coarse grid as the courses sail it.
type wayGrid struct {
	side int32
	// high is each square's shallowest hexagon, dm.
	high []int16
	// dist is how far each square is from the nearest square too shallow
	// for the deepest boat, and areaDist for the deepest that races in the
	// areas, m; blocked those a way may not enter.
	dist, areaDist []float64
	blocked        []bool
}

// squareSlack is how much nearer a square's hexagons may be to a shoal
// square's than their centres are: half a square's diagonal, m.
const squareSlack = coarseCell * math.Sqrt2 / 2

// newWayGrid makes the grid: shoal, for the courses, every square holding a
// hexagon above deep dm, and for the areas above areaDeep dm; blocked every
// square within the courses' margin of a shoal one, beyond the mist's limit
// or in a town's harbour.
func newWayGrid(g *physics.Ground, c *config, towns []Town, deep, areaDeep int16) *wayGrid {
	side := int32(2 * coarseHalf / coarseCell)
	w := &wayGrid{side: side, high: make([]int16, side*side)}
	for i := range w.high {
		w.high[i] = math.MinInt16
	}
	for n := range int32(physics.ChunkCount) {
		ch := g.Chunks[n]
		if ch == nil {
			continue
		}
		c0, j0 := physics.ChunkCorner(n)
		for i := range int32(physics.ChunkHexes) {
			x, y := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
			if s, ok := w.index(x, y); ok && ch.Elevation[i] > w.high[s] {
				w.high[s] = ch.Elevation[i]
			}
		}
	}
	shoal := make([]bool, len(w.high))
	areaShoal := make([]bool, len(w.high))
	for i, h := range w.high {
		shoal[i], areaShoal[i] = h > deep, h > areaDeep
	}
	w.dist, w.areaDist = chamfer(side, shoal), chamfer(side, areaShoal)
	w.blocked = make([]bool, len(w.high))
	mist := float64(c.courses.Mist * nauticalMile)
	for i := range w.blocked {
		x, y := w.centre(int32(i))
		w.blocked[i] = w.dist[i] < c.courses.Margin+squareSlack || hypot(x, y) > mist
	}
	for t := range towns {
		for _, d := range towns[t].Harbour {
			a0, b0 := w.cell(d.X-d.R, d.Y-d.R)
			a1, b1 := w.cell(d.X+d.R, d.Y+d.R)
			for a := max(a0, 0); a <= min(a1, side-1); a++ {
				for b := max(b0, 0); b <= min(b1, side-1); b++ {
					if x, y := w.centre(a*side + b); hypot(x-d.X, y-d.Y) <= d.R+squareSlack {
						w.blocked[a*side+b] = true
					}
				}
			}
		}
	}
	return w
}

// chamfer is each square's distance from the nearest seed square, m: a
// chamfer distance transform in two passes (Borgefors 1986), as the coarse
// grid's.
func chamfer(side int32, seed []bool) []float64 {
	dist := make([]float64, side*side)
	for i := range dist {
		dist[i] = math.Inf(1)
		if seed[i] {
			dist[i] = 0
		}
	}
	diag := float64(coarseCell * math.Sqrt2)
	relax := func(i, j int32, d float64) {
		if j >= 0 && j < side*side && dist[j]+d < dist[i] {
			dist[i] = dist[j] + d
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
	return dist
}

// cell is the column and row of the square holding (x, y), maybe off the
// grid.
func (w *wayGrid) cell(x, y float64) (int32, int32) {
	return floor((x + coarseHalf) / coarseCell), floor((y + coarseHalf) / coarseCell)
}

// index is the square holding (x, y).
func (w *wayGrid) index(x, y float64) (int32, bool) {
	a, b := w.cell(x, y)
	if a < 0 || b < 0 || a >= w.side || b >= w.side {
		return 0, false
	}
	return a*w.side + b, true
}

// centre is square i's centre.
func (w *wayGrid) centre(i int32) (float64, float64) {
	a, b := i/w.side, i%w.side
	return float64(float64(a)*coarseCell) - coarseHalf + coarseCell/2, float64(float64(b)*coarseCell) - coarseHalf + coarseCell/2
}

// free reports whether a way may pass (x, y).
func (w *wayGrid) free(x, y float64) bool {
	i, ok := w.index(x, y)
	return ok && !w.blocked[i]
}

// clearance is how far (x, y) is sure to be from water too shallow for
// the deepest boat, m; areaClearance for the deepest that races in the
// areas.
func (w *wayGrid) clearance(x, y float64) float64 {
	i, ok := w.index(x, y)
	if !ok {
		return 0
	}
	return w.dist[i] - squareSlack
}

func (w *wayGrid) areaClearance(x, y float64) float64 {
	i, ok := w.index(x, y)
	if !ok {
		return 0
	}
	return w.areaDist[i] - squareSlack
}

// leastDepth is the least depth of the squares within r of (x, y), m.
func (w *wayGrid) leastDepth(x, y, r float64) float64 {
	a0, b0 := w.cell(x-r, y-r)
	a1, b1 := w.cell(x+r, y+r)
	high := int16(math.MinInt16)
	for a := max(a0, 0); a <= min(a1, w.side-1); a++ {
		for b := max(b0, 0); b <= min(b1, w.side-1); b++ {
			i := a*w.side + b
			if cx, cy := w.centre(i); hypot(cx-x, cy-y) <= r {
				high = max(high, w.high[i])
			}
		}
	}
	if high == math.MinInt16 {
		return 0
	}
	return -float64(high) / 10
}

// cutRay is a cut: a half-line from (x, y) toward the bearing whose sine
// and cosine are s and c, which a way must cross once: clockwise about
// its start for want +1, anticlockwise for −1, either way for 0.
type cutRay struct {
	x, y, s, c float64
	want       int8
}

// across is how far (px, py) lies to the anticlockwise side of the line of
// the ray, m: positive before a clockwise sweep about its start reaches the
// ray, negative after. along is how far along the ray's line it lies.
func (r *cutRay) across(px, py float64) float64 {
	return float64(r.s*(py-r.y)) - float64(r.c*(px-r.x))
}

func (r *cutRay) along(px, py float64) float64 {
	return float64(r.s*(px-r.x)) + float64(r.c*(py-r.y))
}

// crossing is how segment (ax, ay)–(bx, by) crosses the ray: +1 clockwise
// about its start, −1 anticlockwise, 0 not at all; and where along the
// segment, as a share of it.
func (r *cutRay) crossing(ax, ay, bx, by float64) (int8, float64) {
	pa, pb := r.across(ax, ay), r.across(bx, by)
	if (pa >= 0) == (pb >= 0) {
		return 0, 0
	}
	t := pa / (pa - pb)
	x, y := ax+float64(t*(bx-ax)), ay+float64(t*(by-ay))
	if !(r.along(x, y) > 0) {
		return 0, 0
	}
	if pa >= 0 {
		return 1, t
	}
	return -1, t
}

// wayNode is a state of the search on the heap: its cost so far and its
// estimate in all, in tenths of a square's side.
type wayNode struct {
	f, g, s int32
}

// wayHeap is the search's open states, the least estimate first, then the
// furthest gone, then the lowest state.
type wayHeap []wayNode

func (h wayHeap) less(i, j int) bool {
	if h[i].f != h[j].f {
		return h[i].f < h[j].f
	}
	if h[i].g != h[j].g {
		return h[i].g > h[j].g
	}
	return h[i].s < h[j].s
}

func (h *wayHeap) push(n wayNode) {
	*h = append(*h, n)
	i := len(*h) - 1
	for i > 0 {
		p := (i - 1) / 2
		if !h.less(i, p) {
			break
		}
		(*h)[i], (*h)[p] = (*h)[p], (*h)[i]
		i = p
	}
}

func (h *wayHeap) pop() wayNode {
	old := *h
	top := old[0]
	last := len(old) - 1
	old[0] = old[last]
	*h = old[:last]
	i := 0
	for {
		l, r, m := 2*i+1, 2*i+2, i
		if l < last && h.less(l, m) {
			m = l
		}
		if r < last && h.less(r, m) {
			m = r
		}
		if m == i {
			break
		}
		(*h)[i], (*h)[m] = (*h)[m], (*h)[i]
		i = m
	}
	return top
}

// The steps' costs: a side and a diagonal, in tenths of a square's side.
const (
	stepSide = 10
	stepDiag = 14
)

// way is the shortest way from (fx, fy) to (tx, ty) crossing each cut
// once its way round, searched within box (west, south, east, north, m):
// the squares' centres, the first and last the ends themselves; nil if
// there is none.
func (w *wayGrid) way(fx, fy, tx, ty float64, cuts []cutRay, box [4]float64) [][2]float64 {
	a0, b0 := w.cell(box[0], box[1])
	a1, b1 := w.cell(box[2], box[3])
	a0, b0, a1, b1 = max(a0, 0), max(b0, 0), min(a1, w.side-1), min(b1, w.side-1)
	if a1 < a0 || b1 < b0 {
		return nil
	}
	cols, rows := a1-a0+1, b1-b0+1
	cells := cols * rows
	layers := int32(1) << len(cuts)
	full := layers - 1
	local := func(a, b int32) int32 { return (a-a0)*rows + (b - b0) }
	fa, fb := w.cell(fx, fy)
	ta, tb := w.cell(tx, ty)
	in := func(a, b int32) bool { return a >= a0 && a <= a1 && b >= b0 && b <= b1 }
	if !in(fa, fb) || !in(ta, tb) || w.blocked[fa*w.side+fb] || w.blocked[ta*w.side+tb] {
		return nil
	}
	// Each square's side of each cut, and whether it lies ahead of the
	// cut's start.
	var sides, ahead []uint8
	if len(cuts) > 0 {
		sides, ahead = make([]uint8, cells), make([]uint8, cells)
		for a := a0; a <= a1; a++ {
			for b := b0; b <= b1; b++ {
				x, y := w.centre(a*w.side + b)
				l := local(a, b)
				for k := range cuts {
					if cuts[k].across(x, y) >= 0 {
						sides[l] |= 1 << k
					}
					if cuts[k].along(x, y) > 0 {
						ahead[l] |= 1 << k
					}
				}
			}
		}
	}
	g := make([]int32, cells*layers)
	from := make([]int32, cells*layers)
	for i := range g {
		g[i] = math.MaxInt32
	}
	estimate := func(a, b int32) int32 {
		da, db := a-ta, b-tb
		da, db = max(da, -da), max(db, -db)
		return stepSide*max(da, db) + (stepDiag-stepSide)*min(da, db)
	}
	start := local(fa, fb) * layers
	g[start], from[start] = 0, -1
	open := wayHeap{{f: estimate(fa, fb), g: 0, s: start}}
	goal := int32(-1)
	steps := [8][3]int32{{1, 0, stepSide}, {-1, 0, stepSide}, {0, 1, stepSide}, {0, -1, stepSide},
		{1, 1, stepDiag}, {1, -1, stepDiag}, {-1, 1, stepDiag}, {-1, -1, stepDiag}}
	for len(open) > 0 {
		n := open.pop()
		if n.g != g[n.s] {
			continue
		}
		l, mask := n.s/layers, n.s%layers
		a, b := a0+l/rows, b0+l%rows
		if a == ta && b == tb && mask == full {
			goal = n.s
			break
		}
		for _, st := range steps {
			na, nb := a+st[0], b+st[1]
			if !in(na, nb) || w.blocked[na*w.side+nb] {
				continue
			}
			if st[0] != 0 && st[1] != 0 && (w.blocked[na*w.side+b] || w.blocked[a*w.side+nb]) {
				continue // no cutting a corner of land
			}
			nl := local(na, nb)
			nmask, ok := mask, true
			for k := range cuts {
				bit := uint8(1) << k
				if sides[l]&bit == sides[nl]&bit || ahead[l]&bit == 0 || ahead[nl]&bit == 0 {
					continue
				}
				dir := int8(-1)
				if sides[l]&bit != 0 {
					dir = 1
				}
				if nmask&(1<<k) != 0 || cuts[k].want != 0 && cuts[k].want != dir {
					ok = false
					break
				}
				nmask |= 1 << k
			}
			if !ok {
				continue
			}
			ns := nl*layers + nmask
			ng := n.g + st[2]
			if ng < g[ns] {
				g[ns], from[ns] = ng, n.s
				open.push(wayNode{f: ng + estimate(na, nb), g: ng, s: ns})
			}
		}
	}
	if goal < 0 {
		return nil
	}
	var path [][2]float64
	for s := goal; s >= 0; s = from[s] {
		l := s / layers
		x, y := w.centre((a0+l/rows)*w.side + b0 + l%rows)
		path = append(path, [2]float64{x, y})
	}
	slices.Reverse(path)
	path[0], path[len(path)-1] = [2]float64{fx, fy}, [2]float64{tx, ty}
	return w.taut(path, cuts)
}

// tautLook is how many squares past the last clear one a straight line is
// tried before the way is pulled no further.
const tautLook = 6

// taut is a way pulled taut: from each point, straight to the furthest
// point after it a clear line reaches that crosses the cuts as the way
// between them does.
func (w *wayGrid) taut(path [][2]float64, cuts []cutRay) [][2]float64 {
	if len(path) < 3 {
		return path
	}
	// Each step's crossings of each cut, summed from the start.
	sums := make([][]int32, len(path))
	sums[0] = make([]int32, len(cuts))
	for i := 1; i < len(path); i++ {
		sums[i] = slices.Clone(sums[i-1])
		for k := range cuts {
			d, _ := cuts[k].crossing(path[i-1][0], path[i-1][1], path[i][0], path[i][1])
			sums[i][k] += int32(d)
		}
	}
	out := [][2]float64{path[0]}
	i := 0
	for i < len(path)-1 {
		next := i + 1
		misses := 0
		for j := i + 2; j < len(path) && misses <= tautLook; j++ {
			if w.clearLine(path[i], path[j]) && crossesAs(cuts, path[i], path[j], sums[i], sums[j]) {
				next, misses = j, 0
			} else {
				misses++
			}
		}
		out = append(out, path[next])
		i = next
	}
	return out
}

// clearLine reports whether every point of the line from p to q, every
// quarter of a square's side, is free.
func (w *wayGrid) clearLine(p, q [2]float64) bool {
	d := hypot(q[0]-p[0], q[1]-p[1])
	n := toInt32(d/(coarseCell/4)) + 1
	for k := int32(1); k < n; k++ {
		f := float64(k) / float64(n)
		if !w.free(p[0]+float64(f*(q[0]-p[0])), p[1]+float64(f*(q[1]-p[1]))) {
			return false
		}
	}
	return true
}

// crossesAs reports whether the line from p to q crosses each cut as the
// way between them does, whose sums from the start are at p and at q.
func crossesAs(cuts []cutRay, p, q [2]float64, at, to []int32) bool {
	for k := range cuts {
		d, _ := cuts[k].crossing(p[0], p[1], q[0], q[1])
		if int32(d) != to[k]-at[k] {
			return false
		}
	}
	return true
}

// wayLength is a way's length, m.
func wayLength(way [][2]float64) float64 {
	var l float64
	for i := 1; i < len(way); i++ {
		l += hypot(way[i][0]-way[i-1][0], way[i][1]-way[i-1][1])
	}
	return l
}

// crossings is how a way crosses a ray: its crossings clockwise about the
// ray's start less those anticlockwise, and how far along the way the
// first crossing the way the net one goes lies, m.
func crossings(r *cutRay, way [][2]float64) (int32, float64) {
	type hit struct {
		dir   int8
		along float64
	}
	var hits []hit
	var net int32
	var gone float64
	for i := 1; i < len(way); i++ {
		p, q := way[i-1], way[i]
		seg := hypot(q[0]-p[0], q[1]-p[1])
		if d, t := r.crossing(p[0], p[1], q[0], q[1]); d != 0 {
			hits = append(hits, hit{d, gone + float64(t*seg)})
			net += int32(d)
		}
		gone += seg
	}
	for _, h := range hits {
		if net > 0 && h.dir > 0 || net < 0 && h.dir < 0 {
			return net, h.along
		}
	}
	return net, 0
}

// width is the narrows' width across a way at (x, y), heading h: the water
// clear of shoal squares either side, square to the way, at most most m.
func (w *wayGrid) width(x, y, h, most float64) float64 {
	s, c := sincos(h)
	var total float64
	for _, side := range [2]float64{1, -1} {
		// Square to the way: (c, −s) to starboard, (−c, s) to port.
		dx, dy := float64(side*c), float64(-side*s)
		d := 0.0
		for d < most {
			nd := d + coarseCell/2
			i, ok := w.index(x+float64(nd*dx), y+float64(nd*dy))
			if !ok || w.dist[i] == 0 {
				break
			}
			d = nd
		}
		total += min(d, most)
	}
	return min(total, most)
}
