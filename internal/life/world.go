// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
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
	// met is per alive encounter, for a group riding a bow, its boat's
	// pose as the group came to the bow: where they met, and the heading
	// the ride began on.
	met     []Pose
	grounds []ground // the grounds of fish begun and not over
	flushed int64    // the flushes' last slot
	bows    []float64
	boats   []boatLife
	raised  uint32
	drawn   []bus.LifeEncounter // scratch
}

// ground is a ground of fish alive, and how far its patch reaches, m.
type ground struct {
	e     bus.LifeEncounter
	reach float64
}

// defaultBow is how far a boat's bow is ahead of its origin, m, for a kind
// of boat the world was not told of.
const defaultBow = 4.0

// breakUp is how long bait broken up by a boat lasts after, ticks: the
// fish go down and the birds leave ("a boat through its middle breaks it
// up"; Hebshi and others 2008).
const breakUp = 60 * physics.StepsPerSecond

// boatLife is what a boat's slot keeps of the boat for the sea's life:
// the boat, its heading when its course last changed and since when, and
// the tick before which nothing follows it.
type boatLife struct {
	boat  uint64
	ref   float64
	since int64
	quiet int64
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
		if k.Follows || k.Rides() {
			life = float64(2*k.Arrive(k.SpeedLow)) + k.StayHigh
		}
		longest = math.Max(longest, life)
	}
	w.back = int64(toInt32(math.Ceil(float64(longest*physics.StepsPerSecond)/float64(s.p.SlotTicks)))) + 1
	w.pending = make([]bus.LifeEncounter, 0, bus.LifeRoom)
	w.alive = make([]bus.LifeEncounter, 0, bus.LifeRoom)
	w.last = make([]Pose, 0, bus.LifeRoom)
	w.met = make([]Pose, 0, bus.LifeRoom)
	w.grounds = make([]ground, 0, bus.LifeRoom)
	w.drawn = make([]bus.LifeEncounter, 0, bus.LifeRoom)
	w.flushed = math.MinInt64
	return w
}

// SetBows tells the world how far each kind of boat's bow is ahead of its
// origin, m, by the kind's index: a boat's fish are flushed ahead of its
// bow. A kind it is not told of has a bow 4 m ahead.
func (w *World) SetBows(bows []float64) { w.bows = bows }

// Schedule is the world's schedule.
func (w *World) Schedule() *Schedule { return w.s }

// Tick brings the world's life to frame f's tick, in the weather c there,
// and writes it to f.Life: the slots begun since are drawn, the
// encounters due begin, a group that follows boats or rides their bows
// takes one, the boats in a ground of fish flush them, those whose boat
// has gone go on without it, bait a boat sails through breaks up, and
// those over end.
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
	// The grounds over end; the boats in those alive flush their fish,
	// once a slot of the flushes' time.
	g := w.grounds[:0]
	for _, gr := range w.grounds {
		if gr.e.End > now {
			g = append(g, gr)
		}
	}
	w.grounds = g
	if fs := FlushSlot(w.s.p, now); fs != w.flushed {
		w.flushed = fs
		w.flushes(f, fs)
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
				if k := &w.s.kinds[e.Kind]; k.Rides() && !w.riding(k, &e, st, &w.met[i], now) {
					w.leave(&e, &w.last[i], &w.met[i], now)
				}
			} else {
				w.leave(&e, &w.last[i], &w.met[i], now)
			}
		}
		w.alive[n], w.last[n], w.met[n] = e, w.last[i], w.met[i]
		n++
	}
	w.alive, w.last, w.met = w.alive[:n], w.last[:n], w.met[:n]
	if now%steadyEvery == 0 {
		w.breakUp(f)
	}
	f.Life = append(f.Life[:0], w.alive...)
}

