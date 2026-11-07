// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// nauticalMile is a nautical mile, m.
const nauticalMile = 1852

// The water a route keeps to: deeper than shallowest, m below the sea,
// clear of shallower water by clear m, and within within m of the centre.
const (
	shallowest = 2.0
	clear      = 120.0
	within     = 4.2 * nauticalMile
)

// The waters the tally is split by: near the islands within nearLand of
// land, the outer water beyond outerFrom of the centre.
const (
	nearLand  = 1.5 * nauticalMile
	outerFrom = 3.5 * nauticalMile
)

// air is the weather the tally is sailed in at a tick: what the schedule
// draws in, and the visibility, m.
type air interface {
	life.Conditions
	Visibility(x, y float64) float64
}

// sea is a world as the tally sails it: its life schedule, its weather
// tick by tick, its chart of the water, and how long its week lasts,
// ticks.
type sea struct {
	sched *life.Schedule
	air   func(tick int64) air
	chart *chart
	week  int64
	seed  uint64
}

// worldSea is the world of a seed as keel makes it, with its week of
// weather from the sample epoch and its life schedule. A seed none of
// whose attempts passed the rules is sailed all the same, as its last.
func worldSea(cat *catalog.Catalog, wcfg *weather.Config, seed uint64) (*sea, error) {
	b, err := worldgen.Generate(seed, cat)
	if err != nil && !errors.Is(err, worldgen.ErrInvalid) {
		return nil, err
	}
	disk := wcfg.Prepared.Edge()
	epoch, ends := weather.SampleEpoch, weather.SampleEpoch+weather.SampleWeek
	w := weather.Generate(wcfg, b.Seed, epoch, ends, islandsOf(b))
	tl, err := weather.New(wcfg, w)
	if err != nil {
		return nil, err
	}
	if h, ok := b.Harbour(); ok {
		tl = tl.InHarbour(&h)
	}
	return &sea{
		sched: scheduleOf(cat, b, disk, epoch),
		air:   func(tick int64) air { return weatherAir{weatherAt(tl, tick)} },
		chart: newChart(b.Ground, disk),
		week:  weather.TicksOf(epoch, ends),
		seed:  seed,
	}, nil
}

// islandsOf is a world's islands as its week's showers form over them, as
// keel gives them.
func islandsOf(b *worldgen.Bundle) []weather.Island {
	var out []weather.Island
	for _, is := range b.Islands {
		if is.Group >= 0 {
			continue
		}
		out = append(out, weather.Island{X: is.X, Y: is.Y, Area: is.Area, Across: is.Across})
	}
	return out
}

// scheduleOf is a world's life schedule as keel builds it: its habitat
// from its terrain, its places and the disk, its seed, and the sky over it
// from its epoch, µs of UTC.
func scheduleOf(cat *catalog.Catalog, b *worldgen.Bundle, disk float64, epoch int64) *life.Schedule {
	p, kinds := life.Prepare(cat)
	places := life.Places{}
	for _, t := range b.Towns {
		places.Towns = append(places.Towns, [2]float64{t.X, t.Y})
	}
	sites := map[string]catalog.Site{}
	for _, k := range cat.World.Places.Kinds {
		sites[string(k.ID)] = k.Site
	}
	for _, pl := range b.Places {
		if s := sites[pl.Kind]; s == catalog.SiteReef || s == catalog.SiteLagoon {
			places.Reefs = append(places.Reefs, life.Reach{X: pl.X, Y: pl.Y, Half: math.Min(pl.Details.Length/2, 1000)})
		}
	}
	colony := map[string]bool{}
	for _, k := range cat.World.Features.Kinds {
		colony[string(k.ID)] = k.Site == catalog.FeatureSiteColony
	}
	for _, f := range b.Features {
		if colony[f.Kind] {
			places.Colonies = append(places.Colonies, [2]float64{f.X, f.Y})
		}
	}
	for _, is := range b.Islands {
		places.Islands = append(places.Islands, [2]float64{is.X, is.Y})
	}
	h := life.NewHabitat(p, b.Ground, places, disk)
	return life.NewSchedule(&life.Config{Params: p, Kinds: kinds, Habitat: h, Seed: b.Seed, Sky: cat.PrepareSky(), Epoch: epoch})
}

// weatherAt is a timeline's weather at a tick, with its spells, its coming
// front and its systems, as the simulation brings it there.
func weatherAt(tl *weather.Timeline, tick int64) *physics.WeatherTick {
	w := &physics.Weather{Prepared: tl.Prepared()}
	var sp [physics.WeatherSpells]physics.Spell
	w.Set(sp[:tl.Spells(tick, nil, &sp)])
	coming := tl.Coming(tick, nil)
	w.SetComing(&coming)
	var keys [bus.KeyFrames]physics.Keyframe
	tl.Keyframes(tick, nil, &keys)
	w.SetKeys(keys[:2])
	t := new(physics.WeatherTick)
	physics.WeatherAt(w, t, float64(tick))
	return t
}

