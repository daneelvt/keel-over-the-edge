// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Port Royal's town, a port's and a fishing village's.

// square lays out the town's square on its quay where the shore is most
// central to the town: the land within its depth of the quay's back and
// half its width either side of the town's middle, cobbled, levelled no
// lower than the quay. Returns its middle, or false if it has no room.
func (tw *townWork) square(from float64) ([2]float64, bool) {
	c := tw.c
	sq := &c.towns.Plan.Square
	t := &tw.g
	var hexes []int32
	for i := range t.w * t.h {
		if t.elev[i] <= 0 || tw.use[i] != useFree || tw.shore[i] > from+sq.Back {
			continue
		}
		x, y := t.centre(i)
		_, off := tw.bearing(x, y)
		if math.Abs(float64(off*hypot(x-tw.ox, y-tw.oy))) > sq.Along/2 {
			continue
		}
		hexes = append(hexes, i)
	}
	if len(hexes) < 8 {
		return [2]float64{}, false
	}
	quay := int16(round(float64(c.towns.Waterfront.Quay * 10)))
	level := max(tw.levelPlot(hexes, useSquare, c.townSurface.street), quay)
	var sx, sy float64
	for _, i := range hexes {
		t.elev[i] = level
		x, y := t.centre(i)
		sx, sy = sx+x, sy+y
	}
	n := float64(len(hexes))
	return [2]float64{sx / n, sy / n}, true
}

// aroundSquare puts a building of kind k on the square's edge facing it:
// at its back, or either side, wherever along them it fits first.
func (tw *townWork) aroundSquare(k *buildingKind, sq [2]float64) bool {
	c := tw.c
	s := &c.towns.Plan.Square
	radial := physics.Atan2(sq[0]-tw.ox, sq[1]-tw.oy)
	sr, cr := sincos(radial)
	f, d := tw.size(k)
	var spots [][2]float64
	for _, t := range []float64{0, 0.25, -0.25, 0.45, -0.45} {
		spots = append(spots, [2]float64{float64(t * s.Along), s.Back/2 + 1})
	}
	for _, t := range []float64{0, 0.3, -0.3} {
		spots = append(spots, [2]float64{s.Along/2 + 1, float64(t * s.Back)}, [2]float64{-(s.Along/2 + 1), float64(t * s.Back)})
	}
	for range 2 {
		for _, at := range spots {
			// across the shore (along), and back from the water (back).
			px := sq[0] + float64(at[0]*cr) + float64(at[1]*sr)
			py := sq[1] - float64(at[0]*sr) + float64(at[1]*cr)
			h := physics.Atan2(sq[0]-px, sq[1]-py)
			sh, ch := sincos(h)
			for _, gap := range []float64{1, 3, 5} {
				cx, cy := px-float64((d/2+gap)*sh), py-float64((d/2+gap)*ch)
				if tw.placeAt(k, cx, cy, h, f, d) {
					return true
				}
			}
		}
		// The least of its size, and try again.
		f, d = k.frontage[0], k.depth[0]
	}
	// Near it, facing it.
	return tw.overlooking(k, sq[0], sq[1], 30)
}

// overlooking puts a building of kind k on the highest ground within reach
// of (x, y) where it fits, facing (x, y): Emilien and others' geographical
// domination, "built in overlooking places so that they can be seen from
// afar".
func (tw *townWork) overlooking(k *buildingKind, x, y, reach float64) bool {
	t := &tw.g
	type cand struct {
		i int32
		e int16
	}
	var cands []cand
	for i := range t.w * t.h {
		if tw.use[i] != useFree || t.elev[i] <= 0 {
			continue
		}
		if hx, hy := t.centre(i); hypot(hx-x, hy-y) <= reach {
			cands = append(cands, cand{i, t.elev[i]})
		}
	}
	slices.SortFunc(cands, func(a, b cand) int { return int(b.e) - int(a.e) })
	f, d := tw.size(k)
	for range 2 {
		for _, cd := range cands[:min(len(cands), 600)] {
			hx, hy := t.centre(cd.i)
			h := physics.Atan2(x-hx, y-hy)
			if tw.placeAt(k, hx, hy, h, f, d) {
				return true
			}
		}
		f, d = k.frontage[0], k.depth[0]
	}
	return false
}

