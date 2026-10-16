// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math/rand/v2"
)

// Every random number the generator draws comes from a stream of its own:
// a PCG keyed by the seed and by what draws from it, a stage or an island,
// and never shared. A change to how one stage draws then moves no other's
// numbers, so the rest of a world stays as it was while a stage is tuned.
// Only Uint64 and what is built on it exactly (IntN, Float64) are used: they
// are integer arithmetic and an exact division, the same on every machine.

// The stages' streams.
const (
	streamLayout uint64 = iota + 1
	streamMainPort
	streamGroups
	streamNames
	streamStart
	streamCirculation
	streamIsland = 1 << 32 // plus the island's number
)

// circulationOf is the way the water of the world of a seed circulates
// round the disk: 1 clockwise seen from above, −1 the other way.
func circulationOf(seed uint64) int {
	if newStream(seed, streamCirculation).r.Uint64()&1 == 0 {
		return 1
	}
	return -1
}

// stream is a stage's or an island's generator.
type stream struct{ r *rand.Rand }

// newStream is the stream of key under seed.
func newStream(seed, key uint64) stream {
	return stream{rand.New(rand.NewPCG(mix(seed), mix(seed^mix(key))))}
}

// mix scrambles x (Stafford's variant 13 of the SplitMix64 finaliser).
func mix(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}

// float is a number in [0, 1).
func (s stream) float() float64 { return float64(s.r.Float64()) }

// in is a number in [lo, hi).
func (s stream) in(lo, hi float64) float64 { return lerp(s.float(), lo, hi) }

// pick is a whole number from lo to hi.
func (s stream) pick(lo, hi int) int {
	if hi <= lo {
		return lo
	}
	return lo + s.r.IntN(hi-lo+1)
}

// chance is true with probability p.
func (s stream) chance(p float64) bool { return s.float() < p }

// seed32 is a number for seeding noise.
func (s stream) seed32() uint32 { return uint32(s.r.Uint64() >> 32) }

// angle is a direction in [0, 2π).
func (s stream) angle() float64 { return float64(s.float() * (2 * 3.141592653589793)) }

// weighted is an index drawn with the weights given; -1 if they add up to
// nothing.
func (s stream) weighted(w []float64) int {
	var sum float64
	for _, x := range w {
		if x > 0 {
			sum += x
		}
	}
	if !(sum > 0) {
		return -1
	}
	u := float64(s.float() * sum)
	for i, x := range w {
		if !(x > 0) {
			continue
		}
		if u < x {
			return i
		}
		u -= x
	}
	for i := len(w) - 1; i >= 0; i-- {
		if w[i] > 0 {
			return i
		}
	}
	return -1
}
