// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A boat is changed in port: in the harbour of Port Royal or of a port, not
// at a fishing village's jetty. A sailor at sea there may swap their boat
// for another of their fleet, which takes its place where it lies, or give
// it a new look; ashore or waiting for a boat, the change is the next
// boat's. Away from a port the boat stays as it is.

// Disc is a disc of water: its centre, m east and north, and its radius.
type Disc struct{ X, Y, R float64 }

// inPort reports whether (x, y) is water in port: within a disc of a
// port's harbour, on water.
func (w *World) inPort(x, y float64) bool {
	if len(w.ports) == 0 {
		return false
	}
	if w.ground != nil {
		if e, _ := w.ground.At(x, y); e > 0 {
			return false
		}
	}
	for _, d := range w.ports {
		dx, dy := x-d.X, y-d.Y
		if float64(dx*dx)+float64(dy*dy) <= float64(d.R*d.R) {
			return true
		}
	}
	return false
}

// InPort reports whether (x, y) is water in port, as a change of boat
// finds it.
func (w *World) InPort(x, y float64) bool { return w.inPort(x, y) }

// afloatIn is the account's live slot in f, or −1.
func afloatIn(f *bus.Frame, account bus.Account) int32 {
	for _, s := range f.Live {
		if f.Owner[s] == account {
			return s
		}
	}
	return -1
}

// setBoat swaps the account's boat for one of c's kind, look and name: in
// port, where there is room for it, in its place, heading as it was, at
// rest, its sheet eased, its reefs shaken out and its autopilot off. Its
// place in the queue takes the new boat for when it is given one. A boat
// out of port stays (Away), as does one where the new hull would meet
// land, shoal water or another boat (NoRoom); an account with neither has
// none (NoBoat), and is ashore.
func (w *World) setBoat(c *bus.Command) bus.Reply {
	f := w.next
	kind := w.kindOf(c.BoatKind)
	s := afloatIn(f, c.Account)
	if s < 0 {
		if i := queued(f, c.Account); i >= 0 {
			q := &f.Queue[i]
			q.BoatKind, q.BoatLook, q.BoatName = kind, c.BoatLook, c.BoatName
			return bus.Reply{Result: bus.Done, Slot: -1}
		}
		return bus.Reply{Result: bus.NoBoat, Slot: -1}
	}
	r := bus.Reply{Result: bus.Away, Slot: s, Boat: f.Boat[s], Gen: f.Gen[s]}
	st := &f.State[s]
	if f.Voyage[s].Over != 0 || !w.inPort(st.X, st.Y) {
		return r
	}
	if !w.room(f, s, kind, st) {
		r.Result = bus.NoRoom
		return r
	}
	f.Kind[s], f.BoatLook[s], f.BoatName[s] = kind, c.BoatLook, c.BoatName
	f.State[s] = physics.State{X: st.X, Y: st.Y, Heading: st.Heading}
	f.Course[s] = physics.Course{}
	word := f.Control[s]
	f.Control[s] = bus.Pack(word.Seq(), bus.Steps/2, bus.Steps, f.Gen[s])
	f.Pilot[s] = bus.HandPilot(f.Control[s])
	f.Rig[s] = bus.HandRig(f.Control[s])
	if w.given == nil {
		// The sailor's phone takes the controls from the Welcome that
		// follows the swap.
		w.bus.Controls.Store(s, f.Control[s], f.Pilot[s], f.Rig[s])
	}
	r.Result = bus.Done
	return r
}

// room reports whether a boat of kind may lie at st in place of the boat
// in slot s of f, or beside it: the water under its middle and its ends,
// along its heading, its draught and startDeep deep, and its hull
// startClear clear of every other boat's. A small boat fits where a large
// one would lie across its neighbours, or touch the bottom.
func (w *World) room(f *bus.Frame, s int32, kind uint16, st *physics.State) bool {
	if !w.clear(f, s, kind, st) {
		return false
	}
	if w.ground != nil {
		b := &w.kinds[kind]
		r := physics.Radius(b)
		sin, cos := physics.SinCos(st.Heading)
		for _, along := range [2]float64{r, -r} {
			x, y := st.X+float64(along*sin), st.Y+float64(along*cos)
			if e, _ := w.ground.At(x, y); e > -(physics.Draught(b) + startDeep) {
				return false
			}
		}
	}
	return true
}

// setBoatLook gives the account's boat c's look and name, in port; its
// place in the queue takes them for its boat to come. A boat out of port
// keeps its own (Away); an account with neither has none (NoBoat).
func (w *World) setBoatLook(c *bus.Command) bus.Reply {
	f := w.next
	s := afloatIn(f, c.Account)
	if s < 0 {
		if i := queued(f, c.Account); i >= 0 {
			f.Queue[i].BoatLook, f.Queue[i].BoatName = c.BoatLook, c.BoatName
			return bus.Reply{Result: bus.Done, Slot: -1}
		}
		return bus.Reply{Result: bus.NoBoat, Slot: -1}
	}
	r := bus.Reply{Result: bus.Away, Slot: s, Boat: f.Boat[s], Gen: f.Gen[s]}
	if st := &f.State[s]; f.Voyage[s].Over == 0 && w.inPort(st.X, st.Y) {
		f.BoatLook[s], f.BoatName[s] = c.BoatLook, c.BoatName
		r.Result = bus.Done
	}
	return r
}
