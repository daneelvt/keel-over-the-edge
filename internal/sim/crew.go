// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Crews: a boat may carry people besides its skipper, up to its kind's
// capacity, each let aboard by the skipper (the game connection asks).
// Someone aboard has no boat of their own in the world: their own leaves
// the water as they come aboard, and is put in the water again at the
// nearest port as they go ashore, ahead of anyone waiting. One person
// aboard holds the boat's controls, its skipper unless they have handed
// them on (Holder).
//
// At each change of who holds the controls the slot's generation moves
// on and the controls in force are stamped with it, as when a slot is
// reused: a word the former holder's connection wrote, or is still to
// write, carries the old generation and is never applied, so the edge
// need not stop that writer in step with the tick. The new holder starts
// from the controls in force: the boat does not jump, and an autopilot
// engaged steers on.
//
// Who is aboard is world state, in the snapshot and the digest, so a
// restart keeps people aboard: someone whose connection ends stays aboard
// for the grace a boat has, and goes ashore if they do not come back.

// capacityOf is how many people a boat of kind carries, its skipper
// included.
func (w *World) capacityOf(kind uint16) int {
	if int(kind) < len(w.capacities) {
		return min(w.capacities[kind], bus.MaxCrew+1)
	}
	return 1
}

// board brings c's account aboard c's boat as crew, through c's
// connection: a seat is free, and the account is not the boat's skipper.
// Its own boat, if it has one in the water, leaves at once (an event of
// its own, a Leave with the result Gone, which a replay does not apply
// again); a place it held in the queue is given up; if it was aboard
// another boat it leaves that one. Already aboard this boat, it is aboard
// through the new connection.
func (w *World) board(c *bus.Command) bus.Reply {
	f := w.next
	s := slotOf(f, c.Boat)
	if s < 0 {
		return bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: c.Boat}
	}
	r := bus.Reply{Result: bus.Crewed, Slot: s, Boat: c.Boat, Gen: f.Gen[s]}
	if f.Owner[s] == c.Account {
		r.Result = bus.Stale
		return r
	}
	if i := f.Aboard(c.Account); i >= 0 && f.Crew[i].Boat == c.Boat {
		f.Crew[i].Conn, f.Crew[i].Grace = c.Conn, 0
		return r
	}
	lo, hi := f.CrewOf(s)
	seat := uint8(1)
	for i := lo; i < hi && f.Crew[i].Seat == seat; i++ {
		seat++
	}
	if int(seat) >= w.capacityOf(f.Kind[s]) {
		r.Result = bus.NoRoom
		return r
	}
	if i := f.Aboard(c.Account); i >= 0 {
		w.leaveCrew(f, i, bus.EndAboard)
	}
	if o := afloatIn(f, c.Account); o >= 0 {
		boat := f.Boat[o]
		gone := bus.Reply{Result: bus.Gone, Slot: o, Boat: boat, Gen: f.Gen[o], Tick: f.Tick}
		w.free(o, bus.EndAboard)
		f.Events = append(f.Events, bus.Event{Command: bus.Command{Op: bus.Leave, Boat: boat, Account: c.Account}, Reply: gone})
	}
	if q := queued(f, c.Account); q >= 0 {
		f.Queue = slices.Delete(f.Queue, q, q+1)
	}
	// The skipper's slot is where it was: freeing another never moves a
	// boat.
	lo, hi = f.CrewOf(s)
	at := lo
	for at < hi && f.Crew[at].Seat < seat {
		at++
	}
	f.Crew = slices.Insert(f.Crew, at, bus.Aboard{Slot: s, Boat: c.Boat, Seat: seat, Account: c.Account, Conn: c.Conn, Since: f.Tick,
		Machine: c.Machine, Priority: c.Priority, Look: c.Look, Name: c.Name, BoatKind: w.kindOf(c.BoatKind), BoatLook: c.BoatLook, BoatName: c.BoatName})
	f.Deck[s]++
	return r
}

// leaveCrew takes f.Crew[i] off their boat, how, the controls back to its
// skipper if they held them, and returns who they were.
func (w *World) leaveCrew(f *bus.Frame, i int, how uint8) bus.Aboard {
	a := f.Crew[i]
	w.aboardEnded(f, &a, how)
	f.Crew = slices.Delete(f.Crew, i, i+1)
	f.Deck[a.Slot]++
	if f.Holder[a.Slot] == a.Account {
		w.handTo(f, a.Slot, bus.Account{})
	}
	return a
}

