// Package pure keeps every rule of the physics package, including the
// cases that look like breaking one.
package pure

import "math"

const half = 0.5 * 1.0

func toInt32(f float64) int32 { return int32(f) }

func Good(x, y, z float64, a, b int) (float64, int32, int) {
	r := float64(x*y) + z
	r -= float64(x * z)
	r += half * 2 // constants fold
	k := a*b + 1  // integers do not fuse
	c := int(2.0) // a constant conversion is exact
	return math.Sqrt(math.Abs(r)) + math.Pi, toInt32(r), k + c
}
