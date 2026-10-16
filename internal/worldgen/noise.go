// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import "math"

// Gradient noise in two dimensions (Perlin 2002), its lattice's corners
// hashed with integer arithmetic, and sums of octaves of it (fractional
// Brownian motion), with which the islands' shapes are warped and their
// ground made rough.

// hash32 mixes the bits of x (Wellons's lowbias32).
func hash32(x uint32) uint32 {
	x ^= x >> 16
	x *= 0x7feb352d
	x ^= x >> 15
	x *= 0x846ca68b
	x ^= x >> 16
	return x
}

// gradients are eight unit directions.
var gradX, gradY = [8]float64{1, 0.7071067811865476, 0, -0.7071067811865476, -1, -0.7071067811865476, 0, 0.7071067811865476},
	[8]float64{0, 0.7071067811865476, 1, 0.7071067811865476, 0, -0.7071067811865476, -1, -0.7071067811865476}

// fade is Perlin's quintic, 6t⁵ − 15t⁴ + 10t³.
func fade(t float64) float64 {
	return float64(float64(t*t)*t) * (float64(t*(float64(t*6)-15)) + 10)
}

// corner is the gradient at lattice corner (i, j) dotted with the offset
// (x, y) from it.
func corner(i, j int32, x, y float64, seed uint32) float64 {
	h := hash32(uint32(i)*0x9e3779b1 ^ hash32(uint32(j)*0x85ebca77^seed))
	k := h & 7
	return dot(gradX[k], gradY[k], x, y)
}

// noise2 is gradient noise at (x, y), in about [−1, 1].
func noise2(x, y float64, seed uint32) float64 {
	fx, fy := math.Floor(x), math.Floor(y)
	i, j := toInt32(fx), toInt32(fy)
	tx, ty := x-fx, y-fy
	u, v := fade(tx), fade(ty)
	a := corner(i, j, tx, ty, seed)
	b := corner(i+1, j, tx-1, ty, seed)
	c := corner(i, j+1, tx, ty-1, seed)
	d := corner(i+1, j+1, tx-1, ty-1, seed)
	// The largest a sum of two-dimensional gradient noise reaches is
	// about √2 / 2: scaled to about 1.
	return float64(lerp(v, lerp(u, a, b), lerp(u, c, d)) * 1.4142135623730951)
}

// fbm is octaves of noise from the first given, each of twice the
// frequency and half the weight of the one before, normalised so that the
// weights add up to 1.
func fbm(x, y float64, seed uint32, first, octaves int32) float64 {
	var sum, weight float64
	f, w := pow2(first), 1.0
	for k := range octaves {
		sum += float64(w * noise2(float64(x*f), float64(y*f), seed+uint32(first+k)*0x632be5ab))
		weight += w
		f *= 2
		w *= 0.5
	}
	if weight == 0 {
		return 0
	}
	return sum / weight
}

// pow2 is 2^k.
func pow2(k int32) float64 {
	f := 1.0
	for ; k > 0; k-- {
		f *= 2
	}
	for ; k < 0; k++ {
		f *= 0.5
	}
	return f
}

// ridged is ridged noise: 1 − |n|, sharpened, so that it has crests where
// the noise crosses zero.
func ridged(x, y float64, seed uint32, octaves int32) float64 {
	n := 1 - math.Abs(fbm(x, y, seed, 0, octaves))
	return float64(n * n)
}
