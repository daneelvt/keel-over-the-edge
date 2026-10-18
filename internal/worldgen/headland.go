// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Caves, arches and blowholes, cut into an island's cliffed headlands in
// the order the sea cuts them: the waves work a joint into a notch, the
// notch into a cave; caves cut through a narrow headland into an arch; the
// arch's roof falls and leaves a stack (the standard account; Internet
// Geography, "Erosion of a headland"). So a cave is cut into a cliff from
// its foot, facing open water, a few hexagons in, its back closed: Fingal's
// Cave on Staffa is 69–82 m long and 12 m wide, its roof 20–22 m over the
// sea (Britannica), so at these islands' 10–30 m cliffs a cave is a few
// metres high and a few hexagons deep. An arch is cut through a headland
// where its neck is narrow. A cave whose roof is thin at its back has a
// vent there, open to the sky: a blowhole, where "a wave fills the cave,
// compresses the air, and air and water burst from the vent" (Kiama,
// Spouting Horn). The height field cannot overhang, so a cave's or an
// arch's hexagons are roofs: their ground is rock awash, which no boat
// sails and the sea foams through, at the sea's level, shallower than any
// hull draws; and their land is drawn from the roof's underside up to its
// top.

// axial are the axial offsets of a hexagon's six neighbours, the k-th and
// the (k+3)-th opposite.
var axial = [6][2]int32{{1, 0}, {0, 1}, {-1, 1}, {-1, 0}, {0, -1}, {1, -1}}

// step is the hexagon of the grid one step from hexagon i along direction
// k of axial, or -1 off the grid.
func (g *islandGrid) step(i int32, k int) int32 {
	q, r := physics.CellHex(g.c0+i/g.h, g.j0+i%g.h)
	c, j := physics.HexCell(q+axial[k][0], r+axial[k][1])
	cc, jj := c-g.c0, j-g.j0
	if cc < 0 || jj < 0 || cc >= g.w || jj >= g.h {
		return -1
	}
	return cc*g.h + jj
}

// headlandsOf cuts island m's caves, blowholes and arches, each where its
// kind's chance gives it one.
func (c *config) headlandsOf(s stream, m *made, w *work, z int32, spots []spot) {
	ck := c.features.kind(catalog.FeatureSiteCave, m.biome)
	ak := c.features.kind(catalog.FeatureSiteArch, m.biome)
	if ak >= 0 && s.chanceOf(&c.features.kinds[ak], z) {
		c.archOf(s, m, w, ak)
	}
	if ck >= 0 && s.chanceOf(&c.features.kinds[ck], z) {
		c.caveOf(s, m, w, ck, spots)
	}
}

// own reports whether hexagon i is the island's own land as it stands:
// not a stack's, which stood in what was water.
func (w *work) own(i int32) bool { return w.land[i] && w.din[i] > 0 }

// roof roofs hexagon i of island m's grid at underside under: its land
// drawn from there up to its height, its ground rock awash.
func (c *config) roof(s stream, m *made, w *work, i int32, under float64) {
	h := c.features.headland
	m.roofs = append(m.roofs, roofWork{i: i, top: w.height[i], under: under})
	w.land[i], w.cliff[i] = false, false
	w.height[i] = -s.in(h.Floor[0], h.Floor[1])
	m.floors = append(m.floors, i)
}

