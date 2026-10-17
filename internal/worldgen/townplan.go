// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"container/heap"
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The plan's ways: the quay, the contour streets and the lanes, and the
// buildings along them.

// quay makes the town's quay: the land within the quay street's width of
// its water over the share of its arc given, a quay's height, of dressed
// stone, within m of the town's site; and its water's foot dredged to foot
// m. Returns its edge along the water, in order, in stretches.
func (tw *townWork) quay(share, foot, within float64, seaward bool) [][][2]float64 {
	c := tw.c
	t := &tw.g
	wf := &c.towns.Waterfront
	height := int16(round(float64(wf.Quay * 10)))
	width := c.towns.Plan.Quay + 2
	var nb [6]int32
	var edge []int32
	for i := range t.w * t.h {
		if t.elev[i] <= 0 || tw.use[i] != useFree || tw.shore[i] > width {
			continue
		}
		x, y := t.centre(i)
		if !tw.inArc(x, y, share) || hypot(x-tw.sx, y-tw.sy) > within {
			continue
		}
		// Only on the shore that faces the town's water: its nearest
		// water nearer the town's origin than it is.
		if w := tw.near[i]; w >= 0 && seaward {
			wx, wy := t.centre(w)
			if hypot(wx-tw.ox, wy-tw.oy) > hypot(x-tw.ox, y-tw.oy) {
				continue
			}
		}
		t.elev[i], t.surf[i], tw.use[i] = height, c.townSurface.quay, useQuay
		k := t.neighbours(i, &nb)
		onEdge := false
		for _, j := range nb[:k] {
			if tw.water[j] {
				onEdge = true
				t.elev[j] = min(t.elev[j], -int16(round(float64(foot*10))))
			}
		}
		if onEdge {
			edge = append(edge, i)
		}
	}
	lines := tw.polyline(edge)
	for _, l := range lines {
		for k := range l {
			l[k] = [2]float64{round1(l[k][0]), round1(l[k][1])}
		}
	}
	return lines
}

// longest is the longest of the lines, or none.
func longest(lines [][][2]float64) [][2]float64 {
	var out [][2]float64
	for _, l := range lines {
		if len(l) > len(out) {
			out = l
		}
	}
	return out
}

func cmpAsc(a, b float64) int { return -cmpDesc(a, b) }

// polyline makes a way's points from its hexagons: chained from the one
// furthest round the town's arc to the nearest not yet taken, a new line
// where none is near; each line's points averaged in threes, so that a
// way two hexagons wide runs down its middle.
func (tw *townWork) polyline(hexes []int32) [][][2]float64 {
	type pt struct{ off, x, y float64 }
	pts := make([]pt, 0, len(hexes))
	for _, i := range hexes {
		x, y := tw.g.centre(i)
		_, off := tw.bearing(x, y)
		pts = append(pts, pt{off, x, y})
	}
	slices.SortFunc(pts, func(a, b pt) int { return cmpAsc(a.off, b.off) })
	taken := make([]bool, len(pts))
	var lines [][][2]float64
	for start := range pts {
		if taken[start] {
			continue
		}
		taken[start] = true
		line := [][2]float64{{pts[start].x, pts[start].y}}
		at := start
		for {
			next, far := -1, 6.0
			for k := range pts {
				if taken[k] {
					continue
				}
				if d := hypot(pts[k].x-pts[at].x, pts[k].y-pts[at].y); d < far {
					next, far = k, d
				}
			}
			if next < 0 {
				break
			}
			taken[next] = true
			// Its band's other hexagons beside it are taken with it.
			for k := range pts {
				if !taken[k] && hypot(pts[k].x-pts[next].x, pts[k].y-pts[next].y) < 4.5 &&
					hypot(pts[k].x-pts[at].x, pts[k].y-pts[at].y) < far+0.5 {
					taken[k] = true
				}
			}
			line = append(line, [2]float64{pts[next].x, pts[next].y})
			at = next
		}
		if len(line) > 2 {
			lines = append(lines, smoothLine(smoothLine(line)))
		}
	}
	return lines
}

