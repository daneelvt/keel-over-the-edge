// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"fmt"
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// config is the catalog's world values as the generator uses them: in
// metres and radians, the biomes' surfaces as indices.
type config struct {
	disk, mist float64 // m
	zones      [2]float64
	calm       float64
	port       struct {
		name   string
		biome  int32
		across [2]float64
		height [2]float64
		cliffs float64
		offset float64
		rocks  [2]int
		// harbour is its harbour's values.
		harbour catalog.PortHarbour
	}
	layout struct {
		landmarks      int
		landmarkAcross [2]float64
		landmarkApart  float64
		landmarkRing   [2]float64
		islands        int
		islandAcross   [2]float64
		korcak         float64
		islandRing     [2]float64
		gap            float64
		candidates     int
		groups         [2]int
		groupSize      [2]int
		groupSpread    float64
		rockAcross     [2]float64
	}
	sizes    []sizeClass
	land     [2]float64
	talus    float64 // the height a neighbour may stand below another before the ground slides, m
	seabed   catalog.WorldSeabed
	reef     catalog.WorldReef
	erosion  catalog.WorldErosion
	biomes   []biome
	biomeIDs []string
	friction [physics.GroundSurfaces]float64
	fetch    struct {
		radials int
		spread  float64 // rad
		step    float64
		cap     float64 // m
	}
	shelter   physics.ShelterPrepared
	start     catalog.WorldStart
	validator catalog.WorldValidator
	names     catalog.WorldNames
	lists     *nameLists

	hazards     catalog.WorldHazards
	rockSurface uint8
	places      catalog.WorldPlaces
	lights      catalog.WorldLights
	// kinds are the places' kinds' ids by their site rule.
	kinds map[catalog.Site]string
	// mainLight is the main port's light's character, by its index in the
	// catalog's list.
	mainLight int
	towns     catalog.WorldTowns
	buildings []buildingKind
	terraceDm int16 // the land's terraces, dm
	moorings  catalog.StartMoorings
	// townSurface is each part of a town's surface, by its index.
	townSurface struct{ street, quay, deck, yard uint8 }
	// kitOf is each biome's kit, by its index in the catalog's list.
	kitOf []uint8
	// features are the islands' features' kinds and rules (features.go).
	features featureConfig
	// canopy is each surface's plants' height over its ground, m, and
	// cover the forms of plant that grow on it, each with the share of it
	// their crowns cover.
	canopy [physics.GroundSurfaces]float64
	cover  [physics.GroundSurfaces][]formCover
	// featureSurface is the surface each feature's ground is, by what it
	// is: a stream's bed, a mangrove shore, sulphur, guano.
	featureSurface struct{ stream, mangrove, sulphur, guano uint8 }
	score          catalog.WorldScore
}

// formCover is a form of plant on a surface, and the share of it their
// crowns cover.
type formCover struct {
	form  catalog.Form
	share float64
}

// sizeClass is a size class: the islands narrower than below.
type sizeClass struct {
	class string
	below float64
}

// biome is a biome's values.
type biome struct {
	zones       [zones]float64
	height      [2]float64
	lobes       [2]int
	elongation  [2]float64
	warp        float64
	bays        [2]int
	rise        float64
	hills       float64
	ridges      float64
	cone        float64
	crater      float64
	cliffs      [2]float64
	cliffHeight [2]float64
	beach       float64
	dean        float64
	reef, bars  bool
	stacks      [2]int
	split       float64
	stream      float64 // m²: the catchment a stream runs from
	mangroves   bool
	surfaces    struct{ beach, low, high, steep, bed uint8 }
}

func pair(v []float64) [2]float64 { return [2]float64{v[0], v[1]} }
func ipair(v []int) [2]int        { return [2]int{v[0], v[1]} }

