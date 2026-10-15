// SPDX-License-Identifier: AGPL-3.0-only

package client

import (
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
)

// Wakes are the other boats' wakes as the prediction approximates them:
// the server steps each boat in the shadow of the wakes the boats near it
// left a tick before, and the client knows those boats only from the
// snapshots' samples. For each boat in the near band it keeps the newest
// two samples; before a step into tick t it offers the step the wakes of
// the ClientWakes nearest, each where its samples put it at t − 1 (between
// them, or carried on past the newest at the speed between them), heading
// and heeled as the newest says, in the wind at that place and tick. The
// difference from the server's shadow is corrected as any other.
// client/src/predict/wakes.ts is its twin, bit for bit.
type Wakes struct {
	n     [protocol.ViewSlots]uint8 // samples held: 0, 1 or 2
	tick  [protocol.ViewSlots][2]int64
	x, y  [protocol.ViewSlots][2]float64 // [0] the newest, [1] the one before
	pose  [protocol.ViewSlots][3]float64 // the newest's heading, heel and boom
	order [protocol.ViewSlots]int32
	d2    [protocol.ViewSlots]float64
	src   physics.Sources
	wind  physics.WeatherTick
}

// Reset forgets every boat: a new connection.
func (w *Wakes) Reset() { w.n = [protocol.ViewSlots]uint8{} }

// Observe takes a snapshot's view: the boats it samples in the near band
// gain a sample; a slot a boat entered starts afresh; one left, or in the
// far band, holds none.
func (w *Wakes) Observe(tick int64, v *protocol.View, ch protocol.Changes, sampled uint64) {
	for slot := range protocol.ViewSlots {
		bit := uint64(1) << slot
		if ch.Left&bit != 0 || ch.Entered&bit != 0 || !v.Has(slot) {
			w.n[slot] = 0
		}
		if !v.Has(slot) {
			continue
		}
		q := &v.Boats[slot]
		if q.Far() {
			w.n[slot] = 0
			continue
		}
		if sampled&bit == 0 {
			continue
		}
		w.tick[slot][1], w.x[slot][1], w.y[slot][1] = w.tick[slot][0], w.x[slot][0], w.y[slot][0]
		w.tick[slot][0] = tick
		w.x[slot][0] = float64(q.X) * protocol.PositionStep
		w.y[slot][0] = float64(q.Y) * protocol.PositionStep
		w.pose[slot] = [3]float64{headingOf(q.Heading), float64(q.Heel) * protocol.AngleStep, float64(q.Boom) * protocol.AngleStep}
		w.n[slot] = min(w.n[slot]+1, 2)
	}
}

// headingOf is a heading's steps as radians in [−π, π), as the page has it.
func headingOf(steps uint16) float64 {
	return float64(int16(steps)) * protocol.AngleStep
}

// Shadow changes e, the wind at (x, y) for a step into tick, by the wakes
// of the nearest boats, as they were at tick − 1, and returns how many
// reach. weather is the weather in play; kind the boats' kind.
func (w *Wakes) Shadow(e *physics.Env, x, y float64, tick int64, weather *physics.Weather, kind *physics.Prepared, enc *physics.EncounterPrepared) int {
	n := 0
	for slot := range protocol.ViewSlots {
		if w.n[slot] == 0 {
			continue
		}
		dx, dy := w.x[slot][0]-x, w.y[slot][0]-y
		w.d2[slot] = float64(dx*dx) + float64(dy*dy)
		w.order[n] = int32(slot)
		n++
	}
	if n == 0 {
		return 0
	}
	// The nearest first, ties to the lower slot: an insertion sort, as
	// the page's.
	for i := 1; i < n; i++ {
		for j := i; j > 0 && w.d2[w.order[j]] < w.d2[w.order[j-1]]; j-- {
			w.order[j], w.order[j-1] = w.order[j-1], w.order[j]
		}
	}
	n = min(n, physics.ClientWakes)
	at := tick - 1
	physics.WeatherAt(weather, &w.wind, float64(at))
	w.src.Reset()
	var p physics.WindPoint
	for i := range n {
		slot := w.order[i]
		px, py, vx, vy := w.place(slot, at)
		physics.WindPointAt(&w.wind, px, py, &p, nil)
		pose := &w.pose[slot]
		wake := physics.WakeAt(px, py, pose[0], pose[1], pose[2], vx, vy, p.Speed, p.From, kind, enc)
		w.src.Consider(&wake, int32(i), x, y, enc)
	}
	physics.ShadowAt(e, x, y, &w.src, enc)
	return int(w.src.Len())
}

// place is where boat slot was at tick at, and its velocity, m/s.
func (w *Wakes) place(slot int32, at int64) (x, y, vx, vy float64) {
	x, y = w.x[slot][0], w.y[slot][0]
	if w.n[slot] < 2 || w.tick[slot][0] <= w.tick[slot][1] {
		return x, y, 0, 0
	}
	k := float64(w.tick[slot][0] - w.tick[slot][1])
	ux := (x - w.x[slot][1]) / k
	uy := (y - w.y[slot][1]) / k
	dt := float64(at - w.tick[slot][0])
	return x + float64(ux*dt), y + float64(uy*dt), float64(ux * physics.StepsPerSecond), float64(uy * physics.StepsPerSecond)
}
