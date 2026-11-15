// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"errors"
	"io"
	"math"
	"net/http"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// home asks for the boat to be lifted home, and reads until it is
// answered.
func (v *viewer) home() *pb.Lifted {
	v.t.Helper()
	n := len(v.lifted)
	v.command(&pb.Command{Body: &pb.Command_Home{Home: &pb.Home{}}})
	if !v.read(5*time.Second, func() bool { return len(v.lifted) > n }) {
		v.t.Fatal("no answer to a lift home")
	}
	return v.lifted[len(v.lifted)-1]
}

// TestTheWayHome: Ann, far out with Bob aboard, is lifted home: she and
// Bob are told the tick, her boat is at the start again, at rest, with Bob
// still aboard, and the snapshots show it there from that tick. Asked
// again at once, she is told it is too soon; a minute on, she may. Bob,
// aboard, lifts nothing, and nor does a spectator.
func TestTheWayHome(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{BoatOf: keelboats(t)})
		annToken, ann := srv.Sailor("Ann Bonny")
		bobToken, bob := srv.Sailor("Bob Read")
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		a.keepAlive()
		b := dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		b.keepAlive()
		b.aboardOf(a, srv.Link(ann, "Ann Bonny"), "Bob Read")
		start := boatAt(srv, bus.Account(ann))
		_, boat := slotOf(srv, bus.Account(ann))
		far := start.state
		far.X, far.Y = start.state.X+600, start.state.Y+400
		srv.Place(boat, far)
		a.read(time.Second, nil)

		got := a.home()
		if got.GetTick() == 0 || got.GetSoon() {
			t.Fatalf("lifted: %v", got)
		}
		if !b.read(5*time.Second, func() bool { return len(b.lifted) > 0 }) || b.lifted[0].GetTick() != got.GetTick() {
			t.Fatalf("Bob was told %v", b.lifted)
		}
		if !a.read(5*time.Second, func() bool {
			return a.snap.Tick >= got.GetTick() && math.Hypot(a.snap.State.X-start.state.X, a.snap.State.Y-start.state.Y) < 50
		}) {
			t.Fatalf("the snapshots do not show the boat home: tick %d at (%.0f, %.0f)", a.snap.Tick, a.snap.State.X, a.snap.State.Y)
		}
		now := boatAt(srv, bus.Account(ann))
		if d := math.Hypot(now.state.X-start.state.X, now.state.Y-start.state.Y); d > 50 || now.slot != start.slot {
			t.Fatalf("lifted to %.0f m from the start, slot %d", d, now.slot)
		}
		if math.Abs(now.state.Surge) > 1 {
			t.Errorf("lifted at %.2f m/s", now.state.Surge)
		}
		f := srv.World.Bus().Frames.Acquire()
		aboard := f.Aboard(bus.Account(bob))
		inSlot := aboard >= 0 && f.Crew[aboard].Boat == boat
		f.Release()
		if !inSlot {
			t.Fatal("Bob is no longer aboard")
		}

		if again := a.home(); again.GetTick() != 0 || !again.GetSoon() {
			t.Fatalf("lifted again at once: %v", again)
		}
		if crew := b.home(); crew.GetTick() != 0 || crew.GetSoon() {
			t.Fatalf("one aboard asked: %v", crew)
		}
		time.Sleep(edge.LiftEvery)
		if later := a.home(); later.GetTick() == 0 {
			t.Fatalf("lifted a minute on: %v", later)
		}
	})
}

// takeOut posts to /api/me/ashore with the session token given, and
// returns the status and the body.
func takeOut(t *testing.T, s *Server, token string) (int, string) {
	t.Helper()
	req, err := http.NewRequest("POST", "http://example.com/api/me/ashore", nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Cookie", auth.CookieName+"="+token)
	}
	res, err := s.Client(nil).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

// TestTakenOutFromTheStart: from the start screen, a boat is taken out of
// the water: one in its grace at once; one sailing on another screen too,
// that screen closed with why, and the shipmate aboard put ashore, in a
// boat of his own. With no boat there is nothing to do; without a session
// the answer is 401, and an AI account's is 403.
func TestTakenOutFromTheStart(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{BoatOf: keelboats(t)})
		if status, _ := takeOut(t, srv, ""); status != http.StatusUnauthorized {
			t.Fatalf("with no session: %d", status)
		}
		agent, _ := srv.Sessions.Add("Agent", store.AI)
		if status, body := takeOut(t, srv, agent); status != http.StatusForbidden || !jsonIs(body, `{"error":"ai-account"}`) {
			t.Fatalf("an AI account: %d %s", status, body)
		}
		cidToken, _ := srv.Sailor("Cid")
		if status, body := takeOut(t, srv, cidToken); status != http.StatusOK || !jsonIs(body, `{"out":false}`) {
			t.Fatalf("no boat: %d %s", status, body)
		}

		// In its grace: the page closed a moment ago.
		deeToken, dee := srv.Sailor("Dee")
		d := dial(t, srv, deeToken, client.Hello())
		d.welcomed()
		d.ws.Close(websocket.StatusNormalClosure, "")
		time.Sleep(time.Second)
		if s, _ := slotOf(srv, bus.Account(dee)); s < 0 {
			t.Fatal("Dee's boat left at once, with no grace")
		}
		if status, body := takeOut(t, srv, deeToken); status != http.StatusOK || !jsonIs(body, `{"out":true}`) {
			t.Fatalf("a boat in its grace: %d %s", status, body)
		}
		if s, _ := slotOf(srv, bus.Account(dee)); s >= 0 {
			t.Fatal("Dee's boat is still in the water")
		}

		// Sailing on another screen, with Bob aboard.
		annToken, ann := srv.Sailor("Ann Bonny")
		bobToken, bob := srv.Sailor("Bob Read")
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		a.keepAlive()
		b := dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		b.keepAlive()
		b.aboardOf(a, srv.Link(ann, "Ann Bonny"), "Bob Read")
		if status, body := takeOut(t, srv, annToken); status != http.StatusOK || !jsonIs(body, `{"out":true}`) {
			t.Fatalf("a boat sailing elsewhere: %d %s", status, body)
		}
		if s, _ := slotOf(srv, bus.Account(ann)); s >= 0 {
			t.Fatal("Ann's boat is still in the water")
		}
		a.read(3*time.Second, func() bool { return a.closed })
		var ce websocket.CloseError
		if !errors.As(a.in.Err(), &ce) || ce.Code != edge.CloseRemoved || ce.Reason != edge.ReasonTakenOut {
			t.Fatalf("the other screen closed with %v", a.in.Err())
		}
		if !b.read(5*time.Second, func() bool { return b.ashore != nil && b.welcomes > 2 }) ||
			b.ashore.GetWhy() != pb.AshoreWhy_ASHORE_WHY_LEFT || b.welcome.GetAboard() != nil {
			t.Fatalf("Bob: ashore %v, welcome %v", b.ashore, b.welcome)
		}
		if s, _ := slotOf(srv, bus.Account(bob)); s < 0 {
			t.Fatal("Bob has no boat of his own")
		}
		// Asked again: nothing left to take out.
		if status, body := takeOut(t, srv, annToken); status != http.StatusOK || !jsonIs(body, `{"out":false}`) {
			t.Fatalf("again: %d %s", status, body)
		}
	})
}

// jsonIs reports whether a body is the JSON want, give or take a newline.
func jsonIs(body, want string) bool {
	return body == want || body == want+"\n"
}
