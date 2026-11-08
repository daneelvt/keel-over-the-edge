// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// keelboats sails every sailor in the catalog's kind that carries five.
func keelboats(t *testing.T) func(context.Context, store.Account) edge.Boat {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range cat.Capacities() {
		if c == 5 {
			return func(context.Context, store.Account) edge.Boat { return edge.Boat{Kind: uint16(i)} }
		}
	}
	t.Fatal("no kind carries five")
	return nil
}

// keepAlive pings for the connection every 20 s, as a client does, so a
// test that waits minutes is not dropped for its silence.
func (v *viewer) keepAlive() {
	go func() {
		for {
			select {
			case <-v.t.Context().Done():
				return
			case <-time.After(20 * time.Second):
			}
			_ = client.Send(v.t.Context(), v.ws, &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{}}})
		}
	}()
}

// drain reads and drops whatever comes, from now on: a connection the test
// no longer reads must not hold up its writer.
func (v *viewer) drain() {
	go func() {
		for range v.in.C {
		}
	}()
}

// command sends a Command.
func (v *viewer) command(c *pb.Command) {
	v.t.Helper()
	v.send(&pb.ClientMessage{Body: &pb.ClientMessage_Command{Command: c}})
}

// knock knocks with a link's token and reads until the knock's state is
// told.
func (v *viewer) knock(token string) pb.KnockState {
	v.t.Helper()
	v.knocking = nil
	v.command(&pb.Command{Body: &pb.Command_Knock{Knock: &pb.Knock{Token: token}}})
	if !v.read(5*time.Second, func() bool { return v.knocking != nil }) {
		v.t.Fatal("no Knocking")
	}
	return v.knocking.GetState()
}

// card reads until a knock waits on the boat, and returns it.
func (v *viewer) card() *pb.KnockCard {
	v.t.Helper()
	if !v.read(5*time.Second, func() bool { return len(v.cards) > 0 }) {
		v.t.Fatal("no knock card")
	}
	for _, c := range v.cards {
		return c
	}
	return nil
}

// holding reads until the snapshots say the connection holds the controls,
// or does not.
func (v *viewer) holding(want bool) {
	v.t.Helper()
	n := v.snaps
	if !v.read(5*time.Second, func() bool { return v.snaps > n+1 && v.snap.Elsewhere == !want }) {
		v.t.Fatalf("the snapshots do not say holding %v", want)
	}
}

// helm sends controls stamped a few ticks ahead.
func (v *viewer) helm(s *Server, helm uint32) {
	v.t.Helper()
	seq := uint32(s.World.Now() + 3)
	v.send(&pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{Seq: seq, Helm: helm, Sheet: 512, AckTick: v.snap.Tick}}})
}

// helmOf is the helm in force on boat.
func helmOf(s *Server, boat uint64) uint16 {
	f := s.World.Bus().Frames.Acquire()
	defer f.Release()
	for _, sl := range f.Live {
		if f.Boat[sl] == boat {
			return f.Control[sl].HelmIndex()
		}
	}
	return 0xffff
}

