// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

// The places' and lights' tests: the names' lists held to the catalog's
// words, the namer over many draws, the offshore hazards, each kind's site
// on terrain made by hand and in seed 1's world, and the lights.

// TestPlaceNameLists holds the places' names to the world's words: every
// tag one the catalog or the sites have, no name twice across every list,
// the islands' included, none the main port's, a form with at most one
// place to fill, a class a specific takes that some generic has.
func TestPlaceNameLists(t *testing.T) {
	c := testConfig(t)
	l := c.lists.places
	var tones, features []string
	for _, tn := range c.names.Tones {
		tones = append(tones, tn.Word)
	}
	for _, f := range c.names.Features {
		features = append(features, f.Word)
	}
	needs := append(slices.Clone(features), needBeach, needMangrove, needSand, needRock, needDeep, needWreck)
	quals := []string{qualitySmall, qualityLarge, qualityFringing, qualityOffshore, qualityShore, qualitySnug, qualityGood, qualityLow, qualityHigh}
	sites := []string{pointSite}
	for _, s := range siteRules {
		sites = append(sites, string(s))
	}
	check := func(where, field string, got, allowed []string, any bool) {
		for _, tag := range got {
			if !slices.Contains(allowed, tag) && !(any && tag == anyTag && len(got) == 1) {
				t.Errorf("%s: %s %q is not one of %s", where, field, tag, strings.Join(allowed, ", "))
			}
		}
	}
	seen := map[string]string{strings.ToLower(c.port.name): "the main port"}
	for _, w := range c.lists.wholes {
		seen[strings.ToLower(w.name)] = "an island"
	}
	for _, g := range c.lists.groups {
		seen[strings.ToLower(g.name)] = "a group"
	}
	once := func(where, name string) {
		if was, ok := seen[strings.ToLower(name)]; ok {
			t.Errorf("%s: %q is %s's name too", where, name, was)
		}
		seen[strings.ToLower(name)] = where
	}
	for _, site := range sites {
		list := l.wholes[site]
		if len(list) == 0 {
			if site != string(catalog.SiteLight) && site != string(catalog.SiteWreck) {
				t.Errorf("no whole names for %s", site)
			}
			continue
		}
		for _, w := range list {
			where := site + " name " + w.name
			once(where, w.name)
			check(where, "qualities", w.quals, quals, false)
			check(where, "biomes", w.biomes, c.biomeIDs, true)
			check(where, "needs", w.needs, needs, false)
			check(where, "zones", w.zones, zoneNames[:], true)
			if !slices.Contains(tones, w.tone) {
				t.Errorf("%s: tone %q", where, w.tone)
			}
		}
	}
	for _, s := range l.ships {
		once("ship "+s.name, s.name)
		if !slices.Contains(tones, s.tone) {
			t.Errorf("ship %s: tone %q", s.name, s.tone)
		}
	}
	var classes []string
	for _, g := range l.generics {
		where := "generic " + g.word
		check(where, "sites", g.sites, sites, false)
		check(where, "qualities", g.quals, quals, false)
		check(where, "biomes", g.biomes, c.biomeIDs, true)
		check(where, "needs", g.needs, needs, false)
		if strings.Count(g.form, specificSlot) > 1 || strings.Contains(g.form, islandSlot) {
			t.Errorf("%s: form %q", where, g.form)
		}
		classes = append(classes, g.class)
	}
	specifics := map[string]bool{}
	for _, s := range l.specifics {
		where := "specific " + s.word
		if specifics[strings.ToLower(s.word)] {
			t.Errorf("%s: twice", where)
		}
		specifics[strings.ToLower(s.word)] = true
		check(where, "takes", s.takes, classes, false)
		check(where, "biomes", s.biomes, c.biomeIDs, true)
		check(where, "needs", s.needs, needs, false)
		check(where, "zones", s.zones, zoneNames[:], true)
	}
	if len(c.lists.cargoes) < 30 {
		t.Errorf("%d cargoes", len(c.lists.cargoes))
	}
}

