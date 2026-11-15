// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A course to a sailor's boat, on the game connection. A player sails to
// a shipmate at sea, or to one of their own machine sailors in the water:
// the phone asks for them by account (CourseTo), and is told where their
// boat is every two seconds (ShipmateAt), as a race's picture is, until it
// stops asking or the course no longer holds (CourseEnded). A shipmate is
// found only while MayFind holds (shipmates, one age band, no block, not
// appearing offline) and they are at sea, and is told once a voyage who
// sails to them (ShipmateCourse); every refusal reads alike, and a
// shipmate not at sea when asked is refused, so nothing says whether one
// who appears offline is in the game. A player's own machine sailor is
// always found while its boat is in the water, and is told nothing.
// Nothing of it is kept: a new connection asks again.

// courseEvery is how often a course's boat is told, ticks: the race
// picture's rate.
const courseEvery = pictureEvery

// courseAsk is the sailor's boat a connection sails to, as its reader
// checked it: their account, and for a machine sailor its name (a
// shipmate's is the hub's) and that it is the connection's own.
type courseAsk struct {
	sailor  bus.Account
	id      string
	name    string
	machine bool
}

// connCourse is the encoder's side of a connection's course: the ask it
// last answered, when, and whether it has told where the boat is yet.
type connCourse struct {
	ask      *courseAsk
	told     int64
	answered bool
}

// sailedTo is who has been told a shipmate sails to them, and on which
// boat: told once a voyage, each shipmate.
type sailedTo struct {
	mu sync.Mutex
	m  map[[2]bus.Account]uint64
}

// courseToCommand acts on a CourseTo: an empty one stops the course; a
// shipmate is asked for as such, and anyone else only as the account's own
// machine sailor, which reads the database. What is refused here is told
// at once; the rest the encoder checks at each telling.
func (c *conn) courseToCommand(sailor string) {
	if sailor == "" {
		c.course.Store(nil)
		return
	}
	e := c.e
	id, ok := store.ParseID(sailor)
	a := bus.Account(id)
	if !ok || a == c.account {
		c.courseEnded(sailor, pb.CourseEnd_COURSE_END_REFUSED)
		return
	}
	if e.cfg.Chat != nil && e.cfg.Chat.Shipmates(c.account, a) {
		c.course.Store(&courseAsk{sailor: a, id: sailor})
		return
	}
	if e.cfg.WatchByID == nil {
		c.courseEnded(sailor, pb.CourseEnd_COURSE_END_REFUSED)
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, DeckLookup)
	defer cancel()
	t, err := e.cfg.WatchByID(ctx, a)
	if err != nil || !t.Mine(store.AccountID(c.account)) {
		c.course.Store(nil)
		c.courseEnded(sailor, pb.CourseEnd_COURSE_END_REFUSED)
		return
	}
	c.course.Store(&courseAsk{sailor: a, id: sailor, name: t.Name, machine: true})
}

// courseEnded tells the connection a course to sailor ended, and why.
func (c *conn) courseEnded(sailor string, why pb.CourseEnd) bool {
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_CourseEnded{CourseEnded: &pb.CourseEnded{
		Sailor: sailor, Why: why,
	}}}, outCourse)
}

// sailTo tells c where the boat of the sailor it sails to is in f, at once
// for a new ask and then every courseEvery, or that the course has ended:
// false if c has closed. Not while it watches another's boat, whose
// compass shows no course of its own; the course holds meanwhile.
func (c *conn) sailTo(f *bus.Frame) bool {
	cc := &c.sailing
	a := c.course.Load()
	if a == nil {
		cc.ask = nil
		return true
	}
	if a != cc.ask {
		cc.ask, cc.answered = a, false
	} else if f.Tick-cc.told < courseEvery {
		return true
	}
	if c.w.on {
		return true
	}
	cc.told = f.Tick
	why, s, name := c.e.findFor(f, c.account, a)
	if why != pb.CourseEnd_COURSE_END_UNSPECIFIED {
		c.course.CompareAndSwap(a, nil)
		if !cc.answered && !a.machine {
			// Asked of a shipmate not to be found: refused, as any other.
			why = pb.CourseEnd_COURSE_END_REFUSED
		}
		cc.ask = nil
		return c.courseEnded(a.id, why)
	}
	cc.answered = true
	if !a.machine {
		c.e.tellSailedTo(f, a.sailor, c.account, f.Boat[s])
	}
	st := &f.State[s]
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_ShipmateAt{ShipmateAt: &pb.ShipmateAt{
		Sailor: a.id, Name: name, East: metres(st.X), North: metres(st.Y),
	}}}, outCourse)
}