// TestSailingTogether: Bob opens Ann's link and knocks; Ann lets him
// aboard. His boat leaves the water; he is welcomed to hers as crew, sees
// who is aboard, and steers nothing. Ann hands him the controls: nothing
// moves until he takes them; then his inputs steer and hers do not. She
// takes them back at once; hands them again and he gives them back. He
// goes ashore and is welcomed to his own boat.
func TestSailingTogether(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{BoatOf: keelboats(t)})
		annToken, ann := srv.Sailor("Ann Bonny")
		bobToken, bob := srv.Sailor("Bob Read")
		a := dial(t, srv, annToken, client.Hello())
		wa := a.welcomed()
		b := dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		if a.snap.Elsewhere {
			t.Fatal("a sailor does not hold their own boat's controls")
		}
		_, bobBoat := slotOf(srv, bus.Account(bob))

		link := srv.Link(ann, "Ann Bonny")
		if got := b.knock(link); got != pb.KnockState_KNOCK_STATE_WAITING || b.knocking.GetSkipper() != "Ann Bonny" {
			t.Fatalf("the knock: %v", b.knocking)
		}
		card := a.card()
		if card.GetSailor() != "Bob Read" {
			t.Fatalf("the card: %v", card)
		}
		// Bob's boat sails while he waits.
		if s, _ := slotOf(srv, bus.Account(bob)); s < 0 {
			t.Fatal("Bob's boat left the water as he knocked")
		}
		a.command(&pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: card.GetId(), Let: true}}})
		w := b.welcomed()
		if w.GetAboard().GetSkipper() != "Ann Bonny" || w.GetBoat() != wa.GetBoat() || w.GetAboard().GetSeat() != 1 {
			t.Fatalf("the Welcome aboard: %v", w)
		}
		if s, _ := slotOf(srv, bus.Account(bob)); s >= 0 {
			t.Fatal("Bob's boat is still in the water")
		}
		_ = bobBoat
		b.holding(false)
		if !a.read(5*time.Second, func() bool { return a.crew != nil && len(a.crew.GetPeople()) == 2 }) {
			t.Fatal("Ann was not told who is aboard")
		}
		if p := a.crew.GetPeople(); p[0].GetName() != "Ann Bonny" || p[1].GetName() != "Bob Read" || !p[0].GetYou() || p[1].GetYou() {
			t.Fatalf("Ann's crew: %v", a.crew)
		}
		if !b.read(5*time.Second, func() bool { return b.crew != nil && len(b.crew.GetPeople()) == 2 }) || !b.crew.GetPeople()[1].GetYou() {
			t.Fatalf("Bob's crew: %v", b.crew)
		}

		boat := wa.GetBoat()
		held := helmOf(srv, boat)
		// Bob steers nothing yet.
		b.helm(srv, 0)
		time.Sleep(time.Second / 3)
		if h := helmOf(srv, boat); h != held {
			t.Fatalf("crew steered before holding the controls: %d", h)
		}

		// Handed: nothing moves until he takes them.
		a.command(&pb.Command{Body: &pb.Command_Hand{Hand: &pb.Hand{To: 1}}})
		if !b.read(5*time.Second, func() bool { return b.handed != nil }) || b.handed.GetFrom() != "Ann Bonny" || b.handed.GetSeconds() != 15 {
			t.Fatalf("handed: %v", b.handed)
		}
		time.Sleep(time.Second)
		a.holding(true)
		b.command(&pb.Command{Body: &pb.Command_Take{Take: &pb.Take{}}})
		b.holding(true)
		a.holding(false)
		if a.crew.GetHolder() != 1 {
			a.read(time.Second, func() bool { return a.crew.GetHolder() == 1 })
		}
		// The boat does not jump: the controls in force are kept.
		if h := helmOf(srv, boat); h != held {
			t.Fatalf("the helm moved at the change of hands: %d, was %d", h, held)
		}
		// Ann's inputs are dropped; Bob's steer.
		a.helm(srv, 1024)
		time.Sleep(time.Second / 3)
		if h := helmOf(srv, boat); h != held {
			t.Fatalf("the skipper steered without the controls: %d", h)
		}
		b.helm(srv, 100)
		if !b.read(5*time.Second, func() bool { return helmOf(srv, boat) == 100 }) {
			t.Fatalf("the holder's helm did not reach the boat: %d", helmOf(srv, boat))
		}
		if b.snap.Margin == protocol.NoMargin {
			b.read(time.Second, func() bool { return b.snap.Margin != protocol.NoMargin })
		}

		// Taken back at once.
		a.command(&pb.Command{Body: &pb.Command_Take{Take: &pb.Take{}}})
		a.holding(true)
		b.holding(false)
		b.helm(srv, 900)
		time.Sleep(time.Second / 3)
		if h := helmOf(srv, boat); h == 900 {
			t.Fatal("the former holder steered after the controls were taken back")
		}

		// Handed again and given back.
		b.handed = nil
		a.command(&pb.Command{Body: &pb.Command_Hand{Hand: &pb.Hand{To: 1}}})
		b.read(5*time.Second, func() bool { return b.handed != nil && !b.handed.GetGone() })
		b.command(&pb.Command{Body: &pb.Command_Take{Take: &pb.Take{}}})
		b.holding(true)
		b.command(&pb.Command{Body: &pb.Command_GiveBack{GiveBack: &pb.GiveBack{}}})
		a.holding(true)

		// Ashore: told why, then his own boat.
		b.ashore = nil
		b.command(&pb.Command{Body: &pb.Command_Ashore{Ashore: &pb.GoAshore{}}})
		w = b.welcomed()
		if b.ashore.GetWhy() != pb.AshoreWhy_ASHORE_WHY_CHOSE || w.GetAboard() != nil || w.GetBoat() == boat {
			t.Fatalf("ashore %v, then %v", b.ashore, w)
		}
		if s, _ := slotOf(srv, bus.Account(bob)); s < 0 {
			t.Fatal("Bob's own boat is not in the water")
		}
		b.holding(true)
	})
}

