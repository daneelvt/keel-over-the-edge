// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"math"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// courseTo asks for a course to a sailor's boat, by account; "" stops it.
func (v *viewer) courseTo(sailor string) {
	v.t.Helper()
	v.command(&pb.Command{Body: &pb.Command_CourseTo{CourseTo: &pb.CourseTo{Sailor: sailor}}})
}

// sailsTo asks for a course to a sailor's boat and reads until the first
// answer of it: where the boat is, or why not. What is still told of the
// course before it is dropped.
func (v *viewer) sailsTo(id store.AccountID) (*pb.ShipmateAt, pb.CourseEnd) {
	v.t.Helper()
	v.at, v.courseEnded = nil, nil
	v.courseTo(id.String())
	var at *pb.ShipmateAt
	if !v.read(5*time.Second, func() bool {
		for _, m := range v.at {
			if m.GetSailor() == id.String() {
				at = m
			}
		}
		return at != nil || v.courseEnded != nil && v.courseEnded.GetSailor() == id.String()
	}) {
		v.t.Fatal("no answer to a course")
	}
	if at == nil {
		return nil, v.courseEnded.GetWhy()
	}
	v.at, v.courseEnded = []*pb.ShipmateAt{at}, nil
	return at, pb.CourseEnd_COURSE_END_UNSPECIFIED
}

// courseEnds reads until the course ends, and returns why.
func (v *viewer) courseEnds() pb.CourseEnd {
	v.t.Helper()
	if !v.read(5*time.Second, func() bool { return v.courseEnded != nil }) {
		v.t.Fatalf("the course did not end (%d told)", len(v.at))
	}
	return v.courseEnded.GetWhy()
}

// toldNear reports whether a ShipmateAt is within 30 m of an account's
// boat as the world has it now.
func toldNear(s *Server, at *pb.ShipmateAt, a store.AccountID) bool {
	st := boatAt(s, bus.Account(a)).state
	return math.Hypot(float64(at.GetEast())-st.X, float64(at.GetNorth())-st.Y) < 30
}