// TestPlaceNames names seed 1's places over many of the namer's draws:
// every place named, no name twice in the world, a whole name fitting its
// place, a light named after its site, a reef with a wreck taking her name
// about as often as the catalog says, the main port's name never drawn.
func TestPlaceNames(t *testing.T) {
	c, b := wholeWorld(t)
	pw := b.made.pw
	islandNames, groupNames := b.made.names[:len(b.made.islands)], b.made.names[len(b.made.islands):]
	draws := 1000
	if testing.Short() {
		draws = 100
	}
	wholes := map[string]*placeName{}
	for site, list := range c.lists.places.wholes {
		for i := range list {
			wholes[site+"\x00"+list[i].name] = &list[i]
		}
	}
	tone := map[string]*catalog.NameTone{}
	for i := range c.names.Tones {
		tone[c.names.Tones[i].Word] = &c.names.Tones[i]
	}
	lights := b.made.lightWork
	reefsWithWrecks, tookHerName := 0, 0
	for draw := range uint64(draws) {
		for _, s := range pw.sites {
			s.name = ""
		}
		c.nameSites(draw+1, pw, lights, islandNames, groupNames)
		seen := map[string]bool{}
		for _, n := range b.made.names {
			seen[strings.ToLower(n)] = true
		}
		for _, s := range pw.sites {
			if s.name == "" {
				t.Fatalf("draw %d: a %s at (%.0f, %.0f) has no name", draw, s.rule, s.x, s.y)
			}
			if seen[strings.ToLower(s.name)] {
				t.Fatalf("draw %d: %q twice", draw, s.name)
			}
			seen[strings.ToLower(s.name)] = true
			if s.name == c.port.name {
				t.Fatalf("draw %d: a place named %s", draw, s.name)
			}
			switch s.rule {
			case catalog.SiteLight:
				lw := lights[s.light]
				if !strings.HasSuffix(s.name, " "+lightWord) {
					t.Fatalf("draw %d: the light %q", draw, s.name)
				}
				if lw.site >= 0 && s.name != pw.sites[lw.site].name+" "+lightWord {
					t.Fatalf("draw %d: the light %q of %q", draw, s.name, pw.sites[lw.site].name)
				}
				continue
			case catalog.SiteReef:
				if s.wreck >= 0 {
					reefsWithWrecks++
					if s.name == pw.sites[s.wreck].name+" Reef" {
						tookHerName++
					}
				}
			case catalog.SiteWreck:
				if s.details.Ship.Name != s.name {
					t.Fatalf("draw %d: the wreck %q of the ship %q", draw, s.name, s.details.Ship.Name)
				}
				continue
			}
			w, whole := wholes[string(s.rule)+"\x00"+s.name]
			if !whole {
				continue
			}
			d := hypot(s.x, s.y)
			if !tagged(w.biomes, s.biome) || !all(w.quals, s.offers) || !all(w.needs, s.offers) {
				t.Fatalf("draw %d: %q for a %s site of %s offering %v", draw, s.name, s.rule, s.biome, s.offers)
			}
			if tone[w.tone].Phantom && len(w.zones) == 1 && w.zones[0] == zoneNames[zoneRim] && d < c.mist {
				t.Fatalf("draw %d: the phantom %q %.0f m out", draw, s.name, d)
			}
		}
	}
	share := float64(tookHerName) / float64(max(reefsWithWrecks, 1))
	if reefsWithWrecks == 0 || math.Abs(share-c.names.WreckReef) > 0.1 {
		t.Errorf("of %d reefs with a wreck, %.2f took her name, not about %.2f", reefsWithWrecks, share, c.names.WreckReef)
	}
	t.Logf("%d draws; a reef with a wreck took her name %.2f of %d times", draws, share, reefsWithWrecks)
}