// TestKnocks: a knock lapses after two minutes; the sixth waiting is
// refused; not now keeps a knocker off the boat for a while; an ended link,
// the own link and a boat closed to knocks refuse; a sailor who has not
// answered the age question cannot knock; a machine sailor's boat takes
// nobody.
func TestKnocks(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{BoatOf: keelboats(t)})
		annToken, ann := srv.Sailor("Ann Bonny")
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		a.keepAlive()
		link := srv.Link(ann, "Ann Bonny")

		var knockers []*viewer
		for i, name := range []string{"Bob", "Cal", "Dee", "Eve", "Fin", "Gus"} {
			tok, _ := srv.Sailor(name + " Read")
			v := dial(t, srv, tok, client.Hello())
			v.welcomed()
			v.keepAlive()
			want := pb.KnockState_KNOCK_STATE_WAITING
			if i == 5 {
				want = pb.KnockState_KNOCK_STATE_BUSY
			}
			if got := v.knock(link); got != want {
				t.Fatalf("knock %d: %v", i, got)
			}
			knockers = append(knockers, v)
			if i >= 2 {
				v.drain()
			}
		}
		if !a.read(5*time.Second, func() bool { return len(a.cards) == 5 }) {
			t.Fatalf("%d cards", len(a.cards))
		}
		// Not now: Bob may not knock again for ten minutes.
		var bobCard uint64
		for id, c := range a.cards {
			if c.GetSailor() == "Bob Read" {
				bobCard = id
			}
		}
		a.command(&pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: bobCard, Let: false}}})
		bob := knockers[0]
		if !bob.read(5*time.Second, func() bool { return bob.knocking.GetState() == pb.KnockState_KNOCK_STATE_NOT_NOW }) {
			t.Fatalf("Bob was told %v", bob.knocking)
		}
		if got := bob.knock(link); got != pb.KnockState_KNOCK_STATE_OFTEN {
			t.Fatalf("Bob again: %v", got)
		}
		bob.drain()
		// The rest lapse after two minutes.
		cal := knockers[1]
		if !cal.read(edge.KnockLapse+5*time.Second, func() bool { return cal.knocking.GetState() == pb.KnockState_KNOCK_STATE_LAPSED }) {
			t.Fatalf("Cal was told %v", cal.knocking)
		}
		if !a.read(5*time.Second, func() bool { return len(a.cards) == 0 }) {
			t.Fatalf("%d cards after the lapse", len(a.cards))
		}

		// The own link, closed to knocks, an ended link.
		if got := a.knock(link); got != pb.KnockState_KNOCK_STATE_OWN {
			t.Fatalf("the own link: %v", got)
		}
		a.command(&pb.Command{Body: &pb.Command_CloseKnocks{CloseKnocks: &pb.CloseKnocks{Closed: true}}})
		time.Sleep(time.Second / 10)
		if got := cal.knock(link); got != pb.KnockState_KNOCK_STATE_CLOSED {
			t.Fatalf("closed to knocks: %v", got)
		}
		a.command(&pb.Command{Body: &pb.Command_CloseKnocks{CloseKnocks: &pb.CloseKnocks{Closed: false}}})
		time.Sleep(time.Second / 10)
		srv.EndLink(link)
		if got := cal.knock(link); got != pb.KnockState_KNOCK_STATE_ENDED {
			t.Fatalf("an ended link: %v", got)
		}
		if got := cal.knock("not-a-token"); got != pb.KnockState_KNOCK_STATE_ENDED {
			t.Fatalf("not a token: %v", got)
		}

		// The age question first.
		youngToken, _ := srv.Sessions.add(store.Account{Kind: store.Human, Name: "Hal Read", Born: -1})
		h := dial(t, srv, youngToken, client.Hello())
		h.welcomed()
		if got := h.knock(srv.Link(ann, "Ann Bonny")); got != pb.KnockState_KNOCK_STATE_FIRST {
			t.Fatalf("unanswered: %v", got)
		}

		// A machine sailor's boat.
		mary, _ := srv.Machine(t, "Iron Mary", ann, near(3))
		if got := cal.knock(srv.Link(mary, "Iron Mary")); got != pb.KnockState_KNOCK_STATE_CLOSED {
			t.Fatalf("a machine sailor's boat: %v", got)
		}
	})
}

