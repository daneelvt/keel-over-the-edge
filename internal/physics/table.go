// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Small functions the model is built from. Each is exact or rounds the same
// way on every machine.

// lookup interpolates linearly in a table of values at x = 0, step, 2·step …,
// given invStep = 1/step. Beyond either end, and for NaN, it holds the end
// value.
func lookup(t []float64, x, invStep float64) float64 {
	f := float64(x * invStep)
	if !(f > 0) {
		return t[0]
	}
	last := len(t) - 1
	if f >= float64(last) {
		return t[last]
	}
	i := toInt32(f)
	frac := f - float64(i)
	return t[i] + float64(frac*(t[i+1]-t[i]))
}

// smooth rises from 0 at t ≤ 0 to 1 at t ≥ 1, with no step in its slope at
// either end.
func smooth(t float64) float64 {
	if !(t > 0) {
		return 0
	}
	if t >= 1 {
		return 1
	}
	return float64(t * t * (3 - float64(2*t)))
}

func clamp(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

// control clamps a player's control to its range, and makes NaN 0.
func control(x, lo, hi float64) float64 {
	if x != x {
		return 0
	}
	return clamp(x, lo, hi)
}

// approach moves x toward target by at most step.
func approach(x, target, step float64) float64 {
	if target > x+step {
		return x + step
	}
	if target < x-step {
		return x - step
	}
	return target
}

// sign returns -1, 0 or 1.
func sign(x float64) float64 {
	if x > 0 {
		return 1
	}
	if x < 0 {
		return -1
	}
	return 0
}

// 2π in two parts; the first holds 33 bits, so a multiple of it by an integer
// below 2^20 is exact.
const (
	twoPi1  = 4 * pio2_1
	twoPi1t = 4 * pio2_1t
)

// wrapAngle returns a, less the whole turns that bring it into [-π, π).
func wrapAngle(a float64) float64 {
	n := math.Floor(float64(a*(invPio2/4)) + 0.5)
	return (a - float64(n*twoPi1)) - float64(n*twoPi1t)
}