// riding says whether a group riding a bow keeps riding it at now, the
// boat's state st: it leaves at once when the boat is slower than the
// ride allows or has turned too far from the heading the ride began on,
// as dolphins keep with a boat on a steady speed and course and leave
// erratic handling (Fiori and others 2024). While it is still coming in,
// where it meets the boat moves with the boat.
func (w *World) riding(k *Kind, e *bus.LifeEncounter, st *physics.State, met *Pose, now int64) bool {
	p := w.s.p
	if speed := math.Sqrt(float64(st.Surge*st.Surge) + float64(st.Sway*st.Sway)); speed < p.RideSlower {
		return false
	}
	if float64(now-e.Start) < float64(k.Arrive(e.Speed)*physics.StepsPerSecond) {
		*met = Pose{X: st.X, Y: st.Y, Heading: st.Heading}
		return true
	}
	return math.Abs(wrap(st.Heading-met.Heading)) <= p.RideTurn
}

// flushes has each boat sailing through a ground of fish at the binding's
// speed or faster flush them, in the flushes' slot fs: the flushes begin
// once due.
func (w *World) flushes(f *bus.Frame, fs int64) {
	if len(w.grounds) == 0 {
		return
	}
	p := w.s.p
	for gi := range w.grounds {
		gr := &w.grounds[gi]
		k := &w.s.kinds[gr.e.Kind]
		for _, s := range f.Live {
			st := &f.State[s]
			if f.Voyage[s].Falling() || f.Stay[s] || f.Unseen[s] || !InGround(&gr.e, gr.reach, st.X, st.Y) {
				continue
			}
			if speed := math.Sqrt(float64(st.Surge*st.Surge) + float64(st.Sway*st.Sway)); speed < p.BindSpeed {
				continue
			}
			bow := defaultBow
			if int(f.Kind[s]) < len(w.bows) {
				bow = w.bows[f.Kind[s]]
			}
			sin, cos := physics.SinCos(st.Heading)
			at := Pose{X: st.X + float64(sin*bow), Y: st.Y + float64(cos*bow), Heading: st.Heading}
			if e, ok := Flush(p, k, &gr.e, f.Boat[s], fs, at, f.Tick); ok {
				e.ID = flushID(fs, s, gi)
				w.pending = append(w.pending, e)
			}
		}
	}
}

// breakUp ends the bait a boat sails through: each boil not already
// ending with a boat within its patch of its middle lasts breakUp more,
// and the groups over it leave with it, from where each is.
func (w *World) breakUp(f *bus.Frame) {
	now := f.Tick
	for i := range w.alive {
		e := &w.alive[i]
		k := &w.s.kinds[e.Kind]
		if k.Form != catalog.LifeFormBait || e.End-now <= breakUp {
			continue
		}
		x, y, _, ok := FlockAt(e, k, float64(now), nil)
		if !ok || !w.boatWithin(f, x, y, Patch(k, e.Seed)) {
			continue
		}
		e.End = now + breakUp
		e.Rev++
		for j := range w.alive {
			c := &w.alive[j]
			if c.Over != e.ID || c.Boat != 0 {
				continue
			}
			ck := &w.s.kinds[c.Kind]
			if end := leaving(ck, c, now); end < c.End {
				c.End = end
				c.Rev++
			}
		}
	}
}

// leaving is the end of a group of the kind that lingers over a patch if
// it is to leave from now with no jump in where it is: one staying goes
// out from now, one still coming in comes in and goes straight out. A
// group that does not linger, or that has no stay to cut short, keeps its
// end.
func leaving(k *Kind, e *bus.LifeEncounter, now int64) int64 {
	if !lingers(k.PathOf(e)) {
		return e.End
	}
	a := k.Arrive(e.Speed)
	in := lifeTicks(float64(2 * a))
	if e.End-e.Start <= in {
		return e.End
	}
	return max(now+lifeTicks(a), e.Start+in)
}

