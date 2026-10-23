// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A place's weather is measured on the water about it, as a boat there
// would meet it: at its centre and eight points a quarter of a nautical
// mile beyond an island's bounds, or about a port or a light, the mean
// wind, its typical strongest gust, the rain, the visibility and what is
// near each; the pressure at its centre; and the regime's risk there, its
// fog patches only where the fog's own rule lets a bank be born. The
// page's twin is client/src/chart/place.ts.

// placeReach is how far beyond a place's bounds, or about it, its weather
// is measured, m: a quarter of a nautical mile.
const placeReach = 0.25 * nauticalMile

// PlacePoints are the points a place's weather is measured at: its centre,
// then the corners and the middles of the sides of its bounds (west,
// south, east, north, m) grown by a quarter of a mile; with no bounds,
// eight points a quarter of a mile about it, from the north clockwise.
func PlacePoints(east, north float64, bounds *[4]float64) [9][2]float64 {
	out := [9][2]float64{{east, north}}
	if bounds == nil {
		for i := range 8 {
			s, c := physics.SinCos(float64(float64(i) * (3.141592653589793 / 4)))
			out[i+1] = [2]float64{east + float64(placeReach*s), north + float64(placeReach*c)}
		}
		return out
	}
	w, s, e, n := bounds[0]-placeReach, bounds[1]-placeReach, bounds[2]+placeReach, bounds[3]+placeReach
	mx, my := float64(0.5*(w+e)), float64(0.5*(s+n))
	ring := [8][2]float64{{mx, n}, {e, n}, {e, my}, {e, s}, {mx, s}, {w, s}, {w, my}, {w, n}}
	copy(out[1:], ring[:])
	return out
}

// Risk is a regime's risk: its sky's words, whether it makes fog patches,
// which the fog's rule allows only in light air by night and at dawn.
type Risk struct {
	Sky string
	Fog bool
}

// FogRule is when a fog bank may be born: in a mean wind under Calm, m/s,
// by night or within Dawn ticks of sunrise.
type FogRule struct {
	Calm float64
	Dawn int64
}

// RisksOf are the catalog's risks, by the regimes' indices, and the fog's
// rule, its night-born kind's.
func RisksOf(c *catalog.Catalog) ([]Risk, FogRule) {
	out := make([]Risk, len(c.Weather.Regimes))
	for _, r := range c.Weather.Forecast.Risks {
		i := RegimeIndex(c, string(r.Regime))
		if i < 0 {
			continue
		}
		out[i].Sky = string(r.Sky)
		for _, m := range r.Marks {
			out[i].Fog = out[i].Fog || m == catalog.RiskMarkFogPatches
		}
	}
	var fog FogRule
	for _, k := range c.Weather.Systems {
		if k.Night {
			fog = FogRule{Calm: k.CalmBelow * knot, Dawn: int64(k.Dawn * ticksPerMinute)}
		}
	}
	return out, fog
}

// RiskAt is the sky a regime's risk gives at a place: its words, but for
// fog patches where the fog's rule does not allow them: "fair". mean is
// the mean wind at the place, m/s; sun the sun's height there now and Dawn
// before, rad.
func RiskAt(r Risk, fog FogRule, mean float64, sun [2]float64) string {
	if r.Fog && !(mean < fog.Calm && (sun[0] < 0 || sun[1] < 0)) {
		return skies[skyFair]
	}
	return r.Sky
}

// SampleAt is the weather at a point at the tick t was set to.
func SampleAt(t *physics.WeatherTick, x, y float64) PlaceSample {
	mean, from, gust, _ := physics.TypicalAt(t, x, y)
	return PlaceSample{
		Mean: mean, From: from, Gust: gust,
		Rain: physics.RainAt(t, x, y), Visibility: physics.VisibilityAt(t, x, y), Near: int(physics.NearAt(t, x, y)),
	}
}

// PlaceAt is a place's weather: at its points at the tick now was set to,
// the pressure at its centre then and at the ticks before and quarter were
// set to, 5 and 15 minutes before, and the risk of the regime in effect,
// risks by the regimes' indices; sun is the sun's height at its centre now
// and the fog's dawn before.
func PlaceAt(now, before, quarter *physics.WeatherTick, points *[9][2]float64, risks []Risk, fog FogRule, sun [2]float64) PlaceWeather {
	var w PlaceWeather
	for _, p := range points {
		w.Points = append(w.Points, SampleAt(now, p[0], p[1]))
	}
	c := points[0]
	w.Pressure = physics.PressureAt(now, c[0], c[1])
	w.Before = physics.PressureAt(before, c[0], c[1])
	w.Quarter = physics.PressureAt(quarter, c[0], c[1])
	if r := int(physics.RegimeAt(now)); r >= 0 && r < len(risks) {
		w.Risk = RiskAt(risks[r], fog, w.Points[0].Mean, sun)
	}
	w.Cyclonic = physics.NearAt(now, c[0], c[1])&physics.NearStorm != 0
	return w
}
