// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// Naming the islands, from the names in namelist.go, by the rules sailors'
// charts follow. The main port keeps its name, and no name is given twice
// in a world. A name must fit the island: its size class, its biome and the
// features its terrain shows; of those that fit, the ones that belong to
// its zone are preferred, then one is drawn, each tone weighted by the
// zone, so that eerie and warning names gather toward the rim, with at most
// as many of a tone as the catalog allows. A phantom name that belongs only
// to the rim is given only in the mist band. Whole names come first; when
// none fits, a specific and a generic make one. Neighbours may share a name
// (Great and Little), an islet may be the Calf of its neighbour, and names
// written as a pair are given together. Groups of rocks get the group names.

// zoneNames are the zones as the names give them.
var zoneNames = [zones]string{"centre", "middle", "rim"}

// nameFeature is a feature a name may need, and what shows it.
type nameFeature struct {
	word                          string
	cliffs, peak, twin, twinApart float64
	lagoon                        float64
	stacks                        int32
	reef                          bool
}

// tone is a tone of names: its weights by zone, its limit, and whether its
// names of the rim alone are phantoms.
type tone struct {
	word    string
	weight  [zones]float64
	most    int
	phantom bool
}

// features are the catalog's features, made plain.
func (c *config) features() []nameFeature {
	var out []nameFeature
	for _, f := range c.names.Features {
		out = append(out, nameFeature{word: f.Word, cliffs: f.Cliffs, peak: f.Peak, twin: f.Twin, twinApart: f.TwinApart,
			lagoon: f.Lagoon, stacks: int32(f.Stacks), reef: f.Reef})
	}
	return out
}

// feature is the first feature that ok accepts, or nil.
func (c *config) feature(ok func(f *nameFeature) bool) *nameFeature {
	fs := c.features()
	for i := range fs {
		if ok(&fs[i]) {
			return &fs[i]
		}
	}
	return nil
}

// shows lists the features island m shows.
func (c *config) shows(m *made) []string {
	var out []string
	for _, f := range c.features() {
		shown := f.cliffs > 0 && m.cliffs >= f.cliffs ||
			f.peak > 0 && m.highest >= f.peak ||
			f.twin > 0 && m.twin ||
			f.stacks > 0 && m.stacks >= f.stacks ||
			f.reef && m.reef ||
			f.lagoon > 0 && m.reef && m.lagoon >= f.lagoon
		if shown {
			out = append(out, f.word)
		}
	}
	return out
}

// namer names one world's places.
type namer struct {
	c         *config
	s         stream
	tones     []tone
	used      map[string]bool // names given, in lower case
	specifics map[string]bool // specifics used
	toneCount map[string]int
	pending   []string        // partners waiting for an island they fit
	wholes    map[string]bool // the whole names, in lower case
}

// fits is what an island offers a name.
type fits struct {
	size, biome string
	zone        int32
	mist        bool
	shows       []string
}

func (n *namer) tone(word string) *tone {
	for i := range n.tones {
		if n.tones[i].word == word {
			return &n.tones[i]
		}
	}
	return nil
}

// allows reports whether a name of the tone may still be given.
func (n *namer) allows(word string) bool {
	t := n.tone(word)
	return t != nil && (t.most == 0 || n.toneCount[word] < t.most)
}

func tagged(tags []string, v string) bool {
	return slices.Contains(tags, v) || slices.Contains(tags, anyTag)
}

// free reports whether a name may be given: not given already.
func (n *namer) free(name string) bool {
	return !n.used[strings.ToLower(name)]
}

// wholeFits reports whether a whole name fits an island, its zone aside.
func (n *namer) wholeFits(w *wholeName, f *fits) bool {
	if !slices.Contains(w.sizes, f.size) || !tagged(w.biomes, f.biome) || !n.allows(w.tone) || !n.free(w.name) {
		return false
	}
	for _, need := range w.needs {
		if !slices.Contains(f.shows, need) {
			return false
		}
	}
	if t := n.tone(w.tone); t.phantom && len(w.zones) == 1 && w.zones[0] == zoneNames[zoneRim] && !f.mist {
		return false
	}
	return true
}