// TestCourseToAShipmate: Ann sails to Bob, her shipmate at sea: she is
// told where his boat is at once and every two seconds, and he is told
// once a voyage that she sails to him, however often she asks, and after
// he comes back on a new connection. Dan, no shipmate, and Tia, Ann's
// shipmate of another age band, are refused. Bob appearing offline, their
// no longer being shipmates and a block each end it, refused with the one
// line that never says why, and refuse it asked again; Bob out of the game
// is no longer at sea; leaving the water to watch, he has come ashore,
// and is refused, not at sea, when asked again. Stopped, nothing more is
// told.
func TestCourseToAShipmate(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cw := newChatWorld(t)
		srv := cw.srv
		annToken, ann := cw.sailor("Ann Bonny", aboard.Speaker{})
		bobToken, bob := cw.sailor("Bob Read", aboard.Speaker{})
		danToken, _ := cw.sailor("Dan Kidd", aboard.Speaker{})
		tiaToken, tia := cw.sailor("Tia Lowe", aboard.Speaker{Band: aboard.Teen, Rules: true})
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		b := dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		d := dial(t, srv, danToken, client.Hello())
		d.welcomed()
		ti := dial(t, srv, tiaToken, client.Hello())
		ti.welcomed()
		for _, v := range []*viewer{a, b, d, ti} {
			v.keepAlive()
		}
		cw.ties.SetShipmates(ann, bob, true)
		cw.ties.SetShipmates(ann, tia, true)
		mary, _ := srv.Machine(t, "Iron Mary", ann, near(3))

		at, why := a.sailsTo(bob)
		if why != pb.CourseEnd_COURSE_END_UNSPECIFIED {
			t.Fatalf("a course to a shipmate at sea: %v", why)
		}
		if at.GetName() != "Bob Read" || at.GetSailor() != bob.String() || !toldNear(srv, at, bob) {
			t.Fatalf("told %v, Bob's boat at %+v", at, boatAt(srv, bus.Account(bob)).state)
		}
		if !b.read(5*time.Second, func() bool { return len(b.sailedTo) > 0 }) || b.sailedTo[0] != "Ann Bonny" {
			t.Fatalf("Bob was told %q", b.sailedTo)
		}
		// Every two seconds.
		a.read(4500*time.Millisecond, nil)
		if len(a.at) < 3 {
			t.Fatalf("told %d times in four and a half seconds", len(a.at))
		}
		// Stopped: nothing more.
		a.courseTo("")
		a.read(time.Second, nil)
		n := len(a.at)
		a.read(5*time.Second, nil)
		if len(a.at) != n || a.courseEnded != nil {
			t.Fatalf("told %d more after it stopped, ended %v", len(a.at)-n, a.courseEnded)
		}
		// Asked again on the same voyage: Bob is not told again.
		if _, why := a.sailsTo(bob); why != pb.CourseEnd_COURSE_END_UNSPECIFIED {
			t.Fatalf("asked again: %v", why)
		}
		b.read(3*time.Second, nil)
		if len(b.sailedTo) != 1 {
			t.Fatalf("Bob told %q", b.sailedTo)
		}

		// No shipmate, and a shipmate of another age band: refused.
		if _, why := d.sailsTo(ann); why != pb.CourseEnd_COURSE_END_REFUSED {
			t.Fatalf("a stranger's course: %v", why)
		}
		if _, why := a.sailsTo(tia); why != pb.CourseEnd_COURSE_END_REFUSED {
			t.Fatalf("a course across the age bands: %v", why)
		}
		if _, why := ti.sailsTo(ann); why != pb.CourseEnd_COURSE_END_REFUSED {
			t.Fatalf("a course across the age bands, the other way: %v", why)
		}
		// Someone else's machine sailor: refused, as anyone else.
		if _, why := d.sailsTo(mary); why != pb.CourseEnd_COURSE_END_REFUSED {
			t.Fatalf("a course to someone else's machine sailor: %v", why)
		}
		a.read(time.Second, nil)
		if len(a.sailedTo) != 0 || len(ti.sailedTo) != 0 {
			t.Fatalf("told of a refused course: %q, %q", a.sailedTo, ti.sailedTo)
		}

		// Appearing offline ends it, and refuses it asked again.
		if _, why := a.sailsTo(bob); why != pb.CourseEnd_COURSE_END_UNSPECIFIED {
			t.Fatalf("before appearing offline: %v", why)
		}
		srv.Chat.Update(bus.Account(bob), func(s *aboard.Speaker) { s.Offline = true })
		if why := a.courseEnds(); why != pb.CourseEnd_COURSE_END_REFUSED {
			t.Fatalf("Bob appearing offline: %v", why)
		}
		if _, why := a.sailsTo(bob); why != pb.CourseEnd_COURSE_END_REFUSED {
			t.Fatalf("asked of Bob appearing offline: %v", why)
		}
		srv.Chat.Update(bus.Account(bob), func(s *aboard.Speaker) { s.Offline = false })

		// No longer shipmates.
		if _, why := a.sailsTo(bob); why != pb.CourseEnd_COURSE_END_UNSPECIFIED {
			t.Fatalf("back online: %v", why)
		}
		cw.ties.SetShipmates(ann, bob, false)
		if why := a.courseEnds(); why != pb.CourseEnd_COURSE_END_REFUSED {
			t.Fatalf("no longer shipmates: %v", why)
		}
		if _, why := a.sailsTo(bob); why != pb.CourseEnd_COURSE_END_REFUSED {
			t.Fatalf("asked of someone no longer a shipmate: %v", why)
		}
		cw.ties.SetShipmates(ann, bob, true)

		// A block, by either.
		for _, by := range [][2]store.AccountID{{bob, ann}, {ann, bob}} {
			if _, why := a.sailsTo(bob); why != pb.CourseEnd_COURSE_END_UNSPECIFIED {
				t.Fatalf("before a block: %v", why)
			}
			cw.ties.SetBlock(by[0], by[1], true)
			if why := a.courseEnds(); why != pb.CourseEnd_COURSE_END_REFUSED {
				t.Fatalf("a block: %v", why)
			}
			cw.ties.SetBlock(by[0], by[1], false)
		}

		// Out of the game: no longer at sea. Back on a new connection, on
		// the same voyage, he is not told again.
		if _, why := a.sailsTo(bob); why != pb.CourseEnd_COURSE_END_UNSPECIFIED {
			t.Fatalf("before Bob leaves: %v", why)
		}
		b.ws.CloseNow()
		if why := a.courseEnds(); why != pb.CourseEnd_COURSE_END_GONE {
			t.Fatalf("Bob out of the game: %v", why)
		}
		b = dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		b.keepAlive()
		if _, why := a.sailsTo(bob); why != pb.CourseEnd_COURSE_END_UNSPECIFIED {
			t.Fatalf("Bob back: %v", why)
		}
		b.read(3*time.Second, nil)
		if len(b.sailedTo) != 0 {
			t.Fatalf("Bob told again on the same voyage: %q", b.sailedTo)
		}

		// Bob leaves the water to watch: come ashore; asked again, refused.
		b.command(&pb.Command{Body: &pb.Command_Watch{Watch: &pb.Watch{Sailor: "Iron Mary"}}})
		if why := a.courseEnds(); why != pb.CourseEnd_COURSE_END_ASHORE {
			t.Fatalf("Bob ashore: %v", why)
		}
		if _, why := a.sailsTo(bob); why != pb.CourseEnd_COURSE_END_REFUSED {
			t.Fatalf("asked of Bob ashore: %v", why)
		}
		for _, v := range []*viewer{a, b, d, ti} {
			v.drain()
		}
	})
}