// handTo gives the controls of the boat in slot s of f to account: the
// slot's generation moves on, and the controls in force are stamped with
// it and written back to the slot, so that only the new holder's words
// are applied from here on.
func (w *World) handTo(f *bus.Frame, s int32, account bus.Account) {
	f.Holder[s] = account
	f.Deck[s]++
	g := (f.Gen[s] + 1) & bus.GenMask
	f.Gen[s] = g
	cw, p, rg := f.Control[s], f.Pilot[s], f.Rig[s]
	f.Control[s] = bus.Pack(cw.Seq(), cw.HelmIndex(), cw.SheetIndex(), g)
	f.Pilot[s] = bus.PackPilot(p.Seq(), p.Mode(), p.Way(), p.Order(), p.Target(), g)
	f.Rig[s] = rg.Restamp(rg.Seq(), g)
	if w.given == nil {
		w.bus.Controls.Store(s, f.Control[s], f.Pilot[s], f.Rig[s])
	}
}

// setHolder gives c's boat's controls to c's account, one of its crew, or
// with the zero account to its skipper.
func (w *World) setHolder(c *bus.Command) bus.Reply {
	f := w.next
	s := slotOf(f, c.Boat)
	if s < 0 {
		return bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: c.Boat}
	}
	r := bus.Reply{Result: bus.Done, Slot: s, Boat: c.Boat}
	if c.Account != (bus.Account{}) {
		if i := f.Aboard(c.Account); i < 0 || f.Crew[i].Boat != c.Boat {
			r.Result, r.Gen = bus.Stale, f.Gen[s]
			return r
		}
	}
	if f.Holder[s] != c.Account {
		w.handTo(f, s, c.Account)
	}
	r.Gen = f.Gen[s]
	return r
}

// ashore takes c's account off the boat it is aboard (c's boat, unless
// that is 0), for c's reason, and puts its own boat in the water at the
// nearest port.
func (w *World) ashore(c *bus.Command) bus.Reply {
	f := w.next
	i := f.Aboard(c.Account)
	if i < 0 || c.Boat != 0 && f.Crew[i].Boat != c.Boat {
		return bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: c.Boat}
	}
	why := c.Why
	if why != bus.AshorePut {
		why = bus.AshoreChose
	}
	return w.land(f, w.leaveCrew(f, i, bus.EndAshore), why)
}

// landCrew puts everyone aboard the boat in slot s ashore, for why: the
// boat is leaving the water. Each is an event of its own, an Ashore the
// tick makes itself, which a replay does not apply again.
func (w *World) landCrew(f *bus.Frame, s int32, why uint8) {
	lo, hi := f.CrewOf(s)
	if lo == hi {
		return
	}
	aboard := slices.Clone(f.Crew[lo:hi])
	for i := range aboard {
		w.aboardEnded(f, &aboard[i], bus.EndLanded)
	}
	f.Crew = slices.Delete(f.Crew, lo, hi)
	f.Holder[s] = bus.Account{}
	f.Deck[s]++
	for _, a := range aboard {
		w.landed = append(w.landed, landing{a: a, why: why})
	}
}

// landing is someone going ashore from a boat that left the water, whose
// own boat is put in the water once the command or the tick that took
// the boat out has done.
type landing struct {
	a   bus.Aboard
	why uint8
}

// launch puts in the water the boats of those whose boat left the water
// meanwhile, each recorded as an Ashore of its own.
func (w *World) launch() {
	f := w.next
	for len(w.landed) > 0 {
		l := w.landed[0]
		w.landed = w.landed[1:]
		r := w.land(f, l.a, l.why)
		r.Tick = f.Tick
		f.Events = append(f.Events, bus.Event{Command: bus.Command{Op: bus.Ashore, Account: l.a.Account, Conn: l.a.Conn, Boat: l.a.Boat,
			Why: l.why}, Reply: r})
	}
	w.landed = w.landed[:0]
}

