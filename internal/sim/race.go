// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
)

// Races: the server hands the committee a race at its warning signal
// (bus.RacePlace), and the committee lays its course to the mean wind at
// its place. Each entrant's boat at sea is then placed behind the line, in
// an order drawn by lot, at the first of the committee's spots clear of
// land, shoal water and every other boat: at rest, its course cleared, its
// controls ready to sail as a new boat's; on a reach or a Dash, where it is
// placed facing the mark across the wind, its sheet set for a beam reach.
// Its sheet is eased as the wind rises, and its sail set as if trimmed so,
// its boom out to leeward: placed with its boom on the centreline and its
// sail hauled in, a boat at rest in a fresh wind turns up into the wind
// and stops there, and in a gale capsizes. In a gale it is reefed too.
// Left alone, it sails off. A skipper sailing another kind
// of boat changes to the race's, from their fleet, wherever they are: the
// voyage in the old boat ends and one in the new begins, so the log keeps
// the boat sailed. Those aboard stay if the skipper entered with them and
// there is room, and go ashore otherwise. The voyage is not marked placed,
// as the owner's tools' moves are: a race's placing is no cheat, and the
// log keeps the voyage; its odometer adds nothing for the move, and its
// pairs begin afresh. An entrant whose boat is not at sea (ashore, waiting
// for a boat, or aboard another's) did not start; nor did one still placed
// or racing in another race: a boat sails one race at a time, and it sails
// on in the race it is in. A trial's run for a sailor still racing is not
// begun: it waits, handed again, until that race is over.
//
// Where each boat was just before it was placed, its kind, look and name,
// its place and heading, is kept in the frame (bus.RaceHome), the first
// place only while it races on. When the race is over for it (it
// finished, retired, or the race ended) it goes back there,
// bus.HomeAfter later, so its sailor sees it across the line first: in its
// own kind again, those aboard with it, at rest, ready to sail as a
// placed boat is, a little astern of its place if another boat lies
// there. A boat gone from the sea meanwhile, or over the lip, has no home
// to go to.
//
// A race (not a trial's run) whose place has a storm's mean wind as it is
// handed over is called off: its course laid but no boat placed, and it
// ends as it begins, for the server to tell its entrants.
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
	if !call.Trial && speed >= committee.StormWind {
		committee.CallOff(f, call, course)
		r.Result = bus.Done
		return r
	}
	if call.Trial && len(call.Entrants) == 1 && committee.RacerOf(f, call.Entrants[0].Account) >= 0 {
		// Still racing: the run waits.
		return r
	}
	length := 2 * physics.Radius(&w.kinds[call.Kind])
	spots := committee.Spots(course, length)
	placed := make([]committee.Placing, len(call.Entrants))
	for _, i := range committee.Lot(call) {
		e := &call.Entrants[i]
		if committee.RacerOf(f, e.Account) >= 0 {
			// Still in another race: it sails on there, and sits this one out.
			continue
		}
		home := homeOf(f, e.Account)
		s := w.raceBoat(f, e, call.Kind)
		if s < 0 {
			continue
		}
		w.keepHome(f, home)
		w.raceSpot(f, s, spots, course.Across, speed, from)
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
	w.changeKind(f, s, kind, e.BoatLook, e.BoatName)
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

// changeKind makes the boat in slot s of f one of kind, look and name, if
// it is another: its voyage in the old boat ends and one in the new
// begins, and nobody holds its controls but its skipper.
func (w *World) changeKind(f *bus.Frame, s int32, kind uint16, look uint32, name string) {
	if f.Kind[s] == kind {
		return
	}
	w.voyageEnds(f, s, bus.EndReturned)
	f.Voyage[s] = newVoyage(f.Tick)
	f.Kind[s], f.BoatLook[s], f.BoatName[s] = kind, look, name
	if f.Holder[s] != (bus.Account{}) {
		w.handTo(f, s, bus.Account{})
	}
}

// homeOf is where the account's boat at sea in f is now, as a home to go
// back to; its slot −1 if it has none afloat.
func homeOf(f *bus.Frame, account bus.Account) bus.RaceHome {
	s := afloatIn(f, account)
	if s < 0 || f.Voyage[s].Falling() {
		return bus.RaceHome{Slot: -1}
	}
	st := &f.State[s]
	return bus.RaceHome{Account: account, Slot: s, Boat: f.Boat[s], Kind: f.Kind[s], BoatLook: f.BoatLook[s], BoatName: f.BoatName[s],
		X: st.X, Y: st.Y, Heading: st.Heading}
}

// keepHome keeps home h of a boat just placed, unless its boat has one
// kept already: the place it left for its first race, which it has not
// gone back to yet.
func (w *World) keepHome(f *bus.Frame, h bus.RaceHome) {
	if h.Slot < 0 {
		return
	}
	for i := range f.RaceHomes {
		if g := &f.RaceHomes[i]; g.Account == h.Account && g.Boat == h.Boat {
			g.At = 0
			return
		}
	}
	f.RaceHomes = append(f.RaceHomes, h)
}

// raceHomes sends home each boat whose race is over for it, HomeAfter
// after: the tick it saw it over counts on from there. A home whose boat
// is gone from the sea, or over the lip, is let go.
func (w *World) raceHomes() {
	f := w.next
	if len(f.RaceHomes) == 0 {
		return
	}
	kept := f.RaceHomes[:0]
	for _, h := range f.RaceHomes {
		s := h.Slot
		switch {
		case s < 0 || int(s) >= len(f.Occupied) || !f.Occupied[s] || f.Boat[s] != h.Boat || f.Owner[s] != h.Account ||
			f.Voyage[s].Falling():
			continue
		case committee.RacerOf(f, h.Account) >= 0:
			h.At = 0
		case h.At == 0:
			h.At = f.Tick + bus.HomeAfter
		case f.Tick >= h.At:
			w.raceHome(f, &h)
			continue
		}
		kept = append(kept, h)
	}
	clear(f.RaceHomes[len(kept):])
	f.RaceHomes = kept
}

// homeTries are how many places a boat going home tries, each homeBack
// of its lengths astern of the last, before it goes to its own place
// whatever lies there.
const (
	homeTries = 6
	homeBack  = 2.0
)

// raceHome puts the boat of home h back where it was: in its own kind,
// those aboard who have room staying, at rest, ready to sail.
func (w *World) raceHome(f *bus.Frame, h *bus.RaceHome) {
	s := h.Slot
	if int(h.Kind) < len(w.kinds) && f.Kind[s] != h.Kind {
		w.changeKind(f, s, h.Kind, h.BoatLook, h.BoatName)
		room := w.capacityOf(h.Kind)
		lo, hi := f.CrewOf(s)
		for i := hi - 1; i >= lo; i-- {
			if int(f.Crew[i].Seat) >= room {
				w.landed = append(w.landed, landing{a: w.leaveCrew(f, i, bus.EndLanded), why: bus.AshoreLeft})
			}
		}
	}
	st := physics.State{X: h.X, Y: h.Y, Heading: h.Heading}
	if int(f.Kind[s]) < len(w.kinds) {
		back := float64(homeBack * 2 * physics.Radius(&w.kinds[f.Kind[s]]))
		sin, cos := physics.SinCos(h.Heading)
		for i := range homeTries {
			p := physics.State{X: h.X - float64(float64(float64(i)*back)*sin), Y: h.Y - float64(float64(float64(i)*back)*cos), Heading: h.Heading}
			if w.clear(f, s, f.Kind[s], &p) {
				st = p
				break
			}
		}
	}
	speed, from := physics.MeanWindAt(&w.wind, st.X, st.Y)
	off := math.Abs(math.Remainder(st.Heading-from, 2*math.Pi)) * 180 / math.Pi
	w.putAtRest(f, s, st, off, speed, from)
}

// raceSpot puts the boat in slot s of f at the first of spots where it
// fits, at rest, ready to sail in a mean wind of speed from from; at the
// first if none is clear. Across is a reach's or a Dash's spots: the boat
// lies across the wind there.
func (w *World) raceSpot(f *bus.Frame, s int32, spots []physics.State, across bool, speed, from float64) {
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
	off := startOffWind * 180 / math.Pi
	if across {
		off = 90
	}
	w.putAtRest(f, s, st, off, speed, from)
}

// putAtRest puts the boat in slot s of f at st, at rest, its course
// cleared, its controls ready to sail off degrees off a mean wind of
// speed from from, its sail set as if trimmed so: placed by the
// committee, its pairs begin afresh.
func (w *World) putAtRest(f *bus.Frame, s int32, st physics.State, off, speed, from float64) {
	f.State[s] = st
	f.Course[s] = physics.Course{}
	f.Voyage[s].Over = 0
	if lg := &f.Voyage[s].Log; lg.Read {
		// The odometer adds nothing for the move.
		lg.X, lg.Y = st.X, st.Y
	}
	if len(w.start) > 0 {
		sheet := placedSheet(w.startSheetOff(f, s, off), speed)
		w.readyControlsWith(f, s, sheet, placedReef(speed))
		if k := int(f.Kind[s]); k < len(w.kinds) {
			physics.TrimmedAtRest(&w.kinds[k], &f.State[s], f.Control[s].Sheet(), from, placedReef(speed) > 0)
		}
	}
	w.racePlaced = append(w.racePlaced, s)
}

// A boat placed for a race has its start sheet in a light or middling
// wind, eased from placedEaseFrom knots on to placedEased at placedEaseTo
// and above, and is reefed from placedReefFrom knots.
const (
	placedEaseFrom = 12
	placedEaseTo   = 22
	placedEased    = 0.85
	placedReefFrom = 30
)

// placedSheet is the sheet, in a control word's steps, a boat placed for a
// race has in a mean wind of speed, m/s, from its start sheet start.
func placedSheet(start uint16, speed float64) uint16 {
	knots := speed / physics.Knot
	t := min(max((knots-placedEaseFrom)/(placedEaseTo-placedEaseFrom), 0), 1)
	eased := uint16(math.Floor(float64(float64(t*placedEased)*bus.Steps) + 0.5))
	return max(start, eased)
}

// placedReef is the reef a boat placed for a race has in a mean wind of
// speed, m/s: in a gale, the deepest.
func placedReef(speed float64) uint8 {
	if speed/physics.Knot >= placedReefFrom {
		return bus.MaxReef
	}
	return 0
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
	next.RaceHomes = append(next.RaceHomes[:0], cur.RaceHomes...)
	next.RaceEvents = next.RaceEvents[:0]
	for _, e := range cur.RaceEvents {
		if e.Tick > next.Tick-bus.BumpTicks {
			next.RaceEvents = append(next.RaceEvents, e)
		}
	}
}