// contours lays out up to most contour streets behind the quay, each
// apart m further from the water than the last, wandering, the arc
// narrowing as they climb; and returns the hexagons of the last.
func (tw *townWork) contours(most int, from float64) []int32 {
	c := tw.c
	p := &c.towns.Plan
	t := &tw.g
	d := from
	var last []int32
	for k := 1; k <= most; k++ {
		d += tw.s.in(p.Apart[0], p.Apart[1])
		if d > tw.reach {
			break
		}
		f1, f2 := tw.s.in(1.5, 3), tw.s.in(4, 7)
		p1, p2 := tw.s.angle(), tw.s.angle()
		share := 1 - float64(0.08*float64(k))
		var hexes []int32
		for i := range t.w * t.h {
			if t.elev[i] <= 0 || tw.use[i] != useFree {
				continue
			}
			x, y := t.centre(i)
			_, off := tw.bearing(x, y)
			if math.Abs(off) > float64(tw.half*share) {
				continue
			}
			wander := float64(p.Wander * (float64(0.6*physics.Sin(float64(f1*off)+p1)) + float64(0.4*physics.Sin(float64(f2*off)+p2))))
			if math.Abs(tw.shore[i]-(d+wander)) <= p.Street/2+0.6 {
				hexes = append(hexes, i)
			}
		}
		if len(hexes) < 6 {
			break
		}
		for _, i := range hexes {
			tw.use[i], t.surf[i] = useStreet, c.townSurface.street
		}
		for _, line := range tw.polyline(hexes) {
			tw.ways = append(tw.ways, way{pts: line, width: p.Street, sides: 3, rank: d})
		}
		last = hexes
	}
	return last
}

// pathNode is a hexagon reached, with the direction it was reached in.
type pathNode struct {
	cost float64
	at   int32 // hexagon × 6 + direction
}

type pathHeap []pathNode

func (h pathHeap) Len() int { return len(h) }
func (h pathHeap) Less(a, b int) bool {
	if h[a].cost != h[b].cost {
		return h[a].cost < h[b].cost
	}
	return h[a].at < h[b].at
}
func (h pathHeap) Swap(a, b int) { h[a], h[b] = h[b], h[a] }
func (h *pathHeap) Push(x any)   { *h = append(*h, x.(pathNode)) }
func (h *pathHeap) Pop() any {
	old := *h
	n := old[len(old)-1]
	*h = old[:len(old)-1]
	return n
}

// path is the least-cost way over the town's land from hexagon from to any
// hexagon of to, as Galin and others make a road: each step's cost its
// length, more the steeper it climbs past 1 in steep, more for each turn,
// and a street already made at reuse of it; water and buildings are not
// crossed. nil if none.
func (tw *townWork) path(from int32, to map[int32]bool, crossable func(i int32) bool) []int32 {
	c := tw.c
	p := &c.towns.Plan
	t := &tw.g
	total := t.w * t.h
	cost := make([]float64, total*6)
	for i := range cost {
		cost[i] = math.Inf(1)
	}
	prev := make([]int32, total*6)
	h := &pathHeap{}
	for d := range int32(6) {
		cost[from*6+d] = 0
		prev[from*6+d] = -1
		heap.Push(h, pathNode{0, from*6 + d})
	}
	var nb [6]int32
	end := int32(-1)
	for h.Len() > 0 {
		n := heap.Pop(h).(pathNode)
		if n.cost > cost[n.at] {
			continue
		}
		i, dir := n.at/6, n.at%6
		if to[i] && i != from {
			end = n.at
			break
		}
		k := t.neighbours(i, &nb)
		for e, j := range nb[:k] {
			if !crossable(j) {
				continue
			}
			rise := math.Abs(float64(t.elev[j]-t.elev[i])) / 10
			grade := rise / physics.HexAcross
			step := float64(physics.HexAcross)
			if over := float64(grade * p.Steep); over > 1 {
				step = float64(step * float64(over*over))
			}
			nd := int32(e)
			if turns := min((nd-dir+6)%6, (dir-nd+6)%6); turns > 0 && prev[n.at] >= 0 {
				step += float64(float64(turns) * float64(p.Turn*physics.HexAcross))
			}
			if tw.use[j] == useStreet || tw.use[j] == useQuay || tw.use[j] == useSquare {
				step = float64(step * p.Reuse)
			}
			at := j*6 + nd
			if nc := n.cost + step; nc < cost[at] {
				cost[at], prev[at] = nc, n.at
				heap.Push(h, pathNode{nc, at})
			}
		}
	}
	if end < 0 {
		return nil
	}
	var out []int32
	for at := end; at >= 0; at = prev[at] {
		out = append(out, at/6)
	}
	slices.Reverse(out)
	return out
}

