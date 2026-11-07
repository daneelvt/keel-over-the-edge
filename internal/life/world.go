// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// World is a world's life as the simulation keeps it, tick by tick: the
// encounters drawn and not yet begun, those alive, and what each boat has
// had of them. It is the ticking goroutine's alone, and none of it is
// checkpointed: a world opened again begins its life from the schedule.
type World struct {
	s       *Schedule
	begun   bool
	slot    int64 // the last slot drawn
	back    int64 // how many slots back an encounter may still be alive
	pending []bus.LifeEncounter
	alive   []bus.LifeEncounter
	last    []Pose // per alive encounter: its boat's pose at the last tick
	boats   []boatLife
	raised  uint32
	drawn   []bus.LifeEncounter // scratch
}

// boatLife is what a boat's slot keeps of the boat for the sea's life:
// the boat, its heading when its course last changed and since when, and
// the tick before which nothing follows it.
type boatLife struct {
	boat   uint64
	ref    float64
	since  int64
	quiet  int64
	steady bool
}

// steadyEvery is how often each boat's course is looked at, ticks.
const steadyEvery = physics.StepsPerSecond

// NewWorld is a world's life, for a world of capacity slots.
func NewWorld(s *Schedule, capacity int) *World {
	w := &World{s: s, boats: make([]boatLife, capacity)}
	longest := 0.0
	for i := range s.kinds {
		k := &s.kinds[i]
		life := k.FreeLife(k.SpeedLow, k.StayHigh)
		if k.Follows {
			life = float64(2*k.Arrive(k.SpeedLow)) + k.StayHigh
		}
		longest = math.Max(longest, life)
	}
	w.back = int64(math.Ceil(float64(longest*physics.StepsPerSecond)/float64(s.p.SlotTicks))) + 1
	w.pending = make([]bus.LifeEncounter, 0, bus.LifeRoom)
	w.alive = make([]bus.LifeEncounter, 0, bus.LifeRoom)
	w.last = make([]Pose, 0, bus.LifeRoom)
	w.drawn = make([]bus.LifeEncounter, 0, bus.LifeRoom)
	return w
}

// Schedule is the world's schedule.
func (w *World) Schedule() *Schedule { return w.s }

// Tick brings the world's life to frame f's tick, in the weather c there,
// and writes it to f.Life: the slots begun since are drawn, the
// encounters due begin, a group that follows boats takes one, those whose
// boat has gone go on without it, and those over end.
func (w *World) Tick(f *bus.Frame, c Conditions) {
	now := f.Tick
	sl := w.s.SlotOf(now)
	if !w.begun {
		w.begun = true
		w.slot = sl - w.back
	}
	if sl-w.slot > w.back {
		w.slot = sl - w.back
	}
	for w.slot < sl {
		w.slot++
		w.drawn = w.s.Slot(w.slot, c, w.drawn[:0])
		for _, e := range w.drawn {
			if e.End > now {
				w.pending = append(w.pending, e)
			}
		}
	}
	if now%steadyEvery == 0 {
		w.courses(f)
	}
	// Those due begin, in the order drawn.
	kept := w.pending[:0]
	for _, e := range w.pending {
		switch {
		case e.Start > now:
			kept = append(kept, e)
		case e.End > now:
			w.begin(f, e, false)
		}
	}
	w.pending = kept
	// Those with boats keep with them; those over end.
	n := 0
	for i := range w.alive {
		e := w.alive[i]
		if e.End <= now {
			continue
		}
		if e.Boat != 0 {
			s := e.Slot
			if s >= 0 && int(s) < len(f.Occupied) && f.Occupied[s] && f.Boat[s] == e.Boat && !f.Voyage[s].Falling() && !f.Stay[s] && !f.Unseen[s] {
				st := &f.State[s]
				w.last[i] = Pose{X: st.X, Y: st.Y, Heading: st.Heading}
			} else {
				w.leave(&e, &w.last[i], now)
			}
		}
		w.alive[n], w.last[n] = e, w.last[i]
		n++
	}
	w.alive, w.last = w.alive[:n], w.last[:n]
	f.Life = append(f.Life[:0], w.alive...)
}

// courses follows each boat's course: steady while its heading stays
// within the binding's turn of where it was.
func (w *World) courses(f *bus.Frame) {
	turn := w.s.p.BindTurn
	for _, s := range f.Live {
		b := &w.boats[s]
		h := f.State[s].Heading
		if b.boat != f.Boat[s] {
			*b = boatLife{boat: f.Boat[s], ref: h, since: f.Tick}
			continue
		}
		if math.Abs(wrap(h-b.ref)) > turn {
			b.ref, b.since = h, f.Tick
		}
	}
}

