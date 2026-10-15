// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The generator's arithmetic follows the physics package's rules, which
// go run ./tools/physics -check holds it to, so that a seed makes the same
// world on every machine: from package math only the operations IEEE 754
// rounds exactly; sines, exponentials and logarithms from the physics
// package; every product that is added to or subtracted from written
// float64(…), so that Go cannot fuse it into a multiply-add on arm64 or
// amd64 v3; and floats made integers only through toInt32.

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

// floor is ⌊f⌋ as an int32.
func floor(f float64) int32 { return toInt32(math.Floor(f)) }

// round is f rounded to the nearest whole number, halves up, as an int32.
func round(f float64) int32 { return toInt32(math.Floor(f + 0.5)) }

// pow is x to the power y, for x > 0.
func pow(x, y float64) float64 {
	if !(x > 0) {
		return 0
	}
	return physics.Exp(float64(y * physics.Log(x)))
}

func lerp(t, a, b float64) float64 { return a + float64(t*(b-a)) }

func clamp(x, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, x)) }

// smoothstep is 0 below a, 1 above b, and Hermite's cubic between.
func smoothstep(a, b, x float64) float64 {
	if !(b > a) {
		if x < a {
			return 0
		}
		return 1
	}
	t := clamp((x-a)/(b-a), 0, 1)
	return float64(t*t) * (3 - float64(2*t))
}

// sincos is the sine and cosine of a.
func sincos(a float64) (float64, float64) { return physics.SinCos(a) }

// hypot is √(x² + y²).
func hypot(x, y float64) float64 { return math.Sqrt(float64(x*x) + float64(y*y)) }

// dot is x₁x₂ + y₁y₂.
func dot(x1, y1, x2, y2 float64) float64 { return float64(x1*x2) + float64(y1*y2) }

// nauticalMile is a nautical mile, m.
const nauticalMile = 1852.0

// degree is a degree, rad.
const degree = math.Pi / 180
