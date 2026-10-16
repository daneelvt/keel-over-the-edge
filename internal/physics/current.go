// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The current: the water's own motion over the disk. A slow circulation
// runs round it, one way or the other by the world, and the drain runs out
// toward the falls, ever faster toward the lip. Neither moves the refuge's
// water at the centre. Both fall off where the water shoals, in proportion
// to its depth, and are nothing over land. The current is steady for a
// world: a function of the place and the ground alone, so a client works it
// out as the server does, from the world's way and the ground it holds.
//
// A boat feels the current as it feels the waves' orbital motion: its hull
// and foils meet the water's flow less the water's own velocity, while its
// state, its sail and its windage stay in the ground's frame. This is the
// relative-velocity model of marine craft in an irrotational current
// (Fossen, Handbook of Marine Craft Hydrodynamics and Motion Control,
// 2021): the hydrodynamic forces from the velocity through the water, the
// body's inertia and its kinematics from the velocity over the ground.

// polyline is a speed linear between three points, nothing changed before
// the first and the last held beyond the last.
type polyline struct {
	at    [3]float64 // m from the centre
	value [3]float64 // m/s
	slope [2]float64 // m/s per m
}

func (l *polyline) prepare(at, value *[3]float64) {
	for i := range 3 {
		l.at[i] = float64(at[i] * nauticalMile)
		l.value[i] = float64(value[i] * knotSpeed)
	}
	for i := range 2 {
		if span := l.at[i+1] - l.at[i]; span > 0 {
			l.slope[i] = (l.value[i+1] - l.value[i]) / span
		}
	}
}

// of is the speed r metres from the centre.
func (l *polyline) of(r float64) float64 {
	switch {
	case !(r > l.at[0]):
		return l.value[0]
	case r < l.at[1]:
		return l.value[0] + float64((r-l.at[0])*l.slope[0])
	case r < l.at[2]:
		return l.value[1] + float64((r-l.at[1])*l.slope[1])
	}
	return l.value[2]
}

// CurrentAt is the current at (x, y), metres east and north of the centre:
// the circulation the world's way, 1 clockwise seen from above, −1 the
// other way and 0 for none, and the drain, scaled by the depth at the
// point's hexagon on the ground g; nil is the open sea everywhere. It
// returns its east and north parts, m/s, both exactly 0 where the water is
// still.
func CurrentAt(w *WeatherPrepared, way, x, y float64, g *Ground) (east, north float64) {
	r2 := float64(x*x) + float64(y*y)
	if !(r2 > w.stillWithin2) {
		return 0, 0
	}
	r := math.Sqrt(r2)
	round := float64(way * w.circulation.of(r))
	out := w.drain.of(r)
	if round == 0 && out == 0 {
		return 0, 0
	}
	if g != nil {
		e, _ := g.cellAt(HexAt(x, y))
		depth := float64(float64(-e) * 0.1)
		if depth < w.shallow {
			f := max2(float64(depth*w.invShallow), 0)
			round, out = float64(round*f), float64(out*f)
		}
	}
	// Outward along (x, y)/r; clockwise along (y, −x)/r.
	inv := 1 / r
	east = float64((float64(round*y) + float64(out*x)) * inv)
	north = float64((float64(out*y) - float64(round*x)) * inv)
	return east, north
}

// currentInFrame is a current (east, north) in the heading frame whose
// heading's sine and cosine are sinH and cosH: ahead and to starboard.
func currentInFrame(east, north, sinH, cosH float64) (ahead, starboard float64) {
	return float64(east*sinH) + float64(north*cosH), float64(east*cosH) - float64(north*sinH)
}
