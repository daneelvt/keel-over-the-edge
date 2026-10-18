// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"fmt"
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The islands' features. Those the land and the sea make are each island's
// own, made on its grid from a stream of its own after its sea bed and
// stacks and before its surfaces, so that a change to one island's
// features moves no other island: its drainage, springs, streams and
// waterfalls (drainage.go); its caves, arches and blowholes, cut into its
// cliffed headlands in the order the sea cuts them (headland.go); a
// volcanic island's cone and crater, and its fumaroles while it is young
// (cone.go). Ruins and seabird colonies are the world's, a few of each,
// chosen once the towns' sites are known so that none stands in a town
// (ruins.go, colonies.go). The ground under every feature stays one
// elevation and one surface a hexagon, as the physics, the shelter and the
// charts read it; what the height field cannot hold travels beside it in
// the chunks: a roof, a hexagon whose land is drawn from an underside up
// to its top over rock awash, as an arch's span and a cave's roof are; and
// parts, what the page draws of a feature: a fall's lip, a blowhole's
// vent, a fumarole's, a colony's birds.

// Feature is a feature of a made world.
type Feature struct {
	Number int32  `json:"number"`
	Kind   string `json:"kind"`
	Island int32  `json:"island"`
	// X and Y are where it is, m east and north of the world's centre;
	// Heading the way it faces, rad clockwise from north.
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Heading float64 `json:"heading"`
	// Size is how big it is, m: a cave's depth, an arch's span, a fall's
	// width, a crater's width, how far a ruin's or a colony's reach.
	Size float64 `json:"size"`
	// Height is its top's, m above the sea: a roof's, a fall's lip, a
	// crater's rim, a ruin's ground, a colony's nests.
	Height float64 `json:"height"`
	// Catchment is a spring's, a stream's or a fall's, m²; Birds a colony's.
	Catchment float64 `json:"catchment,omitempty"`
	Birds     int32   `json:"birds,omitempty"`
	// SightX and SightY are where a boat sees it from: the nearest water a
	// boat reaches from which it is in sight, if Seen; else its own place.
	SightX float64 `json:"sightX"`
	SightY float64 `json:"sightY"`
	Seen   bool    `json:"seen"`
}

// Roof is a hexagon whose land is drawn from an underside up to its top:
// an arch's span or a cave's roof, over the rock awash its ground is.
type Roof struct {
	C, J  int32 // its column and row
	Top   int16 // dm above the sea
	Under int16 // dm above the sea
}

// Part is what the page draws of a feature: a fall's lip, a blowhole's
// vent, a fumarole's vent, a colony.
type Part struct {
	Kind uint8 // its feature's kind, by its index in the catalog's list
	// X and Y are its middle, m east and north of the world's centre; Level
	// how high it stands, m; Heading the way it faces, rad.
	X, Y    float64
	Level   float64
	Heading float64
	// Size is a fall's width, a vent's, or how far a colony's birds wheel,
	// m; Count a colony's birds, a fall's catchment in hundreds of m².
	Size  float64
	Count uint16
	Seed  uint8
}

// featureKind is a kind of feature as the generator reads it.
type featureKind struct {
	id     string
	site   catalog.FeatureSite
	word   string
	biomes []bool // by the biome's index
	chance float64
	zones  [zones]float64
	ruin   catalog.Ruin
	birds  *catalog.ColonyBirds
}

// featureConfig is the catalog's features.
type featureConfig struct {
	kinds    []featureKind
	headland catalog.FeatureHeadland
	streams  catalog.FeatureStreams
	cone     catalog.FeatureCone
	ruins    catalog.FeatureRuins
	colonies catalog.FeatureColonies
	look     catalog.FeatureLook
}

// read reads the catalog's features.
func (f *featureConfig) read(w *catalog.World, biomeIDs []string) error {
	fs := &w.Features
	f.headland, f.streams, f.cone, f.ruins, f.colonies, f.look = fs.Headland, fs.Streams, fs.Cone, fs.Ruins, fs.Colonies, fs.Look
	for _, k := range fs.Kinds {
		o := featureKind{id: string(k.ID), site: k.Site, chance: k.Chance, birds: k.Birds,
			zones: [zones]float64{k.Zones.Centre, k.Zones.Middle, k.Zones.Rim}, biomes: make([]bool, len(biomeIDs))}
		if k.Word != nil {
			o.word = *k.Word
		}
		if k.Ruin != nil {
			o.ruin = *k.Ruin
		}
		for _, b := range k.Biomes {
			i := slices.Index(biomeIDs, string(b))
			if i < 0 {
				return fmt.Errorf("worldgen: the feature %q's biome %q is not a biome", k.ID, b)
			}
			o.biomes[i] = true
		}
		if k.Site == catalog.FeatureSiteColony && k.Birds == nil {
			return fmt.Errorf("worldgen: the colony %q has no birds", k.ID)
		}
		if k.Site == catalog.FeatureSiteRuin && k.Ruin == nil {
			return fmt.Errorf("worldgen: the ruin %q is not said to have been anything", k.ID)
		}
		f.kinds = append(f.kinds, o)
	}
	return nil
}