// TestTheHolderGoes: the holder's connection ends and the controls are the
// skipper's again the same tick; a crew member who was not handed the
// controls cannot take them; the skipper's boat leaving puts the crew in a
// boat of their own.
func TestTheHolderGoes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{BoatOf: keelboats(t)})
		annToken, ann := srv.Sailor("Ann Bonny")
		bobToken, bob := srv.Sailor("Bob Read")
		calToken, _ := srv.Sailor("Cal Read")
		a := dial(t, srv, annToken, client.Hello())
		wa := a.welcomed()
		link := srv.Link(ann, "Ann Bonny")
		board := func(token string) *viewer {
			v := dial(t, srv, token, client.Hello())
			v.welcomed()
			v.knock(link)
			c := a.card()
			a.command(&pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: c.GetId(), Let: true}}})
			v.welcomed()
			delete(a.cards, c.GetId())
			return v
		}
		b := board(bobToken)
		c := board(calToken)

		// Cal takes nothing offered to nobody, and hands nothing he does not hold.
		c.command(&pb.Command{Body: &pb.Command_Take{Take: &pb.Take{}}})
		c.command(&pb.Command{Body: &pb.Command_Hand{Hand: &pb.Hand{To: 2}}})
		c.command(&pb.Command{Body: &pb.Command_GiveBack{GiveBack: &pb.GiveBack{}}})
		time.Sleep(time.Second)
		a.holding(true)
		c.holding(false)
		// Offered to Bob, Cal cannot take them.
		a.command(&pb.Command{Body: &pb.Command_Hand{Hand: &pb.Hand{To: 1}}})
		b.read(5*time.Second, func() bool { return b.handed != nil })
		c.command(&pb.Command{Body: &pb.Command_Take{Take: &pb.Take{}}})
		time.Sleep(time.Second / 2)
		c.holding(false)
		b.command(&pb.Command{Body: &pb.Command_Take{Take: &pb.Take{}}})
		b.holding(true)
		a.holding(false)

		// Bob's connection ends: the controls are Ann's that tick.
		b.ws.CloseNow()
		a.holding(true)
		f := srv.World.Bus().Frames.Acquire()
		if i := f.Aboard(bus.Account(bob)); i < 0 || f.Crew[i].Grace == 0 {
			t.Errorf("Bob is not aboard in his grace: %+v", f.Crew)
		}
		f.Release()

		// Ann's boat leaves the water: Cal is ashore, in a boat of his own.
		c.ashore = nil
		if err := srv.World.Bus().Commands.Players().TrySend(bus.Command{Op: bus.Leave, Boat: wa.GetBoat()}); err != nil {
			t.Fatal(err)
		}
		w := c.welcomed()
		if c.ashore.GetWhy() != pb.AshoreWhy_ASHORE_WHY_LEFT || w.GetAboard() != nil {
			t.Fatalf("ashore %v, welcomed %v", c.ashore, w)
		}
	})
}
