// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Lightning, the same flash for every player. World time is cut into
// slots; a squall or a storm whose strength at a slot's start is at or
// over its kind's flashes in the slot with a chance by its rate, which
// rises from nothing there to its kind's at full strength, as a cell's
// "occasional flashes" while it develops become "frequent lightning" when
// mature (RMetS). Its time, its place within its kind's ring about the
// system's centre, whether it strikes the sea, its strokes and its own
// seed are drawn from a hash of the system's seed and the slot, so the
// server and every phone find the same flash from the same keyframes.
//
// A quarter of flashes strike the sea and the rest stay in the cloud:
// "most lightning (~75-80%) occurs within the cloud" (NWS). "A third of the
// flashes are single-stroke events, while the overall mean … equals 3.67"
// (Poelman and others 2021): the rest have from two strokes to the most
// evenly, whose mean is 5 for eight. The strokes come "about 60 ms" apart
// at the geometric mean (CIGRÉ TB 549, Rakov and others 2013): each gap is
// drawn evenly in its logarithm from half that to twice it.

// MaxFlashes is the most flashes a slot holds: one a system.
const MaxFlashes = 2 * MaxSystems

// flashSalt draws a slot's flash apart from the system's other draws.
const flashSalt = 0x3c6ef372

// SlotTicks is how long lightning's slots of world time are, ticks.
func (w *WeatherPrepared) SlotTicks() float64 { return w.vis.slot }

// FlashSlot is the slot of world time a tick is in.
func (w *WeatherPrepared) FlashSlot(tick float64) float64 { return math.Floor(tick / w.vis.slot) }

// Flashes writes to out the flashes in a slot of world time, slot ×
// SlotTicks to the next, from the systems at the tick t was set to, the
// slot's start, and returns how many: one at most a system.
func Flashes(t *WeatherTick, slot float64, out []Flash) int {
	v := &t.p.vis
	n := 0
	start := float64(slot * v.slot)
	key := uint32(toInt32(slot))*0x9e3779b9 ^ flashSalt
	for i := range t.ns {
		st := &t.sys[i]
		k := &st.k.lightning
		if !(k.rate > 0) || !(st.strength >= k.above) || n >= len(out) {
			continue
		}
		share := min2((st.strength-k.above)/max2(1-k.above, 1e-6), 1)
		chance := float64(float64(k.rate*share)*v.slotSeconds) / 60
		draw := drawer(hash32(st.seed ^ hash32(key)))
		if !(unit(draw.n(0)) < chance) {
			continue
		}
		f := &out[n]
		n++
		r := float64(st.size * math.Sqrt(lerp(unit(draw.n(2)), k.inner2, k.outer2)))
		sin, cos := SinCos(float64(unit(draw.n(3)) * (2 * math.Pi)))
		// A line's anywhere along its length.
		along := float64(st.half * float64(float64(2*unit(draw.n(9)))-1))
		*f = Flash{
			Slot: float64(st.slot), Kind: st.kind, Seed: float64(draw.n(7)),
			Tick:  start + float64(unit(draw.n(1))*v.slot),
			East:  st.cx + float64(r*sin) + float64(along*st.uy),
			North: st.cy + float64(r*cos) - float64(along*st.ux),
			Base:  st.k.cloud.base,
		}
		if unit(draw.n(4)) < v.sea {
			f.Sea = 1
		}
		strokes := int32(1)
		if !(unit(draw.n(5)) < v.single) && v.most > 1 {
			strokes = min(2+toInt32(math.Floor(float64(unit(draw.n(6))*float64(v.most-1)))), v.most)
		}
		f.Strokes = float64(strokes)
		at := 0.0
		for j := int32(1); j < strokes; j++ {
			// A gap from half the mean to twice it, even in its logarithm.
			u := unit(hash32(draw.n(8) ^ uint32(j)))
			at += float64(v.apart * Exp(float64((float64(2*u)-1)*math.Ln2)))
			f.Stroke[j] = at
		}
	}
	return n
}
