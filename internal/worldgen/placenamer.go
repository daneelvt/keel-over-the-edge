// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"fmt"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

// Naming the places, after the islands and by the same namer, so that no
// name is given twice in a world and a world's tones are counted together.
// Kind by kind: a name must fit its place, its qualities, its island's
// biome (or any, offshore) and what the site shows; of those that fit, the
// ones that belong to its zone are preferred, then one is drawn, each tone
// weighted by the zone. Whole names come first, then a specific and a
// generic, no specific twice on one island, then the island's own name
// before a generic (Nevis Road). A wreck is named by her ship, the world's
// ships mixing their kinds of name; a reef with a wreck on it may take her
// name, as the Florida reefs took their ships'; and a light is named after
// its site, its port, its hazard or a point of its island's coast, as real
// lights are (Gannet Point Light).

// pointSite is the generics' and specifics' word for a point.
const pointSite = "point"

// lightWord follows a lighthouse's site's name in its own.
const lightWord = "Light"

// placeName is a whole name for a place.
type placeName struct {
	name                        string
	quals, biomes, needs, zones []string
	tone                        string
}

// placeGeneric is a generic word of the places, the sites it serves, the
// qualities, biomes and needs it suits, and its form.
type placeGeneric struct {
	word, class                 string
	sites, quals, biomes, needs []string
	form                        string
}

// placeSpecific combines with the place generics of the classes it takes.
type placeSpecific struct {
	word                        string
	takes, biomes, needs, zones []string
	tone                        string
}

// shipName is a wrecked ship's name, its language and kind of name.
type shipName struct {
	name, language, kind, tone string
}

// cargo is a wrecked ship's cargo and its kind.
type cargo struct{ name, kind string }

// placeLists are the places' names of placenames.go, read.
type placeLists struct {
	// wholes are each site rule's whole names, and the points'.
	wholes    map[string][]placeName
	generics  []placeGeneric
	specifics []placeSpecific
	ships     []shipName
}

// parsePlaceNames reads the names of placenames.go.
func parsePlaceNames() (*placeLists, error) {
	l := &placeLists{wholes: map[string][]placeName{}}
	fields := func(list string, i int, line string, n int) ([]string, error) {
		f := strings.Split(line, " | ")
		if len(f) != n {
			return nil, fmt.Errorf("worldgen: %s[%d] %q has %d fields, not %d", list, i, line, len(f), n)
		}
		return f, nil
	}
	tags := func(field string) []string {
		if field == "-" {
			return []string{}
		}
		return strings.Fields(field)
	}
	for _, w := range []struct {
		site  string
		list  string
		lines []string
	}{
		{string(catalog.SiteHarbour), "portNames", portNames},
		{string(catalog.SiteVillage), "villageNames", villageNames},
		{string(catalog.SiteAnchorage), "anchorageNames", anchorageNames},
		{string(catalog.SiteCove), "coveNames", coveNames},
		{string(catalog.SiteLagoon), "lagoonNames", lagoonNames},
		{string(catalog.SiteReef), "reefNames", reefNames},
		{string(catalog.SiteBar), "sandbarNames", sandbarNames},
		{pointSite, "pointNames", pointNames},
	} {
		for i, line := range w.lines {
			f, err := fields(w.list, i, line, 6)
			if err != nil {
				return nil, err
			}
			l.wholes[w.site] = append(l.wholes[w.site], placeName{name: f[0], quals: tags(f[1]), biomes: tags(f[2]),
				needs: tags(f[3]), zones: tags(f[4]), tone: f[5]})
		}
	}
	for i, line := range placeGenerics {
		f, err := fields("placeGenerics", i, line, 7)
		if err != nil {
			return nil, err
		}
		l.generics = append(l.generics, placeGeneric{word: f[0], class: f[1], sites: tags(f[2]), quals: tags(f[3]),
			biomes: tags(f[4]), needs: tags(f[5]), form: f[6]})
	}
	for i, line := range placeSpecifics {
		f, err := fields("placeSpecifics", i, line, 6)
		if err != nil {
			return nil, err
		}
		l.specifics = append(l.specifics, placeSpecific{word: f[0], takes: tags(f[1]), biomes: tags(f[2]), needs: tags(f[3]),
			zones: tags(f[4]), tone: f[5]})
	}
	for i, line := range shipNames {
		f, err := fields("shipNames", i, line, 4)
		if err != nil {
			return nil, err
		}
		l.ships = append(l.ships, shipName{name: f[0], language: f[1], kind: f[2], tone: f[3]})
	}
	return l, nil
}