// lanes lays out lanes up the slope from the quay, every so far along it,
// to the top street; and from the square's back. Each is a way.
func (tw *townWork) lanes(starts [][2]float64, top []int32) {
	c := tw.c
	p := &c.towns.Plan
	if len(top) == 0 {
		return
	}
	to := map[int32]bool{}
	for _, i := range top {
		to[i] = true
	}
	crossable := func(i int32) bool {
		u := tw.use[i]
		return tw.g.elev[i] > 0 && (u == useFree || u == useStreet || u == useQuay || u == useSquare || u == useGarden)
	}
	for _, st := range starts {
		from := tw.at(st[0], st[1])
		if from < 0 {
			continue
		}
		route := tw.path(from, to, crossable)
		if len(route) < 3 {
			continue
		}
		var pts [][2]float64
		for _, i := range route {
			if tw.use[i] == useFree || tw.use[i] == useGarden {
				tw.use[i], tw.g.surf[i] = useStreet, c.townSurface.street
			}
			x, y := tw.g.centre(i)
			pts = append(pts, [2]float64{x, y})
		}
		tw.ways = append(tw.ways, way{pts: smoothLine(pts), width: p.Lane, sides: 3, rank: tw.shore[from] + 1000})
	}
}

// smoothLine averages each point with its neighbours, so that a way over
// hexagons runs straight where it runs straight.
func smoothLine(pts [][2]float64) [][2]float64 {
	out := make([][2]float64, len(pts))
	for k := range pts {
		a, b := max(k-1, 0), min(k+1, len(pts)-1)
		out[k] = [2]float64{(pts[a][0] + pts[k][0] + pts[b][0]) / 3, (pts[a][1] + pts[k][1] + pts[b][1]) / 3}
	}
	return out
}

// along walks a way's points, calling f at every step m of its length with
// the point there and the bearing it runs; until f returns false.
func along(pts [][2]float64, step float64, f func(x, y, bearing float64) bool) {
	for k := 0; k+1 < len(pts); k++ {
		ax, ay := pts[k][0], pts[k][1]
		bx, by := pts[k+1][0], pts[k+1][1]
		seg := hypot(bx-ax, by-ay)
		if !(seg > 0) {
			continue
		}
		b := physics.Atan2(bx-ax, by-ay)
		for t := 0.0; t < seg; t += step {
			u := t / seg
			if !f(lerp(u, ax, bx), lerp(u, ay, by), b) {
				return
			}
		}
	}
}

