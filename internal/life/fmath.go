// SPDX-License-Identifier: AGPL-3.0-only

package life

import "math"

// The schedule's arithmetic follows the physics package's rules, which go
// run ./tools/physics -check holds it to, as it does the world generator:
// from package math only the operations IEEE 754 rounds exactly; sines and
// arctangents from the physics package; every product added to or taken
// from written float64(…), so that Go fuses none into a multiply-add; and
// floats made integers only through toInt32. Whether anything happens is
// decided by integer draws alone.

// toInt32 converts f to an int32, truncating toward zero: NaN gives 0 and
// out-of-range values saturate, the same on every machine.
func toInt32(f float64) int32 {
	switch {
	case f != f:
		return 0
	case f >= math.MaxInt32:
		return math.MaxInt32
	case f <= math.MinInt32:
		return math.MinInt32
	}
	return int32(f)
}

// turn is an angle in [0, 2π).
func turn(a float64) float64 {
	const whole = 2 * math.Pi
	a -= float64(math.Floor(a/whole) * whole)
	if a < 0 {
		a += whole
	}
	if a >= whole {
		a -= whole
	}
	return a
}
