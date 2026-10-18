// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Ruins, a few a world, on medium and large islands, out of any town: what the
// names ask for, a chapel (Chapel Cay), a beacon or signal station (Beacon
// Cay, Watchfire Isle, Old Signal Isle) and a lost town (Antillia,
// Lyonesse). Smyth's beacon is also "a signal-mark placed on the top of
// hills … near the shore for the safe guidance of shipping"; his look-out
// a watch kept "for any strange sail heaving in sight". Abandoned colonies
// stood ruined in the period: Providence Island, taken in 1641 and "not
// resettled again until 1789". A beacon stands on its island's highest
// ground near the coast; a chapel on gentle ground above the shore; a
// deserted hamlet's roofless houses about its dry well on gentle ground by
// a beach, each on a levelled plot with a path to the well, as a village's
// are. They are built from their island's biome's kit, and named by
// nothing of their own: the island shows ruins.

// ruinTown is a ruin's buildings' town: none.
const ruinTown = 255

// ruinSteep is the steepest ground, 1 in ruinSteep, a ruin's plot is
// levelled on.
const ruinSteep = 2

// ruinsOf chooses the world's ruins: of the kinds each island's biome has,
// its best site for each, drawn by the kinds' weights and the islands'
// zones, at most one an island, apart from each other.
func (c *config) ruinsOf(seed uint64, pw *placesWork) {
	s := newStream(seed, streamRuins)
	rf := &c.features.ruins
	want := s.pick(rf.Count[0], rf.Count[1])
	type cand struct {
		m      *made
		kind   int
		at     int32
		high   float64
		weight float64
	}
	var cands []cand
	for _, m := range pw.islands {
		if m.kind != kindIsland && m.kind != kindLandmark || !slices.Contains(rf.Sizes, c.sizeOf(m.area)) {
			continue
		}
		z := c.zoneOf(hypot(m.x, m.y))
		for k := range c.features.kinds {
			fk := &c.features.kinds[k]
			if fk.site != catalog.FeatureSiteRuin || !fk.biomes[m.biome] {
				continue
			}
			at, high, ok := c.ruinSite(pw, m, fk.ruin, c.ruinHeight(fk.ruin))
			if !ok {
				continue
			}
			cands = append(cands, cand{m: m, kind: k, at: at, high: high, weight: float64(fk.chance * fk.zones[z])})
		}
	}
	for n := 0; n < want && len(cands) > 0; n++ {
		w := make([]float64, len(cands))
		for i := range cands {
			w[i] = cands[i].weight
		}
		i := s.weighted(w)
		if i < 0 {
			break
		}
		cd := cands[i]
		x, y := cd.m.grid.centre(cd.at)
		heading := c.seaward(pw, cd.m, cd.at)
		reach := 10.0
		if c.features.kinds[cd.kind].ruin == catalog.RuinHamlet {
			reach = 40
		}
		f := cd.m.addFeature(cd.kind, cd.at, heading, reach, cd.high)
		// What is seen of it is its tallest building.
		f.seen = cd.high + c.ruinHeight(c.features.kinds[cd.kind].ruin)
		cands = slices.DeleteFunc(cands, func(o cand) bool {
			ox, oy := o.m.grid.centre(o.at)
			return o.m == cd.m || hypot(ox-x, oy-y) < rf.Apart
		})
	}
}

// ruinHeight is how high the tallest building of a ruin of the kind given
// stands, m.
func (c *config) ruinHeight(ruin catalog.Ruin) float64 {
	h := 0.0
	for _, k := range c.standing(catalog.Stands(ruin)) {
		h = max(h, k.height(1))
	}
	return h
}

// ruinTries is how many of an island's best sites for a ruin are looked at
// for one in view of the water.
const ruinTries = 12