// parseCargoes reads the cargoes of placenames.go.
func parseCargoes() ([]cargo, error) {
	var out []cargo
	for i, line := range cargoes {
		f := strings.Split(line, " | ")
		if len(f) != 2 {
			return nil, fmt.Errorf("worldgen: cargoes[%d] %q has %d fields, not 2", i, line, len(f))
		}
		out = append(out, cargo{name: f[0], kind: f[1]})
	}
	return out, nil
}

// placeFits is what a place offers a name.
type placeFits struct {
	site   string
	island int32
	biome  string
	zone   int32
	mist   bool
	offers []string
}

// all reports whether every word is among the offers.
func all(words, offers []string) bool {
	for _, w := range words {
		if !slices.Contains(offers, w) {
			return false
		}
	}
	return true
}

// placeWholeFits reports whether a whole name fits a place, its zone aside.
func (n *namer) placeWholeFits(w *placeName, f *placeFits) bool {
	if !tagged(w.biomes, f.biome) || !n.allows(w.tone) || !n.free(w.name) || !all(w.quals, f.offers) || !all(w.needs, f.offers) {
		return false
	}
	if t := n.tone(w.tone); t.phantom && len(w.zones) == 1 && w.zones[0] == zoneNames[zoneRim] && !f.mist {
		return false
	}
	return true
}

// placeWhole draws a whole name for a place, or "".
func (n *namer) placeWhole(f *placeFits) string {
	list := n.c.lists.places.wholes[f.site]
	var fit, inZone []int
	for i := range list {
		w := &list[i]
		if !n.placeWholeFits(w, f) {
			continue
		}
		fit = append(fit, i)
		if tagged(w.zones, zoneNames[f.zone]) {
			inZone = append(inZone, i)
		}
	}
	if len(inZone) > 0 {
		fit = inZone
	}
	if len(fit) == 0 {
		return ""
	}
	weights := make([]float64, len(fit))
	for k, i := range fit {
		weights[k] = n.tone(list[i].tone).weight[f.zone]
	}
	k := n.s.weighted(weights)
	if k < 0 {
		k = n.s.r.IntN(len(fit))
	}
	return n.take(list[fit[k]].name, list[fit[k]].tone)
}

// genericFits reports whether a generic serves a place: its site, its
// qualities, its needs and, unless loose, its biome.
func genericFits(g *placeGeneric, f *placeFits, loose bool) bool {
	return slices.Contains(g.sites, f.site) && all(g.quals, f.offers) && all(g.needs, f.offers) &&
		(loose || tagged(g.biomes, f.biome))
}

// placeCombined draws a specific and a generic for a place, or "": no
// specific twice on one island, nor a combination that is a whole name.
func (n *namer) placeCombined(f *placeFits, loose bool) string {
	type option struct {
		name, specific, tone string
		inZone               bool
	}
	var opts []option
	l := n.c.lists.places
	for i := range l.specifics {
		sp := &l.specifics[i]
		if n.islandSpecifics[islandWord(f.island, sp.word)] || !n.allows(sp.tone) || !all(sp.needs, f.offers) ||
			!loose && !tagged(sp.biomes, f.biome) {
			continue
		}
		for j := range l.generics {
			g := &l.generics[j]
			if !strings.Contains(g.form, specificSlot) || !slices.Contains(sp.takes, g.class) || !genericFits(g, f, loose) {
				continue
			}
			name := strings.ReplaceAll(g.form, specificSlot, sp.word)
			if !n.free(name) || n.placeWholes[strings.ToLower(name)] {
				continue
			}
			opts = append(opts, option{name, sp.word, sp.tone, tagged(sp.zones, zoneNames[f.zone])})
		}
	}
	if len(opts) == 0 {
		return ""
	}
	if slices.ContainsFunc(opts, func(o option) bool { return o.inZone }) {
		opts = slices.DeleteFunc(opts, func(o option) bool { return !o.inZone })
	}
	weights := make([]float64, len(opts))
	for k, o := range opts {
		weights[k] = n.tone(o.tone).weight[f.zone]
	}
	k := max(n.s.weighted(weights), 0)
	n.islandSpecifics[islandWord(f.island, opts[k].specific)] = true
	return n.take(opts[k].name, opts[k].tone)
}

// islandWord is the key of a specific used on an island.
func islandWord(island int32, word string) string {
	return fmt.Sprintf("%d %s", island, strings.ToLower(word))
}