// TestHazards: each offshore hazard of seed 1 is of its kind's length and
// depth, in its ring, clear of land and the other hazards, its rock above
// the sea; enough of each kind beyond the catalog's distance.
func TestHazards(t *testing.T) {
	c, b := wholeWorld(t)
	h := &c.hazards
	counts, outer := [2]int{}, [2]int{}
	for i, hz := range b.made.hazards {
		counts[hz.kind]++
		d := hypot(hz.x, hz.y)
		if d >= float64(h.Beyond*nauticalMile) {
			outer[hz.kind]++
		}
		if d < float64(h.Ring[0]*nauticalMile)-1 || d > float64(h.Ring[1]*nauticalMile)+1 {
			t.Errorf("hazard %d %.0f m from the centre", i, d)
		}
		lo, hi := h.ReefLength, h.ReefCrest
		if hz.kind == hazardBank {
			lo, hi = h.BankLength, h.BankDepth
		}
		if hz.length < lo[0] || hz.length > lo[1] || hz.depth < hi[0] || hz.depth > hi[1] {
			t.Errorf("hazard %d: %.0f m long, %.2f m deep", i, hz.length, hz.depth)
		}
		// Its shallowest water is about its depth, through the outline's
		// noise.
		shallow := math.Inf(1)
		g := &hz.grid
		for k := range g.w * g.h {
			if g.elev[k] < 0 {
				shallow = min(shallow, -float64(g.elev[k])*0.1)
			}
		}
		if math.Abs(shallow-hz.depth) > 0.25 {
			t.Errorf("hazard %d: its shallowest water %.2f m, its depth %.2f m", i, shallow, hz.depth)
		}
		if e, _ := b.Ground.At(hz.rockX, hz.rockY); e < h.RockHeight[0]-0.05 {
			t.Errorf("hazard %d's rock stands %.1f m above the sea", i, e)
		}
		for j, o := range b.made.hazards[:i] {
			if hypot(hz.x-o.x, hz.y-o.y) < h.Apart {
				t.Errorf("hazards %d and %d %.0f m apart", j, i, hypot(hz.x-o.x, hz.y-o.y))
			}
		}
		// Clear of every island's land: no land within the clearance of
		// its outline's ends.
		for _, m := range b.made.islands {
			if m.nearestTo(hz.x, hz.y) < h.Clear+hz.length/2-coarseCell*2 {
				t.Errorf("hazard %d %.0f m from island %d's land", i, m.nearestTo(hz.x, hz.y), m.number)
			}
		}
	}
	if counts != [2]int{h.Reefs, h.Banks} || outer[0] < h.Outer || outer[1] < h.Outer {
		t.Errorf("reefs and banks %v, beyond %.1f NM %v", counts, h.Beyond, outer)
	}
}

// nearestTo is how far the island's nearest land is from (x, y).
func (m *made) nearestTo(x, y float64) float64 {
	g := &m.grid
	best := math.Inf(1)
	for i := range g.w * g.h {
		if g.elev[i] > 0 {
			px, py := g.centre(i)
			best = min(best, hypot(px-x, py-y))
		}
	}
	return best
}

// TestHazardsLeaveTheIslands: the hazards draw from streams of their own
// and come after the islands, so a world without them has the same
// islands, names and all.
func TestHazardsLeaveTheIslands(t *testing.T) {
	c, b := wholeWorld(t)
	none := *c
	none.hazards.Reefs, none.hazards.Banks = 0, 0
	other := none.generate(1)
	// Their scores read the lights and the towns, which the hazards move.
	unscored := func(islands []Island) string {
		out := slices.Clone(islands)
		for i := range out {
			out[i].Scenery, out[i].Score, out[i].Class = Scenery{}, 0, ""
		}
		return fmt.Sprint(out)
	}
	if unscored(other.Islands) != unscored(b.Islands) || fmt.Sprint(other.Groups) != fmt.Sprint(b.Groups) {
		t.Error("the islands differ without the hazards")
	}
	if len(other.made.hazards) != 0 {
		t.Errorf("%d hazards when none were asked for", len(other.made.hazards))
	}
}