// land puts the own boat of someone just ashore in the water: at the
// nearest port to where they were, through admission but ahead of anyone
// waiting, since they were at sea a moment before; or, with the world at
// its limit, at the head of the queue. Someone with no connection (gone,
// in their grace) gets no boat.
func (w *World) land(f *bus.Frame, a bus.Aboard, why uint8) bus.Reply {
	if a.Conn == 0 || why == bus.AshoreGone {
		return bus.Reply{Result: bus.Ashored, Slot: -1}
	}
	// The boat's slot holds where it was, if it has just left the water.
	x, y := f.State[a.Slot].X, f.State[a.Slot].Y
	q := bus.Waiting{Account: a.Account, Conn: a.Conn, Since: f.Tick, Machine: a.Machine, Priority: a.Priority, Look: a.Look,
		BoatKind: a.BoatKind, BoatLook: a.BoatLook, BoatName: a.BoatName}
	room := len(f.Live) < w.capacity && (len(f.Live) < w.limit || a.Priority) && !f.Held
	if !room {
		if len(f.Queue) == bus.QueueLimit {
			return bus.Reply{Result: bus.Full, Slot: -1}
		}
		f.Queue = slices.Insert(f.Queue, 0, q)
		pos, _ := bus.QueuePlace(f.Queue, 0)
		return bus.Reply{Result: bus.Queued, Slot: -1, Position: pos}
	}
	s := w.newBoat(&q)
	if st, ok := w.portPlace(f, s, x, y); ok {
		f.State[s] = st
		w.readyControls(f, s)
	}
	return bus.Reply{Result: bus.Joined, Slot: s, Boat: f.Boat[s], Gen: f.Gen[s]}
}

// The places tried about a port's harbour for a boat put in the water
// there: rings portStep apart out to portReach beyond the harbour's disc,
// each at portBearings bearings. The bearings' unit vectors are written
// out, so no trigonometry runs: every machine finds the same place.
const (
	portStep  = 10
	portReach = 200
)

var portBearings = [12][2]float64{
	{0, 1}, {0.5, 0.8660254037844386}, {0.8660254037844386, 0.5}, {1, 0}, {0.8660254037844386, -0.5}, {0.5, -0.8660254037844386},
	{0, -1}, {-0.5, -0.8660254037844386}, {-0.8660254037844386, -0.5}, {-1, 0}, {-0.8660254037844386, 0.5}, {-0.5, 0.8660254037844386},
}

// portPlace is where the boat in slot s of f goes in the water at the
// port nearest (x, y): the first place, from the middle of its harbour
// outward, where it fits as a new boat must, facing a reach; ok is false
// in a world with no ports, or with no room about the nearest.
func (w *World) portPlace(f *bus.Frame, s int32, x, y float64) (physics.State, bool) {
	if len(w.ports) == 0 {
		return physics.State{}, false
	}
	best, near := 0, 0.0
	for i, d := range w.ports {
		dx, dy := d.X-x, d.Y-y
		if r := float64(dx*dx) + float64(dy*dy); i == 0 || r < near {
			best, near = i, r
		}
	}
	d := w.ports[best]
	kind := f.Kind[s]
	for r := 0.0; r <= d.R+portReach; r += portStep {
		for i, b := range portBearings {
			if r == 0 && i > 0 {
				break
			}
			st := physics.State{X: d.X + float64(r*b[0]), Y: d.Y + float64(r*b[1]), Heading: f.State[s].Heading}
			if !w.clear(f, s, kind, &st) {
				continue
			}
			w.onReach(&st, int64(s))
			if w.room(f, s, kind, &st) {
				return st, true
			}
		}
	}
	return physics.State{}, false
}

// crewGone takes out of their boats those aboard whose connection's grace
// has ended, each an Ashore the tick makes itself.
func (w *World) crewGone() {
	f := w.next
	for i := 0; i < len(f.Crew); {
		if g := f.Crew[i].Grace; g == 0 || f.Tick < g {
			i++
			continue
		}
		a := w.leaveCrew(f, i, bus.EndAshore)
		f.Events = append(f.Events, bus.Event{Command: bus.Command{Op: bus.Ashore, Account: a.Account, Boat: a.Boat, Why: bus.AshoreGone},
			Reply: bus.Reply{Result: bus.Ashored, Slot: -1, Tick: f.Tick}})
	}
}

// crewDisconnect begins the grace of f.Crew[i], their connection conn
// ended: the controls, if they held them, go back to the skipper at once.
// A connection they no longer use is ignored.
func (w *World) crewDisconnect(f *bus.Frame, i int, conn uint64) bus.Reply {
	a := &f.Crew[i]
	r := bus.Reply{Result: bus.Stale, Slot: a.Slot, Boat: a.Boat, Gen: f.Gen[a.Slot]}
	if a.Conn != conn || a.Grace != 0 {
		return r
	}
	a.Grace = f.Tick + w.grace
	a.Conn = 0
	if f.Holder[a.Slot] == a.Account {
		w.handTo(f, a.Slot, bus.Account{})
	}
	r.Result, r.Gen = bus.Done, f.Gen[a.Slot]
	return r
}