// fillWay puts buildings along a way, on the sides it has, each facing it,
// set back, turned a little, gaps between them, one place in so many left
// as a garden; chosen by pick. It stops when the town has its buildings.
func (tw *townWork) fillWay(w *way, pick func(x, y float64) *buildingKind) {
	c := tw.c
	p := &c.towns.Plan
	for side := range 2 {
		if w.sides&(1<<side) == 0 {
			continue
		}
		sign := 1.0
		if side == 1 {
			sign = -1
		}
		next := 0.0
		walked := 0.0
		along(w.pts, 1, func(x, y, b float64) bool {
			walked++
			if tw.count >= tw.target {
				return false
			}
			if walked < next {
				return true
			}
			// Its way's normal toward this side: on the quay, inland only.
			nb := b + float64(sign*(math.Pi/2))
			sn, cn := sincos(nb)
			if w.quay && math.Abs(angleBetween(nb, physics.Atan2(x-tw.ox, y-tw.oy))) > math.Pi/2 {
				return true
			}
			if tw.s.r.IntN(max(p.Gardens, 1)) == 0 {
				// A garden: a plot left to grow.
				gx, gy := x+float64((w.width/2+3)*sn), y+float64((w.width/2+3)*cn)
				for _, i := range tw.footprint(gx, gy, nb, 6, 5, 0) {
					if tw.use[i] == useFree && tw.g.elev[i] > 0 {
						tw.use[i], tw.g.surf[i] = useGarden, c.townSurface.yard
					}
				}
				next = walked + 7
				return true
			}
			k := pick(x, y)
			if k == nil {
				next = walked + 3
				return true
			}
			f, d := tw.size(k)
			back := tw.s.in(p.SetBack[0], p.SetBack[1])
			turn := float64(tw.s.in(-p.Angle, p.Angle) * degree)
			// Its front's middle, set back from the way's edge, facing
			// the way.
			sb, cb := sincos(b)
			fx := x + float64((w.width/2+back)*sn) + float64(f/2*sb)
			fy := y + float64((w.width/2+back)*cn) + float64(f/2*cb)
			sh, ch := sincos(nb + math.Pi)
			cx, cy := fx-float64(d/2*sh), fy-float64(d/2*ch)
			// Facing the way: the nearest of it before its front.
			wx, wy := tw.nearestWay(fx, fy, x+float64(f/2*sb), y+float64(f/2*cb))
			h := physics.Atan2(wx-cx, wy-cy) + turn
			if tw.placeAt(k, cx, cy, h, f, d) {
				next = walked + f + tw.s.in(p.Gaps[0], p.Gaps[1])
			} else {
				next = walked + 2
			}
			return true
		})
	}
}

// placeAt adds a building of kind k with its middle at (x, y) facing h, if
// its plot is free land gentle enough and clear of the others.
func (tw *townWork) placeAt(k *buildingKind, x, y, h, frontage, depth float64) bool {
	x, y, h, frontage, depth = quantise(x, y, h, frontage, depth)
	plot := tw.footprint(x, y, h, frontage, depth, 0.5)
	if !tw.free(plot) || !tw.slopeOK(plot, max(frontage, depth)) {
		return false
	}
	for _, i := range tw.footprint(x, y, h, frontage, depth, 1.5) {
		if tw.use[i] == useBuilding || tw.use[i] == useTower {
			return false
		}
	}
	tw.add(k, x, y, h, frontage, depth, plot)
	return true
}

// filler picks a building to fill a street at (x, y): by the kinds'
// weights, the larger nearer the water (Emilien and others' water and
// accessibility).
func (tw *townWork) filler(x, y float64) *buildingKind {
	c := tw.c
	near := 0.5
	if i := tw.at(x, y); i >= 0 {
		near = clamp(1-tw.shore[i]/max(tw.reach, 1), 0, 1)
	}
	var kinds []*buildingKind
	var weights []float64
	for i := range c.buildings {
		k := &c.buildings[i]
		if k.prop || k.fill <= 0 || k.stands != catalog.StandsStreet {
			continue
		}
		// The more storeys a kind has, the nearer the water it stands.
		w := k.fill
		if k.storeys[0] > 1 {
			w = float64(w * (0.3 + float64(1.7*near)))
		} else {
			w = float64(w * (1.3 - float64(0.6*near)))
		}
		kinds = append(kinds, k)
		weights = append(weights, w)
	}
	if i := tw.s.weighted(weights); i >= 0 {
		return kinds[i]
	}
	return nil
}