// begin makes an encounter alive at f's tick: one of a kind that follows
// boats takes the nearest boat within reach sailing steadily, if there is
// one, unless it is quiet; raised, a quiet boat is taken too.
func (w *World) begin(f *bus.Frame, e bus.LifeEncounter, raised bool) {
	k := &w.s.kinds[e.Kind]
	pose := Pose{}
	if k.Follows {
		if s := w.boatFor(f, &e, raised); s >= 0 {
			st := &f.State[s]
			pose = Pose{X: st.X, Y: st.Y, Heading: st.Heading}
			e.Boat, e.Slot = f.Boat[s], s
			// They come in from where they were, toward the boat.
			place(&e, e.East, e.North, physics.Atan2(st.X-e.East, st.Y-e.North), e.Speed)
			e.End = e.Start + lifeTicks(float64(2*k.Arrive(e.Speed))+Stay(k, e.Seed))
			w.boats[s].quiet = e.End + w.s.p.Quiet
		}
	}
	w.alive = append(w.alive, e)
	w.last = append(w.last, pose)
}

// boatFor is the slot of the boat a group that follows boats takes as it
// begins: the nearest within reach of its centre sailing fast enough on a
// steady course, not quiet, ties to the lower boat; −1 for none.
func (w *World) boatFor(f *bus.Frame, e *bus.LifeEncounter, raised bool) int32 {
	p := w.s.p
	best, bestD := int32(-1), float64(p.BindWithin*p.BindWithin)
	for _, s := range f.Live {
		b := &w.boats[s]
		st := &f.State[s]
		if f.Voyage[s].Falling() || f.Stay[s] || f.Unseen[s] || b.boat != f.Boat[s] || f.Tick-b.since < p.BindSteady {
			continue
		}
		if !raised && f.Tick < b.quiet {
			continue
		}
		if speed := math.Sqrt(float64(st.Surge*st.Surge) + float64(st.Sway*st.Sway)); speed < p.BindSpeed {
			continue
		}
		dx, dy := st.X-e.East, st.Y-e.North
		d := float64(dx*dx) + float64(dy*dy)
		if d < bestD || d == bestD && best >= 0 && f.Boat[s] < f.Boat[best] {
			best, bestD = s, d
		}
	}
	return best
}

// leave has a group whose boat has gone on alone from where it kept
// astern of the boat last: passing on from there, at its middle now, or
// for one that lingers coming in and going out with no stay.
func (w *World) leave(e *bus.LifeEncounter, at *Pose, now int64) {
	k := &w.s.kinds[e.Kind]
	half := lifeTicks(k.Arrive(e.Speed))
	sin, cos := physics.SinCos(at.Heading)
	b := Behind(e.Seed)
	place(e, at.X-float64(sin*b), at.Y-float64(cos*b), at.Heading+math.Pi, e.Speed)
	e.Boat, e.Slot = 0, -1
	e.Start, e.End = now-half, now+half
	e.Rev++
}

// Raise begins an encounter of the kind at (x, y) at f's tick, by hand:
// the developer's, for tests and scenes. Its draws are its own; one that
// follows boats takes a boat that is quiet too. It reports whether the
// kind is one of the catalog's.
func (w *World) Raise(f *bus.Frame, kind int, x, y float64) bool {
	if kind < 0 || kind >= len(w.s.kinds) {
		return false
	}
	w.raised++
	k := &w.s.kinds[kind]
	seed := hash32(w.raised ^ hash32(uint32(f.Tick)) ^ w.s.seed)
	d := draws(seed)
	e := bus.LifeEncounter{
		ID: 1<<63 | uint64(w.raised), Kind: uint16(kind), Start: f.Tick, Seed: d.n(drawSeed), Slot: -1,
		Count: uint16(k.GroupLow + int32(d.n(drawCount)%(uint32(max(k.GroupHigh-k.GroupLow, 0))+1))),
	}
	place(&e, x, y, float64(unit(d.n(drawHeading))*(2*math.Pi)), lerp(k.SpeedLow, k.SpeedHigh, unit(d.n(drawSpeed))))
	e.End = e.Start + lifeTicks(k.FreeLife(e.Speed, Stay(k, e.Seed)))
	w.begin(f, e, true)
	f.Life = append(f.Life[:0], w.alive...)
	return true
}

// wrap is an angle within ±π.
func wrap(a float64) float64 {
	a = math.Mod(a+math.Pi, 2*math.Pi)
	if a < 0 {
		a += 2 * math.Pi
	}
	return a - math.Pi
}
