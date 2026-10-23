// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Gale warnings are issued from a forecast's synoptic wind: its spells, its
// fronts, its lows and its patches, not its squalls and showers, which no
// forecast places. A gale blows where the mean wind reaches force 8 or the
// typical strongest gust reaches a gale's gusts: the Met Office's gale is
// "force 8 (34-40 knots) or gusts reaching 43-51 knots", "Gales or storms
// include gust-speed criteria" (Met Office, Marine forecasts glossary).
// The typical strongest gust is the gust field at its 90th percentile: the
// gusts most of the water meets at their strongest, not the rarest peak.

// The forces a gale warning names, and the least mean wind and gust of
// each above a gale, knots (Met Office, Marine forecasts glossary: severe
// gale "force 9 (41-47 knots) or gusts reaching 52-60 knots", storm "force
// 10 (48-55 knots) or gusts reaching 61-68 knots", violent storm "force 11
// (56-63 knots) or gusts of 69 knots or more", hurricane force "force 12
// (64 knots or more)").
var galeForces = [...]struct{ force, mean, gust float64 }{
	{9, 41, 52},
	{10, 48, 61},
	{11, 56, 69},
	{12, 64, math.Inf(1)},
}

// GaleStep is a step's gale: how many of the grid's points it covers, and
// its strongest point, m east and north, with its mean wind and typical
// strongest gust there, m/s, the direction the wind comes from, rad, and
// its force, 8 to 12; Points 0 for none.
type GaleStep struct {
	Points float64
	East   float64
	North  float64
	Mean   float64
	Gust   float64
	From   float64
	Force  float64
}

// Gales is a forecast's gale at each step.
type Gales struct {
	Steps [MaxForecastSteps]GaleStep
}

// GaleForce is the force a gale warning names for a mean wind and a typical
// strongest gust, m/s: 8 to 12, or 0 for less than a gale by the thresholds
// the forecast was prepared with.
func GaleForce(p *WeatherPrepared, mean, gust float64) float64 {
	fp := &p.forecast
	if !(mean >= fp.galeMean) && !(gust >= fp.galeGust) {
		return 0
	}
	f := 8.0
	for _, g := range galeForces {
		if float64(mean*(1/knotSpeed)) >= g.mean || float64(gust*(1/knotSpeed)) >= g.gust {
			f = g.force
		}
	}
	return f
}

// GaleGrid sets on, of the gale grid's points, 1 where the synoptic wind of
// the tick t was set to blows a gale over water, 0 elsewhere, and returns
// the step's gale. water is the grid's water, 1 where a point is over it;
// a point beyond the grid's reach from the centre is never in a gale. t
// must be set from a Weather whose Synoptic is set.
func GaleGrid(p *WeatherPrepared, t *WeatherTick, water, on []uint8) GaleStep {
	fp := &p.forecast
	side := fp.side
	c := float64(float64(side-1) * 0.5)
	var g GaleStep
	best := 0.0
	for j := range side {
		y := float64((float64(j) - c) * fp.grid)
		for i := range side {
			n := j*side + i
			if int(n) < len(on) {
				on[n] = 0
			}
			x := float64((float64(i) - c) * fp.grid)
			if float64(x*x)+float64(y*y) > fp.within2 || int(n) >= len(water) || water[n] == 0 {
				continue
			}
			mean, from, gust, _ := TypicalAt(t, x, y)
			if !(mean >= fp.galeMean) && !(gust >= fp.galeGust) {
				continue
			}
			if int(n) < len(on) {
				on[n] = 1
			}
			g.Points++
			if score := max2(mean/fp.galeMean, gust/fp.galeGust); score > best {
				best = score
				g.East, g.North, g.Mean, g.Gust, g.From = x, y, mean, gust, from
			}
		}
	}
	if g.Points > 0 {
		g.Force = GaleForce(p, g.Mean, g.Gust)
	}
	return g
}

// GaleWater sets water, the gale grid's water, from the ground: 1 for a
// point over water, 0 over land; with no ground, all water.
func GaleWater(p *WeatherPrepared, g *Ground, water []uint8) {
	fp := &p.forecast
	side := fp.side
	c := float64(float64(side-1) * 0.5)
	for j := range side {
		y := float64((float64(j) - c) * fp.grid)
		for i := range side {
			n := j*side + i
			if int(n) >= len(water) {
				return
			}
			water[n] = 1
			if g != nil {
				if e, _ := g.At(float64((float64(i)-c)*fp.grid), y); e > 0 {
					water[n] = 0
				}
			}
		}
	}
}

// GaleScan sets out to the forecast's gale at each of its steps, from its
// synoptic wind over the grid's water. w and t are the caller's room to
// work in, on is the grid's room for each step's points.
func GaleScan(p *WeatherPrepared, f *Forecast, w *Weather, t *WeatherTick, water, on []uint8, out *Gales) {
	for k := range out.Steps {
		out.Steps[k] = GaleStep{}
	}
	w.Prepared = p
	synoptic := w.Synoptic
	w.Synoptic = true
	for k := range toInt32(f.Head.Steps) {
		tick := f.Head.Issue + float64(float64(k)*f.Head.Step)
		ForecastAt(w, f, tick)
		WeatherAt(w, t, tick)
		out.Steps[k] = GaleGrid(p, t, water, on)
	}
	w.Synoptic = synoptic
}
