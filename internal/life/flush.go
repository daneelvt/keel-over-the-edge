// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A ground of flying fish is drawn as any encounter is, but is not seen:
// the fish are seen as a boat flushes them, gliding away from its bow
// ("the commonest sight at sea", flushed by a hull and gliding about
// 50 m, linked glides up to about 400 m; Britannica). Every FlushEvery
// ticks each boat sailing through a ground at the binding's speed or
// faster flushes some of its fish at a draw of the boat, the ground and
// that slot of time: a flush, an encounter of its own with no boat, over
// the ground's patch, alive while its fish glide. Flush is a pure
// function, so that a phone with no server (the sandbox) flushes the same
// fish from the same inputs (client/src/life/flush.ts, held to
// testdata/flushes.json).

// flushSalt keeps the flushes' draws apart from the schedule's.
const flushSalt = 0x2f6e9a51

// flushTurn is how far a flush's heading may be from its boat's, rad:
// the fish break away ahead and to either side of the bow.
const flushTurn = 0.6

// flushDraws are the draws of a boat's flush from a ground in a slot of
// the flushes' time: of the ground's seed, the boat's id and the slot,
// each as its two words.
func flushDraws(ground uint32, boat uint64, slot int64) draws {
	k := hash32(ground ^ flushSalt)
	k = hash32(k ^ uint32(boat))
	k = hash32(k ^ uint32(boat>>32))
	k = hash32(k ^ uint32(slot))
	return draws(hash32(k ^ uint32(slot>>32)))
}

// FlushSlot is the slot of the flushes' time a tick is in.
func FlushSlot(p *Params, tick int64) int64 { return tick / p.FlushEvery }

// InGround says whether a point is within a ground's patch, reach m from
// its centre.
func InGround(ground *bus.LifeEncounter, reach, x, y float64) bool {
	dx, dy := x-ground.East, y-ground.North
	return float64(dx*dx)+float64(dy*dy) <= float64(reach*reach)
}

// Flush is the fish the boat of id boat, its bow at bow, flushes from a
// ground of kind k in the flushes' slot at tick now, and whether it
// flushes any: at the catalog's chance, by a draw of the ground's seed,
// the boat and the slot. The fish break the surface FlushLead ticks after
// now, ahead of the bow and to either side of its course, heading near
// the boat's way, and are gone once they have glided their linked glides
// at their slowest. The encounter has no id: the world gives it one. The
// caller says whether the boat is in the ground and fast enough.
func Flush(p *Params, k *Kind, ground *bus.LifeEncounter, boat uint64, slot int64, bow Pose, now int64) (bus.LifeEncounter, bool) {
	d := flushDraws(ground.Seed, boat, slot)
	if d.n(drawWhether) >= threshold(p.FlushChance) {
		return bus.LifeEncounter{}, false
	}
	ahead := lerp(p.FlushAheadLow, p.FlushAheadHigh, unit(d.n(drawEast)))
	beside := float64((float64(2*unit(d.n(drawNorth))) - 1) * p.FlushBeside)
	sin, cos := physics.SinCos(bow.Heading)
	x := bow.X + float64(sin*ahead) + float64(cos*beside)
	y := bow.Y + float64(cos*ahead) - float64(sin*beside)
	heading := bow.Heading + float64((float64(2*unit(d.n(drawHeading)))-1)*flushTurn)
	span := uint32(max(k.GroupHigh-k.GroupLow, 0)) + 1
	e := bus.LifeEncounter{
		Kind:  uint16(k.Index),
		Start: now + p.FlushLead,
		Count: uint16(k.GroupLow + int32(d.n(drawCount)%span)),
		Seed:  d.n(drawSeed),
		Slot:  -1,
		Over:  ground.ID,
	}
	place(&e, x, y, heading, lerp(k.SpeedLow, k.SpeedHigh, unit(d.n(drawSpeed))))
	e.End = e.Start + lifeTicks(k.Linked()/math.Max(k.SpeedLow, 0.1)+flushAfter)
	return e, true
}

// flushAfter is how long a flush is kept after its fish have glided, s:
// the last splash and its rings.
const flushAfter = 3.0

// flushID is a flush's id, as Bring's comment lays out the ids: of the
// flushes' slot, the boat's slot and the ground's number among those
// alive.
func flushID(slot int64, boat int32, ground int) uint64 {
	return flushBit | uint64(slot)&(1<<38-1)<<24 | uint64(boat)&0xffff<<8 | uint64(ground)&0xff
}
