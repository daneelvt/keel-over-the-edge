// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"fmt"
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/names"
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
	db        *names.DB
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
	surfaces    struct{ beach, low, high, steep, bed uint8 }
}

func pair(v []float64) [2]float64 { return [2]float64{v[0], v[1]} }
func ipair(v []int) [2]int        { return [2]int{v[0], v[1]} }

// newConfig reads the catalog's world values.
func newConfig(cat *catalog.Catalog, db *names.DB) (*config, error) {
	w := &cat.World
	c := &config{db: db}
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
