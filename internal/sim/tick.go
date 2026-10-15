// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"runtime/trace"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Tick advances the world by one tick, with the controls and commands waiting
// on the bus, and publishes the new frame.
func (w *World) Tick() {
	w.given = nil
	w.tick()
}

// TickWith advances the world by one tick with the inputs given instead of
// the bus's: those an input log recorded.
func (w *World) TickWith(in *Input) {
	w.given = in
	w.tick()
	w.given = nil
}

// tick writes the next frame from the current one. Each phase runs in a
// trace region, through trace.WithRegion and a function value made once:
// trace.StartRegion allocates on every call while tracing is on, which the
// flight recorder keeps it.
func (w *World) tick() {
	w.cur = w.bus.Frames.Latest()
	w.next = w.bus.Frames.Next()
	trace.WithRegion(w.ctx, "inputs", w.inputsFn)
	w.phaseDone(PhaseInputs)
	trace.WithRegion(w.ctx, "sea", w.seaFn)
	w.phaseDone(PhaseSea)
	trace.WithRegion(w.ctx, "physics", w.physicsFn)
	w.phaseDone(PhasePhysics)
	trace.WithRegion(w.ctx, "grid", w.gridFn)
	w.phaseDone(PhaseGrid)
	trace.WithRegion(w.ctx, "contacts", w.contactsFn)
	w.phaseDone(PhaseContacts)
	trace.WithRegion(w.ctx, "publish", w.publishFn)
	w.phaseDone(PhasePublish)
}

func (w *World) phaseDone(p Phase) {
	if w.observer != nil {
		w.observer.PhaseDone(p)
	}
}

// inputs copies the world into the next frame, then applies what changed:
// first the sea moves on if the tick begins a second, by the weather as it
// stood before this tick's commands; then the boats whose grace has ended leave, and the places in the queue
// whose grace has ended are given up; then the control words of the
// boats sailing are applied, each pair once its tick has come (bus.Due), then
// the commands, in the order they came; last, while there is room, those
// waiting in the queue get their boats, the longest waiting first.
func (w *World) inputs() {
	cur, next := w.cur, w.next
	next.Tick = cur.Tick + 1 + w.skip
	next.Skipped = w.skip
	w.skip = 0
	next.Weathers = append(next.Weathers[:0], cur.Weathers...)
	w.sea.roll(&next.Sea, &cur.Sea, cur.Tick, next.Tick, cur.Weathers)
	next.NextBoat = cur.NextBoat
	next.Held = cur.Held
	next.Live = append(next.Live[:0], cur.Live...)
	copy(next.Occupied, cur.Occupied)
	copy(next.Gen, cur.Gen)
	for _, s := range cur.Live {
		next.Boat[s] = cur.Boat[s]
		next.Owner[s] = cur.Owner[s]
		next.Conn[s] = cur.Conn[s]
		next.Grace[s] = cur.Grace[s]
		next.Kind[s] = cur.Kind[s]
		next.Control[s] = cur.Control[s]
		next.Pilot[s] = cur.Pilot[s]
		next.State[s] = cur.State[s]
		next.Course[s] = cur.Course[s]
	}
	// A bump stays a second in the frames, for encoders that skip one.
	next.Bumps = next.Bumps[:0]
	for _, b := range cur.Bumps {
		if b.Tick > next.Tick-bus.BumpTicks {
			next.Bumps = append(next.Bumps, b)
		}
	}
	next.Queue = append(next.Queue[:0], cur.Queue...)
	next.Changed = next.Changed[:0]
	clear(next.Events) // drop the old events' references
	next.Events = next.Events[:0]
	w.expire()

	if in := w.given; in != nil {
		for _, sw := range in.Changed {
			if sw.Slot >= 0 && int(sw.Slot) < w.capacity && next.Occupied[sw.Slot] {
				next.Control[sw.Slot], next.Pilot[sw.Slot] = sw.Word, sw.Pilot
				next.Changed = append(next.Changed, sw)
			}
		}
		for i := range in.Commands {
			w.apply(&in.Commands[i])
		}
		w.admit()
		w.spells(next)
		return
	}

	controls := w.bus.Controls
	for _, s := range next.Live {
		word, pilot := controls.Load(s)
		// The pair is taken whole: two words of different ticks were read
		// between a writer's two stores, and wait a tick.
		if (word != next.Control[s] || pilot != next.Pilot[s]) && word.Seq() == pilot.Seq() &&
			word.Gen() == next.Gen[s] && pilot.Gen() == next.Gen[s] && bus.Due(word.Seq(), next.Tick) {
			next.Control[s], next.Pilot[s] = word, pilot
			next.Changed = append(next.Changed, bus.SlotWord{Slot: s, Word: word, Pilot: pilot})
		}
	}
	q := w.bus.Commands
	for range bus.QueueSize {
		c, ok := q.Receive()
		if !ok {
			break
		}
		w.apply(&c)
	}
	w.admit()
	w.spells(next)
}

// seaPhase brings the waves to this tick.
func (w *World) seaPhase() { w.sea.tick(w.next) }

// physics steps every boat in the wind and the waves: the weather at the
// tick, and each boat in the wind at its place as its step begins.
func (w *World) physics() {
	w.weatherAt(w.next)
	w.workers.step(w.next.Live)
}

// weatherAt brings the world's wind to f's tick and spells.
func (w *World) weatherAt(f *bus.Frame) {
	if !sameSpells(&w.weather, f) {
		w.weather.Set(f.SpellsInPlay())
	}
	physics.WeatherAt(&w.weather, &w.wind, float64(f.Tick))
}

// sameSpells reports whether w holds f's spells in play.
func sameSpells(w *physics.Weather, f *bus.Frame) bool {
	return w.Count == f.NSpells && w.Spells == f.Spells
}

// stepSlots steps the boats in slots of the next frame, each in the wind at
// its place as its step begins less the shadow of the wakes about it in
// the current frame, and keeps what each step says of its sail, for
// drawing; then works out its wind and wake after the step, and brings its
// course along. Workers call it on disjoint ranges: a step reads only its
// own boat, the weather, the waves and the current frame.
func (w *World) stepSlots(slots []int32, o *physics.Out, src *physics.Sources) {
	f := w.next
	for _, s := range slots {
		word := f.Control[s]
		c := physics.Control{Helm: word.Helm(), Sheet: word.Sheet()}
		c.Pilot, c.Target, c.Order, c.Way = f.Pilot[s].Control()
		st := &f.State[s]
		e := physics.WindAt(&w.wind, st.X, st.Y, nil)
		kind := &w.kinds[f.Kind[s]]
		if w.enc != nil {
			w.shadow(src, &e, s, st.X, st.Y)
		}
		physics.Step(st, &c, &e, w.sea.at, nil, kind, o)
		f.Sail[s] = physics.SailByte(o)
		w.settle(f, s)
		if w.enc != nil {
			physics.TrackCourse(&f.Course[s], st, f.Wind[s].WindFrom, kind, w.enc)
		}
	}
}

// grid sorts the next frame's boats into the grid's cells.
func (w *World) grid() { buildGrid(w.next) }

// publish makes the next frame current and hands it to the recorders.
func (w *World) publish() {
	w.bus.Frames.Publish(w.next)
	for _, r := range w.recorders {
		r.Record(w.next)
	}
	w.cur, w.next = nil, nil
}
