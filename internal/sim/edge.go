// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The edge of the world. After the contacts, the rules: a boat whose centre
// of gravity is at or beyond the lip has gone over the falls. It falls for
// the edge's fall: it is not stepped, touches nothing and casts no shadow,
// its state held as its last step left it, and every view still holds it,
// so everyone near sees it go. Then, in the inputs of the tick its fall
// ends, it starts again at the world's start, at rest, the same boat in the
// same slot, on the controls it held.
//
// Each boat's voyage keeps its approaches to the lip: one begins as the
// boat enters the mist band and is survived when the boat is the edge's
// clear distance back out of it, or when the voyage ends afloat; going over
// ends it unsurvived. When a voyage ends, by leaving, expiring or going
// over, the least distance of its survived approaches is an event, and
// going over is one too; unless the owner's tools moved the boat in that
// voyage, which earns nothing. A boat that stays while its owner's free
// camera roams does not move, and the rules pass it by.

// Edge is how a world treats boats at its edge; where the lip and the mist
// band lie is the weather's.
type Edge struct {
	Fall  int64   // how many ticks a boat that has gone over falls
	Clear float64 // an approach is survived this far back out of the mist band, m
}

// rules sends the boats at or beyond the lip over it, and follows each
// boat's approach to it.
func (w *World) rules() {
	if w.edge == nil {
		return
	}
	f := w.next
	p := w.weather.Prepared
	for _, s := range f.Live {
		v := &f.Voyage[s]
		if v.Falling() || f.Stay[s] {
			continue
		}
		st := &f.State[s]
		if physics.OverEdge(p, st.X, st.Y) {
			v.Over = f.Tick
			f.Edges = append(f.Edges, bus.EdgeEvent{Tick: f.Tick, Kind: bus.EdgeOver, Slot: s, Boat: f.Boat[s], Owner: f.Owner[s], X: st.X, Y: st.Y, Placed: v.Placed})
			// The approach under way ended over the lip: it is not survived.
			v.Approaching = false
			w.voyageEnds(f, s)
			if w.enc != nil {
				f.Wake[s] = physics.Wake{}
			}
			continue
		}
		d := physics.EdgeDistance(p, st.X, st.Y)
		switch {
		case !v.Approaching:
			if d < w.band {
				v.Approaching, v.Least, v.X, v.Y = true, d, st.X, st.Y
			}
		case d >= w.bandClear:
			survive(v)
		case d < v.Least:
			v.Least, v.X, v.Y = d, st.X, st.Y
		}
	}
}

// survive ends v's approach under way, survived.
func survive(v *bus.Voyage) {
	if !v.Approaching {
		return
	}
	if !v.Survived || v.Least < v.Best {
		v.Survived, v.Best, v.BestX, v.BestY = true, v.Least, v.X, v.Y
	}
	v.Approaching = false
}

// voyageEnds records the closest approach slot s of f survived in its
// voyage, if any, and clears the voyage's record: an approach under way is
// survived, since the boat ends it afloat.
func (w *World) voyageEnds(f *bus.Frame, s int32) {
	v := &f.Voyage[s]
	survive(v)
	if v.Survived {
		f.Edges = append(f.Edges, bus.EdgeEvent{
			Tick: f.Tick, Kind: bus.EdgeApproach, Slot: s, Boat: f.Boat[s], Owner: f.Owner[s],
			X: v.BestX, Y: v.BestY, Distance: v.Best, Placed: v.Placed,
		})
	}
	v.Approaching, v.Least, v.X, v.Y = false, 0, 0, 0
	v.Survived, v.Best, v.BestX, v.BestY = false, 0, 0, 0
	v.Placed = false
}

// fallsEnd starts again at the world's start each boat of the next frame
// whose fall has ended.
func (w *World) fallsEnd() {
	if w.edge == nil {
		return
	}
	f := w.next
	for _, s := range f.Live {
		if v := &f.Voyage[s]; v.Falling() && f.Tick >= v.Over+w.edge.Fall {
			w.startAgain(f, s)
		}
	}
}

// startAgain puts boat s at the world's start, at rest, on a new voyage:
// what its autopilot remembered, its time aground and its course are
// cleared, and its pairs begin afresh. Its controls are those it held.
func (w *World) startAgain(f *bus.Frame, s int32) {
	f.Voyage[s] = bus.Voyage{}
	f.State[s] = w.spawn(f, s)
	f.Course[s] = physics.Course{}
	w.restarted = append(w.restarted, s)
}