// onQuay puts the buildings that stand on the quay along its back, facing
// the water: the quay's own kinds from the town's middle out, the
// warehouses at its ends.
func (tw *townWork) onQuay(quay *way) {
	c := tw.c
	type slot struct {
		x, y, b float64
		off     float64
	}
	var slots []slot
	along(quay.pts, 1, func(x, y, b float64) bool {
		_, off := tw.bearing(x, y)
		slots = append(slots, slot{x, y, b, off})
		return true
	})
	if len(slots) == 0 {
		return
	}
	put := func(k *buildingKind, s slot) bool {
		f, d := tw.size(k)
		if tw.s.chance(0.5) {
			f, d = k.frontage[0], k.depth[0]
		}
		// Inland of the quay: the side away from the town's origin.
		nb := physics.Atan2(s.x-tw.ox, s.y-tw.oy)
		sn, cn := sincos(nb)
		back := tw.s.in(0.5, 1.5)
		fx, fy := s.x+float64((quay.width/2+back)*sn), s.y+float64((quay.width/2+back)*cn)
		h := nb + math.Pi
		sh, ch := sincos(h)
		return tw.placeAt(k, fx-float64(d/2*sh), fy-float64(d/2*ch), h, f, d)
	}
	// From the middle out, alternately either side.
	order := slices.Clone(slots)
	slices.SortStableFunc(order, func(a, b slot) int { return cmpAsc(math.Abs(a.off), math.Abs(b.off)) })
	for _, k := range c.standing(catalog.StandsQuay) {
		if k.prop {
			continue
		}
		n := tw.counted(k)
		for _, s := range order {
			if n == 0 {
				break
			}
			if put(k, s) {
				n--
			}
		}
	}
	// The warehouses at either end.
	ends := slices.Clone(slots)
	slices.SortStableFunc(ends, func(a, b slot) int { return cmpDesc(math.Abs(a.off), math.Abs(b.off)) })
	for _, k := range c.standing(catalog.StandsQuayEnd) {
		n := tw.counted(k)
		for i, s := range ends {
			if n == 0 {
				break
			}
			// Alternate ends.
			_ = i
			if put(k, s) {
				n--
			}
		}
	}
}

// squareOnQuay puts the square's own buildings the square had no room for
// on the quay's back nearest the square, facing the water.
func (tw *townWork) squareOnQuay(quay *way, sq [2]float64) {
	c := tw.c
	for _, k := range c.standing(catalog.StandsSquare) {
		if k.prop || tw.counts[k.index] > 0 {
			continue
		}
		want := tw.counted(k)
		type slot struct{ x, y, d float64 }
		var slots []slot
		along(quay.pts, 1, func(x, y, _ float64) bool {
			slots = append(slots, slot{x, y, hypot(x-sq[0], y-sq[1])})
			return true
		})
		slices.SortStableFunc(slots, func(a, b slot) int { return cmpAsc(a.d, b.d) })
		for _, s := range slots {
			if tw.counts[k.index] >= want {
				break
			}
			f, d := tw.size(k)
			nb := physics.Atan2(s.x-tw.ox, s.y-tw.oy)
			sn, cn := sincos(nb)
			fx, fy := s.x+float64((quay.width/2+1)*sn), s.y+float64((quay.width/2+1)*cn)
			sh, ch := sincos(nb + math.Pi)
			tw.placeAt(k, fx-float64(d/2*sh), fy-float64(d/2*ch), nb+math.Pi, f, d)
		}
		// Else the nearest ground to the square it fits on.
		for _, reach := range []float64{60, 120} {
			if tw.counts[k.index] < want {
				tw.overlooking(k, sq[0], sq[1], reach)
			}
		}
	}
}

// finish fills the streets, levels the ways, puts the props about and
// writes the town's record.
func (tw *townWork) finish() {
	// The streets, nearest the water first.
	slices.SortStableFunc(tw.ways, func(a, b way) int { return cmpAsc(a.rank, b.rank) })
	for k := range tw.ways {
		if tw.count >= tw.target {
			break
		}
		tw.fillWay(&tw.ways[k], tw.filler)
	}
	if tw.count < tw.target {
		tw.outskirts()
	}
	tw.levelWays()
	streets := 0
	for i := range tw.use {
		if u := tw.use[i]; u == useStreet || u == useSquare {
			streets++
		}
	}
	tw.town.Streets = streets
	tw.town.Buildings = tw.count
	tw.town.Counts = tw.counts
}

// props puts the props along the quay's edge, on the square, and at the
// pier heads.
func (tw *townWork) props(quay [][2]float64, sq *[2]float64, heads [][2]float64) {
	c := tw.c
	byStand := func(st catalog.Stands) []*buildingKind {
		var out []*buildingKind
		for _, k := range c.standing(st) {
			if k.prop {
				out = append(out, k)
			}
		}
		return out
	}
	// Bollards along the edge, lantern posts among them.
	for _, k := range byStand(catalog.StandsEdge) {
		n := tw.counted(k)
		for j := 0; j < len(quay) && n > 0; j += max(len(quay)/max(n, 1), 1) {
			out := physics.Atan2(tw.ox-quay[j][0], tw.oy-quay[j][1])
			if tw.prop(k, quay[j][0], quay[j][1], out) {
				n--
			}
		}
	}
	for _, k := range byStand(catalog.StandsPost) {
		n := tw.counted(k)
		for _, h := range heads {
			if n > 0 && tw.prop(k, h[0], h[1], 0) {
				n--
			}
		}
		if sq != nil && n > 0 && tw.prop(k, sq[0]+3, sq[1]+3, 0) {
			n--
		}
		step := max(len(quay)/max(n, 1), 1)
		for j := step / 2; j < len(quay) && n > 0; j += step {
			// A little back from the edge.
			x, y := quay[j][0], quay[j][1]
			sb, cb := sincos(physics.Atan2(x-tw.ox, y-tw.oy))
			if tw.prop(k, x+float64(3*sb), y+float64(3*cb), 0) {
				n--
			}
		}
	}
	// On the quay: crates and barrels, and cranes, along its back.
	for _, k := range byStand(catalog.StandsQuay) {
		n := tw.counted(k)
		for range n * 4 {
			if n == 0 || len(quay) == 0 {
				break
			}
			q := quay[tw.s.r.IntN(len(quay))]
			sb, cb := sincos(physics.Atan2(q[0]-tw.ox, q[1]-tw.oy))
			back := tw.s.in(2, 5)
			if tw.prop(k, q[0]+float64(back*sb), q[1]+float64(back*cb), tw.s.angle()) {
				n--
			}
		}
	}
	// On the square: stalls about it, the well in its middle.
	if sq != nil {
		for _, k := range byStand(catalog.StandsSquare) {
			n := tw.counted(k)
			if k.frontage[1] <= 2 && n > 0 {
				tw.prop(k, sq[0], sq[1], 0)
				continue
			}
			for j := range n {
				a := float64(float64(j)*(2*math.Pi/float64(max(n, 1)))) + tw.s.in(-0.2, 0.2)
				sa, ca := sincos(a)
				r := tw.s.in(4, 7)
				tw.prop(k, sq[0]+float64(r*sa), sq[1]+float64(r*ca), a+math.Pi)
			}
		}
	}
}

