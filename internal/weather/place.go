// SPDX-License-Identifier: AGPL-3.0-only

package weather

import "github.com/daneelvt/keel-over-the-edge/internal/physics"

// A place's weather is measured on the water about it, as a boat there
// would meet it: at its centre and eight points a quarter of a nautical
// mile beyond an island's bounds, or about a port or a light, the mean
// wind, its typical strongest gust, the rain, the visibility and what is
// near each; and the pressure at its centre. The page's twin is
// client/src/chart/place.ts.

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

// SampleAt is the weather at a point at the tick t was set to.
func SampleAt(t *physics.WeatherTick, x, y float64) PlaceSample {
	mean, from, gust, _ := physics.TypicalAt(t, x, y)
	return PlaceSample{
		Mean: mean, From: from, Gust: gust,
		Rain: physics.RainAt(t, x, y), Visibility: physics.VisibilityAt(t, x, y), Near: int(physics.NearAt(t, x, y)),
	}
}

// PlaceAt is a place's weather: at its points at the tick now was set to,
// and the pressure at its centre then and at the ticks before and quarter
// were set to, 5 and 15 minutes before.
func PlaceAt(now, before, quarter *physics.WeatherTick, points *[9][2]float64) PlaceWeather {
	var w PlaceWeather
	for _, p := range points {
		w.Points = append(w.Points, SampleAt(now, p[0], p[1]))
	}
	c := points[0]
	w.Pressure = physics.PressureAt(now, c[0], c[1])
	w.Before = physics.PressureAt(before, c[0], c[1])
	w.Quarter = physics.PressureAt(quarter, c[0], c[1])
	w.Cyclonic = physics.NearAt(now, c[0], c[1])&physics.NearStorm != 0
	return w
}