// newConfig reads the catalog's world values.
func newConfig(cat *catalog.Catalog) (*config, error) {
	w := &cat.World
	lists, err := parseNames()
	if err != nil {
		return nil, err
	}
	if lists.places, err = parsePlaceNames(); err != nil {
		return nil, err
	}
	if lists.cargoes, err = parseCargoes(); err != nil {
		return nil, err
	}
	c := &config{lists: lists}
	c.disk = w.Disk.Radius
	c.mist = float64(w.Disk.Mist * nauticalMile)
	c.zones = [2]float64{float64(w.Zones.Centre * nauticalMile), float64(w.Zones.Middle * nauticalMile)}
	c.calm = float64(w.MainPort.Calm * nauticalMile)
	surface := map[string]uint8{}
	for i, s := range w.Surfaces {
		surface[string(s.ID)] = uint8(i)
		c.friction[i] = s.Friction
	}
	look := func(id catalog.ID) (uint8, error) {
		i, ok := surface[string(id)]
		if !ok {
			return 0, fmt.Errorf("worldgen: no surface %q", id)
		}
		return i, nil
	}
	for _, b := range w.Biomes {
		var o biome
		o.zones = [zones]float64{b.Zones.Centre, b.Zones.Middle, b.Zones.Rim}
		o.height, o.lobes, o.elongation = pair(b.Height), ipair(b.Lobes), pair(b.Elongation)
		o.bays = ipair(b.Bays)
		o.warp, o.rise, o.hills, o.ridges, o.cone, o.crater = b.Warp, b.Rise, b.Hills, b.Ridges, b.Cone, b.Crater
		o.cliffs, o.cliffHeight, o.beach, o.dean = pair(b.Cliffs), pair(b.CliffHeight), b.Beach, b.Dean
		o.reef, o.bars, o.stacks, o.split = b.Reef, b.Bars, ipair(b.Stacks), b.Split
		o.stream, o.mangroves = b.Stream, b.Mangroves
		var err error
		for _, s := range []struct {
			to *uint8
			id catalog.ID
		}{{&o.surfaces.beach, b.Surfaces.Beach}, {&o.surfaces.low, b.Surfaces.Low}, {&o.surfaces.high, b.Surfaces.High},
			{&o.surfaces.steep, b.Surfaces.Steep}, {&o.surfaces.bed, b.Surfaces.Bed}} {
			if *s.to, err = look(s.id); err != nil {
				return nil, err
			}
		}
		c.biomes = append(c.biomes, o)
		c.biomeIDs = append(c.biomeIDs, string(b.ID))
	}
	port := &w.MainPort
	c.port.name = port.Name
	c.port.biome = int32(slices.Index(c.biomeIDs, string(port.Biome)))
	if c.port.biome < 0 {
		return nil, fmt.Errorf("worldgen: the main port's biome %q is not a biome", port.Biome)
	}
	c.port.across, c.port.height, c.port.cliffs = pair(port.Across), pair(port.Height), port.Cliffs
	c.port.offset, c.port.rocks = port.Offset, ipair(port.Rocks)
	c.port.harbour = port.Harbour
	l := &w.Layout
	c.layout.landmarks, c.layout.landmarkAcross, c.layout.landmarkApart = l.Landmarks, pair(l.LandmarkAcross), l.LandmarkApart
	c.layout.landmarkRing = [2]float64{float64(l.LandmarkRing[0] * nauticalMile), float64(l.LandmarkRing[1] * nauticalMile)}
	c.layout.islands, c.layout.islandAcross, c.layout.korcak = l.Islands, pair(l.IslandAcross), l.Korcak
	c.layout.islandRing = [2]float64{float64(l.IslandRing[0] * nauticalMile), float64(l.IslandRing[1] * nauticalMile)}
	c.layout.gap, c.layout.candidates = l.Gap, max(l.Candidates, 1)
	c.layout.groups, c.layout.groupSize, c.layout.groupSpread = ipair(l.Groups), ipair(l.GroupSize), l.GroupSpread
	c.layout.rockAcross = pair(l.RockAcross)
	for _, s := range w.Sizes {
		c.sizes = append(c.sizes, sizeClass{class: s.Class, below: s.Below})
	}
	c.land = pair(w.Land)
	c.talus = float64(physics.HexAcross * tan(float64(w.Talus*degree)))
	c.seabed, c.reef, c.erosion = w.Seabed, w.Reef, w.Erosion
	c.fetch.radials, c.fetch.spread, c.fetch.step = w.Fetch.Radials, float64(w.Fetch.Spread*degree), w.Fetch.Step
	c.fetch.cap = float64(cat.Weather.Sea.FetchCap * nauticalMile)
	sp := catalog.ShelterParams(cat)
	physics.PrepareShelter(&sp, &c.shelter)
	c.start, c.validator, c.names = w.Start, w.Validator, w.Names
	c.hazards, c.places, c.lights = w.Hazards, w.Places, w.Lights
	if c.rockSurface, err = look(w.Hazards.RockSurface); err != nil {
		return nil, err
	}
	c.kinds = map[catalog.Site]string{}
	for _, k := range w.Places.Kinds {
		c.kinds[k.Site] = string(k.ID)
	}
	for _, site := range siteRules {
		if c.kinds[site] == "" {
			return nil, fmt.Errorf("worldgen: no kind of place has the site %q", site)
		}
	}
	c.towns, c.moorings = w.Towns, w.Start.Moorings
	c.buildings = kindsOf(w.Towns.Buildings)
	c.terraceDm = int16(max(round(float64(w.Look.Terrace*10)), 1))
	parts := map[catalog.Town]*uint8{catalog.TownStreet: &c.townSurface.street, catalog.TownQuay: &c.townSurface.quay,
		catalog.TownDeck: &c.townSurface.deck, catalog.TownYard: &c.townSurface.yard}
	found := 0
	for i, s := range w.Surfaces {
		if s.Town != nil {
			if to, ok := parts[*s.Town]; ok {
				*to = uint8(i)
				found++
			}
		}
	}
	if found != len(parts) {
		return nil, fmt.Errorf("worldgen: %d of a town's %d surfaces are in the catalog", found, len(parts))
	}
	c.kitOf = make([]uint8, len(c.biomeIDs))
	for i, id := range c.biomeIDs {
		k := slices.IndexFunc(w.Towns.Kits, func(k catalog.TownKit) bool { return string(k.Biome) == id })
		if k < 0 {
			return nil, fmt.Errorf("worldgen: the biome %q has no kit", id)
		}
		c.kitOf[i] = uint8(k)
	}
	plants := map[string]catalog.Form{}
	for _, p := range w.Flora.Kinds {
		plants[string(p.ID)] = p.Form
	}
	roles := map[catalog.Feature]*uint8{catalog.FeatureStream: &c.featureSurface.stream, catalog.FeatureMangrove: &c.featureSurface.mangrove,
		catalog.FeatureSulphur: &c.featureSurface.sulphur, catalog.FeatureGuano: &c.featureSurface.guano}
	found = 0
	for i, s := range w.Surfaces {
		c.canopy[i] = s.Canopy
		for _, cv := range s.Cover {
			f, ok := plants[string(cv.Plant)]
			if !ok {
				return nil, fmt.Errorf("worldgen: the surface %q grows %q, which is not a plant", s.ID, cv.Plant)
			}
			c.cover[i] = append(c.cover[i], formCover{form: f, share: cv.Share})
		}
		if s.Feature != nil {
			if to, ok := roles[*s.Feature]; ok {
				*to = uint8(i)
				found++
			}
		}
	}
	if found != len(roles) {
		return nil, fmt.Errorf("worldgen: %d of the features' %d surfaces are in the catalog", found, len(roles))
	}
	if err := c.features.read(w, c.biomeIDs); err != nil {
		return nil, err
	}
	c.score = w.Score
	c.mainLight = -1
	for i, ch := range w.Lights.Characters {
		if ch.Notation == w.Lights.MainPortCharacter {
			c.mainLight = i
		}
	}
	if c.mainLight < 0 {
		return nil, fmt.Errorf("worldgen: the main port's light %q is not a character", w.Lights.MainPortCharacter)
	}
	return c, nil
}

// sqrtArea is the radius of a circle of the area given.
func sqrtArea(area float64) float64 { return math.Sqrt(area / math.Pi) }

// tan is the tangent of a.
func tan(a float64) float64 {
	s, c := sincos(a)
	return s / c
}

// sizeOf is the size class of an island of the area given.
func (c *config) sizeOf(area float64) string {
	width := float64(2 * sqrtArea(area))
	for _, s := range c.sizes {
		if width < s.below {
			return s.class
		}
	}
	return c.sizes[len(c.sizes)-1].class
}