// beachProps draws boats up on the beach about (x, y): props of the beach.
func (tw *townWork) beachProps(x, y, out float64) {
	c := tw.c
	for _, k := range c.standing(catalog.StandsBeach) {
		n := tw.counted(k)
		for range n * 6 {
			if n == 0 {
				break
			}
			a := out + math.Pi + tw.s.in(-1.2, 1.2)
			r := tw.s.in(4, 25)
			sa, ca := sincos(a)
			px, py := x+float64(r*sa), y+float64(r*ca)
			i := tw.at(px, py)
			if i < 0 || tw.g.elev[i] <= 0 || tw.g.elev[i] > 25 || tw.use[i] != useFree {
				continue
			}
			if tw.prop(k, px, py, out+tw.s.in(-0.4, 0.4)) {
				n--
			}
		}
	}
}

// harbourDiscs are discs every step m along the points given, of radius r.
func harbourDiscs(pts [][2]float64, step, r float64) []Disc {
	var out []Disc
	last := [2]float64{math.Inf(1), math.Inf(1)}
	for _, p := range pts {
		if hypot(p[0]-last[0], p[1]-last[1]) < step {
			continue
		}
		out = append(out, Disc{X: round1(p[0]), Y: round1(p[1]), R: r})
		last = p
	}
	return out
}

// pierPoints are points along a pier, from its root out.
func pierPoints(p Pier) [][2]float64 {
	sa, ca := sincos(p.Heading)
	var out [][2]float64
	for t := 0.0; t <= p.Length; t += physics.HexAcross {
		out = append(out, [2]float64{p.X + float64(t*sa), p.Y + float64(t*ca)})
	}
	return out
}