// weatherAir is a world's weather at a tick.
type weatherAir struct{ t *physics.WeatherTick }

func (a weatherAir) Weather(x, y float64) (wind, rain float64) {
	wind, _ = physics.MeanWindAt(a.t, x, y)
	return wind, physics.RainAt(a.t, x, y)
}

func (a weatherAir) Visibility(x, y float64) float64 { return physics.VisibilityAt(a.t, x, y) }

// chart is a world's water in squares of chartCell m: how far each is from
// water too shallow to sail, or from beyond the routes' reach, and how far
// from land.
type chart struct {
	n      int32
	half   float64
	shoal  []float64 // m to the nearest square too shallow or too far out
	land   []float64 // m to the nearest square of land
	ground *physics.Ground
}

// chartCell is a chart's square, m.
const chartCell = 50.0

// newChart charts a world's ground (nil for open sea everywhere) over a
// disk of radius disk, m.
func newChart(g *physics.Ground, disk float64) *chart {
	c := &chart{half: disk, ground: g}
	c.n = int32(math.Ceil(2 * disk / chartCell))
	size := int(c.n) * int(c.n)
	shoal, land := make([]bool, size), make([]bool, size)
	for j := range c.n {
		for i := range c.n {
			x, y := c.centre(i, j)
			// The ground's deep water, in its decimetres.
			e := physics.DeepWater * 0.1
			if g != nil {
				e, _ = g.At(x, y)
			}
			k := int(j)*int(c.n) + int(i)
			land[k] = e >= 0
			shoal[k] = e >= -shallowest || math.Hypot(x, y) > within
		}
	}
	c.shoal, c.land = distances(shoal, c.n), distances(land, c.n)
	return c
}

// centre is the middle of square (i, j).
func (c *chart) centre(i, j int32) (x, y float64) {
	return (float64(i)+0.5)*chartCell - c.half, (float64(j)+0.5)*chartCell - c.half
}

// at is the square (x, y) is in, and whether it is on the chart.
func (c *chart) at(x, y float64) (int, bool) {
	i, j := int32(math.Floor((x+c.half)/chartCell)), int32(math.Floor((y+c.half)/chartCell))
	if i < 0 || j < 0 || i >= c.n || j >= c.n {
		return 0, false
	}
	return int(j)*int(c.n) + int(i), true
}

// Clearance is how far (x, y) is from water too shallow or too far out:
// nothing off the chart.
func (c *chart) Clearance(x, y float64) float64 {
	k, ok := c.at(x, y)
	if !ok {
		return 0
	}
	return c.shoal[k]
}

// FromLand is how far (x, y) is from land, m: as far as can be off the
// chart, and for a world with no land.
func (c *chart) FromLand(x, y float64) float64 {
	k, ok := c.at(x, y)
	if !ok {
		return math.Inf(1)
	}
	return c.land[k]
}

// distances is each square's distance to the nearest square set, m, by a
// chamfer's two passes (Borgefors 1986): within a few per cent of the
// straight line; as far as can be with none set.
func distances(set []bool, n int32) []float64 {
	d := make([]float64, len(set))
	for k, s := range set {
		if s {
			d[k] = 0
		} else {
			d[k] = math.Inf(1)
		}
	}
	diag := chartCell * math.Sqrt2
	relax := func(k int, i, j int32, di, dj int32, cost float64) {
		ii, jj := i+di, j+dj
		if ii < 0 || jj < 0 || ii >= n || jj >= n {
			return
		}
		if v := d[int(jj)*int(n)+int(ii)] + cost; v < d[k] {
			d[k] = v
		}
	}
	for j := range n {
		for i := range n {
			k := int(j)*int(n) + int(i)
			relax(k, i, j, -1, 0, chartCell)
			relax(k, i, j, 0, -1, chartCell)
			relax(k, i, j, -1, -1, diag)
			relax(k, i, j, 1, -1, diag)
		}
	}
	for j := n - 1; j >= 0; j-- {
		for i := n - 1; i >= 0; i-- {
			k := int(j)*int(n) + int(i)
			relax(k, i, j, 1, 0, chartCell)
			relax(k, i, j, 0, 1, chartCell)
			relax(k, i, j, 1, 1, diag)
			relax(k, i, j, -1, 1, diag)
		}
	}
	return d
}