// ruinSite is island m's site for a ruin of the kind given, standing high
// m: a beacon's highest ground near the coast; a chapel's highest gentle
// ground above the shore; a hamlet's gentle ground by a beach with the
// most room; the best of them in view of water a boat reaches. It gives
// the hexagon of its grid and how high it stands.
func (c *config) ruinSite(pw *placesWork, m *made, ruin catalog.Ruin, high float64) (int32, float64, bool) {
	g := &m.grid
	rf := &c.features.ruins
	steep := c.places.Harbour.Steep
	type cand struct {
		i     int32
		score float64
	}
	var cands []cand
	for i := range g.w * g.h {
		if !m.ownLand(i) || i%3 != 0 || g.elev[i] <= 0 || c.isTownSurface(g.surf[i]) {
			continue
		}
		x, y := g.centre(i)
		inland := m.inland(i)
		h := float64(g.elev[i]) / 10
		var score float64
		switch ruin {
		case catalog.RuinBeacon:
			if inland > rf.Beacon || h < 6 || roomOf(pw.ground, x, y, 6, steep) < 3 {
				continue
			}
			score = h
		case catalog.RuinChapel:
			if inland < 25 || inland > 150 || roomOf(pw.ground, x, y, 14, steep) < 14 {
				continue
			}
			score = h
		case catalog.RuinHamlet:
			if inland < 15 || inland > 70 || !m.beachNear(c, i) {
				continue
			}
			score = float64(roomOf(pw.ground, x, y, 35, steep))
			if score < 50 {
				continue
			}
		}
		cands = append(cands, cand{i, score})
	}
	slices.SortStableFunc(cands, func(a, b cand) int { return cmpDesc(a.score, b.score) })
	for k, cd := range cands {
		if k >= ruinTries {
			break
		}
		x, y := g.centre(cd.i)
		h := float64(g.elev[cd.i]) / 10
		if _, _, ok := pw.sighting(x, y, h+high, c.validator.Features.Seen); ok {
			return cd.i, h, true
		}
	}
	return -1, 0, false
}

// keepInland keeps island m's distances inland on the box its land lies
// in, for its ruins' sites.
func (m *made) keepInland(w *work) {
	g := &m.grid
	c0, j0, c1, j1 := g.w, g.h, int32(-1), int32(-1)
	for i := range g.w * g.h {
		if w.land[i] {
			cc, jj := i/g.h, i%g.h
			c0, j0, c1, j1 = min(c0, cc), min(j0, jj), max(c1, cc), max(j1, jj)
		}
	}
	if c1 < 0 {
		return
	}
	m.dinBox = [4]int32{c0, j0, c1 - c0 + 1, j1 - j0 + 1}
	m.din = make([]float32, m.dinBox[2]*m.dinBox[3])
	for cc := c0; cc <= c1; cc++ {
		for jj := j0; jj <= j1; jj++ {
			m.din[(cc-c0)*m.dinBox[3]+jj-j0] = float32(w.din[cc*g.h+jj])
		}
	}
}

// boxed is hexagon i of island m's grid on its land's box, or -1 off it.
func (m *made) boxed(i int32) int32 {
	g := &m.grid
	cc, jj := i/g.h-m.dinBox[0], i%g.h-m.dinBox[1]
	if cc < 0 || jj < 0 || cc >= m.dinBox[2] || jj >= m.dinBox[3] {
		return -1
	}
	return cc*m.dinBox[3] + jj
}

// inland is how far hexagon i of island m's grid is from the sea as its
// shape was drawn, m; 0 off its land.
func (m *made) inland(i int32) float64 {
	if k := m.boxed(i); k >= 0 {
		return float64(m.din[k])
	}
	return 0
}