// TestCourseToOwnMachine: Ann sails to her own machine sailor, Iron Mary,
// told where its boat is every two seconds, with nothing told to it; Dan
// may not. Its boat leaving the water ends it: no longer at sea, and so
// when asked again.
func TestCourseToOwnMachine(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cw := newChatWorld(t)
		srv := cw.srv
		annToken, ann := cw.sailor("Ann Bonny", aboard.Speaker{})
		danToken, _ := cw.sailor("Dan Kidd", aboard.Speaker{})
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		d := dial(t, srv, danToken, client.Hello())
		d.welcomed()
		a.keepAlive()
		d.keepAlive()
		mary, boat := srv.Machine(t, "Iron Mary", ann, near(3))

		at, why := a.sailsTo(mary)
		if why != pb.CourseEnd_COURSE_END_UNSPECIFIED {
			t.Fatalf("a course to her own machine sailor: %v", why)
		}
		if at.GetName() != "Iron Mary" || !toldNear(srv, at, mary) {
			t.Fatalf("told %v, its boat at %+v", at, boatAt(srv, bus.Account(mary)).state)
		}
		a.read(4500*time.Millisecond, nil)
		if len(a.at) < 3 {
			t.Fatalf("told %d times in four and a half seconds", len(a.at))
		}
		if _, why := d.sailsTo(mary); why != pb.CourseEnd_COURSE_END_REFUSED {
			t.Fatalf("a course to someone else's machine sailor: %v", why)
		}

		a.courseEnded = nil
		if err := srv.World.Bus().Commands.Players().TrySend(bus.Command{Op: bus.Leave, Boat: boat}); err != nil {
			t.Fatal(err)
		}
		if why := a.courseEnds(); why != pb.CourseEnd_COURSE_END_GONE {
			t.Fatalf("its boat out of the water: %v", why)
		}
		if _, why := a.sailsTo(mary); why != pb.CourseEnd_COURSE_END_GONE {
			t.Fatalf("asked of it out of the water: %v", why)
		}
		a.drain()
		d.drain()
	})
}