// handMade is a world of islands made by hand, each land where land says
// and a sea bed of depth elsewhere, for a kind's site rule to be tried on.
type handMade struct {
	land  func(x, y float64) bool
	depth func(x, y float64) float64
	x, y  float64
	reach float64
}

// handWorld makes the islands and the places' work about them.
func handWorld(t *testing.T, c *config, islands ...handMade) *placesWork {
	t.Helper()
	sandy := int32(-1)
	for i := range c.biomes {
		if c.biomes[i].surfaces.bed == 0 && c.biomes[i].surfaces.beach != c.biomes[i].surfaces.steep && sandy < 0 {
			sandy = int32(i)
		}
	}
	var made_ []*made
	for n, h := range islands {
		g := gridFor(h.x, h.y, h.reach)
		g.elev = make([]int16, g.w*g.h)
		g.surf = make([]uint8, g.w*g.h)
		var area float64
		for i := range g.w * g.h {
			px, py := g.centre(i)
			if h.land(px, py) {
				g.elev[i] = 50
				g.surf[i] = c.biomes[sandy].surfaces.beach
				area += hexArea
			} else {
				g.elev[i] = int16(-math.Round(10 * min(h.depth(px, py), c.seabed.Deep)))
			}
		}
		m := &made{spot: spot{kind: kindLandmark, x: h.x, y: h.y, radius: sqrtArea(area), biome: sandy, group: -1},
			number: int32(n), grid: g, area: area, reefRock: -1, bays: 1}
		made_ = append(made_, m)
	}
	ground := c.rasterAll(made_)
	pw := &placesWork{c: c, seed: 1, ground: ground, coarse: newCoarse(ground), islands: made_, coasts: make([]*coastGrid, len(made_))}
	for _, m := range made_ {
		pw.shows = append(pw.shows, c.shows(m))
	}
	return pw
}

// shelf is a sea bed falling away from a disc's coast.
func shelf(cx, cy, r float64) func(x, y float64) float64 {
	return func(x, y float64) float64 { return 1 + max(hypot(x-cx, y-cy)-r, 0)/8 }
}

// TestCoveOnMadeTerrain: a narrow inlet deeper than its mouth is wide is a
// cove; a wide bight is not, nor is a round island's coast.
func TestCoveOnMadeTerrain(t *testing.T) {
	c := testConfig(t)
	const cx, cy, r = 3000.0, 1000.0, 160
	inlet := func(x, y float64) bool { return x > cx+30 && math.Abs(y-cy) < 28 }
	bight := func(x, y float64) bool { return x > cx+r-60 && math.Abs(y-cy) < 110 }
	disc := func(x, y float64) bool { return hypot(x-cx, y-cy) < r }
	depth := func(cut func(x, y float64) bool) func(x, y float64) float64 {
		s := shelf(cx, cy, r)
		return func(x, y float64) float64 {
			if cut(x, y) && disc(x, y) {
				return 3
			}
			return s(x, y)
		}
	}
	for _, cs := range []struct {
		name  string
		cut   func(x, y float64) bool
		coves int
	}{{"an inlet", inlet, 1}, {"a bight", bight, 0}, {"no bay", func(x, y float64) bool { return false }, 0}} {
		pw := handWorld(t, c, handMade{land: func(x, y float64) bool { return disc(x, y) && !cs.cut(x, y) },
			depth: depth(cs.cut), x: cx, y: cy, reach: r + 300})
		pw.coves()
		if got := pw.count(catalog.SiteCove); got != cs.coves {
			t.Errorf("%s: %d coves", cs.name, got)
			continue
		}
		for _, s := range pw.sites {
			if !inlet(s.x, s.y) || s.details.Mouth >= s.details.Across*3 || s.details.Across < c.places.Cove.Across[0] {
				t.Errorf("%s: a cove at (%.0f, %.0f), %.0f m across, its mouth %.0f m", cs.name, s.x, s.y, s.details.Across, s.details.Mouth)
			}
			// It faces out of its mouth: east.
			if math.Abs(angleBetween(s.heading, math.Pi/2)) > 0.3 {
				t.Errorf("%s: the cove faces %.2f rad", cs.name, s.heading)
			}
		}
	}
}

