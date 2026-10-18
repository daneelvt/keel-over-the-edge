// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"fmt"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The features' rules: a world has a feature of every site the catalog
// asks for, enough islands worth seeing, spread over the disk, none of
// them hidden from the water a boat reaches; each biome's islands have
// what that biome always has; and every feature is sound.

// featureRules are the features' and the scores' rules.
func (c *config) featureRules(w *world) []Rule {
	var rules []Rule
	add := func(name string, pass bool, measured, wants string, args ...any) {
		rules = append(rules, Rule{Name: name, Measured: measured, Wants: fmt.Sprintf(wants, args...), Pass: pass})
	}
	v := &c.validator.Features
	b := w.records

	// A feature of every site.
	var missing []string
	for _, site := range v.Sites {
		found := false
		for _, m := range w.islands {
			if c.hasSite(m, site) {
				found = true
				break
			}
		}
		if !found {
			missing = append(missing, string(site))
		}
	}
	counts := map[catalog.FeatureSite]int{}
	for _, m := range w.islands {
		for _, f := range m.features {
			counts[c.siteOf(f)]++
		}
	}
	var measured []string
	for _, site := range v.Sites {
		measured = append(measured, fmt.Sprintf("%s %d", site, counts[site]))
	}
	add("features of every site", len(missing) == 0, strings.Join(measured, ", "), "at least one of each%s", suffix(missing))

	// Islands worth seeing, in the middle waters and at the rim.
	var a, middle, rim int
	for i := range b.Islands {
		is := &b.Islands[i]
		if is.Class != "A" {
			continue
		}
		a++
		switch is.Zone {
		case zoneNames[1]:
			middle++
		case zoneNames[2]:
			rim++
		}
	}
	add("islands worth seeing", a >= v.ClassA && middle >= v.Middle && rim >= v.Rim,
		fmt.Sprintf("%d of class A, %d in the middle waters, %d at the rim", a, middle, rim),
		"at least %d, %d and %d", v.ClassA, v.Middle, v.Rim)

	// None hidden: each class A island's best feature in view of water a
	// boat reaches. The score counts only what is in view, so it is the
	// best of those, and an island with none in view is hidden.
	var hidden []string
	for i := range min(len(b.Islands), len(w.islands)) {
		if b.Islands[i].Class != "A" {
			continue
		}
		if f := c.bestFeature(b, w.islands[i]); f == nil || !f.Seen {
			hidden = append(hidden, b.Islands[i].Name)
		}
	}
	add("none hidden", len(hidden) == 0, fmt.Sprintf("%d hidden", len(hidden)),
		"each class A island's best feature seen from water a boat reaches within %.0f m%s", v.Seen, suffix(hidden[:min(len(hidden), 5)]))

	// What each biome always has.
	lacking := c.lacking(w)
	add("biomes' qualities", len(lacking) == 0, fmt.Sprintf("%d islands lacking", len(lacking)),
		"each island what its biome always has%s", suffix(lacking[:min(len(lacking), 5)]))

	// Every feature sound.
	unsound := c.unsoundFeatures(w)
	add("features sound", len(unsound) == 0, fmt.Sprintf("%d unsound", len(unsound)),
		"none in a town; every roof over rock awash; every stream to the sea; every fall high enough; every ruin built%s",
		suffix(unsound[:min(len(unsound), 5)]))

	// The ruins and colonies a world has.
	var ruins, colonies int
	for _, m := range w.islands {
		for _, f := range m.features {
			switch c.siteOf(f) {
			case catalog.FeatureSiteRuin:
				ruins++
			case catalog.FeatureSiteColony:
				colonies++
			}
		}
	}
	rf, cf := &c.features.ruins, &c.features.colonies
	add("ruins and colonies", ruins >= rf.Count[0] && ruins <= rf.Count[1] && colonies >= cf.Count[0] && colonies <= cf.Count[1],
		fmt.Sprintf("%d ruins, %d colonies", ruins, colonies), "%d–%d ruins, %d–%d colonies", rf.Count[0], rf.Count[1], cf.Count[0], cf.Count[1])
	return rules
}

// bestFeature is island m's best feature in view, as its record: the kind
// fewest islands of its world have, springs aside; nil if it has none in
// view.
func (c *config) bestFeature(b *Bundle, m *made) *Feature {
	having := make([]int, len(c.features.kinds))
	for i := range b.Features {
		having[slices.IndexFunc(c.features.kinds, func(k featureKind) bool { return k.id == b.Features[i].Kind })]++
	}
	var best *Feature
	bestN := 0
	for i := range b.Features {
		f := &b.Features[i]
		if f.Island != m.number {
			continue
		}
		k := slices.IndexFunc(c.features.kinds, func(k featureKind) bool { return k.id == f.Kind })
		if !f.Seen || c.features.kinds[k].site == catalog.FeatureSiteSpring {
			continue
		}
		if best == nil || having[k] < bestN {
			best, bestN = f, having[k]
		}
	}
	return best
}

