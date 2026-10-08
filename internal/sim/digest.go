// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Digest is a 64-bit FNV-1a hash of a frame's state: the tick, the wind, and
// each occupied slot's number, boat, generation, control word and state, as
// little-endian bits. Two worlds with the same digest at a tick are, all but
// certainly, the same world; a replay compares them to find the first tick at
// which it went wrong.
func Digest(f *bus.Frame) uint64 {
	h := fnv(fnvOffset)
	h.u64(uint64(f.Tick))
	h.f64(f.Wind.Speed)
	h.f64(f.Wind.From)
	for _, s := range f.Live {
		h.u64(uint64(s))
		h.u64(f.Boat[s])
		h.u64(uint64(f.Gen[s]))
		h.u64(uint64(f.Control[s]))
		for _, v := range StateFields(&f.State[s]) {
			h.f64(*v)
		}
	}
	return uint64(h)
}

// FNV-1a's 64-bit parameters, as hash/fnv has them.
const (
	fnvOffset = 14695981039346656037
	fnvPrime  = 1099511628211
)

type fnv uint64

func (h *fnv) u64(v uint64) {
	for range 8 {
		*h ^= fnv(byte(v))
		*h *= fnvPrime
		v >>= 8
	}
}

func (h *fnv) f64(v float64) { h.u64(math.Float64bits(v)) }

// StateFields lists a state's fields, in their order. The snapshot, the
// digest and the input log all read the state through it; a test checks it
// has every field.
func StateFields(s *physics.State) [15]*float64 {
	return [15]*float64{
		&s.X, &s.Y, &s.Heading, &s.Surge, &s.Sway, &s.YawRate, &s.Heel, &s.RollRate,
		&s.Boom, &s.BoomRate, &s.Sailor, &s.Rudder, &s.SheetLimit, &s.SailorMode, &s.SailorTimer,
	}
}