// kind is the kind of a site an island of the biome may have, or -1.
func (f *featureConfig) kind(site catalog.FeatureSite, biome int32) int {
	for i := range f.kinds {
		if f.kinds[i].site == site && f.kinds[i].biomes[biome] {
			return i
		}
	}
	return -1
}

// featureWork is a feature as it is made.
type featureWork struct {
	kind      int
	island    int32
	x, y      float64
	heading   float64
	size      float64
	height    float64
	catchment float64
	birds     int32
	parts     []Part
	// at is a hexagon of its island's grid it stands on, where the world
	// page and the sighting look for it; seen how high above the sea what
	// is seen of it stands, m: what is built on it, the steam over it, the
	// birds; 0 for its height.
	at   int32
	seen float64
	// sighted is whether it is in view of water a boat reaches: what the
	// score counts.
	sighted bool
	// cells are the hexagons of its island's grid it is cut from: a cave's,
	// an arch's or a blowhole's.
	cells []int32
}

// site is the feature's site.
func (c *config) siteOf(f *featureWork) catalog.FeatureSite { return c.features.kinds[f.kind].site }

// roofWork is a roof on its island's grid: the hexagon's index, and its
// top and underside, m.
type roofWork struct {
	i          int32
	top, under float64
}

// streamFeatures is the key of an island's features' streams, plus the
// island's number.
const streamFeatures = 2 << 32

// chance reports whether an island of zone z gets a kind of feature it has
// a site for: the kind's chance times its zone's weight.
func (s stream) chanceOf(k *featureKind, z int32) bool {
	return s.chance(min(k.chance*k.zones[z], 1))
}

// featuresOf makes an island's own features on its grid: its streams and
// falls, its headlands' caves, arches and blowholes, its cone's fumaroles.
// spots are the world's islands' spots, which a cave's open water is
// looked for among.
func (c *config) featuresOf(seed uint64, m *made, b *biome, w *work, spots []spot) {
	if m.kind == kindMain || m.kind == kindRock {
		return
	}
	s := newStream(seed, streamFeatures+uint64(m.number))
	z := c.zoneOf(hypot(m.x, m.y))
	c.streamsOf(s, m, b, w, z)
	c.headlandsOf(s, m, w, z, spots)
	c.fumarolesOf(s, m, w)
}

// addFeature adds a feature of kind k to island m at hexagon i of its grid.
func (m *made) addFeature(k int, i int32, heading, size, height float64) *featureWork {
	x, y := m.grid.centre(i)
	f := &featureWork{kind: k, island: m.number, x: x, y: y, heading: heading, size: size, height: height, at: i}
	m.features = append(m.features, f)
	return f
}

// hasSite reports whether island m has a feature of the site.
func (c *config) hasSite(m *made, site catalog.FeatureSite) bool {
	for _, f := range m.features {
		if c.siteOf(f) == site {
			return true
		}
	}
	return false
}

// seesSite reports whether island m has a feature of the site in view of
// water a boat reaches.
func (c *config) seesSite(m *made, site catalog.FeatureSite) bool {
	for _, f := range m.features {
		if f.sighted && c.siteOf(f) == site {
			return true
		}
	}
	return false
}

// featureWords are the words island m's features show names.
func (c *config) featureWords(m *made) []string {
	var out []string
	for _, f := range m.features {
		if w := c.features.kinds[f.kind].word; w != "" && !slices.Contains(out, w) {
			out = append(out, w)
		}
	}
	return out
}

// roofsOf are the world's roofs, from its islands', on the lattice.
func roofsOf(islands []*made) []Roof {
	var out []Roof
	for _, m := range islands {
		g := &m.grid
		for _, r := range m.roofs {
			out = append(out, Roof{C: g.c0 + r.i/g.h, J: g.j0 + r.i%g.h,
				Top: int16(round(float64(r.top * 10))), Under: int16(round(float64(r.under * 10)))})
		}
	}
	return out
}

// headingTo is the heading from (x0, y0) to (x1, y1), rad clockwise from
// north, in [0, 2π).
func headingTo(x0, y0, x1, y1 float64) float64 {
	a := physics.Atan2(x1-x0, y1-y0)
	if a < 0 {
		a += 2 * 3.141592653589793
	}
	return a
}

// kept reports whether a town keeps clear of a feature: of a fall, a
// ruin and a colony.
func (c *config) kept(f *featureWork) bool {
	switch c.siteOf(f) {
	case catalog.FeatureSiteWaterfall, catalog.FeatureSiteRuin, catalog.FeatureSiteColony:
		return true
	}
	return false
}