// mainTown lays out Port Royal's town about its basin.
func (c *config) mainTown(s stream, g *physics.Ground, m *made, lights []*lightWork, name string) *townWork {
	h := m.harbour
	p := &c.towns.Plan
	wf := &c.towns.Waterfront
	r := float64(m.radius*reachOf) + 60
	tw := c.newTownWork(g, s, townMain, m, m.x, m.y, r, func(_ int32, x, y float64) bool { return h.inHarbour(x, y) })
	tw.ox, tw.oy, tw.facing, tw.half, tw.reach = h.x, h.y, wrapAngle(h.bearing+math.Pi), h.town, p.Reach[0]
	tw.sx, tw.sy, tw.around = h.x, h.y, h.radius+p.Reach[0]
	tw.town = &Town{Number: 0, Kind: townMain, Place: -1, Island: m.number, Name: name, Flag: -1}
	tw.flag = uint8(len(c.towns.Flags.Colours) + 1)
	size := c.towns.Size.Main
	tw.target, tw.least = s.pick(size[0], size[1]), size[0]
	tw.markTowers(lights)
	t := &tw.g
	// The mole, already laid, is a pier.
	for i := range t.w * t.h {
		if t.elev[i] > 0 && t.surf[i] == c.townSurface.quay {
			tw.use[i] = usePier
		}
	}
	quays := tw.quay(1, wf.Foot.Main, math.Inf(1), true)
	quayEdge := longest(quays)
	from := p.Quay + 2
	sq, hasSquare := tw.square(from)
	// The special buildings: the harbourmaster's on the square, the church
	// above it, the quay's own.
	if hasSquare {
		tw.town.Square = &[2]float64{round1(sq[0]), round1(sq[1])}
		for _, k := range c.standing(catalog.StandsSquare) {
			if !k.prop {
				for range tw.counted(k) {
					tw.aroundSquare(k, sq)
				}
			}
		}
		for _, k := range c.standing(catalog.StandsAbove) {
			for range tw.counted(k) {
				if !tw.overlooking(k, sq[0], sq[1], 70) {
					tw.overlooking(k, sq[0], sq[1], 140)
				}
			}
		}
	}
	// The quay street, then the contour streets.
	for _, q := range quays {
		tw.ways = append(tw.ways, way{pts: q, width: 2 * (p.Quay + 2), sides: 3, quay: true, rank: 0})
	}
	top := tw.contours(p.Contours.Main, from)
	// Lanes up from the quay, and steps from the square's back.
	var starts [][2]float64
	along(quayEdge, p.Lanes, func(x, y, _ float64) bool {
		sb, cb := sincos(physics.Atan2(x-tw.ox, y-tw.oy))
		starts = append(starts, [2]float64{x + float64((p.Quay+1)*sb), y + float64((p.Quay+1)*cb)})
		return true
	})
	if hasSquare {
		sb, cb := sincos(physics.Atan2(sq[0]-tw.ox, sq[1]-tw.oy))
		starts = append(starts, [2]float64{sq[0] + float64((p.Square.Back/2+2)*sb), sq[1] + float64((p.Square.Back/2+2)*cb)})
	}
	tw.lanes(starts, top)
	tw.onQuay(&tw.ways[0])
	if hasSquare {
		tw.squareOnQuay(&tw.ways[0], sq)
	}
	// The piers: two long where the tall ships lie, two short, from the
	// quay into the basin along the lattice's axis nearest the way in,
	// short of the turning circle.
	var heads [][2]float64
	piers := []struct {
		at     float64
		length [2]float64
		width  float64
	}{}
	for k := range wf.Long.Count {
		at := 0.3 + float64(0.35*float64(k))
		if k%2 == 1 {
			at = -at
		}
		piers = append(piers, struct {
			at     float64
			length [2]float64
			width  float64
		}{at, pair(wf.Long.Length), wf.Long.Width})
	}
	for k := range wf.Short.Count {
		at := 0.85 - float64(0.15*float64(k/2))
		if k%2 == 0 {
			at = -at
		}
		piers = append(piers, struct {
			at     float64
			length [2]float64
			width  float64
		}{at, pair(wf.Short.Length), wf.Short.Width})
	}
	for _, pr := range piers {
		// The quay's edge nearest that share of the town's arc.
		want := wrapAngle(tw.facing + float64(pr.at*tw.half))
		best, far := -1, math.Inf(1)
		for j, q := range quayEdge {
			a, _ := tw.bearing(q[0], q[1])
			if d := math.Abs(angleBetween(a, want)); d < far {
				best, far = j, d
			}
		}
		if best < 0 {
			continue
		}
		q := quayEdge[best]
		axis := nearestAxis(physics.Atan2(h.x-q[0], h.y-q[1]))
		length := s.in(pr.length[0], pr.length[1])
		// Short of the turning circle about the basin's middle.
		sa, ca := sincos(latticeAxes[axis])
		for length > physics.HexAcross {
			ex, ey := q[0]+float64(length*sa), q[1]+float64(length*ca)
			if hypot(ex-h.x, ey-h.y) >= h.turning+10 {
				break
			}
			length -= physics.HexAcross
		}
		pier := tw.pier(q[0], q[1], axis, length, pr.width, c.townSurface.deck)
		if pier.Length >= physics.HexAcross {
			tw.town.Piers = append(tw.town.Piers, pier)
			heads = append(heads, [2]float64{q[0] + float64(pier.Length*sa), q[1] + float64(pier.Length*ca)})
		}
	}
	// The mole, as a pier.
	msa, mca := sincos(latticeAxes[h.moleAxis])
	tw.town.Piers = append(tw.town.Piers, Pier{X: round1(h.moleX), Y: round1(h.moleY), Heading: round3(latticeAxes[h.moleAxis]),
		Length: round1(h.moleLength), Width: h.moleWidth, Mole: true})
	heads = append(heads, [2]float64{h.moleX + float64(h.moleLength*msa), h.moleY + float64(h.moleLength*mca)})
	tw.mainOutside(h)
	tw.finish()
	var sqp *[2]float64
	if hasSquare {
		sqp = &sq
	}
	tw.props(quayEdge, sqp, heads)
	tw.town.Buildings, tw.town.Counts = tw.count, tw.counts
	tw.town.Quay = quayEdge
	if len(quayEdge) > 0 {
		mid := quayEdge[len(quayEdge)/2]
		tw.town.X, tw.town.Y = mid[0], mid[1]
	}
	tw.town.Heading = round3(h.bearing)
	// In port: the basin and the narrows.
	step := c.towns.InPort.Step
	for i := range t.w * t.h {
		cc, jj := t.c0+i/t.h, t.j0+i%t.h
		x, y := physics.CellCentre(cc, jj)
		gx, gy := float64(x/step), float64(y/step)
		if math.Abs(gx-math.Floor(gx+0.5)) > 0.06 || math.Abs(gy-math.Floor(gy+0.5)) > 0.06 {
			continue
		}
		if h.inHarbour(x, y) && t.elev[i] <= 0 {
			tw.town.Harbour = append(tw.town.Harbour, Disc{X: round1(x), Y: round1(y), R: float64(0.8 * step)})
		}
	}
	return tw
}

