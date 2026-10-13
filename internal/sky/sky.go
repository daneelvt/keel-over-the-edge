// SPDX-License-Identifier: AGPL-3.0-only

// Package sky is the rule of the sky: where the sun, the moon and the stars
// stand from any place on the disk at any time. It is written once, here,
// and run by the server and, as part of the WebAssembly module, by the
// client, so every player sees the same sky and the server can judge by it.
//
// The disk is the polar cap of the sky's sphere, with the centre of the
// disk at the pole. A boat r nautical miles from the centre stands at the
// angle Scale × r from the pole, so it sees the sky of the latitude
// 90° − Scale × r: the Pole's at the centre, and with ten degrees to the
// mile that of 45° north at the rim. A body's height is 90° less the angle
// on the sphere between the boat and the point the body stands over.
//
// The stars keep their catalogue places and turn about the pole once in a
// sidereal day; the star at the pole never moves. The sun rides a great
// circle over the centre, rising due east and setting due west there, once
// a day, so that day and night are equal everywhere. The moon rides the
// same circle behind the sun by its age, and its lit share follows from
// that age.
//
// Sky time is whole microseconds of UTC since the sky's epoch, the same in
// every world, held in a float64, which is exact for 285 years. Every angle
// is the fraction of its period that sky time has run, taken on whole
// numbers, so none loses precision however old the sky is.
//
// The package is held to the physics package's rules (tools/physics): its
// own sine, cosine and arctangent, no fused multiply-add, no allocation.
package sky

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

const (
	turn         = 2 * math.Pi
	degree       = math.Pi / 180
	nauticalMile = 1852 // m
	minute       = 60e6 // µs
	microsPerSec = 1e6
)

// Params are the sky's numbers, as the catalog has them.
type Params struct {
	Day          float64 // the day, in minutes
	Year         float64 // the year, in days: the stars gain one turn on the sun in it
	Month        float64 // the moon's month, new moon to new moon, in days
	Scale        float64 // degrees of the sky to a nautical mile on the water
	Epoch        float64 // sky time zero, in seconds of UTC since 1970
	SunAtEpoch   float64 // the sun's angle past the centre's noon at the epoch, in degrees
	StarsAtEpoch float64 // the stars' turn beyond the sun's at the epoch, in degrees
	MoonAtEpoch  float64 // the moon's age at the epoch, in degrees past new
}

// ParamsSize is how many float64s Params holds.
const ParamsSize = 8

// Prepared is Params made ready: the periods in whole microseconds, the
// angles in radians.
type Prepared struct {
	day, year, month    float64 // µs, whole
	scale               float64 // rad/m
	epoch               float64 // µs of UTC since 1970
	sun0, stars0, moon0 float64 // rad
}

// Body is where a body stands from a place: its direction in the place's
// own east, north and up, its height above the true horizon and its
// bearing, clockwise from north, in radians. The bearing of a body at the
// zenith is 0.
type Body struct {
	East, North, Up   float64
	Altitude, Bearing float64
}

// Sky is the sky from a place at a time.
type Sky struct {
	Sun, Moon Body
	// Lit is the moon's lit share: 0 new, 1 full.
	Lit float64
	// Stars turns a star's catalogue vector (Vector) into its direction in
	// the place's east, north and up: three rows of three.
	Stars [9]float64
}

// SkySize and BodySize are how many float64s a Sky and a Body hold.
const (
	SkySize  = 20
	BodySize = 5
)

// Prepare readies the sky's numbers. The periods are rounded to whole
// microseconds, so that an angle's fraction is taken on whole numbers.
func Prepare(p *Params, s *Prepared) {
	s.day = math.Floor(float64(p.Day*minute) + 0.5)
	s.year = math.Floor(float64(p.Year*s.day) + 0.5)
	s.month = math.Floor(float64(p.Month*s.day) + 0.5)
	s.scale = p.Scale * degree / nauticalMile
	s.epoch = math.Floor(float64(p.Epoch*microsPerSec) + 0.5)
	s.sun0 = p.SunAtEpoch * degree
	s.stars0 = p.StarsAtEpoch * degree
	s.moon0 = p.MoonAtEpoch * degree
}

// Day is the length of the day, in microseconds.
func (s *Prepared) Day() float64 { return s.day }

// Year is the length of the year, in microseconds.
func (s *Prepared) Year() float64 { return s.year }

// Month is the length of the moon's month, in microseconds.
func (s *Prepared) Month() float64 { return s.month }

// Time is sky time at a world's time: the world's epoch, in microseconds of
// UTC since 1970, and the microseconds the world has run since. Two worlds
// with different epochs have the same sky at the same moment.
func Time(s *Prepared, worldEpoch, worldTime float64) float64 {
	return math.Floor(worldEpoch-s.epoch) + math.Floor(worldTime)
}