// caveOf cuts a cave into island m's highest cliff that faces open water,
// and a blowhole at its back if its roof is thin there.
func (c *config) caveOf(s stream, m *made, w *work, k int, spots []spot) {
	g := &m.grid
	h := &c.features.headland
	total := g.w * g.h
	type cand struct {
		i    int32
		dir  int // toward the sea
		high float64
	}
	var cands []cand
	for i := range total {
		if !w.own(i) || w.height[i] < h.Cliff || !w.cliff[i] {
			continue
		}
		for d := range 6 {
			j := g.step(i, d)
			if j < 0 || w.land[j] {
				continue
			}
			cands = append(cands, cand{i: i, dir: d, high: w.height[i]})
		}
	}
	slices.SortStableFunc(cands, func(a, b cand) int { return cmpDesc(a.high, b.high) })
	tried := 0
	for _, cd := range cands {
		if tried >= 64 {
			return
		}
		tried++
		in := (cd.dir + 3) % 6
		depth := s.pick(h.Cave.Depth[0], h.Cave.Depth[1])
		under := s.in(h.Cave.Underside[0], h.Cave.Underside[1])
		// The cave's hexagons, from its mouth in; its back closed by land.
		var cells []int32
		at := cd.i
		for range depth {
			if at < 0 || !w.own(at) || w.height[at]-under < h.Cave.Roof {
				break
			}
			cells = append(cells, at)
			at = g.step(at, in)
		}
		for len(cells) >= 2 && (at < 0 || !w.own(at)) {
			// Its back must be land: one hexagon fewer.
			at = cells[len(cells)-1]
			cells = cells[:len(cells)-1]
		}
		if len(cells) < 2 || at < 0 || !w.own(at) || !c.openWater(m, w, cd.i, cd.dir, h.Cave.Open, spots) {
			continue
		}
		mx, my := g.centre(cd.i)
		sx, sy := g.centre(g.step(cd.i, cd.dir))
		heading := headingTo(mx, my, sx, sy)
		cave := m.addFeature(k, cd.i, heading, float64(float64(len(cells))*physics.HexAcross), w.height[cd.i])
		cave.cells = slices.Clone(cells)
		back := cells[len(cells)-1]
		thin := w.height[back]-under <= c.features.headland.Blowhole.Roof
		for _, i := range cells {
			c.roof(s, m, w, i, under)
		}
		// A blowhole: its back's roof open to the sky.
		bk := c.features.kind(catalog.FeatureSiteBlowhole, m.biome)
		if bk >= 0 && thin && len(cells) >= 3 && s.chance(c.features.kinds[bk].chance) {
			r := m.roofs[len(m.roofs)-1]
			m.roofs = m.roofs[:len(m.roofs)-1]
			vx, vy := g.centre(back)
			b := m.addFeature(bk, back, heading, physics.HexAcross, r.top)
			b.cells = slices.Clone(cells)
			b.parts = append(b.parts, Part{X: vx, Y: vy, Level: r.top, Heading: heading, Size: physics.HexAcross,
				Count: uint16(len(cells))})
		}
		return
	}
}

// openWater reports whether the water off hexagon i of island m's grid,
// along direction dir, is open for most metres: no land of the island's
// own on its grid, and no other island's spot near the line.
func (c *config) openWater(m *made, w *work, i int32, dir int, most float64, spots []spot) bool {
	g := &m.grid
	x0, y0 := g.centre(i)
	x1, y1 := g.centre(g.step(i, dir))
	dx, dy := x1-x0, y1-y0
	l := hypot(dx, dy)
	dx, dy = dx/l, dy/l
	// Along the line on its own grid, past the first hexagon of water.
	for d := float64(2 * physics.HexAcross); d < most; d += physics.HexAcross {
		x, y := x0+float64(dx*d), y0+float64(dy*d)
		q, r := physics.HexAt(x, y)
		cc, jj := physics.HexCell(q, r)
		cc, jj = cc-g.c0, jj-g.j0
		if cc < 0 || jj < 0 || cc >= g.w || jj >= g.h {
			break
		}
		if w.land[cc*g.h+jj] {
			return false
		}
	}
	for n := range spots {
		sp := &spots[n]
		if int32(n) == m.number {
			continue
		}
		// The spot's nearest approach to the line from the cave.
		px, py := sp.x-x0, sp.y-y0
		t := clamp(dot(px, py, dx, dy), 0, most)
		ex, ey := px-float64(t*dx), py-float64(t*dy)
		if hypot(ex, ey) < float64(1.3*sp.radius)+physics.HexAcross {
			return false
		}
	}
	return true
}