// mainOutside puts what stands outside Port Royal's town: the windmill on
// its highest open ground, the farms on gentle ground, the shipyard on the
// basin's shore beyond the town, the fishermen's huts above a beach of its
// outer coast.
func (tw *townWork) mainOutside(h *harbour) {
	c := tw.c
	t := &tw.g
	clearOfTown := func(x, y, r float64) bool {
		for _, b := range tw.buildings {
			if hypot(b.X-x, b.Y-y) < r {
				return false
			}
		}
		return true
	}
	// The windmill.
	for _, k := range c.standing(catalog.StandsSummit) {
		for range tw.counted(k) {
			type cand struct {
				i int32
				e int16
			}
			var cands []cand
			for i := range t.w * t.h {
				if tw.use[i] == useFree && t.elev[i] > 0 && tw.shore[i] > 40 {
					cands = append(cands, cand{i, t.elev[i]})
				}
			}
			slices.SortFunc(cands, func(a, b cand) int { return int(b.e) - int(a.e) })
			f, d := tw.size(k)
			for _, cd := range cands[:min(len(cands), 600)] {
				x, y := t.centre(cd.i)
				if clearOfTown(x, y, 40) && tw.placeAt(k, x, y, tw.s.angle(), f, d) {
					break
				}
			}
		}
	}
	// The farms: on gentle ground away from the town, apart.
	for _, k := range c.standing(catalog.StandsFields) {
		n := tw.counted(k)
		var farms [][2]float64
		for range n * 60 {
			if len(farms) >= n {
				break
			}
			i := int32(tw.s.r.IntN(int(t.w * t.h)))
			if tw.use[i] != useFree || t.elev[i] <= 0 {
				continue
			}
			x, y := t.centre(i)
			if !clearOfTown(x, y, 60) || tw.island.harbour != nil && tw.inArc(x, y, 1.3) && hypot(x-tw.ox, y-tw.oy) < tw.reach+80 {
				continue
			}
			ok := true
			for _, o := range farms {
				if hypot(x-o[0], y-o[1]) < 60 {
					ok = false
				}
			}
			f, d := tw.size(k)
			if ok && tw.placeAt(k, x, y, tw.s.angle(), f, d) {
				farms = append(farms, [2]float64{x, y})
				// Its yard.
				for _, j := range tw.footprint(x, y, 0, 24, 24, 0) {
					if tw.use[j] == useFree && t.elev[j] > 0 {
						tw.use[j], t.surf[j] = useGarden, c.townSurface.yard
					}
				}
			}
		}
	}
	// The shipyard: a slip down into the basin beyond the town's end.
	for _, k := range c.standing(catalog.StandsSlip) {
		for range tw.counted(k) {
			for _, side := range []float64{1, -1} {
				placed := false
				for off := tw.half + 0.12; off < tw.half+0.9; off += 0.04 {
					a := wrapAngle(tw.facing + float64(side*off))
					sa, ca := sincos(a)
					if math.Abs(angleBetween(a, h.bearing)) < 0.7 {
						continue
					}
					// The shore along that bearing.
					rr := h.radiusAt(a)
					x, y := h.x+float64(rr*sa), h.y+float64(rr*ca)
					f, d := tw.size(k)
					// Its lower end in the water, facing it.
					cx, cy := x-float64((d/2-8)*sa), y-float64((d/2-8)*ca)
					cx, cy, a, f, d = quantise(cx, cy, a, f, d)
					plot := tw.footprint(cx, cy, a, f, d, 0.5)
					var dry []int32
					for _, i := range plot {
						if t.elev[i] > 0 {
							dry = append(dry, i)
						}
					}
					if len(dry) < len(plot)/3 || !tw.free(dry) || !tw.slopeOK(dry, d) {
						continue
					}
					b := tw.add(k, cx, cy, a, f, d, dry)
					b.Level = tw.c.terraceDm
					for _, i := range dry {
						t.elev[i] = tw.c.terraceDm
					}
					placed = true
					break
				}
				if placed {
					break
				}
			}
		}
	}
	// The fishermen's huts: above the outer coast's beach with the most
	// sand, away from the harbour.
	b := &c.biomes[tw.island.biome]
	best, most := int32(-1), 0
	var nb [6]int32
	for i := range t.w * t.h {
		if t.elev[i] <= 0 || t.surf[i] != b.surfaces.beach || tw.use[i] != useFree || tw.shore[i] < 80 {
			continue
		}
		k := t.neighbours(i, &nb)
		sea := false
		for _, j := range nb[:k] {
			if t.elev[j] <= 0 && !tw.water[j] {
				sea = true
			}
		}
		if !sea {
			continue
		}
		x, y := t.centre(i)
		n := 0
		for j := range t.w * t.h {
			if t.surf[j] == b.surfaces.beach && t.elev[j] > 0 {
				if hx, hy := t.centre(j); hypot(hx-x, hy-y) < 30 {
					n++
				}
			}
		}
		if n > most {
			best, most = i, n
		}
	}
	if best >= 0 {
		x, y := t.centre(best)
		out := physics.Atan2(x-tw.island.x, y-tw.island.y)
		for _, k := range c.standing(catalog.StandsSlope) {
			huts := tw.scatterAbove(k, tw.counted(k), x, y, out, 70)
			tw.paths(huts, x, y)
		}
		tw.beachProps(x, y, out)
	}
}