// take marks a name given.
func (n *namer) take(name, toneWord string) string {
	n.used[strings.ToLower(name)] = true
	n.toneCount[toneWord]++
	return name
}

// whole draws a whole name for an island, or "".
func (n *namer) whole(f *fits) string {
	for k, p := range n.pending {
		for i := range n.c.lists.wholes {
			w := &n.c.lists.wholes[i]
			if w.name == p && n.wholeFits(w, f) {
				n.pending = slices.Delete(n.pending, k, k+1)
				return n.give(w)
			}
		}
	}
	var fit, inZone []int
	for i := range n.c.lists.wholes {
		w := &n.c.lists.wholes[i]
		if !n.wholeFits(w, f) {
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
		weights[k] = n.tone(n.c.lists.wholes[i].tone).weight[f.zone]
	}
	k := n.s.weighted(weights)
	if k < 0 {
		k = n.s.r.IntN(len(fit))
	}
	return n.give(&n.c.lists.wholes[fit[k]])
}

// give gives a whole name, and queues its partner.
func (n *namer) give(w *wholeName) string {
	for _, p := range namePartners {
		if p[0] == w.name || p[1] == w.name {
			other := p[0]
			if other == w.name {
				other = p[1]
			}
			if n.free(other) && !slices.Contains(n.pending, other) {
				n.pending = append(n.pending, other)
			}
		}
	}
	return n.take(w.name, w.tone)
}

// combined draws a specific and a generic for an island, or "".
func (n *namer) combined(f *fits, loose bool) string {
	type option struct {
		name, specific, tone string
		inZone               bool
	}
	var all []option
	for i := range n.c.lists.specifics {
		sp := &n.c.lists.specifics[i]
		if n.specifics[strings.ToLower(sp.word)] || !n.allows(sp.tone) || !loose && !tagged(sp.biomes, f.biome) {
			continue
		}
		for j := range n.c.lists.generics {
			g := &n.c.lists.generics[j]
			if !strings.Contains(g.form, specificSlot) || !slices.Contains(sp.takes, g.class) ||
				!slices.Contains(g.sizes, f.size) || !loose && !tagged(g.biomes, f.biome) {
				continue
			}
			name := g.combine(sp.word)
			// A combination that makes a whole name would escape the whole
			// name's own tags.
			if !n.free(name) || n.wholes[strings.ToLower(name)] {
				continue
			}
			all = append(all, option{name, sp.word, sp.tone, tagged(sp.zones, zoneNames[f.zone])})
		}
	}
	if len(all) == 0 {
		return ""
	}
	if slices.ContainsFunc(all, func(o option) bool { return o.inZone }) {
		all = slices.DeleteFunc(all, func(o option) bool { return !o.inZone })
	}
	weights := make([]float64, len(all))
	for k, o := range all {
		weights[k] = n.tone(o.tone).weight[f.zone]
	}
	k := max(n.s.weighted(weights), 0)
	n.specifics[strings.ToLower(all[k].specific)] = true
	return n.take(all[k].name, all[k].tone)
}

// prefixable reports whether a name may take a prefix: a few plain words,
// not already prefixed, nor beginning with an article or a generic's
// "of".
func (n *namer) prefixable(name string) bool {
	ws := strings.Fields(name)
	if len(ws) < 2 || len(ws) > 3 || strings.Contains(name, " of ") || ws[0] == "The" {
		return false
	}
	for _, p := range n.c.names.Prefixes {
		if slices.Contains(p, ws[0]) {
			return false
		}
	}
	return true
}

// newNamer is a namer for one world, drawing from its seed's stream.
func newNamer(c *config, seed uint64) *namer {
	n := &namer{c: c, s: newStream(seed, streamNames), used: map[string]bool{}, specifics: map[string]bool{},
		toneCount: map[string]int{}, wholes: map[string]bool{}}
	for _, t := range c.names.Tones {
		n.tones = append(n.tones, tone{word: t.Word, weight: [zones]float64{t.Centre, t.Middle, t.Rim}, most: t.Most, phantom: t.Phantom})
	}
	for i := range c.lists.wholes {
		n.wholes[strings.ToLower(c.lists.wholes[i].name)] = true
	}
	return n
}

// nameIslands names every island; the main port's is first.
func (c *config) nameIslands(seed uint64, islands []*made) []string {
	n := newNamer(c, seed)
	out := make([]string, len(islands))
	if len(islands) == 0 {
		return out
	}
	out[0] = c.port.name
	n.used[strings.ToLower(c.port.name)] = true
	order := make([]int, 0, len(islands))
	for i := 1; i < len(islands); i++ {
		order = append(order, i)
	}
	rank := map[string]int{kindLandmark: 0, kindIsland: 1, kindRock: 2}
	slices.SortStableFunc(order, func(a, b int) int {
		ma, mb := islands[a], islands[b]
		if ra, rb := rank[ma.kind], rank[mb.kind]; ra != rb {
			return ra - rb
		}
		return cmpDesc(ma.area, mb.area)
	})
	for _, i := range order {
		m := islands[i]
		d := hypot(m.x, m.y)
		f := fits{size: c.sizeOf(m.area), biome: c.biomeIDs[m.biome], zone: c.zoneOf(d), mist: d >= c.mist, shows: c.shows(m)}
		if name := n.neighbour(islands, out, i, &f); name != "" {
			out[i] = name
			continue
		}
		name := n.whole(&f)
		if name == "" {
			name = n.combined(&f, false)
		}
		if name == "" {
			name = n.combined(&f, true)
		}
		out[i] = name
	}
	return out
}

// neighbour may name island i after a named neighbour: the Calf of a
// larger island beside an islet, or Great and Little (and the other
// prefixes) for two of a biome near each other, renaming the first. It
// returns the name, or "".
func (n *namer) neighbour(islands []*made, out []string, i int, f *fits) string {
	m := islands[i]
	for j, o := range islands {
		if j == i || j == 0 || out[j] == "" {
			continue
		}
		d := hypot(m.x-o.x, m.y-o.y)
		if d < n.c.names.Calf && o.area > float64(4*m.area) && n.s.chance(n.c.names.CalfShare) {
			for g := range n.c.lists.generics {
				gen := &n.c.lists.generics[g]
				if !strings.Contains(gen.form, islandSlot) || !slices.Contains(gen.sizes, f.size) {
					continue
				}
				name := strings.ReplaceAll(gen.form, islandSlot, out[j])
				if n.free(name) {
					n.used[strings.ToLower(name)] = true
					return name
				}
			}
		}
		if d < n.c.names.Neighbours && o.biome == m.biome && n.prefixable(out[j]) && n.s.chance(n.c.names.NeighbourShare) {
			p := n.c.names.Prefixes[n.s.r.IntN(len(n.c.names.Prefixes))]
			first, second := p[0], p[1]
			if m.area > o.area {
				first, second = second, first
			}
			a, b := first+" "+out[j], second+" "+out[j]
			if n.free(a) && n.free(b) {
				n.used[strings.ToLower(a)], n.used[strings.ToLower(b)] = true, true
				out[j] = a
				return b
			}
		}
	}
	return ""
}

// nameGroups names the groups of rocks.
func (c *config) nameGroups(seed uint64, groups []groupSpot, used []string) []string {
	s := newStream(seed, streamNames^0x9e3779b97f4a7c15)
	taken := map[string]bool{}
	for _, u := range used {
		taken[strings.ToLower(u)] = true
	}
	tones := map[string][zones]float64{}
	for _, t := range c.names.Tones {
		tones[t.Word] = [zones]float64{t.Centre, t.Middle, t.Rim}
	}
	out := make([]string, len(groups))
	for gi, g := range groups {
		zone := c.zoneOf(hypot(g.x, g.y))
		biome := c.biomeIDs[g.biome]
		var fit []int
		var weights []float64
		for pass := range 2 {
			for i := range c.lists.groups {
				gr := &c.lists.groups[i]
				count := len(g.members)
				if taken[strings.ToLower(gr.name)] || !tagged(gr.biomes, biome) {
					continue
				}
				if pass == 0 && (count < gr.count[0] || count > gr.count[1] || !tagged(gr.zones, zoneNames[zone])) {
					continue
				}
				fit = append(fit, i)
				weights = append(weights, tones[gr.tone][zone])
			}
			if len(fit) > 0 {
				break
			}
		}
		if len(fit) == 0 {
			continue
		}
		k := max(s.weighted(weights), 0)
		out[gi] = c.lists.groups[fit[k]].name
		taken[strings.ToLower(out[gi])] = true
	}
	return out
}

// anyTag is the tag that fits every biome or zone.
const anyTag = "any"

// The places in a generic's form.
const (
	specificSlot = "{specific}"
	islandSlot   = "{island}"
)

// wholeName is a whole name for a single island, with the size classes,
// biomes and zones it suits, the features the island must show, and its
// tone.
type wholeName struct {
	name                        string
	sizes, biomes, needs, zones []string
	tone                        string
}

// groupName is a name for a group of count[0] to count[1] rocks.
type groupName struct {
	name          string
	count         [2]int
	biomes, zones []string
	tone          string
}

// genericWord is a generic word, its class, the sizes and biomes it suits,
// and its form.
type genericWord struct {
	word, class   string
	sizes, biomes []string
	form          string
}

// combine is a specific in the generic's form.
func (g *genericWord) combine(specific string) string {
	return strings.ReplaceAll(g.form, specificSlot, specific)
}

// specificWord combines with the generics of the classes it takes.
type specificWord struct {
	word                 string
	takes, biomes, zones []string
	tone                 string
}

// nameLists are the names of namelist.go, read.
type nameLists struct {
	wholes    []wholeName
	groups    []groupName
	generics  []genericWord
	specifics []specificWord
}

// parseNames reads the names of namelist.go.
func parseNames() (*nameLists, error) {
	l := &nameLists{}
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
	for i, line := range wholeNames {
		f, err := fields("wholeNames", i, line, 6)
		if err != nil {
			return nil, err
		}
		l.wholes = append(l.wholes, wholeName{name: f[0], sizes: tags(f[1]), biomes: tags(f[2]), needs: tags(f[3]), zones: tags(f[4]), tone: f[5]})
	}
	for i, line := range groupNames {
		f, err := fields("groupNames", i, line, 5)
		if err != nil {
			return nil, err
		}
		a, b, ranged := strings.Cut(f[1], "-")
		lo, err1 := strconv.Atoi(a)
		hi, err2 := lo, error(nil)
		if ranged {
			hi, err2 = strconv.Atoi(b)
		}
		if err1 != nil || err2 != nil || lo < 1 || hi < lo {
			return nil, fmt.Errorf("worldgen: groupNames[%d] %q: count %q is not a number or a range", i, f[0], f[1])
		}
		l.groups = append(l.groups, groupName{name: f[0], count: [2]int{lo, hi}, biomes: tags(f[2]), zones: tags(f[3]), tone: f[4]})
	}
	for i, line := range genericWords {
		f, err := fields("genericWords", i, line, 5)
		if err != nil {
			return nil, err
		}
		l.generics = append(l.generics, genericWord{word: f[0], class: f[1], sizes: tags(f[2]), biomes: tags(f[3]), form: f[4]})
	}
	for i, line := range specificWords {
		f, err := fields("specificWords", i, line, 5)
		if err != nil {
			return nil, err
		}
		l.specifics = append(l.specifics, specificWord{word: f[0], takes: tags(f[1]), biomes: tags(f[2]), zones: tags(f[3]), tone: f[4]})
	}
	return l, nil
}
