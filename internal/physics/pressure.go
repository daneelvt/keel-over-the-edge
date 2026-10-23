// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The pressure at a point is a function of the same inputs as the wind, so
// the barometer, the isobars and the wind agree: the spells' levels, mixed
// as their winds are, or at a change with no front eased evenly from the
// old level to the new over the ease, so a change of spell never reads as
// a storm's fall; behind a front's line, the new spell's level rising back
// to itself; a gentle slope across the disk with low pressure on the left
// of the base wind, so that Buys Ballot's law holds of the spells' own
// wind (American Meteorological Society, Glossary of Meteorology, Buys
// Ballot's law); a front's trough; and each dome's and low's shape.

// The tendency's words: the change over a quarter of an hour, at the
// world's pace a real three hours, named as the Met Office's marine
// forecasts name a three-hour change (Met Office, Marine forecasts
// glossary).
const (
	TendencySteady  = 0 // under 0.1 hPa
	TendencySlowly  = 1 // 0.1–1.5 hPa
	TendencyPlain   = 2 // 1.6–3.5 hPa
	TendencyQuickly = 3 // 3.6–6 hPa
	TendencyRapidly = 4 // over 6 hPa: very rapidly
)

// The changes that part the tendency's words, hPa.
const (
	tendSteady  = 0.1
	tendSlowly  = 1.5
	tendPlain   = 3.5
	tendQuickly = 6
	// tendTurned is the least change in the last few minutes, against the
	// quarter of an hour's, that turns the words to "now rising" or "now
	// falling".
	tendTurned = 0.05
)

// PressureAt is the pressure at (x, y) at the tick t was set to, hPa.
func PressureAt(t *WeatherTick, x, y float64) float64 {
	if t.n == 0 {
		return standardPress
	}
	if t.n == 1 && t.at[0].s.steady {
		return t.at[0].s.level
	}
	w := t.p
	r := math.Sqrt(float64(x*x) + float64(y*y))
	b := t.base(x, y, r, pointMean)
	var p float64
	if t.easing {
		// A change with no front, from the level the spell before gave
		// here, still rising if a front brought it, to the spell in
		// effect's, the last in play.
		from := t.levelOf(t.easeFrom, x, y)
		p = from + float64(t.ease*(t.at[t.n-1].s.level-from))
	} else {
		for i := range t.n {
			p += float64(b.shares[i] * t.levelOf(t.at[i].s, x, y))
		}
	}
	// Low on the left with the base wind at one's back: the air's motion
	// turned anticlockwise, by the angle a large system's wind is turned
	// from its slope.
	sin, cos := SinCos(b.dir)
	me, mn := -float64(b.speed*sin), -float64(b.speed*cos)
	le := float64(me*w.frontCos) - float64(mn*w.frontSin)
	ln := float64(mn*w.frontCos) + float64(me*w.frontSin)
	p -= float64(w.slope * (float64(le*x) + float64(ln*y)))
	if t.front {
		f, _ := w.trough(b.s)
		p += float64(t.trough * f)
	}
	for i := range t.ns {
		if st := &t.sys[i]; st.k.shape != ShapeNone {
			p += st.pressure(x, y)
		}
	}
	return p
}

// levelOf is a spell's pressure level at (x, y): its own, or for a spell a
// front brought, its own less what it has still to rise since the line
// passed the point.
func (t *WeatherTick) levelOf(s *spell, x, y float64) float64 {
	if !s.front {
		return s.level
	}
	w := t.p
	// The tick the line passed the point.
	passed := s.begin + float64((float64(x*s.fsin)+float64(y*s.fcos)+w.frontReach)/s.fspeed)
	rose := clamp(float64(w.rise*(t.Tick-passed)), 0, w.riseMost)
	return s.level - w.riseMost + rose
}

// Tendency is the barometer's tendency: the words for the change from a
// quarter of an hour before to now, one of the Tendency constants, negative
// falling; and whether the last few minutes, from before to now, turned
// against it: "now rising" after a fall, "now falling" after a rise.
func Tendency(now, before, quarter float64) (words int32, turned bool) {
	d := now - quarter
	a := math.Abs(d)
	switch {
	case !(a >= tendSteady):
		words = TendencySteady
	case a <= tendSlowly:
		words = TendencySlowly
	case a <= tendPlain:
		words = TendencyPlain
	case a <= tendQuickly:
		words = TendencyQuickly
	default:
		words = TendencyRapidly
	}
	if d < 0 {
		words = -words
	}
	last := now - before
	turned = words != 0 && (d < 0 && last > tendTurned || d > 0 && last < -tendTurned)
	return words, turned
}