// phase is 2π × the fractional part of t ÷ period, for whole t and period
// below 2⁵³: the quotient's whole part is found in floats and taken away
// exactly, so the remainder is exact.
func phase(t, period float64) float64 {
	q := math.Floor(t / period)
	r := t - float64(q*period)
	// The quotient rounds to the nearest float, which may be the whole
	// number just past it.
	if r < 0 {
		r += period
	} else if r >= period {
		r -= period
	}
	// The conversion keeps the product whole when the call is inlined into
	// a sum.
	return float64(turn * (r / period))
}

// angles are the sun's angle past the centre's noon, the stars' turn and
// the moon's age at sky time t, in radians.
func angles(s *Prepared, t float64) (sun, stars, moon float64) {
	t = math.Floor(t)
	sun = phase(t, s.day) + s.sun0
	stars = sun + phase(t, s.year) + s.stars0
	moon = phase(t, s.month) + s.moon0
	return sun, stars, moon
}

// frame is the turn that carries the centre's east, north and up to a
// place's: by the place's angle from the pole, about the level axis square
// to its bearing from the centre. Its rows are the place's east, north and
// up, in the centre's axes.
func frame(s *Prepared, east, north float64, m *[9]float64) {
	r := math.Sqrt(float64(east*east) + float64(north*north))
	if r == 0 {
		*m = [9]float64{1, 0, 0, 0, 1, 0, 0, 0, 1}
		return
	}
	ux, uy := east/r, north/r
	sc, cc := physics.SinCos(s.scale * r)
	k := 1 - cc
	m[0] = cc + float64(float64(k*uy)*uy)
	m[1] = -float64(k*ux) * uy
	m[2] = -sc * ux
	m[3] = m[1]
	m[4] = cc + float64(float64(k*ux)*ux)
	m[5] = -sc * uy
	m[6] = sc * ux
	m[7] = sc * uy
	m[8] = cc
}

// place writes to b the body in direction (x, y, z) in a place's east,
// north and up.
func place(x, y, z float64, b *Body) {
	b.East, b.North, b.Up = x, y, z
	b.Altitude = physics.Atan2(z, math.Sqrt(float64(x*x)+float64(y*y)))
	bearing := physics.Atan2(x, y)
	if bearing < 0 {
		bearing += turn
	}
	b.Bearing = bearing
}

// apply writes to b the body in direction (x, y, z) in the centre's axes,
// as the place whose frame is m sees it.
func apply(m *[9]float64, x, y, z float64, b *Body) {
	place(
		float64(m[0]*x)+float64(m[1]*y)+float64(m[2]*z),
		float64(m[3]*x)+float64(m[4]*y)+float64(m[5]*z),
		float64(m[6]*x)+float64(m[7]*y)+float64(m[8]*z),
		b,
	)
}

// starMatrix is the place's frame after the stars' turn: m × T, where T
// carries a catalogue vector to the centre's axes at the stars' angle. A
// star's point bears angle − right ascension from the centre.
func starMatrix(m *[9]float64, angle float64, out *[9]float64) {
	sa, ca := physics.SinCos(angle)
	for i := 0; i < 9; i += 3 {
		a, b := m[i], m[i+1]
		out[i] = float64(a*sa) + float64(b*ca)
		out[i+1] = float64(b*sa) - float64(a*ca)
		out[i+2] = m[i+2]
	}
}

// At writes to out the sky at sky time t from the place east and north of
// the centre, in metres.
func At(s *Prepared, t, east, north float64, out *Sky) {
	sun, stars, moon := angles(s, t)
	var m [9]float64
	frame(s, east, north, &m)
	ss, cs := physics.SinCos(sun)
	apply(&m, -ss, 0, cs, &out.Sun)
	sm, cm := physics.SinCos(sun - moon)
	apply(&m, -sm, 0, cm, &out.Moon)
	out.Lit = (1 - physics.Cos(moon)) / 2
	starMatrix(&m, stars, &out.Stars)
}

// SunAltitude is the sun's height above the true horizon at sky time t
// from a place, in radians: below zero, it is night there.
func SunAltitude(s *Prepared, t, east, north float64) float64 {
	sun, _, _ := angles(s, t)
	var m [9]float64
	frame(s, east, north, &m)
	ss, cs := physics.SinCos(sun)
	var b Body
	apply(&m, -ss, 0, cs, &b)
	return b.Altitude
}

// Vector is a star's catalogue vector, from its right ascension and
// declination in degrees: the vector the stars' matrix turns. A star at
// the pole is on the axis itself.
func Vector(ra, dec float64) (x, y, z float64) {
	if dec >= 90 {
		return 0, 0, 1
	}
	sd, cd := physics.SinCos(dec * degree)
	sa, ca := physics.SinCos(ra * degree)
	return cd * ca, cd * sa, sd
}

// Star writes to out the star of a right ascension and declination, in
// degrees, at sky time t from a place: the stars' matrix on its vector.
func Star(s *Prepared, t, east, north, ra, dec float64, out *Body) {
	_, stars, _ := angles(s, t)
	var m, sm [9]float64
	frame(s, east, north, &m)
	starMatrix(&m, stars, &sm)
	x, y, z := Vector(ra, dec)
	apply(&sm, x, y, z, out)
}
