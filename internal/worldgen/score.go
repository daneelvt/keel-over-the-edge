// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

// Worth seeing. Every island is scored by the seven key factors of the US
// Bureau of Land Management's Scenic Quality Field Inventory (Form 8400-1;
// Handbook H-8410-1), each over the form's own range, in halves, from the
// island's own measures: landform ("high vertical relief as expressed in
// prominent cliffs, spires, or massive rock outcrops" 5; "cinder cones …
// or interesting erosional patterns" 3; "low rolling hills" 1), vegetation
// ("a variety of vegetative types" 5; "one or two major types" 3), water
// ("cascading white water … a dominant factor" 5; "flowing, or still, but
// not dominant" 3; "absent" 0), colour, adjacent scenery, scarcity ("one
// of a kind … very rare within region" 5; "distinctive, though somewhat
// similar to others" 3; "fairly common" 1) and cultural modifications (to
// 2). A total of 19 or more is class A, 12 to 18 class B, 11 or less class
// C; a total of 11.5 or 18.5 is reassessed half a point either way, here by
// the factor the next class turns on: a scarce feature at 18.5, water at
// 11.5. The catalog holds what each factor reads and how much.

// Scenery is an island's scenic quality by each of the seven factors.
type Scenery struct {
	Landform   float64 `json:"landform"`
	Vegetation float64 `json:"vegetation"`
	Water      float64 `json:"water"`
	Colour     float64 `json:"colour"`
	Adjacent   float64 `json:"adjacent"`
	Scarcity   float64 `json:"scarcity"`
	Cultural   float64 `json:"cultural"`
}

// sum is the scenery's total.
func (s Scenery) sum() float64 {
	return s.Landform + s.Vegetation + s.Water + s.Colour + s.Adjacent + s.Scarcity + s.Cultural
}

// halves is v to the nearest half.
func halves(v float64) float64 { return float64(round(float64(v*2))) / 2 }

// scoreIslands scores every island of the bundle and classes it.
func (c *config) scoreIslands(b *Bundle, islands []*made, pw *placesWork) {
	lit := map[int32]bool{}
	for _, s := range pw.sites {
		if (s.rule == catalog.SiteLight || s.light >= 0) && s.island >= 0 {
			lit[s.island] = true
		}
	}
	towned := map[int32]bool{}
	for _, t := range b.Towns {
		towned[t.Island] = true
	}
	for i, m := range islands {
		sc := c.scenery(m, islands, lit[m.number], towned[m.number])
		is := &b.Islands[i]
		is.Scenery = sc
		is.Score = sc.sum()
		is.Class = c.classOf(sc)
	}
}

// classOf is the class of an island of the scenery given.
func (c *config) classOf(sc Scenery) string {
	total := sc.sum()
	cl := &c.score.Classes
	switch {
	case total == cl.A-0.5:
		if sc.Scarcity >= 3 {
			total = cl.A
		}
	case total == cl.B-0.5:
		if sc.Water >= 3 {
			total = cl.B
		}
	}
	switch {
	case total >= cl.A:
		return "A"
	case total >= cl.B:
		return "B"
	}
	return "C"
}