// scatterAbove puts n buildings of kind k up the slope above a beach at
// (x, y) whose sea lies toward out, facing down to it.
func (tw *townWork) scatterAbove(k *buildingKind, n int, x, y, out, reach float64) [][2]float64 {
	so, co := sincos(out)
	// About a point up the slope.
	cx, cy := x-float64(reach/2*so), y-float64(reach/2*co)
	var got [][2]float64
	for range n * 50 {
		if len(got) >= n {
			break
		}
		a := tw.s.angle()
		r := float64(reach / 2 * math.Sqrt(tw.s.float()))
		sa, ca := sincos(a)
		px, py := cx+float64(r*sa), cy+float64(r*ca)
		i := tw.at(px, py)
		if i < 0 || tw.g.elev[i] <= 0 || tw.use[i] != useFree || hypot(px-x, py-y) < 12 {
			continue
		}
		ok := true
		for _, o := range got {
			if hypot(px-o[0], py-o[1]) < 10 {
				ok = false
			}
		}
		f, d := tw.size(k)
		hd := physics.Atan2(x-px, y-py) + tw.s.in(-0.4, 0.4)
		if ok && tw.placeAt(k, px, py, hd, f, d) {
			got = append(got, [2]float64{px, py})
		}
	}
	return got
}

// roomOf is how many hexagons of land within r of (x, y), reached over
// land from the land nearest it, are no steeper than 1 in steep: the room
// a town has, not counting the land across a bay.
func roomOf(g *physics.Ground, x, y, r, steep float64) int {
	most := float64(physics.HexAcross/steep) * 10
	var nb [6][2]int32
	// The land nearest (x, y): itself, or a neighbour.
	q0, r0 := physics.HexAt(x, y)
	c0, j0 := physics.HexCell(q0, r0)
	start := [2]int32{-1, -1}
	if elevationAt(g, c0, j0) > 0 {
		start = [2]int32{c0, j0}
	} else {
		for _, n := range cellNeighbours(c0, j0, &nb) {
			if elevationAt(g, n[0], n[1]) > 0 {
				start = n
				break
			}
		}
	}
	if start[0] < 0 {
		return 0
	}
	seen := map[[2]int32]bool{start: true}
	queue := [][2]int32{start}
	n := 0
	for len(queue) > 0 {
		h := queue[0]
		queue = queue[1:]
		e := elevationAt(g, h[0], h[1])
		gentle := true
		for _, o := range cellNeighbours(h[0], h[1], &nb) {
			oe := elevationAt(g, o[0], o[1])
			if oe > 0 && math.Abs(float64(oe-e)) > most {
				gentle = false
			}
		}
		if gentle {
			n++
		}
		for _, o := range cellNeighbours(h[0], h[1], &nb) {
			if seen[o] || elevationAt(g, o[0], o[1]) <= 0 {
				continue
			}
			if hx, hy := physics.CellCentre(o[0], o[1]); hypot(hx-x, hy-y) > r {
				continue
			}
			seen[o] = true
			queue = append(queue, o)
		}
	}
	return n
}

// portQuay is how far a port's quay runs from its site, m.
const portQuay = 70