// collapsible reports whether a feature falls in where a town is sited:
// a cave, an arch, a blowhole.
func (c *config) collapsible(f *featureWork) bool {
	switch c.siteOf(f) {
	case catalog.FeatureSiteCave, catalog.FeatureSiteArch, catalog.FeatureSiteBlowhole:
		return true
	}
	return false
}

// collapse lets fall in each cave, arch and blowhole within a town's reach
// of its site: its roofs fall, as an arch's roof falls and leaves a stack,
// and the rock awash under them is a channel or an inlet, a geo.
func (c *config) collapse(pw *placesWork) {
	for _, s := range pw.sites {
		var reach float64
		switch s.rule {
		case catalog.SiteHarbour:
			reach = c.towns.Plan.Reach[1]
		case catalog.SiteVillage:
			reach = c.towns.Plan.Reach[2]
		default:
			continue
		}
		m := pw.islands[s.island]
		var fallen []int32
		m.features = slices.DeleteFunc(m.features, func(f *featureWork) bool {
			if c.collapsible(f) && hypot(f.x-s.x, f.y-s.y) < reach+featureClear {
				fallen = append(fallen, f.cells...)
				return true
			}
			return false
		})
		if len(fallen) == 0 {
			continue
		}
		// A blowhole falls with its cave.
		m.features = slices.DeleteFunc(m.features, func(f *featureWork) bool {
			return c.collapsible(f) && slices.ContainsFunc(f.cells, func(i int32) bool { return slices.Contains(fallen, i) })
		})
		m.roofs = slices.DeleteFunc(m.roofs, func(r roofWork) bool { return slices.Contains(fallen, r.i) })
	}
}

// featureClear is how far beyond its reach a town keeps from a feature, m.
const featureClear = 15

// featureRecords are the world's features' records, island by island, and
// their parts; each sighted from the nearest water a boat reaches within
// the validator's reach from which it is in view.
func (c *config) featureRecords(pw *placesWork) ([]Feature, []Part) {
	var out []Feature
	var parts []Part
	for _, m := range pw.islands {
		for _, f := range m.features {
			r := Feature{
				Number: int32(len(out)), Kind: c.features.kinds[f.kind].id, Island: f.island, X: f.x, Y: f.y,
				Heading: round3(f.heading), Size: round1(f.size), Height: round1(f.height), Catchment: f.catchment, Birds: f.birds,
				SightX: f.x, SightY: f.y,
			}
			seen := f.height
			if f.seen > 0 {
				seen = f.seen
			}
			if sx, sy, ok := pw.sighting(f.x, f.y, seen, c.validator.Features.Seen); ok {
				r.SightX, r.SightY, r.Seen = sx, sy, true
				f.sighted = true
			}
			out = append(out, r)
			for _, p := range f.parts {
				p.Kind = uint8(f.kind)
				parts = append(parts, p)
			}
		}
	}
	return out, parts
}

// sightEye is how high a sailor's eye is, m: a boat's deck and a standing
// sailor.
const sightEye = 2

// sightRays is how many directions a feature is looked at from.
const sightRays = 48

// sighting is the nearest water a boat reaches within most of (x, y) from
// which a thing high m above the sea there is in view: no land rises above
// the line from an eye at sightEye to it, but its own hexagons'. It looks
// along rays out from the thing, from the first water a boat reaches on
// each and from further out, where the land beside the thing hides less.
func (pw *placesWork) sighting(x, y, high, most float64) (float64, float64, bool) {
	target := max(high, 0) + 1
	best, bx, by := math.Inf(1), 0.0, 0.0
	for r := range sightRays {
		sa, ca := sincos(float64(float64(r) * (2 * math.Pi / sightRays)))
		first := -1.0
		for d := float64(physics.HexAcross); d <= min(most, best); d += physics.HexAcross {
			px, py := x+float64(d*sa), y+float64(d*ca)
			if first < 0 {
				if e, _ := pw.ground.At(px, py); e > 0 || !pw.reached(px, py) {
					continue
				}
				first = d
			}
			// From the first water reached, and twice and four times as far.
			if d != first && d != 2*first && d != 4*first {
				continue
			}
			if e, _ := pw.ground.At(px, py); e <= 0 && pw.reached(px, py) && pw.inView(px, py, x, y, target) {
				best, bx, by = d, px, py
				break
			}
		}
	}
	return bx, by, !math.IsInf(best, 1)
}

// inView reports whether a point high m up at (x1, y1) is in view of an eye
// at sightEye over (x0, y0): the ground stands below the line between
// them, the last hexagons before the point aside.
func (pw *placesWork) inView(x0, y0, x1, y1, high float64) bool {
	d := hypot(x1-x0, y1-y0)
	for t := float64(physics.HexAcross); t < d-2*physics.HexAcross; t += physics.HexAcross / 2 {
		u := t / d
		e, _ := pw.ground.At(lerp(u, x0, x1), lerp(u, y0, y1))
		if e > lerp(u, sightEye, high) {
			return false
		}
	}
	return true
}
