// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Rain at a point is a rate in millimetres an hour, the most of each
// source's: a front's band behind its line, a squall's core, a shower's,
// and a storm's spiral bands, turning with the tick. A system's rain
// follows its strength, not its cloud strength, so its rain and its gust
// front come together.
//
// Its words are WMO-No. 8's (2008): light under 2.5 mm an hour, moderate
// to 10, heavy to 50, violent above. It shortens the visibility by its
// extinction, 0.16 R^0.74 per km for R mm an hour (Shipley and others
// 1974), added to the clear air's; on the game's stage visibility is 0.4 of
// the real, as the game's visibility words are, so the extinction is
// taken over 0.4.

// The words for rain, from RainWord.
const (
	RainNone     = 0
	RainLight    = 1
	RainModerate = 2
	RainHeavy    = 3
	RainViolent  = 4
)

// rainLeast is the least rate that is rain at all, mm an hour.
const rainLeast = 0.05

// koschmieder is the visual range's constant: a contrast of 2%, ln 50.
const koschmieder = 3.912

// The spiral bands' shape: they wind out bandWinding radians over the
// storm's size, are whole within bandsWhole of their reach, and leave
// bandFloor of the rate between them.
const (
	bandWinding = 7
	bandsWhole  = 0.4
	bandFloor   = 0.3
)

// RainAt is the rain at (x, y), mm an hour, at the tick t was set to.
func RainAt(t *WeatherTick, x, y float64) float64 {
	c := &t.p.clouds
	rain := 0.0
	if c.rainRate > 0 {
		for i := range t.nf {
			f := &t.fronts[i]
			d := float64(x*f.fe) + float64(y*f.fn) - f.line
			q := float64((d + c.rainAt) * c.invRain)
			if q*q < 30 {
				rain = max2(rain, float64(c.rainRate*Exp(-float64(q*q))))
			}
		}
	}
	for i := range t.ns {
		st := &t.sys[i]
		if !(st.k.cloud.rate > 0) {
			continue
		}
		rain = max2(rain, st.rain(t.Tick, x, y))
	}
	return rain
}

// rain is a system's rain at (x, y) at a tick, mm an hour.
func (st *systemTick) rain(tick, x, y float64) float64 {
	k := &st.k.cloud
	dx, dy := x-st.cx, y-st.cy
	d2 := float64(dx*dx) + float64(dy*dy)
	rate := float64(k.rate * st.strength)
	if !(k.bands > 0) {
		w := float64(k.width * st.size)
		q := d2 / max2(float64(w*w), 1)
		if !(q < 30) {
			return 0
		}
		return float64(rate * Exp(-q))
	}
	reach := float64(k.width * st.size)
	if !(d2 < float64(reach*reach)) {
		return 0
	}
	d := math.Sqrt(d2)
	turn := cycle(k.bandTurns, tick) + float64(unit(st.seed)*(2*math.Pi))
	angle := float64(k.bands*Atan2(dy, dx)) + float64(bandWinding*d)/st.size - turn
	band := 0.5 + float64(0.5*Sin(angle))
	shape := bandFloor + float64((1-bandFloor)*float64(float64(band*band)*band))
	return float64(float64(rate*shape) * fall(d, float64(bandsWhole*reach), reach))
}

// rainCore is a system's rain at its core now, mm an hour, and how far
// from its centre it falls at a millimetre an hour or more, m.
func (st *systemTick) rainCore() (rate, reach float64) {
	k := &st.k.cloud
	rate = float64(k.rate * st.strength)
	if !(rate > 1) {
		return rate, 0
	}
	if k.bands > 0 {
		return rate, float64(k.width * st.size)
	}
	return rate, float64(float64(k.width*st.size) * math.Sqrt(Log(rate)))
}

// RainWord is the word for rain of a rate, mm an hour: RainNone to
// RainViolent.
func (w *WeatherPrepared) RainWord(rate float64) int32 {
	c := &w.clouds
	switch {
	case !(rate >= rainLeast):
		return RainNone
	case rate < c.words[0]:
		return RainLight
	case rate < c.words[1]:
		return RainModerate
	case rate < c.words[2]:
		return RainHeavy
	}
	return RainViolent
}

// RainVisibility is the visibility in rain of a rate, mm an hour, where
// the clear air's is clear, m: Koschmieder's 3.912 over the clear air's
// extinction and the rain's, on the game's stage.
func (w *WeatherPrepared) RainVisibility(rate, clear float64) float64 {
	c := &w.clouds
	sigma := 0.0
	if clear > 0 {
		sigma = koschmieder / clear
	}
	if rate > 0 && c.extA > 0 {
		perKm := float64(c.extA * Exp(float64(c.extB*Log(rate))))
		sigma += float64(float64(perKm*c.invScale) * 0.001)
	}
	if !(sigma > 0) {
		return clear
	}
	return koschmieder / sigma
}
