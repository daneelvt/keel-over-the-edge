// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
)

// Races: the server hands the committee a race at its warning signal
// (bus.RacePlace), and the committee lays its course to the mean wind at
// its place. Each entrant's boat at sea is then placed behind the line, in
// an order drawn by lot, at the first of the committee's spots clear of
// land, shoal water and every other boat: at rest, its course cleared, its
// controls ready to sail as a new boat's. A skipper sailing another kind
// of boat changes to the race's, from their fleet, wherever they are: the
// voyage in the old boat ends and one in the new begins, so the log keeps
// the boat sailed. Those aboard stay if the skipper entered with them and
// there is room, and go ashore otherwise. The voyage is not marked placed,
// as the owner's tools' moves are: a race's placing is no cheat, and the
// log keeps the voyage; its odometer adds nothing for the move, and its
// pairs begin afresh. An entrant whose boat is not at sea (ashore, waiting
// for a boat, or aboard another's) did not start.
//
// Then, in the rules phase, the committee runs every race one tick on.

// racePlace hands the committee the race of c and places its boats.
func (w *World) racePlace(c *bus.Command) bus.Reply {
	f := w.next
	call := c.Race
	r := bus.Reply{Result: bus.NoBoat, Slot: -1}
	switch {
	case w.stage == nil || call == nil || int(call.Kind) >= len(w.kinds):
		return r
	case committee.Holds(f, call.ID, call.Run):
		r.Result = bus.Stale
		return r
	}
	x, y, ok := w.stage.Where(f, call)
	if !ok {
		return r
	}
	speed, from := physics.MeanWindAt(&w.wind, x, y)
	course := w.stage.Lay(f, call, speed, from, len(call.Entrants))
	if course == nil {
		return r
	}
	length := 2 * physics.Radius(&w.kinds[call.Kind])
	spots := committee.Spots(course, length)
	placed := make([]committee.Placing, len(call.Entrants))
	for _, i := range committee.Lot(call) {
		e := &call.Entrants[i]
		s := w.raceBoat(f, e, call.Kind)
		if s < 0 {
			continue
		}
		w.raceSpot(f, s, spots)
		placed[i] = committee.Placing{Slot: s, Boat: f.Boat[s], Placed: true}
	}
	committee.Begin(f, call, course, placed)
	r.Result = bus.Done
	return r
}

// raceBoat readies entrant e's boat for a race of boats of kind: out of
// any race it sails in, afloat again if it was falling over the lip, of
// the race's kind, with those aboard who race with it. It returns its
// slot, or −1 if it is not at sea.
func (w *World) raceBoat(f *bus.Frame, e *bus.RaceEntrant, kind uint16) int32 {
	s := afloatIn(f, e.Account)
	if s < 0 {
		return -1
	}
	committee.Retire(f, e.Account)
	v := &f.Voyage[s]
	if v.Falling() {
		// Its voyage ended as it went over: a new one begins on the line.
		f.Voyage[s] = newVoyage(f.Tick)
	}
	if f.Kind[s] != kind {
		w.voyageEnds(f, s, bus.EndReturned)
		f.Voyage[s] = newVoyage(f.Tick)
		f.Kind[s], f.BoatLook[s], f.BoatName[s] = kind, e.BoatLook, e.BoatName
		if f.Holder[s] != (bus.Account{}) {
			w.handTo(f, s, bus.Account{})
		}
	}
	room := w.capacityOf(kind)
	lo, hi := f.CrewOf(s)
	for i := hi - 1; i >= lo; i-- {
		if !e.Crew || int(f.Crew[i].Seat) >= room {
			w.landed = append(w.landed, landing{a: w.leaveCrew(f, i, bus.EndLanded), why: bus.AshoreLeft})
		}
	}
	f.Stay[s], f.Unseen[s] = false, false
	return s
}

// raceSpot puts the boat in slot s of f at the first of spots where it
// fits, at rest, ready to sail; at the first if none is clear.
func (w *World) raceSpot(f *bus.Frame, s int32, spots []physics.State) {
	if len(spots) == 0 {
		return
	}
	st := spots[0]
	for _, p := range spots {
		if w.clear(f, s, f.Kind[s], &p) && w.room(f, s, f.Kind[s], &p) {
			st = p
			break
		}
	}
	f.State[s] = st
	f.Course[s] = physics.Course{}
	f.Voyage[s].Over = 0
	if lg := &f.Voyage[s].Log; lg.Read {
		// The odometer adds nothing for the move.
		lg.X, lg.Y = st.X, st.Y
	}
	w.readyControls(f, s)
	w.racePlaced = append(w.racePlaced, s)
}

// raceRules runs the races one tick on.
func (w *World) raceRules() {
	if len(w.next.Races) > 0 {
		committee.Step(w.next, w.cur)
	}
}

// raceCopy copies the races of the current frame into the next, and the
// events of the last bus.BumpTicks ticks.
func raceCopy(next, cur *bus.Frame) {
	next.NextRace = cur.NextRace
	next.Races = append(next.Races[:0], cur.Races...)
	next.Racers = append(next.Racers[:0], cur.Racers...)
	next.RaceEvents = next.RaceEvents[:0]
	for _, e := range cur.RaceEvents {
		if e.Tick > next.Tick-bus.BumpTicks {
			next.RaceEvents = append(next.RaceEvents, e)
		}
	}
}
