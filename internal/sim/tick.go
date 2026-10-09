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
	trace.WithRegion(w.ctx, "physics", w.physicsFn)
	w.phaseDone(PhasePhysics)
	trace.WithRegion(w.ctx, "grid", w.gridFn)
	w.phaseDone(PhaseGrid)
	trace.WithRegion(w.ctx, "publish", w.publishFn)
	w.phaseDone(PhasePublish)
}

func (w *World) phaseDone(p Phase) {
	if w.observer != nil {
		w.observer.PhaseDone(p)
	}
}

// inputs copies the world into the next frame, then applies what changed:
// first the boats whose grace has ended leave, and the places in the queue
// whose grace has ended are given up; then the control words of the
// boats sailing are applied, each once its tick has come (bus.Due), then
// the commands, in the order they came; last, while there is room, those
// waiting in the queue get their boats, the longest waiting first.
func (w *World) inputs() {
	cur, next := w.cur, w.next
	next.Tick = cur.Tick + 1 + w.skip
	next.Skipped = w.skip
	w.skip = 0
	next.Wind = cur.Wind
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
		next.State[s] = cur.State[s]
	}
	next.Queue = append(next.Queue[:0], cur.Queue...)
	next.Changed = next.Changed[:0]
	clear(next.Events) // drop the old events' references
	next.Events = next.Events[:0]
	w.expire()

	if in := w.given; in != nil {
		for _, sw := range in.Changed {
			if sw.Slot >= 0 && int(sw.Slot) < w.capacity && next.Occupied[sw.Slot] {
				next.Control[sw.Slot] = sw.Word
				next.Changed = append(next.Changed, sw)
			}
		}
		for i := range in.Commands {
			w.apply(&in.Commands[i])
		}
		w.admit()
		return
	}

	controls := w.bus.Controls
	for _, s := range next.Live {
		word := controls.Load(s)
		if word != next.Control[s] && word.Gen() == next.Gen[s] && bus.Due(word.Seq(), next.Tick) {
			next.Control[s] = word
			next.Changed = append(next.Changed, bus.SlotWord{Slot: s, Word: word})
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
}

// physics steps every boat in the wind.
func (w *World) physics() {
	w.env = physics.Env{WindSpeed: w.next.Wind.Speed, WindFrom: w.next.Wind.From}
	w.workers.step(w.next.Live)
}

// stepSlots steps the boats in slots of the next frame, and keeps what each
// step says of its sail, for drawing. Workers call it on disjoint ranges.
func (w *World) stepSlots(slots []int32, o *physics.Out) {
	f := w.next
	for _, s := range slots {
		word := f.Control[s]
		c := physics.Control{Helm: word.Helm(), Sheet: word.Sheet()}
		physics.Step(&f.State[s], &c, &w.env, &w.kinds[f.Kind[s]], o)
		f.Sail[s] = physics.SailByte(o)
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