// findFor is where in f the boat of the sailor seeker asked for is, its
// slot, and the sailor's name; or why the course to it no longer holds.
func (e *Edge) findFor(f *bus.Frame, seeker bus.Account, a *courseAsk) (why pb.CourseEnd, slot int32, name string) {
	if a.machine {
		if s := seaSlot(f, a.sailor); s >= 0 {
			return pb.CourseEnd_COURSE_END_UNSPECIFIED, s, a.name
		}
		return pb.CourseEnd_COURSE_END_GONE, -1, ""
	}
	h := e.cfg.Chat
	if h == nil {
		return pb.CourseEnd_COURSE_END_REFUSED, -1, ""
	}
	mine, in := h.Speaker(seeker)
	if !in {
		return pb.CourseEnd_COURSE_END_REFUSED, -1, ""
	}
	theirs, in := h.Speaker(a.sailor)
	blocked := h.Rules.Ties != nil && h.Rules.Ties.Blocks(seeker, a.sailor) ||
		e.cfg.Refuser != nil && (e.cfg.Refuser.Refuses(seeker, a.sailor) || e.cfg.Refuser.Refuses(a.sailor, seeker))
	shipmates := h.Shipmates(seeker, a.sailor)
	switch {
	case !shipmates || blocked:
		return pb.CourseEnd_COURSE_END_REFUSED, -1, ""
	case !in:
		// Out of the game: no longer at sea, as far as anyone can tell.
		return pb.CourseEnd_COURSE_END_GONE, -1, ""
	case !aboard.MayFind(mine, theirs, shipmates, blocked):
		return pb.CourseEnd_COURSE_END_REFUSED, -1, ""
	}
	s := seaSlot(f, a.sailor)
	switch {
	case s < 0:
		return pb.CourseEnd_COURSE_END_ASHORE, -1, ""
	case f.Unseen[s]:
		// The owner's tools keep the boat out of every view.
		return pb.CourseEnd_COURSE_END_REFUSED, -1, ""
	}
	return pb.CourseEnd_COURSE_END_UNSPECIFIED, s, h.Name(a.sailor)
}

// seaSlot is the slot of the boat an account is at sea in, its own or one
// it is aboard as crew; −1 for none.
func seaSlot(f *bus.Frame, a bus.Account) int32 {
	if s := findBoat(f, a); s >= 0 {
		return s
	}
	for i := range f.Crew {
		if f.Crew[i].Account == a {
			return f.Crew[i].Slot
		}
	}
	return -1
}

// sailedToSweep is how many pairs are kept before those whose voyage is
// over are swept.
const sailedToSweep = 1024

// tellSailedTo tells shipmate, at sea on boat, that seeker sails to them:
// once a voyage for each seeker, and only while shipmate has a connection
// to be told on.
func (e *Edge) tellSailedTo(f *bus.Frame, shipmate, seeker bus.Account, boat uint64) {
	st := &e.sailedTo
	key := [2]bus.Account{shipmate, seeker}
	st.mu.Lock()
	if st.m == nil {
		st.m = map[[2]bus.Account]uint64{}
	}
	if st.m[key] == boat {
		st.mu.Unlock()
		return
	}
	if len(st.m) >= sailedToSweep {
		live := map[uint64]bool{}
		for _, s := range f.Live {
			live[f.Boat[s]] = true
		}
		for k, b := range st.m {
			if !live[b] {
				delete(st.m, k)
			}
		}
	}
	st.m[key] = boat
	st.mu.Unlock()
	c := e.registry.get(shipmate)
	if c == nil || c.gone.Load() {
		return
	}
	name := ""
	if h := e.cfg.Chat; h != nil {
		name = h.Name(seeker)
	}
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_ShipmateCourse{ShipmateCourse: &pb.ShipmateCourse{Name: name}}}, outCourse)
}