// boatWithin says whether a boat at sea is within r m of (x, y).
func (w *World) boatWithin(f *bus.Frame, x, y, r float64) bool {
	for _, s := range f.Live {
		if f.Voyage[s].Falling() || f.Stay[s] || f.Unseen[s] {
			continue
		}
		st := &f.State[s]
		if dx, dy := st.X-x, st.Y-y; float64(dx*dx)+float64(dy*dy) <= float64(r*r) {
			return true
		}
	}
	return false
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
// boats or rides their bows takes the nearest boat within reach sailing
// steadily, if there is one, unless it is quiet; raised, a quiet boat is
// taken too. A group that comes with another takes none. A ground of fish
// is kept apart, unseen: the fish its boats flush are seen.
func (w *World) begin(f *bus.Frame, e bus.LifeEncounter, raised bool) {
	k := &w.s.kinds[e.Kind]
	if k.Flushes() && e.Over == 0 {
		reach := Patch(k, e.Seed)
		if raised {
			reach = k.PatchHigh
		}
		w.grounds = append(w.grounds, ground{e: e, reach: reach})
		return
	}
	pose := Pose{}
	if (k.Follows || k.Rides()) && e.Over == 0 {
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
	w.met = append(w.met, pose)
}

// boatFor is the slot of the boat a group that follows boats or rides
// their bows takes as it begins: the nearest within reach of its centre sailing fast enough on a
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

// leave has a group whose boat has gone, or that leaves its boat, go on
// alone from where it was with the boat last: one that followed passing
// on from astern of the boat, at its middle now, or for one that lingers
// coming in and going out with no stay; one that rode the bow from where
// it is, heading back toward where it met the boat, as dolphins after
// riding often go back to where they met it (Fiori and others 2024).
func (w *World) leave(e *bus.LifeEncounter, at, met *Pose, now int64) {
	k := &w.s.kinds[e.Kind]
	half := lifeTicks(k.Arrive(e.Speed))
	if k.Rides() {
		x, y, _, ok := FlockAt(e, k, float64(now), at)
		if !ok {
			x, y = at.X, at.Y
		}
		place(e, x, y, physics.Atan2(met.X-x, met.Y-y), e.Speed)
	} else {
		sin, cos := physics.SinCos(at.Heading)
		b := Behind(e.Seed)
		place(e, at.X-float64(sin*b), at.Y-float64(cos*b), at.Heading+math.Pi, e.Speed)
	}
	e.Boat, e.Slot = 0, -1
	e.Start, e.End = now-half, now+half
	e.Rev++
}

// Raise begins an encounter of the kind at (x, y) at f's tick, by hand:
// the developer's, for tests and scenes. Its draws are its own; one that
// follows boats or rides their bows takes a boat that is quiet too; one
// that brings others brings them; a ground of fish reaches its kind's
// furthest. It reports whether the kind is one of the catalog's.
func (w *World) Raise(f *bus.Frame, kind int, x, y float64) bool {
	if kind < 0 || kind >= len(w.s.kinds) {
		return false
	}
	w.raised++
	k := &w.s.kinds[kind]
	seed := hash32(w.raised ^ hash32(uint32(f.Tick)) ^ w.s.seed)
	d := draws(seed)
	e := bus.LifeEncounter{
		ID: raisedBit | uint64(w.raised), Kind: uint16(kind), Start: f.Tick, Seed: d.n(drawSeed), Slot: -1,
		Count: uint16(k.GroupLow + int32(d.n(drawCount)%(uint32(max(k.GroupHigh-k.GroupLow, 0))+1))),
	}
	place(&e, x, y, float64(unit(d.n(drawHeading))*(2*math.Pi)), lerp(k.SpeedLow, k.SpeedHigh, unit(d.n(drawSpeed))))
	e.End = e.Start + lifeTicks(k.FreeLife(e.Speed, Stay(k, e.Seed)))
	w.begin(f, e, true)
	if len(k.Brings) > 0 {
		w.drawn = w.s.Bring(&e, w.drawn[:0])
		for _, c := range w.drawn {
			w.begin(f, c, true)
		}
	}
	f.Life = append(f.Life[:0], w.alive...)
	return true
}

// wrap is an angle within ±π.
func wrap(a float64) float64 { return turn(a+math.Pi) - math.Pi }
