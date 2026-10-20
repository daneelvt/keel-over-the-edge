// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Digest is a 64-bit FNV-1a hash of a frame's state: the tick, the
// developer's weathers (each one's tick, mode, regime, speed and direction)
// and systems (each one's ticks, kind, point, slot, heading and speed),
// the sea in effect and next (each run of areas with the same inputs, and
// its length), whether admission is held, each occupied slot's number, boat, generation,
// owner, connection, grace, control word, pilot word, state, course and, if it has
// anything, its voyage at the edge (the tick it went over, its flags and its six
// distances and places), and, if it has any, the owner's tools' marks, each waiting
// connection's account, connection, tick of joining the queue and grace,
// and each pair's slots, boats, keep-clear boat, Article, whose action and
// ticks, as little-endian bits. Two worlds with the
// same digest at a tick are, all but certainly, the same world; a replay
// compares them to find the first tick at which it went wrong.
func Digest(f *bus.Frame) uint64 {
	h := fnv(fnvOffset)
	h.u64(uint64(f.Tick))
	for _, w := range f.Weathers {
		h.u64(uint64(w.From))
		h.byte(byte(w.Mode))
		h.u64(uint64(w.Regime))
		h.u64(uint64(w.Speed))
		h.u64(uint64(w.Dir))
	}
	for _, s := range f.Systems {
		h.u64(uint64(s.Born))
		h.u64(uint64(s.At))
		h.u64(uint64(s.Kind))
		h.u64(uint64(int64(s.East)))
		h.u64(uint64(int64(s.North)))
		h.byte(s.Slot)
		h.u64(uint64(s.Heading))
		h.u64(uint64(s.Speed))
	}
	h.sea(f.Sea.Now)
	h.sea(f.Sea.Next)
	if f.Held {
		h.byte(1)
	} else {
		h.byte(0)
	}
	for _, s := range f.Live {
		h.u64(uint64(s))
		h.u64(f.Boat[s])
		h.u64(uint64(f.Gen[s]))
		for _, b := range f.Owner[s] {
			h.byte(b)
		}
		h.u64(f.Conn[s])
		h.u64(uint64(f.Grace[s]))
		h.u64(uint64(f.Control[s]))
		h.u64(uint64(f.Pilot[s]))
		for _, v := range StateFields(&f.State[s]) {
			h.f64(*v)
		}
		for _, v := range CourseFields(&f.Course[s]) {
			h.f64(*v)
		}
		// A voyage at the edge counts once it has something, so a world
		// whose boats never near it hashes as before.
		if v := &f.Voyage[s]; *v != (bus.Voyage{}) {
			h.u64(uint64(v.Over))
			h.byte(byte(voyageFlags(v)))
			for _, x := range [...]float64{v.Least, v.X, v.Y, v.Best, v.BestX, v.BestY} {
				h.f64(x)
			}
		}
		// The owner's tools' marks count once one is set, so a world they
		// never touched hashes as before.
		if m := marks(f, s); m != 0 {
			h.u64(m)
		}
	}
	for _, q := range f.Queue {
		for _, b := range q.Account {
			h.byte(b)
		}
		h.u64(q.Conn)
		h.u64(uint64(q.Since))
		h.u64(uint64(q.Grace))
	}
	for _, p := range f.Pairs {
		h.u64(uint64(p.A))
		h.u64(uint64(p.B))
		h.u64(p.BoatA)
		h.u64(p.BoatB)
		h.byte(p.Keeper)
		h.byte(p.Article)
		h.byte(p.By)
		h.u64(uint64(p.Since))
		h.u64(uint64(p.Touched))
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

// sea hashes a sea's areas as runs: under one wind the whole sea is one.
func (h *fnv) sea(areas []physics.SeaInput) {
	for i := 0; i < len(areas); {
		j := i + 1
		for j < len(areas) && areas[j] == areas[i] {
			j++
		}
		h.u64(uint64(j - i))
		h.u64(uint64(areas[i].Speed))
		h.u64(uint64(areas[i].From))
		h.u64(uint64(areas[i].Fetch))
		h.u64(uint64(areas[i].SwellHeight))
		h.u64(uint64(areas[i].SwellPeriod))
		h.u64(uint64(areas[i].SwellFrom))
		h.u64(uint64(uint32(areas[i].CurrentEast)))
		h.u64(uint64(uint32(areas[i].CurrentNorth)))
		i = j
	}
}

func (h *fnv) byte(b byte) {
	*h ^= fnv(b)
	*h *= fnvPrime
}

// StateFields lists a state's fields, in their order. The snapshot, the
// digest and the input log all read the state through it; a test checks it
// has every field.
func StateFields(s *physics.State) [StateSize]*float64 {
	return [StateSize]*float64{
		&s.X, &s.Y, &s.Heading, &s.Surge, &s.Sway, &s.YawRate, &s.Heel, &s.RollRate,
		&s.Boom, &s.BoomRate, &s.Sailor, &s.Rudder, &s.SheetLimit, &s.SailorMode, &s.SailorTimer,
		&s.Heave, &s.HeaveRate, &s.Pitch, &s.PitchRate,
		&s.PilotTrim, &s.PilotWay, &s.PilotOrder,
		&s.GroundTimer,
	}
}

// StateSize is the number of a state's fields: BoatSize of the boat's, then
// PilotSize of what its autopilot remembers, then GroundSize of how long it
// has been aground.
const (
	StateSize  = BoatSize + PilotSize + GroundSize
	BoatSize   = 19
	PilotSize  = 3
	GroundSize = 1
)

// CourseFields lists a course's fields, in their order, as StateFields does
// a state's.
func CourseFields(c *physics.Course) [CourseSize]*float64 {
	return [CourseSize]*float64{&c.Tack, &c.Tacking, &c.Settled, &c.Course}
}

// CourseSize is the number of a course's fields.
const CourseSize = 4