// placeIsland names a place after its island, the island's name before a
// generic that serves it: Nevis Road. "" offshore, or if none is free.
func (n *namer) placeIsland(f *placeFits, island string) string {
	if island == "" {
		return ""
	}
	l := n.c.lists.places
	for i := range l.generics {
		g := &l.generics[i]
		if !strings.HasPrefix(g.form, specificSlot+" ") || !genericFits(g, f, true) {
			continue
		}
		name := strings.ReplaceAll(g.form, specificSlot, island)
		if n.free(name) {
			n.used[strings.ToLower(name)] = true
			return name
		}
	}
	return ""
}

// placeName names a place: a whole name, then a specific and a generic,
// strictly by biome and then loosely, then its island's name.
func (n *namer) placeName(f *placeFits, island string) string {
	if name := n.placeWhole(f); name != "" {
		return name
	}
	if name := n.placeCombined(f, false); name != "" {
		return name
	}
	if name := n.placeCombined(f, true); name != "" {
		return name
	}
	return n.placeIsland(f, island)
}

// ship draws a wrecked ship's name: one of a kind of name the world's
// wrecks do not have yet, while there is one.
func (n *namer) ship(f *placeFits, kinds map[string]bool) *shipName {
	l := n.c.lists.places
	var fit []int
	for pass := range 2 {
		for i := range l.ships {
			sh := &l.ships[i]
			if !n.free(sh.name) || !n.allows(sh.tone) || pass == 0 && kinds[sh.kind] {
				continue
			}
			fit = append(fit, i)
		}
		if len(fit) > 0 {
			break
		}
	}
	if len(fit) == 0 {
		return nil
	}
	weights := make([]float64, len(fit))
	for k, i := range fit {
		weights[k] = n.tone(l.ships[i].tone).weight[f.zone]
	}
	k := max(n.s.weighted(weights), 0)
	sh := &l.ships[fit[k]]
	n.take(sh.name, sh.tone)
	kinds[sh.kind] = true
	return sh
}

// nameSites names the places, kind by kind, after the islands and groups
// named: ports, fishing villages, anchorages, coves, lagoons, wrecks,
// reefs, sandbars, then the lights after their sites.
func (c *config) nameSites(seed uint64, pw *placesWork, lights []*lightWork, islandNames, groupNames []string) {
	n := newNamer(c, seed)
	n.s = newStream(seed, streamPlaceNames)
	for _, name := range append(append([]string{}, islandNames...), groupNames...) {
		if name != "" {
			n.used[strings.ToLower(name)] = true
		}
	}
	fitsOf := func(s *site, rule string) *placeFits {
		d := hypot(s.x, s.y)
		return &placeFits{site: rule, island: s.island, biome: s.biome, zone: c.zoneOf(d), mist: d >= c.mist, offers: s.offers}
	}
	islandOf := func(s *site) string {
		if s.island < 0 {
			return ""
		}
		return islandNames[s.island]
	}
	r := newStream(seed, streamPlaceNames^0x5bd1e995)
	order := []catalog.Site{catalog.SiteHarbour, catalog.SiteVillage, catalog.SiteAnchorage, catalog.SiteCove, catalog.SiteLagoon,
		catalog.SiteWreck, catalog.SiteReef, catalog.SiteBar}
	kinds := map[string]bool{}
	for _, rule := range order {
		for _, s := range pw.sites {
			if s.rule != rule {
				continue
			}
			f := fitsOf(s, string(rule))
			switch rule {
			case catalog.SiteWreck:
				if sh := n.ship(f, kinds); sh != nil {
					s.name = sh.name
					s.details.Ship.Name, s.details.Ship.Language = sh.name, sh.language
				}
			case catalog.SiteReef:
				// A reef with a wreck on it may take her name.
				if s.wreck >= 0 && pw.sites[s.wreck].name != "" && r.chance(c.names.WreckReef) {
					name := pw.sites[s.wreck].name + " Reef"
					if n.free(name) {
						n.used[strings.ToLower(name)] = true
						s.name = name
						continue
					}
				}
				s.name = n.placeName(f, islandOf(s))
			default:
				s.name = n.placeName(f, islandOf(s))
			}
		}
	}
	// The lights, after their sites: a port's or a hazard's name, a rock's
	// or a group's, or a point of its island's coast.
	for _, s := range pw.sites {
		if s.rule != catalog.SiteLight {
			continue
		}
		lw := lights[s.light]
		var after string
		switch {
		case lw.site >= 0:
			after = pw.sites[lw.site].name
		case lw.group >= 0:
			after = groupNames[lw.group]
		case lw.point:
			after = n.placeName(fitsOf(s, pointSite), islandOf(s))
		case lw.island >= 0:
			after = islandNames[lw.island]
		}
		if after == "" {
			continue
		}
		name := after + " " + lightWord
		if n.free(name) {
			n.used[strings.ToLower(name)] = true
			s.name = name
		}
	}
}
