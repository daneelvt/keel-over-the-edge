// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Seabird colonies, a few a world, each where its birds nest: northern
// gannets on stacks and cliff ledges, "white-capped from years of guano"
// (Bird Rock, Cape St Mary's, Newfoundland: about 30,000 birds); brown
// boobies on cays and cliffs (Cayman Brac's East Lighthouse Cliffs);
// frigatebirds roosting in mangroves and trees (Half Moon Caye). Smyth's
// booby "is fond of resting out of the water at night"; his gannet is "the
// solan goose … common on the Scottish coasts". A colony on rock whitens
// it. The towns keep clear of it.

// colonyWheel is how high over their nests a colony's birds are seen, m.
const colonyWheel = 15

// colonySite is where a colony of some kind could nest on an island: its
// hexagons, the one it is marked at, how high, and on what.
type colonySite struct {
	cells []int32
	at    int32
	high  float64
	nest  catalog.Nest
}

// coloniesOf chooses the world's colonies from its islands' sites for
// them, each island's best for each kind its biome has, drawn by the
// kinds' weights and the islands' zones; at most one an island; and
// whitens their rock.
func (c *config) coloniesOf(seed uint64, pw *placesWork) {
	s := newStream(seed, streamColonies)
	cf := &c.features.colonies
	want := s.pick(cf.Count[0], cf.Count[1])
	type cand struct {
		m      *made
		kind   int
		site   colonySite
		weight float64
	}
	var cands []cand
	for _, m := range pw.islands {
		if m.kind == kindMain {
			continue
		}
		z := c.zoneOf(hypot(m.x, m.y))
		for k := range c.features.kinds {
			fk := &c.features.kinds[k]
			if fk.site != catalog.FeatureSiteColony || !fk.biomes[m.biome] {
				continue
			}
			site, ok := c.colonySiteOn(m, fk.birds.Nests)
			if !ok {
				continue
			}
			cands = append(cands, cand{m: m, kind: k, site: site, weight: float64(fk.chance * fk.zones[z])})
		}
	}
	var chosen []cand
	for len(chosen) < want && len(cands) > 0 {
		w := make([]float64, len(cands))
		for i := range cands {
			w[i] = cands[i].weight
		}
		i := s.weighted(w)
		if i < 0 {
			break
		}
		cd := cands[i]
		chosen = append(chosen, cd)
		// One an island.
		cands = slices.DeleteFunc(cands, func(o cand) bool { return o.m == cd.m })
	}
	for _, cd := range chosen {
		m := cd.m
		birds := int32(s.pick(cf.Birds[0], cf.Birds[1]))
		wheel := s.in(cf.Wheel[0], cf.Wheel[1])
		x, y := m.grid.centre(cd.site.at)
		f := m.addFeature(cd.kind, cd.site.at, 0, wheel, cd.site.high)
		f.birds = birds
		// The birds are seen wheeling over it.
		f.seen = cd.site.high + colonyWheel
		f.parts = append(f.parts, Part{X: x, Y: y, Level: cd.site.high, Size: wheel, Count: uint16(birds),
			Seed: uint8(s.r.IntN(256))})
		if cd.site.nest == catalog.NestTrees {
			continue
		}
		g := &m.grid
		for _, i := range cd.site.cells {
			g.surf[i] = c.featureSurface.guano
			setSurface(pw.ground, g.c0+i/g.h, g.j0+i%g.h, c.featureSurface.guano)
		}
	}
}

// setSurface sets the ground's surface at column c and row j, if it holds
// that chunk.
func setSurface(g *physics.Ground, c, j int32, s uint8) {
	if n, i, ok := physics.ChunkOf(c, j); ok && g.Chunks[n] != nil {
		g.Chunks[n].Surface[i] = s
	}
}