// beachNear reports whether island m has beach within beachReach of
// hexagon i: worked out for the land's box when first asked for, by the
// steps from hexagon to hexagon.
func (m *made) beachNear(c *config, i int32) bool {
	g := &m.grid
	if m.beach == nil && m.din != nil {
		box := m.dinBox
		m.beach = make([]bool, box[2]*box[3])
		beach := c.biomes[m.biome].surfaces.beach
		steps := make([]int32, len(m.beach))
		var queue []int32
		for k := range int32(len(steps)) {
			steps[k] = -1
			gi := (box[0]+k/box[3])*g.h + box[1] + k%box[3]
			if g.elev[gi] > 0 && g.surf[gi] == beach {
				steps[k] = 0
				queue = append(queue, gi)
			}
		}
		most := toInt32(beachReach / physics.HexAcross)
		var nb [6]int32
		for head := 0; head < len(queue); head++ {
			at := queue[head]
			s := steps[m.boxed(at)]
			m.beach[m.boxed(at)] = true
			if s >= most {
				continue
			}
			n := g.neighbours(at, &nb)
			for _, j := range nb[:n] {
				if k := m.boxed(j); k >= 0 && steps[k] < 0 {
					steps[k] = s + 1
					queue = append(queue, j)
				}
			}
		}
	}
	k := m.boxed(i)
	return k >= 0 && m.beach != nil && m.beach[k]
}

// beachReach is how near a deserted hamlet's beach is, m.
const beachReach = 90

// seaward is the heading from hexagon i of island m's grid to its nearest
// water.
func (c *config) seaward(pw *placesWork, m *made, i int32) float64 {
	g := &m.grid
	x, y := g.centre(i)
	bx, by, best := x, y+1, 1e9
	for _, j := range m.near(i, 200, func(j int32) bool { return g.elev[j] <= 0 }) {
		if jx, jy := g.centre(j); hypot(jx-x, jy-y) < best {
			bx, by, best = jx, jy, hypot(jx-x, jy-y)
		}
	}
	return headingTo(x, y, bx, by)
}

// layRuins lays out the world's ruins' buildings, once the towns are laid:
// a beacon's watch-house, a chapel, a hamlet's houses about its well with
// their paths; each plot levelled, each facing the sea or the well; none
// on a town's building or way.
func (c *config) layRuins(seed uint64, g *physics.Ground, pw *placesWork, lights []*lightWork, towns []Building) []Building {
	var out []Building
	n := 0
	for _, m := range pw.islands {
		for _, f := range m.features {
			fk := &c.features.kinds[f.kind]
			if fk.site != catalog.FeatureSiteRuin {
				continue
			}
			n++
			s := newStream(seed, streamRuins+uint64(n)<<8)
			kinds := c.standing(catalog.Stands(fk.ruin))
			var house, well *buildingKind
			for _, k := range kinds {
				if k.prop {
					well = k
				} else {
					house = k
				}
			}
			if house == nil {
				continue
			}
			// Its grid reaches the shore, which a ruin keeps back from.
			tw := c.newTownWork(g, s, string(fk.ruin), m, f.x, f.y, c.features.ruins.Beacon+60, func(int32, float64, float64) bool { return true })
			tw.town = &Town{Number: ruinTown}
			// A ruin's plot is cut into what slopes there.
			tw.steep = ruinSteep
			tw.markTowers(lights)
			tw.markTaken(towns)
			sa, ca := sincos(f.heading)
			// What it faces: the sea, or a hamlet's well.
			fx, fy := f.x+float64(100*sa), f.y+float64(100*ca)
			switch fk.ruin {
			case catalog.RuinHamlet:
				if well != nil {
					tw.prop(well, f.x, f.y, f.heading)
				}
				houses := tw.scatter(house, s.pick(c.features.ruins.Hamlet[0], c.features.ruins.Hamlet[1]), f.x, f.y, 35, 8, math.Inf(1), 9, f.x, f.y)
				tw.paths(houses, f.x, f.y)
			default:
				tw.scatter(house, 1, f.x, f.y, 25, 6, math.Inf(1), 0, fx, fy)
			}
			tw.writeBack(g)
			out = append(out, tw.buildings...)
		}
	}
	return out
}