// lacking lists the islands that lack what their biome always has: a
// sandy cay's beaches and its lowness; a tropical island's fringing reef
// and its strand; a wooded island's woods; a rocky island's cliffs, and no
// trees but tuckamore; a volcanic island's cone and crater, and its
// fumaroles while it is young.
func (c *config) lacking(w *world) []string {
	var out []string
	for i, m := range w.islands {
		if m.kind == kindRock || m.kind == kindMain {
			continue
		}
		b := &c.biomes[m.biome]
		g := &m.grid
		var land, wooded, trees int
		for k := range g.w * g.h {
			if g.elev[k] <= 0 || !m.ownLand(k) {
				continue
			}
			land++
			s := g.surf[k]
			if c.isTownSurface(s) {
				continue
			}
			if c.canopy[s] >= 10 {
				wooded++
			}
			for _, f := range c.cover[s] {
				if majorType(f.form) != catalog.FormShrub && f.form != catalog.FormTuft {
					trees++
					break
				}
			}
		}
		name := w.names[i]
		switch {
		case !b.reef && b.bars && b.cliffs[1] == 0:
			// Sandy: low, and its bars in its shallows.
			if m.highest > b.height[1]+1 || m.barAt == 0 {
				out = append(out, name+": not a low cay with its bars")
			}
		case b.reef:
			if !m.reef {
				out = append(out, name+": no fringing reef")
			}
		case b.cone > 0:
			if m.cone == nil || !c.hasSite(m, catalog.FeatureSiteCrater) {
				out = append(out, name+": no cone with its crater")
			} else if m.cone.age == ageYoung && !c.hasSite(m, catalog.FeatureSiteFumarole) {
				out = append(out, name+": young, and not smoking")
			}
		case b.cliffs[0] >= 0.5:
			if trees > 0 {
				out = append(out, name+": trees on it")
			}
		case b.surfaces.high != b.surfaces.low && c.canopy[b.surfaces.high] >= 10:
			// Wooded: woods on its high ground, on an island high enough to
			// have it.
			if m.highest > 8 && land > 200 && wooded == 0 {
				out = append(out, name+": no woods")
			}
		}
	}
	return out
}

// townSite is where a town's site is: its place's, or for Port Royal its
// waterfront's middle.
func townSite(w *world, t *Town) (float64, float64) {
	for i := range w.places {
		if w.places[i].Number == t.Place {
			return w.places[i].X, w.places[i].Y
		}
	}
	return t.X, t.Y
}

// townReach is how far a town of the kind given reaches from its
// waterfront, m.
func (c *config) townReach(kind string) float64 {
	switch kind {
	case townMain:
		return c.towns.Plan.Reach[0]
	case townPort:
		return c.towns.Plan.Reach[1]
	}
	return c.towns.Plan.Reach[2]
}

// unsoundFeatures lists what is wrong with the world's features: one in a
// town's reach of its site; a roof not over rock awash; a stream that does not reach
// the sea; a fall whose lip is too low; a ruin not built.
func (c *config) unsoundFeatures(w *world) []string {
	var bad []string
	built := map[int32]int{} // ruins' buildings, by island
	for _, bd := range w.buildings {
		if bd.Town == ruinTown && !c.buildings[bd.Kind].prop {
			q, r := physics.HexAt(bd.X, bd.Y)
			for _, m := range w.islands {
				g := &m.grid
				cc, jj := physics.HexCell(q, r)
				if cc >= g.c0 && jj >= g.j0 && cc < g.c0+g.w && jj < g.j0+g.h && g.elev[(cc-g.c0)*g.h+(jj-g.j0)] > 0 {
					built[m.number]++
					break
				}
			}
		}
	}
	for _, m := range w.islands {
		for _, f := range m.features {
			fk := &c.features.kinds[f.kind]
			if fk.site != catalog.FeatureSiteSpring && fk.site != catalog.FeatureSiteCrater && fk.site != catalog.FeatureSiteFumarole {
				for _, t := range w.towns {
					if x, y := townSite(w, &t); hypot(x-f.x, y-f.y) < c.townReach(t.Kind) {
						bad = append(bad, fmt.Sprintf("%s in %s", fk.id, t.Name))
					}
				}
			}
			switch fk.site {
			case catalog.FeatureSiteWaterfall:
				if f.height < c.features.streams.Fall {
					bad = append(bad, fmt.Sprintf("%s's lip %.1f m", fk.id, f.height))
				}
			case catalog.FeatureSiteRuin:
				if built[m.number] == 0 || fk.ruin == catalog.RuinHamlet && built[m.number] < c.features.ruins.Hamlet[0] {
					bad = append(bad, fmt.Sprintf("%s of %d buildings", fk.id, built[m.number]))
				}
			}
		}
		g := &m.grid
		for _, r := range m.roofs {
			e := elevationAt(w.ground, g.c0+r.i/g.h, g.j0+r.i%g.h)
			if e > 0 || float64(-e) > float64(c.features.headland.Floor[1]*10)+0.5 || r.under >= r.top {
				bad = append(bad, fmt.Sprintf("a roof over %d dm", e))
			}
		}
		for _, st := range m.streams {
			mouth := st[len(st)-1]
			if !m.coastal(mouth) {
				bad = append(bad, "a stream that does not reach the sea")
			}
			for k := 1; k < len(st); k++ {
				if !m.adjacent(st[k-1], st[k]) {
					bad = append(bad, "a stream broken")
					break
				}
			}
		}
	}
	return bad
}

// adjacent reports whether hexagons i and j of island m's grid are
// neighbours.
func (m *made) adjacent(i, j int32) bool {
	var nb [6]int32
	k := m.grid.neighbours(i, &nb)
	return slices.Contains(nb[:k], j)
}
