// SPDX-License-Identifier: AGPL-3.0-only

// Package light is the rule of a lighthouse's light: whether it shows at a
// moment of world time, by its character and phase; how bright it is at a
// distance, by Allard's law; and how charts write it. And the rule of its
// fog signal: when its blasts sound, by its pattern and the light's phase,
// and which pattern each lighthouse is given.
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

// Blast reports whether a fog signal of the steps given, its blasts and
// silences in turn in milliseconds beginning with a blast, and the phase
// given, µs, is sounding a blast at world time t, µs, and if so when that
// blast began, µs. A fog signal's pattern is written "in the same way as
// the phases of a light" (IHO S-12), and keeps the same schedule.
func Blast(steps []int, phase, t int64) (start int64, on bool) {
	p := Period(steps)
	if p <= 0 {
		return 0, false
	}
	at := ((t+phase)%p + p) % p
	for i, s := range steps {
		d := int64(s) * 1000
		if at < d {
			if i%2 != 0 {
				return 0, false
			}
			return t - at, true
		}
		at -= d
	}
	return 0, false
}

// AssignFogSignals gives each light, in the order given, which is their
// numbers', a fog signal: the first of the patterns of its device that no
// light before it within apart m has, so that signals heard together
// differ; or, where every one of them is had, the one whose nearest holder
// is furthest. places are the lights' places, m east and north; devices
// each light's device; patterns each pattern's device. It returns each
// light's pattern by its index in patterns, −1 for a device with none.
func AssignFogSignals(places [][2]float64, devices, patterns []string, apart float64) []int {
	out := make([]int, len(places))
	apart2 := apart * apart
	for i, p := range places {
		out[i] = -1
		best, bestNear := -1, -1.0
		for j, d := range patterns {
			if d != devices[i] {
				continue
			}
			// The nearest light before this one with pattern j, squared.
			near := math.Inf(1)
			for k := range i {
				if out[k] != j {
					continue
				}
				dx, dy := places[k][0]-p[0], places[k][1]-p[1]
				near = min(near, float64(dx*dx)+float64(dy*dy))
			}
			if near > apart2 {
				best = j
				break
			}
			if near > bestNear {
				best, bestNear = j, near
			}
		}
		out[i] = best
	}
	return out
}

// NauticalMile is a nautical mile, m.
const NauticalMile = 1852.0

// Transmissivity is the air's transmissivity over a nautical mile for a
// visibility of v nautical miles: the share of a light's flux left after a
// mile, e^(−σ × 1 mile) in air of extinction σ (IALA R0202), with
// visibility the distance at which contrast falls to 2%, Koschmieder's
// 3.912 / σ, as every visibility in the game is. 0.676 for 10 miles.
func Transmissivity(v float64) float64 {
	return math.Exp(-Koschmieder / v)
}

// Koschmieder is ln 50: the optical depth at which a contrast falls to 2%.
const Koschmieder = 3.912

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