// scenery is island m's scenery among the islands given: lit is whether a
// lighthouse stands on it, towned whether a town does.
func (c *config) scenery(m *made, islands []*made, lit, towned bool) Scenery {
	sc := &c.score
	g := &m.grid
	var sum Scenery
	// What a sailor sees of it: its features in view of water a boat
	// reaches, as the form rates what is seen from where it is seen.
	has := func(site catalog.FeatureSite) bool { return c.seesSite(m, site) }

	// Landform: relief, cliffs, twin summits, stacks, and what the sea and
	// the fire made.
	lf := &sc.Landform
	relief := float64(2 * clamp((m.highest-lf.Relief[0])/max(lf.Relief[1]-lf.Relief[0], 1e-6), 0, 1))
	land := 1 + relief
	if m.cliffs >= lf.Cliffs {
		land++
	}
	if m.twin {
		land += lf.Twin
	}
	if m.stacks > 0 {
		land += lf.Stacks
	}
	if has(catalog.FeatureSiteCave) || has(catalog.FeatureSiteBlowhole) {
		land += lf.Cave
	}
	if has(catalog.FeatureSiteArch) {
		land += lf.Arch
	}
	if has(catalog.FeatureSiteCrater) {
		land += lf.Crater
	}
	sum.Landform = halves(min(land, 5))

	// Vegetation and colour: the surfaces covering enough of its land, and
	// the plants' crowns.
	counts := map[uint8]int{}
	own := 0
	for i := range g.w * g.h {
		if g.elev[i] > 0 && m.ownLand(i) {
			counts[g.surf[i]]++
			own++
		}
	}
	var types []catalog.Form
	var crowns []float64
	colours := 0
	var sulphur, guano bool
	for s := range uint8(len(c.canopy)) {
		n := counts[s]
		if n == 0 {
			continue
		}
		sulphur = sulphur || s == c.featureSurface.sulphur
		guano = guano || s == c.featureSurface.guano
		share := float64(n) / float64(max(own, 1))
		for _, f := range c.cover[s] {
			t := majorType(f.form)
			k := slices.Index(types, t)
			if k < 0 {
				types = append(types, t)
				crowns = append(crowns, 0)
				k = len(types) - 1
			}
			crowns[k] += float64(share * f.share)
		}
		if share >= sc.Colour.Least && !c.isTownSurface(s) {
			colours++
		}
	}
	major := 0
	for _, cr := range crowns {
		if cr >= vegetationLeast {
			major++
		}
	}
	veg := sc.Vegetation
	sum.Vegetation = veg[min(major, len(veg)-1)]
	lagoon := m.reef && m.lagoon >= 40
	col := 1 + float64(float64(colours)*sc.Colour.Each)
	if lagoon {
		col += sc.Colour.Lagoon
	}
	if sulphur {
		col += sc.Colour.Sulphur
	}
	if guano {
		col += sc.Colour.Guano
	}
	sum.Colour = halves(min(col, 5))

	// Water: the best of what it has.
	wt := &sc.Water
	water := 0.0
	if has(catalog.FeatureSiteWaterfall) {
		water = max(water, wt.Waterfall)
	}
	if lagoon {
		water = max(water, wt.Lagoon)
	}
	if len(m.streams) > 0 {
		water = max(water, wt.Stream)
	}
	if has(catalog.FeatureSiteBlowhole) {
		water = max(water, wt.Blowhole)
	}
	if has(catalog.FeatureSiteArch) {
		water = max(water, wt.Arch)
	}
	if has(catalog.FeatureSiteCave) {
		water = max(water, wt.Cave)
	}
	sum.Water = water

	// Adjacent scenery: the islands near it, and those with features.
	adj := 0.0
	for _, o := range islands {
		if o == m || o.kind == kindRock {
			continue
		}
		gap := hypot(o.x-m.x, o.y-m.y) - o.radius - m.radius
		if gap > sc.Adjacent.Within {
			continue
		}
		adj += sc.Adjacent.Island
		if c.featured(o) {
			adj += sc.Adjacent.Featured
		}
	}
	sum.Adjacent = halves(min(adj, 5))

	// Scarcity: its rarest kind of feature within its region, springs
	// aside.
	sum.Scarcity = 1
	for _, f := range m.features {
		if !f.sighted || c.siteOf(f) == catalog.FeatureSiteSpring {
			continue
		}
		others := 0
		for _, o := range islands {
			if o != m && hypot(o.x-m.x, o.y-m.y) <= sc.Scarcity.Region && slices.ContainsFunc(o.features, func(g *featureWork) bool { return g.kind == f.kind }) {
				others++
			}
		}
		switch {
		case others <= sc.Scarcity.Rare:
			sum.Scarcity = 5
		case others <= sc.Scarcity.Few:
			sum.Scarcity = max(sum.Scarcity, 3)
		}
	}

	// Cultural modifications that add to it.
	cu := 0.0
	if has(catalog.FeatureSiteRuin) {
		cu += sc.Cultural.Ruin
	}
	if lit {
		cu += sc.Cultural.Light
	}
	if towned {
		cu += sc.Cultural.Town
	}
	sum.Cultural = min(cu, 2)
	return sum
}

// vegetationLeast is the share of an island's land a major type of plant's
// crowns must cover to count.
const vegetationLeast = 0.02

// majorType is the major type of vegetation a form of plant is: each form
// of tree its own; a shrub and a stunted tree the shrubs.
func majorType(f catalog.Form) catalog.Form {
	if f == catalog.FormKrummholz {
		return catalog.FormShrub
	}
	return f
}

// featured reports whether island m has a feature in view besides
// springs, which are not seen.
func (c *config) featured(m *made) bool {
	for _, f := range m.features {
		if f.sighted && c.siteOf(f) != catalog.FeatureSiteSpring {
			return true
		}
	}
	return false
}