// archOf cuts an arch through island m's neck: a run of its land along one
// of the lattice's axes no more than the neck's hexagons long, high, with
// water at both ends, which joins a headland's tip to the rest; its
// underside a share of the neck's height. The highest neck is cut.
func (c *config) archOf(s stream, m *made, w *work, k int) {
	g := &m.grid
	h := &c.features.headland
	total := g.w * g.h
	type cand struct {
		run  []int32
		axis int
		low  float64
	}
	var best *cand
	for i := range total {
		if !w.own(i) || w.height[i] < h.Cliff {
			continue
		}
		for axis := range 3 {
			// Only from the run's first hexagon, so that each run is seen once.
			if b := g.step(i, axis+3); b >= 0 && w.land[b] {
				continue
			}
			run := []int32{i}
			at := g.step(i, axis)
			for at >= 0 && w.land[at] && len(run) <= h.Arch.Neck {
				run = append(run, at)
				at = g.step(at, axis)
			}
			if at < 0 || w.land[at] || len(run) > h.Arch.Neck {
				continue
			}
			low := w.height[i]
			ok := true
			for _, j := range run {
				low = min(low, w.height[j])
				if !w.own(j) || w.height[j] < h.Cliff {
					ok = false
				}
			}
			if !ok || best != nil && low <= best.low {
				continue
			}
			if !m.isNeck(w, run) {
				continue
			}
			best = &cand{run: run, axis: axis, low: low}
		}
	}
	if best == nil {
		return
	}
	under := float64(best.low * s.in(h.Arch.Underside[0], h.Arch.Underside[1]))
	mid := best.run[len(best.run)/2]
	x0, y0 := g.centre(best.run[0])
	x1, y1 := g.centre(best.run[len(best.run)-1])
	heading := headingTo(x0, y0, x1, y1)
	if len(best.run) == 1 {
		x1, y1 = g.centre(g.step(best.run[0], best.axis))
		heading = headingTo(x0, y0, x1, y1)
	}
	span := float64(float64(len(best.run)) * physics.HexAcross)
	m.addFeature(k, mid, heading, span, w.height[mid]).cells = slices.Clone(best.run)
	for _, i := range best.run {
		c.roof(s, m, w, i, under)
	}
}

// neckReach is how many hexagons a side of a neck may hold and still be
// a headland's tip.
const neckReach = 800

// isNeck reports whether run joins a headland's tip, of a few hexagons at
// least and at most neckReach, to the rest of the island: the land beside
// it, with it taken away, falls apart in two.
func (m *made) isNeck(w *work, run []int32) bool {
	g := &m.grid
	in := func(i int32) bool { return slices.Contains(run, i) }
	var sides []int32
	var nb [6]int32
	for _, i := range run {
		n := g.neighbours(i, &nb)
		for _, j := range nb[:n] {
			if w.land[j] && !in(j) && !slices.Contains(sides, j) {
				sides = append(sides, j)
			}
		}
	}
	if len(sides) < 2 {
		return false
	}
	// The land reached from a side, without the run, up to the limit.
	reach := func(from int32) (map[int32]bool, bool) {
		seen := map[int32]bool{from: true}
		queue := []int32{from}
		for len(queue) > 0 {
			i := queue[0]
			queue = queue[1:]
			n := g.neighbours(i, &nb)
			for _, j := range nb[:n] {
				if !w.land[j] || in(j) || seen[j] {
					continue
				}
				seen[j] = true
				if len(seen) > neckReach {
					return seen, false
				}
				queue = append(queue, j)
			}
		}
		return seen, true
	}
	for _, from := range sides {
		seen, whole := reach(from)
		if !whole {
			continue
		}
		// A tip: every side not in it is the rest's.
		apart := false
		for _, o := range sides {
			if !seen[o] {
				apart = true
			}
		}
		return apart && len(seen) >= 3
	}
	return false
}