// portTown lays out a port's town at its quay and piers.
func (c *config) portTown(s stream, g *physics.Ground, m *made, si *site, lights []*lightWork, number int32, flag uint8) *townWork {
	p := &c.towns.Plan
	wf := &c.towns.Waterfront
	reach := p.Reach[1]
	tw := c.newTownWork(g, s, townPort, m, si.x, si.y, max(reach+120, c.places.Harbour.Pier+40), func(int32, float64, float64) bool { return true })
	sh, ch := sincos(si.heading)
	tw.ox, tw.oy = si.x+float64(50*sh), si.y+float64(50*ch)
	tw.sx, tw.sy, tw.around = si.x, si.y, c.places.Harbour.RoomWithin
	tw.facing, tw.half, tw.reach = wrapAngle(si.heading+math.Pi), float64(60*degree), reach
	tw.town = &Town{Number: number, Kind: townPort, Island: m.number, Name: si.name, Flag: int32(flag) - 1}
	tw.flag = flag
	room := roomOf(g, si.x, si.y, c.places.Harbour.RoomWithin, c.places.Harbour.Steep)
	size := c.towns.Size.Port
	share := clamp(float64(room-c.places.Harbour.Room)/2400, 0, 1)
	tw.target = size[0] + int(toInt32(float64(share*float64(size[1]-size[0]))))
	tw.least = size[0]
	tw.markTowers(lights)
	quays := tw.quay(0.6, wf.Foot.Port, portQuay, true)
	if len(quays) == 0 {
		// A shore that does not face the town's water: its quay where it
		// can be.
		quays = tw.quay(1, wf.Foot.Port, 2*portQuay, false)
	}
	quayEdge := longest(quays)
	from := p.Quay + 2
	sq, hasSquare := tw.square(from)
	for _, q := range quays {
		tw.ways = append(tw.ways, way{pts: q, width: 2 * (p.Quay + 2), sides: 3, quay: true, rank: 0})
	}
	top := tw.contours(p.Contours.Port, from)
	var starts [][2]float64
	along(quayEdge, p.Lanes, func(x, y, _ float64) bool {
		sb, cb := sincos(physics.Atan2(x-tw.ox, y-tw.oy))
		starts = append(starts, [2]float64{x + float64((p.Quay+1)*sb), y + float64((p.Quay+1)*cb)})
		return true
	})
	tw.lanes(starts, top)
	if hasSquare {
		tw.town.Square = &[2]float64{round1(sq[0]), round1(sq[1])}
	}
	for _, k := range c.standing(catalog.StandsSquare) {
		if k.prop {
			continue
		}
		for range tw.counted(k) {
			if !hasSquare || !tw.aroundSquare(k, sq) {
				// No square: on the quay.
				tw.overlooking(k, si.x, si.y, 40)
			}
		}
	}
	tw.onQuay(&tw.ways[0])
	if hasSquare {
		tw.squareOnQuay(&tw.ways[0], sq)
	}
	// The piers: out from the quay to water deep enough, along the
	// lattice's axis that reaches it soonest.
	var heads [][2]float64
	n := s.pick(wf.Port.Count[0], wf.Port.Count[1])
	for k := range n {
		want := wrapAngle(tw.facing + float64(float64(0.25-float64(0.5*float64(k)))*tw.half))
		// From the quay's edge nearest that share of its arc, the nearer
		// quay points after it, and last from the shore at the site.
		var roots [][2]float64
		order := slices.Clone(quayEdge)
		slices.SortStableFunc(order, func(p, q [2]float64) int {
			pa, _ := tw.bearing(p[0], p[1])
			qa, _ := tw.bearing(q[0], q[1])
			return cmpAsc(math.Abs(angleBetween(pa, want)), math.Abs(angleBetween(qa, want)))
		})
		roots = append(roots, order[:min(len(order), 6)]...)
		roots = append(roots, [2]float64{si.x, si.y})
		// The root and outward axis whose pier reaches the depth soonest,
		// or else the deepest water; each able to run out clear of land
		// for a landing stage's length at least.
		var q [2]float64
		axis, length, deepest := -1, math.Inf(1), 0.0
		least := float64(3 * physics.HexAcross)
		for _, r := range roots {
			for ax, a := range latticeAxes {
				// Out from the shore, toward the deep water, not along it.
				if math.Abs(angleBetween(a, si.heading)) > float64(61*degree) {
					continue
				}
				if tw.pierRun(r[0], r[1], ax, least) < least {
					continue
				}
				l := tw.reachDepth(r[0], r[1], ax, c.places.Harbour.Depth, c.places.Harbour.Pier)
				d, at := tw.deepestAlong(r[0], r[1], ax, c.places.Harbour.Pier)
				switch {
				case l < length:
					q, axis, length = r, ax, l
				case math.IsInf(length, 1) && d > deepest:
					q, axis, deepest = r, ax, d
					length = at
				}
			}
		}
		if axis < 0 {
			continue
		}
		pier := tw.pier(q[0], q[1], axis, max(length+physics.HexAcross, least), wf.Port.Width, c.townSurface.deck)
		if pier.Length >= physics.HexAcross {
			tw.town.Piers = append(tw.town.Piers, pier)
			sa, ca := sincos(latticeAxes[axis])
			heads = append(heads, [2]float64{q[0] + float64(pier.Length*sa), q[1] + float64(pier.Length*ca)})
		}
	}
	// Farms beyond the town.
	for _, k := range c.standing(catalog.StandsFields) {
		tw.scatter(k, tw.counted(k), si.x, si.y, 220, reach, 220, 60, si.x, si.y)
	}
	tw.finish()
	var sqp *[2]float64
	if hasSquare {
		sqp = &sq
	}
	tw.props(quayEdge, sqp, heads)
	tw.town.Buildings, tw.town.Counts = tw.count, tw.counts
	tw.town.Quay = quayEdge
	tw.town.X, tw.town.Y, tw.town.Heading = round1(si.x), round1(si.y), round3(si.heading)
	var front [][2]float64
	front = append(front, quayEdge...)
	for _, pr := range tw.town.Piers {
		front = append(front, pierPoints(pr)...)
	}
	tw.town.Harbour = harbourDiscs(front, c.towns.InPort.Step, c.towns.InPort.Port)
	return tw
}