// TestAnchorageOnMadeTerrain: water enclosed by an island open on one side
// is a snug anchorage, and every anchorage is as sheltered as it is said
// to be; the water off a lone islet's coast is not sheltered enough to be
// one.
func TestAnchorageOnMadeTerrain(t *testing.T) {
	c := testConfig(t)
	const cx, cy = 3500.0, -1500.0
	// A ring of land 300 m across, 70 m wide, open to the south by 150 m.
	ring := func(x, y float64) bool {
		d := hypot(x-cx, y-cy)
		return d > 230 && d < 300 && !(y < cy && math.Abs(x-cx) < 75)
	}
	inside := func(x, y float64) float64 {
		if hypot(x-cx, y-cy) < 230 {
			return 7
		}
		return 1 + max(hypot(x-cx, y-cy)-300, 0)/8
	}
	pw := handWorld(t, c, handMade{land: ring, depth: inside, x: cx, y: cy, reach: 700})
	pw.anchorages()
	snugInside := false
	for _, s := range pw.sites {
		if hypot(s.x-cx, s.y-cy) < 230 && s.details.Shelter == qualitySnug {
			snugInside = true
		}
		n := pw.sheltered(s.x, s.y, c.places.Anchorage.Fetch)
		want := qualityGood
		if n >= c.places.Anchorage.Snug {
			want = qualitySnug
		}
		if s.details.Shelter != want || n < c.places.Anchorage.Good {
			t.Errorf("an anchorage sheltered in %d directions is %s", n, s.details.Shelter)
		}
		if d := s.details.Depth; d < c.places.Anchorage.Depth[0] || d > c.places.Anchorage.Depth[1] {
			t.Errorf("an anchorage in %.1f m", d)
		}
	}
	if !snugInside {
		t.Error("no snug anchorage within the ring")
	}
	// An islet covers too little of the horizon to shelter anyone.
	lone := handWorld(t, c, handMade{land: func(x, y float64) bool { return hypot(x-cx, y-cy) < 50 }, depth: shelf(cx, cy, 50), x: cx, y: cy, reach: 500})
	lone.anchorages()
	if n := lone.count(catalog.SiteAnchorage); n != 0 {
		t.Errorf("%d anchorages off a lone islet's coast", n)
	}
}

// TestSitesOfSeedOne: seed 1's places stand where their rules say.
func TestSitesOfSeedOne(t *testing.T) {
	c, b := wholeWorld(t)
	pw := b.made.pw
	var ports [][2]float64
	for _, s := range pw.sites {
		switch s.rule {
		case catalog.SiteHarbour:
			m := pw.islands[s.island]
			if m.kind != kindLandmark || hypot(s.x, s.y) >= c.mist {
				t.Errorf("a port on a %s island %.0f m out", m.kind, hypot(s.x, s.y))
			}
			deep := false
			pw.hexesWithin(s.x, s.y, c.places.Harbour.Within, func(hx, hy float64, e int16) bool {
				deep = float64(-e) >= c.places.Harbour.Depth*10 && pw.reached(hx, hy)
				return !deep
			})
			if !deep {
				t.Errorf("a port at (%.0f, %.0f) with no deep water reached from the start near it", s.x, s.y)
			}
			for _, p := range ports {
				if hypot(p[0]-s.x, p[1]-s.y) < float64(c.places.Harbour.Apart*nauticalMile) {
					t.Errorf("ports %.0f m apart", hypot(p[0]-s.x, p[1]-s.y))
				}
			}
			ports = append(ports, [2]float64{s.x, s.y})
		case catalog.SiteLagoon:
			m := pw.islands[s.island]
			if !m.reef || m.lagoon < c.places.Lagoon.Width || pw.depth(s.x, s.y) <= 0 {
				t.Errorf("a lagoon at (%.0f, %.0f), its island's reef %v, %.0f m wide", s.x, s.y, m.reef, m.lagoon)
			}
		case catalog.SiteWreck:
			d, sh := s.details.Depth, s.details.Ship
			if sh.Sunk && (d < c.places.Wreck.Depth[0]-0.05 || d > c.places.Wreck.Depth[1]+0.05) || !sh.Sunk && d > 1.55 {
				t.Errorf("the %s, sunk %v, in %.1f m", sh.Name, sh.Sunk, d)
			}
		case catalog.SiteAnchorage:
			if n := pw.sheltered(s.x, s.y, c.places.Anchorage.Fetch); n < c.places.Anchorage.Good {
				t.Errorf("an anchorage sheltered in %d directions", n)
			}
		}
	}
	mist := 0
	for _, p := range b.Places {
		if p.Kind == c.kinds[catalog.SiteWreck] && hypot(p.X, p.Y) >= c.mist {
			mist++
		}
	}
	if mist < c.places.Wreck.Mist {
		t.Errorf("%d wrecks in the mist band", mist)
	}
}