// levelWays eases every street's and lane's ground along it and levels it
// to the land's terraces: each hexagon the mean of its own and its
// neighbours' on the way, twice, then to the nearest terrace.
func (tw *townWork) levelWays() {
	t := &tw.g
	var nb [6]int32
	for range 2 {
		next := slices.Clone(t.elev)
		for i := range t.w * t.h {
			if tw.use[i] != useStreet {
				continue
			}
			sum, n := float64(t.elev[i]), 1.0
			k := t.neighbours(i, &nb)
			for _, j := range nb[:k] {
				if tw.use[j] == useStreet || tw.use[j] == useQuay || tw.use[j] == useSquare {
					sum += float64(t.elev[j])
					n++
				}
			}
			next[i] = int16(round(sum / n))
		}
		t.elev = next
	}
	for i := range t.w * t.h {
		if u := tw.use[i]; u == useStreet || u == useGarden || u == usePath {
			t.elev[i] = tw.c.terrace(float64(t.elev[i]))
		}
	}
}

// pier lays a pier, a jetty or a mole from (x, y) out along axis k, length
// m long and width m wide: its water a quay's height, of planking. It
// stops at land beyond its first stretch of water. Returns its record.
func (tw *townWork) pier(x, y float64, k int, length, width float64, surface uint8) Pier {
	c := tw.c
	height := int16(round(float64(c.towns.Waterfront.Quay * 10)))
	a := latticeAxes[k]
	sa, ca := sincos(a)
	wet := false
	laid := 0.0
	for t := 0.0; t <= length; t += physics.HexAcross / 2 {
		cx, cy := x+float64(t*sa), y+float64(t*ca)
		i := tw.at(cx, cy)
		if i < 0 {
			break
		}
		if tw.g.elev[i] > 0 && tw.use[i] != usePier && wet {
			break // land again
		}
		if tw.g.elev[i] <= 0 {
			wet = true
		}
		for o := -width / 2; o <= width/2; o += physics.HexAcross / 2 {
			px, py := cx+float64(o*ca), cy-float64(o*sa)
			j := tw.at(px, py)
			if j < 0 || tw.g.elev[j] > 0 {
				continue
			}
			tw.g.elev[j], tw.g.surf[j], tw.use[j] = height, surface, usePier
		}
		laid = t
	}
	return Pier{X: round1(x), Y: round1(y), Heading: round3(a), Length: round1(laid), Width: width}
}

// reachDepth is how far from (x, y) along axis k water depth m deep lies,
// at most most m; +∞ if none, or if land comes first after water.
func (tw *townWork) reachDepth(x, y float64, k int, depth, most float64) float64 {
	sa, ca := sincos(latticeAxes[k])
	wet := false
	for t := 0.0; t <= most; t += physics.HexAcross / 2 {
		i := tw.at(x+float64(t*sa), y+float64(t*ca))
		if i < 0 {
			return math.Inf(1)
		}
		e := tw.g.elev[i]
		if e > 0 && wet {
			return math.Inf(1)
		}
		if e <= 0 {
			wet = true
			if float64(-e) >= float64(depth*10) {
				return t
			}
		}
	}
	return math.Inf(1)
}