// colonySiteOn is island m's best site for birds that nest where nests
// says: its tallest stack, its highest cliff's ledges, the top of a cay,
// or the largest stand of mangroves.
func (c *config) colonySiteOn(m *made, nests []catalog.Nest) (colonySite, bool) {
	g := &m.grid
	total := g.w * g.h
	var best colonySite
	found := false
	better := func(s colonySite) {
		if !found || s.high > best.high {
			best, found = s, true
		}
	}
	for _, nest := range nests {
		switch nest {
		case catalog.NestStack:
			// The highest hexagon of a stack, and its stack's others about it.
			top := int32(-1)
			for i := range total {
				if g.elev[i] > 0 && !m.ownLand(i) && (top < 0 || g.elev[i] > g.elev[top]) {
					top = i
				}
			}
			if top >= 0 && g.elev[top] >= 50 {
				better(colonySite{cells: m.near(top, 8, func(i int32) bool { return g.elev[i] > 0 && !m.ownLand(i) }),
					at: top, high: float64(g.elev[top]) / 10, nest: nest})
			}
		case catalog.NestCliff:
			// The highest of its coast's cliffs, 10 m or more, and its ledges
			// along the coast about it.
			top := int32(-1)
			for i := range total {
				if m.ownLand(i) && g.elev[i] >= 100 && m.coastal(i) && (top < 0 || g.elev[i] > g.elev[top]) {
					top = i
				}
			}
			if top >= 0 {
				better(colonySite{cells: m.near(top, 14, func(i int32) bool { return m.ownLand(i) && m.coastal(i) && g.elev[i] >= 60 }),
					at: top, high: float64(g.elev[top]) / 10, nest: nest})
			}
		case catalog.NestCay:
			// A cay: a small, low island, or a rock of a group; its top.
			if m.kind != kindRock && (m.area > 8000 || m.highest > 8) {
				continue
			}
			top := int32(-1)
			for i := range total {
				if g.elev[i] > 0 && (top < 0 || g.elev[i] > g.elev[top]) {
					top = i
				}
			}
			if top >= 0 {
				better(colonySite{cells: m.near(top, 12, func(i int32) bool { return g.elev[i] > 0 }),
					at: top, high: float64(g.elev[top]) / 10, nest: nest})
			}
		case catalog.NestTrees:
			// Mangroves, the most of them within 30 m of one.
			var stand []int32
			for i := range total {
				if g.elev[i] > 0 && g.surf[i] == c.featureSurface.mangrove {
					stand = append(stand, i)
				}
			}
			bestAt, most := int32(-1), 0
			for k, i := range stand {
				if k%4 != 0 {
					continue
				}
				x, y := g.centre(i)
				n := 0
				for _, j := range stand {
					if jx, jy := g.centre(j); hypot(jx-x, jy-y) <= 30 {
						n++
					}
				}
				if n > most {
					bestAt, most = i, n
				}
			}
			if bestAt >= 0 && most >= 12 {
				better(colonySite{at: bestAt, high: float64(g.elev[bestAt])/10 + 6, nest: nest})
			}
		}
	}
	return best, found
}

// apart is how far apart hexagons i and j of island m's grid are, m.
func (m *made) apart(i, j int32) float64 {
	x0, y0 := m.grid.centre(i)
	x1, y1 := m.grid.centre(j)
	return hypot(x1-x0, y1-y0)
}

// coastal reports whether hexagon i of island m's grid is beside water.
func (m *made) coastal(i int32) bool {
	g := &m.grid
	var nb [6]int32
	k := g.neighbours(i, &nb)
	for _, j := range nb[:k] {
		if g.elev[j] <= 0 {
			return true
		}
	}
	return false
}

// near lists the hexagons of island m's grid within r m of hexagon i that
// ok accepts.
func (m *made) near(i int32, r float64, ok func(j int32) bool) []int32 {
	g := &m.grid
	x, y := g.centre(i)
	n := toInt32(r/physics.HexAcross) + 1
	cc, jj := i/g.h, i%g.h
	var out []int32
	for dc := -n - 1; dc <= n+1; dc++ {
		for dj := -n - 1; dj <= n+1; dj++ {
			c, j := cc+dc, jj+dj
			if c < 0 || j < 0 || c >= g.w || j >= g.h {
				continue
			}
			k := c*g.h + j
			if hx, hy := g.centre(k); hypot(hx-x, hy-y) <= r && ok(k) {
				out = append(out, k)
			}
		}
	}
	return out
}