// TestLightsOfSeedOne: Port Royal's light is the catalog's, the tallest;
// each light stands on land, its focal height its ground and its tower;
// each its own character, phase within its period, range by its role and
// colour; the edge lights far enough inside the lip.
func TestLightsOfSeedOne(t *testing.T) {
	c, b := wholeWorld(t)
	l := &c.lights
	if len(b.Lights) == 0 || b.Lights[0].Role != RoleMain || int(b.Lights[0].Character) != c.mainLight || b.Lights[0].Notation != l.MainPortCharacter {
		t.Fatalf("the first light is %+v", b.Lights[0])
	}
	given := map[int32]bool{}
	for _, lt := range b.Lights {
		if lt.Tower > b.Lights[0].Tower {
			t.Errorf("light %d's tower is taller than Port Royal's", lt.Number)
		}
		if e, _ := b.Ground.At(lt.X, lt.Y); e <= 0 {
			t.Errorf("light %d stands in %.1f m of water", lt.Number, -e)
		}
		if math.Abs(lt.Focal-lt.Ground-lt.Tower) > 0.06 {
			t.Errorf("light %d: focal %.1f, ground %.1f, tower %.0f", lt.Number, lt.Focal, lt.Ground, lt.Tower)
		}
		if given[lt.Character] {
			t.Errorf("light %d's character is another's", lt.Number)
		}
		given[lt.Character] = true
		ch := &l.Characters[lt.Character]
		var period int64
		for _, s := range ch.Steps {
			period += int64(s) * 1000
		}
		if lt.Phase < 0 || lt.Phase >= period {
			t.Errorf("light %d's phase %d in a period of %d", lt.Number, lt.Phase, period)
		}
		want := map[string]float64{RoleMain: l.Range.MainPort, RolePort: l.Range.Port, RoleEdge: l.Range.Edge, RoleHazard: l.Range.Hazard}[lt.Role] * nauticalMile
		if ch.Colour != catalog.LightCharacterColourWhite {
			want *= l.Range.Colour
		}
		if math.Abs(lt.Range-want) > 1 {
			t.Errorf("light %d (%s, %s) reaches %.0f m, not %.0f", lt.Number, lt.Role, ch.Notation, lt.Range, want)
		}
		if lt.Role == RoleEdge && hypot(lt.X, lt.Y) > c.disk-l.Edge.Inside {
			t.Errorf("edge light %d %.0f m inside the lip", lt.Number, c.disk-hypot(lt.X, lt.Y))
		}
	}
	// Every lighthouse is a place, of the lighthouse's kind, named after
	// its site.
	for _, lt := range b.Lights {
		i := slices.IndexFunc(b.Places, func(p Place) bool { return p.Number == lt.Place })
		if i < 0 || b.Places[i].Kind != c.kinds[catalog.SiteLight] || !strings.HasSuffix(b.Places[i].Name, " "+lightWord) {
			t.Errorf("light %d's lighthouse is %+v", lt.Number, b.Places[max(i, 0)])
		}
	}
}