// scatter puts n buildings of kind k on free, gentle land between the
// distances given from the town's water and within reach of (x, y),
// each facing toward (fx, fy), at least apart m from the others; drawn
// from the town's stream. Returns the middles of those placed.
func (tw *townWork) scatter(k *buildingKind, n int, x, y, reach, lo, hi, apart, fx, fy float64) [][2]float64 {
	var out [][2]float64
	for range n * 40 {
		if len(out) >= n {
			break
		}
		a := tw.s.angle()
		r := float64(reach * math.Sqrt(tw.s.float()))
		sa, ca := sincos(a)
		px, py := x+float64(r*sa), y+float64(r*ca)
		i := tw.at(px, py)
		if i < 0 || tw.g.elev[i] <= 0 || tw.shore[i] < lo || tw.shore[i] > hi {
			continue
		}
		ok := true
		for _, o := range out {
			if hypot(px-o[0], py-o[1]) < apart {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		f, d := tw.size(k)
		h := physics.Atan2(fx-px, fy-py) + float64(tw.s.in(-0.35, 0.35))
		if tw.placeAt(k, px, py, h, f, d) {
			out = append(out, [2]float64{px, py})
		}
	}
	return out
}

// paths joins each point to the hexagon at (x, y) by the least-cost way
// over free land, beaten earth.
func (tw *townWork) paths(from [][2]float64, x, y float64) {
	c := tw.c
	end := tw.at(x, y)
	if end < 0 {
		return
	}
	to := map[int32]bool{end: true}
	crossable := func(i int32) bool {
		u := tw.use[i]
		return tw.g.elev[i] > 0 && (u == useFree || u == usePath || u == useStreet || u == useQuay || u == useGarden)
	}
	for _, p := range from {
		start := tw.at(p[0], p[1])
		if start < 0 {
			continue
		}
		// From the hexagon before its door: the nearest free one.
		var nb [6]int32
		k := tw.g.neighbours(start, &nb)
		best, far := int32(-1), math.Inf(1)
		for _, j := range nb[:k] {
			if crossable(j) {
				hx, hy := tw.g.centre(j)
				if d := hypot(hx-x, hy-y); d < far {
					best, far = j, d
				}
			}
		}
		if best < 0 {
			continue
		}
		for _, i := range tw.path(best, to, crossable) {
			if tw.use[i] == useFree {
				tw.use[i], tw.g.surf[i] = usePath, c.townSurface.yard
			}
		}
		to[best] = true
	}
}

// outskirts puts the buildings a town still lacks on the free land nearest
// its water, within its reach, each facing the nearest of its ways and
// joined to it by a lane of its own.
func (tw *townWork) outskirts() {
	tw.outskirtsWithin(1.15, tw.target, tw.reach)
	// Short of the least it may have, beyond its arc and its reach: those
	// nearest it first.
	if tw.count < tw.least {
		tw.outskirtsWithin(2, tw.least, float64(1.5*tw.reach))
	}
	// Still short: all round its site, on steeper ground terraced.
	if tw.count < tw.least {
		tw.steep = 2
		tw.outskirtsWithin(4, tw.least, float64(1.5*tw.reach))
		tw.steep = 0
	}
}

// outskirtsWithin puts buildings on the free land within the share of the
// town's arc given, nearest its water and its arc's middle first, until
// it has want.
func (tw *townWork) outskirtsWithin(share float64, want int, reach float64) {
	c := tw.c
	t := &tw.g
	type cand struct {
		i int32
		d float64
	}
	var cands []cand
	for i := range t.w * t.h {
		if tw.use[i] != useFree || t.elev[i] <= 0 || tw.shore[i] > reach || i%3 != 0 {
			continue
		}
		x, y := t.centre(i)
		if !tw.inArc(x, y, share) || share > 2 && hypot(x-tw.sx, y-tw.sy) > tw.around {
			continue
		}
		_, off := tw.bearing(x, y)
		beyond := max(math.Abs(off)-float64(1.15*tw.half), 0)
		cands = append(cands, cand{i, tw.shore[i] + float64(beyond*hypot(x-tw.ox, y-tw.oy))})
	}
	slices.SortStableFunc(cands, func(a, b cand) int { return cmpAsc(a.d, b.d) })
	isWay := func(i int32) bool { u := tw.use[i]; return u == useStreet || u == useQuay || u == useSquare }
	crossable := func(i int32) bool {
		u := tw.use[i]
		return t.elev[i] > 0 && (u == useFree || u == useStreet || u == useQuay || u == useSquare || u == useGarden || u == usePath)
	}
	var nb [6]int32
	for _, cd := range cands {
		if tw.count >= want {
			return
		}
		if tw.use[cd.i] != useFree {
			continue
		}
		x, y := t.centre(cd.i)
		// The nearest way, by a search over the land.
		seen := map[int32]bool{cd.i: true}
		queue := []int32{cd.i}
		way := int32(-1)
		for len(queue) > 0 && way < 0 && len(seen) < 1500 {
			i := queue[0]
			queue = queue[1:]
			k := t.neighbours(i, &nb)
			for _, j := range nb[:k] {
				if seen[j] || !crossable(j) {
					continue
				}
				seen[j] = true
				if isWay(j) {
					way = j
					break
				}
				queue = append(queue, j)
			}
		}
		if way < 0 {
			continue
		}
		wx, wy := t.centre(way)
		k := tw.filler(x, y)
		if k == nil {
			return
		}
		f, d := tw.size(k)
		h := physics.Atan2(wx-x, wy-y)
		if !tw.placeAt(k, x, y, h, f, d) {
			continue
		}
		// A lane from before its door to the way; or none, and it is taken
		// back.
		b := &tw.buildings[len(tw.buildings)-1]
		sh, ch := sincos(b.Heading)
		door := tw.at(b.X+float64((b.Depth/2+2.5)*sh), b.Y+float64((b.Depth/2+2.5)*ch))
		var route []int32
		switch {
		case door < 0 || !crossable(door):
		case isWay(door):
			route = []int32{door}
		default:
			route = tw.path(door, map[int32]bool{way: true}, crossable)
		}
		if len(route) == 0 {
			tw.unplace()
			continue
		}
		for _, i := range route {
			if tw.use[i] == useFree || tw.use[i] == useGarden || tw.use[i] == usePath {
				tw.use[i], t.surf[i] = useStreet, c.townSurface.street
			}
		}
	}
}

// nearestWay is the middle of the hexagon of a street, a quay or a square
// nearest (x, y) within a few metres; or (dx, dy) if there is none.
func (tw *townWork) nearestWay(x, y, dx, dy float64) (float64, float64) {
	bx, by, far := dx, dy, math.Inf(1)
	q0, r0 := physics.HexAt(x, y)
	for dq := int32(-3); dq <= 3; dq++ {
		for dr := max(-3, -dq-3); dr <= min(3, -dq+3); dr++ {
			hx, hy := physics.HexCentre(q0+dq, r0+dr)
			i := tw.at(hx, hy)
			if i < 0 {
				continue
			}
			if u := tw.use[i]; u != useStreet && u != useQuay && u != useSquare {
				continue
			}
			if d := hypot(hx-x, hy-y); d < far {
				bx, by, far = hx, hy, d
			}
		}
	}
	return bx, by
}

// deepestAlong is the deepest water from (x, y) along axis k within most m,
// m, and how far along it lies; it stops at land beyond water.
func (tw *townWork) deepestAlong(x, y float64, k int, most float64) (float64, float64) {
	sa, ca := sincos(latticeAxes[k])
	wet := false
	deepest, at := 0.0, 0.0
	for t := 0.0; t <= most; t += physics.HexAcross / 2 {
		i := tw.at(x+float64(t*sa), y+float64(t*ca))
		if i < 0 {
			break
		}
		e := tw.g.elev[i]
		if e > 0 {
			if wet {
				break
			}
			continue
		}
		wet = true
		if d := float64(-e) / 10; d > deepest {
			deepest, at = d, t
		}
	}
	return deepest, at
}

// pierRun is how far a pier from (x, y) along axis k could run, at most
// most m: over its first stretch of water, to land beyond it.
func (tw *townWork) pierRun(x, y float64, k int, most float64) float64 {
	sa, ca := sincos(latticeAxes[k])
	wet := false
	for t := 0.0; t <= most; t += physics.HexAcross / 2 {
		i := tw.at(x+float64(t*sa), y+float64(t*ca))
		if i < 0 {
			return t
		}
		if tw.g.elev[i] > 0 {
			if wet {
				return t
			}
			continue
		}
		wet = true
	}
	return most
}
