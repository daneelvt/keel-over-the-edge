// SPDX-License-Identifier: AGPL-3.0-only

// Package light is the rule of a lighthouse's light: whether it shows at a
// moment of world time, by its character and phase; how bright it is at a
// distance, by Allard's law; and how charts write it.
//
// A character is its light and dark in turn, in milliseconds, beginning
// with light, as IALA's Recommendation E-110 describes the rhythmic
// characters of lights. A light shows its character's step at (t + phase)
// mod period, in whole microseconds of world time, so that the server, the
// page and the owner's page agree to the microsecond and every player sees
// the same flash at the same moment. The page's copy of this rule
// (client/src/lights/character.ts) is held to the same schedule by the
// golden file this package's tests write.
package light

import (
	"fmt"
	"math"
	"strings"
)

// Period is a character's period, µs.
func Period(steps []int) int64 {
	var p int64
	for _, s := range steps {
		p += int64(s)
	}
	return p * 1000
}

// On reports whether a light of the character's steps and the phase given,
// µs, shows at world time t, µs.
func On(steps []int, phase, t int64) bool {
	p := Period(steps)
	if p <= 0 {
		return false
	}
	at := ((t+phase)%p + p) % p
	for i, s := range steps {
		d := int64(s) * 1000
		if at < d {
			return i%2 == 0
		}
		at -= d
	}
	return false
}

// NauticalMile is a nautical mile, m.
const NauticalMile = 1852.0

// Transmissivity is the air's transmissivity over a nautical mile for a
// meteorological visibility of v nautical miles: the share of a light's
// flux left after a mile, with visibility the distance at which contrast
// falls to 5% (IALA E-200-2). 0.741 for 10 miles.
func Transmissivity(v float64) float64 {
	return math.Pow(0.05, 1/v)
}

// Illuminance is the illuminance at d metres from a light of intensity i,
// candela, in air of transmissivity t a mile: Allard's law, E = I T^d / d²,
// lux.
func Illuminance(i, d, t float64) float64 {
	if d <= 0 {
		return math.Inf(1)
	}
	return i * math.Pow(t, d/NauticalMile) / (d * d)
}

// Intensity is the intensity, candela, of a light whose illuminance falls
// to the threshold, lux, at its range r, m, in air of transmissivity t a
// mile.
func Intensity(r, t, threshold float64) float64 {
	return threshold * r * r / math.Pow(t, r/NauticalMile)
}

// Notation is a light as charts write it: its character, the light's
// height above the sea and its nominal range, as Fl(3) W 15s 30m 2.5M.
func Notation(character string, focal, rangeM float64) string {
	nm := rangeM / NauticalMile
	r := fmt.Sprintf("%.1f", nm)
	r = strings.TrimSuffix(r, ".0")
	return fmt.Sprintf("%s %.0fm %sM", character, focal, r)
}
