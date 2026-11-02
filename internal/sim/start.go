// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A new boat in a world with a start area starts ready to sail: at rest on
// a reach, startOffWind off the mean wind at its place, on the side whose
// course leads away from the coast, its sheet set for that reach from its
// kind's start sheet, its helm centred and its autopilot off. A sailor who
// touches nothing moves off: the boat's weather helm rounds it up toward a
// close reach, still sailing. On the spawn grid of a world with none, open
// sea, a boat starts as the grid has it, heading east with its controls
// centred.

// startOffWind is how far off the wind a new boat faces, rad: 110°.
const startOffWind = 110 * math.Pi / 180

// StartSheet is a kind of boat's sheet for a start from rest: pairs of an
// angle off the wind, degrees, and the sheet there, from 0 hauled in to 1
// let fly, by rising angle; read linearly between them and as the nearest
// end beyond them.
type StartSheet [][2]float64

// At is the sheet for a start off degrees off the wind.
func (t StartSheet) At(off float64) float64 {
	if len(t) == 0 {
		return 0.5
	}
	if off <= t[0][0] {
		return t[0][1]
	}
	for i := 1; i < len(t); i++ {
		if off <= t[i][0] {
			a, b := t[i-1], t[i]
			return a[1] + float64((off-a[0])/(b[0]-a[0])*(b[1]-a[1]))
		}
	}
	return t[len(t)-1][1]
}

// onReach turns a boat at place p of the start to face startOffWind off
// the mean wind there, on the side with the more open water ahead, both on
// that reach and on the close reach the boat rounds up to; or, as open on
// both, on the side that leads away from the coast. With no wind, it keeps
// the place's heading.
func (w *World) onReach(st *physics.State, p int64) {
	if len(w.start) == 0 {
		return
	}
	e := physics.WindAt(&w.wind, st.X, st.Y, w.shelter)
	if !(e.WindSpeed > 0) {
		return
	}
	away := st.Heading
	if n := int64(len(w.away)); n > 0 {
		away = w.away[p%n]
	}
	best, open, most := st.Heading, -1.0, math.Inf(-1)
	for _, side := range [2]float64{1, -1} {
		h := headingOf(e.MeanFrom + float64(side*startOffWind))
		up := headingOf(e.MeanFrom + float64(side*roundedUp))
		clear := min(w.openAhead(st.X, st.Y, h), w.openAhead(st.X, st.Y, up))
		if _, c := physics.SinCos(h - away); clear > open || clear == open && c > most {
			best, open, most = h, clear, c
		}
	}
	st.Heading = best
}

// roundedUp is how far off the wind an untouched boat started on its reach
// comes to sail, its weather helm having rounded it up, rad: 60°.
const roundedUp = 60 * math.Pi / 180

// openAhead is how far from (x, y) along heading the water stays deep
// enough for a boat, m, looked for out to openReach.
func (w *World) openAhead(x, y, heading float64) float64 {
	if w.ground == nil {
		return openReach
	}
	sin, cos := physics.SinCos(heading)
	for d := float64(openStep); d < openReach; d += openStep {
		if e, _ := w.ground.At(x+float64(d*sin), y+float64(d*cos)); e > -openDepth {
			return d
		}
	}
	return openReach
}

// A new boat's course is looked along for land and shoal water this far,
// in steps this long, m, and water this deep is open: as far as an
// untouched boat sails in a minute and a little more.
const (
	openReach = 150
	openStep  = 4
	openDepth = 1
)

// headingOf is an angle as a state's heading holds it, in [−π, π).
func headingOf(a float64) float64 {
	a = math.Mod(a, 2*math.Pi)
	if a < -math.Pi {
		a += 2 * math.Pi
	} else if a >= math.Pi {
		a -= 2 * math.Pi
	}
	return a
}

// startSheet is the sheet, in a control word's steps, the boat in slot s
// of f starts with: its kind's start sheet for startOffWind, or half on
// the spawn grid.
func (w *World) startSheet(f *bus.Frame, s int32) uint16 {
	if len(w.start) == 0 {
		return bus.Steps / 2
	}
	var t StartSheet
	if k := int(f.Kind[s]); k < len(w.sheets) {
		t = StartSheet(w.sheets[k])
	}
	sheet := min(max(t.At(startOffWind*180/math.Pi), 0), 1)
	return uint16(math.Floor(float64(sheet*bus.Steps) + 0.5))
}

// readyControls sets the controls of the boat in slot s of f, just put at
// the start, as a new boat's: the helm centred, the sheet its start
// sheet, the autopilot off. The slot is told, so the controls hold until
// its sailor writes again; the sailor's phone takes them from the
// Welcome that follows.
func (w *World) readyControls(f *bus.Frame, s int32) {
	if len(w.start) == 0 {
		return
	}
	word := f.Control[s]
	f.Control[s] = bus.Pack(word.Seq(), bus.Steps/2, w.startSheet(f, s), f.Gen[s])
	f.Pilot[s] = bus.HandPilot(f.Control[s])
	if w.given == nil {
		w.bus.Controls.Store(s, f.Control[s], f.Pilot[s])
	}
}

// sailHeld is the sail's state an agent is told after a step that left
// out, the boat's instruments before it being before: what the step says
// of the sail once it has said so bus.SailHold steps, until it has drawn
// bus.SailClear.
func sailHeld(before *bus.Instruments, o *physics.Out) (state, raw uint8, run int32) {
	raw = uint8(o.Sail)
	run = 1
	if raw == before.SailRaw {
		run = before.SailFor + 1
	}
	state = before.Sail
	switch {
	case raw == bus.SailDrawing && run >= bus.SailClear:
		state = bus.SailDrawing
	case raw != bus.SailDrawing && run >= bus.SailHold:
		state = raw
	}
	return state, raw, min(run, bus.SailHold)
}