// villageTown lays out a fishing village: its jetty, its room of stages,
// flakes and sheds at the water, its boats drawn up, and its houses
// scattered up the slope above, joined by paths.
func (c *config) villageTown(s stream, g *physics.Ground, m *made, si *site, lights []*lightWork, number int32) *townWork {
	p := &c.towns.Plan
	wf := &c.towns.Waterfront
	reach := p.Reach[2]
	tw := c.newTownWork(g, s, townVillage, m, si.x, si.y, reach+60, func(int32, float64, float64) bool { return true })
	sh, ch := sincos(si.heading)
	tw.ox, tw.oy = si.x+float64(30*sh), si.y+float64(30*ch)
	tw.facing, tw.half, tw.reach = wrapAngle(si.heading+math.Pi), float64(70*degree), reach
	tw.town = &Town{Number: number, Kind: townVillage, Island: m.number, Name: si.name, Flag: -1}
	tw.target = 1 << 20
	tw.markTowers(lights)
	t := &tw.g
	// The shore: the island's own land nearest the site, not a bank's.
	root := int32(-1)
	far := math.Inf(1)
	for i := range t.w * t.h {
		if t.elev[i] > 0 && tw.shore[i] <= physics.HexAcross {
			x, y := t.centre(i)
			if j, ok := m.grid.index(x, y); !ok || m.grid.elev[j] <= 0 || !m.ownLand(j) {
				continue
			}
			// The nearest with room for the village's houses about it, or
			// failing any, the nearest.
			d := hypot(x-si.x, y-si.y)
			if d < 150 && roomOf(g, x, y, 50, c.places.Harbour.Steep) < 40 {
				d += 1000
			}
			if d < far {
				root, far = i, d
			}
		}
	}
	if root < 0 {
		tw.town.X, tw.town.Y = si.x, si.y
		return tw
	}
	rx, ry := t.centre(root)
	// The jetty.
	axis := nearestAxis(si.heading)
	jetty := tw.pier(rx, ry, axis, s.in(wf.Jetty.Length[0], wf.Jetty.Length[1]), wf.Jetty.Width, c.townSurface.deck)
	tw.town.Piers = append(tw.town.Piers, jetty)
	// The stages at the water either side of the jetty, standing out over
	// it on their posts.
	quay := int16(round(float64(wf.Quay * 10)))
	for _, k := range c.standing(catalog.StandsWater) {
		n := tw.counted(k)
		for j := range n * 8 {
			if n == 0 {
				break
			}
			side := 1.0
			if j%2 == 1 {
				side = -1
			}
			off := float64(side * float64(10+float64(6*float64(j/2))))
			x, y := rx+float64(off*ch), ry-float64(off*sh)
			f, d := tw.size(k)
			cx, cy := x+float64((d/2-4)*sh), y+float64((d/2-4)*ch)
			cx, cy, hd, f, d := quantise(cx, cy, si.heading, f, d)
			plot := tw.footprint(cx, cy, hd, f, d, 0.5)
			dry, wet := 0, 0
			ok := len(plot) > 0
			for _, i := range plot {
				switch {
				case tw.use[i] != useFree && tw.use[i] != useWater:
					ok = false
				case t.elev[i] > 0:
					dry++
				case t.elev[i] < -30:
					ok = false // too deep for its posts
				default:
					wet++
				}
			}
			if !ok || dry == 0 || wet == 0 {
				continue
			}
			b := tw.add(k, cx, cy, hd, f, d, plot)
			b.Level = quay
			for _, i := range plot {
				t.elev[i] = quay
				t.surf[i] = c.townSurface.deck
				tw.use[i] = usePier
			}
			n--
		}
	}
	// The flakes behind them, the boat sheds at the shore.
	for _, k := range c.standing(catalog.StandsBehind) {
		tw.scatter(k, tw.counted(k), rx-float64(18*sh), ry-float64(18*ch), 20, 6, 40, 8, rx, ry)
	}
	for _, k := range c.standing(catalog.StandsShore) {
		tw.scatter(k, tw.counted(k), rx, ry, 25, 0, 10, 8, rx+float64(20*sh), ry+float64(20*ch))
	}
	// The houses, up the slope, joined by paths to the jetty's root; where
	// the slope above is too steep, about the cove.
	var houses [][2]float64
	for _, k := range c.standing(catalog.StandsSlope) {
		n := tw.counted(k)
		got := tw.scatterAbove(k, n, rx, ry, si.heading, reach)
		if len(got) < n {
			got = append(got, tw.scatter(k, n-len(got), rx, ry, float64(1.5*reach), 8, float64(1.5*reach), 10, rx, ry)...)
		}
		houses = append(houses, got...)
	}
	tw.paths(houses, rx, ry)
	tw.beachProps(rx, ry, si.heading)
	tw.props(nil, nil, [][2]float64{{rx + float64(jetty.Length*sh), ry + float64(jetty.Length*ch)}})
	// Crates and barrels by the stages.
	tw.levelWays()
	tw.town.Buildings, tw.town.Counts = tw.count, tw.counts
	tw.town.X, tw.town.Y, tw.town.Heading = round1(rx), round1(ry), round3(si.heading)
	tw.town.Harbour = harbourDiscs(pierPoints(jetty), c.towns.InPort.Step, c.towns.InPort.Village)
	return tw
}
