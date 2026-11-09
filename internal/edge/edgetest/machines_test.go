// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chat"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// keelboat is the catalog's kind that carries five.
func keelboat(t *testing.T) uint16 {
	t.Helper()
	return keelboats(t)(context.Background(), store.Account{}).Kind
}

// comeAboard asks to come aboard the machine sailor watched, and reads
// until it is told how that stands.
func (v *viewer) comeAboard() pb.KnockState {
	v.t.Helper()
	v.knocking = nil
	v.command(&pb.Command{Body: &pb.Command_ComeAboard{ComeAboard: &pb.ComeAboard{}}})
	if !v.read(5*time.Second, func() bool { return v.knocking != nil }) {
		v.t.Fatal("no Knocking")
	}
	return v.knocking.GetState()
}

// TestTheOwnerComesAboard: Ann, watching her machine sailor, comes aboard
// its keelboat without knocking, as crew; Bob, watching it too, may not;
// a machine sailor's Jolly boat has no room for anyone.
func TestTheOwnerComesAboard(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{BoatOf: keelboats(t)})
		annToken, ann := srv.Sailor("Ann Bonny")
		bobToken, _ := srv.Sailor("Bob Read")
		mary, boat := srv.MachineKind(t, "Iron Mary", ann, keelboat(t), near(0))
		srv.Machine(t, "Tin Tom", ann, near(2))

		b := dial(t, srv, bobToken, client.HelloWatch("Iron Mary"))
		b.welcomed()
		if got := b.comeAboard(); got != pb.KnockState_KNOCK_STATE_CLOSED {
			t.Fatalf("Bob comes aboard another's machine sailor: %v", got)
		}
		if s, _ := slotOf(srv, bus.Account(mary)); s < 0 {
			t.Fatal("Iron Mary's boat left the water")
		}

		a := dial(t, srv, annToken, client.HelloWatch("Tin Tom"))
		a.welcomed()
		if got := a.comeAboard(); got != pb.KnockState_KNOCK_STATE_FULL {
			t.Fatalf("aboard a Jolly boat: %v", got)
		}
		time.Sleep(time.Second)
		a.send(client.Watch("Iron Mary"))
		if w := a.welcomed(); w.GetWatching().GetSailor() != "Iron Mary" || !w.GetWatching().GetMine() {
			t.Fatalf("the watch: %v", w)
		}
		if got := a.comeAboard(); got != pb.KnockState_KNOCK_STATE_LET {
			t.Fatalf("Ann comes aboard her own: %v", got)
		}
		w := a.welcomed()
		if w.GetAboard().GetSkipper() != "Iron Mary" || w.GetBoat() != boat || w.GetAboard().GetSeat() != 1 || w.GetWatching() != nil {
			t.Fatalf("the Welcome aboard: %v", w)
		}
		if !a.read(5*time.Second, func() bool { return a.crew != nil && len(a.crew.GetPeople()) == 2 }) {
			t.Fatal("Ann was not told who is aboard")
		}
		if p := a.crew.GetPeople(); !p[0].GetMachine() || !p[1].GetYou() || a.crew.GetHolder() != 0 {
			t.Fatalf("Ann's crew: %v", a.crew)
		}
		// Bob, watching, sees her on deck.
		if !b.read(5*time.Second, func() bool { return b.crew != nil && len(b.crew.GetPeople()) == 2 }) {
			t.Fatal("the spectator was not shown the crew")
		}
		if p := b.crew.GetPeople(); p[1].GetName() != "" {
			t.Fatalf("a spectator told a name aboard: %v", b.crew)
		}
	})
}

// helms stand in for the machine sailors' helms: each machine sailor
// sent aboard comes aboard through a connection of its own, and the
// controls offered each are kept.
type helms struct {
	srv    *Server
	names  map[bus.Account]string
	mu     sync.Mutex
	handed map[bus.Account][]string
}

func newHelms() *helms {
	return &helms{names: map[bus.Account]string{}, handed: map[bus.Account][]string{}}
}

func (h *helms) Board(ctx context.Context, m bus.Account, boat uint64) (bus.Reply, error) {
	reply := make(chan bus.Reply, 1)
	players := h.srv.World.Bus().Commands.Players()
	cmd := bus.Command{Op: bus.Board, Boat: boat, Account: m, Conn: 1<<62 | uint64(m[15]), Machine: true, Name: h.names[m], Reply: reply}
	for players.TrySend(cmd) != nil {
		time.Sleep(time.Second / 30)
	}
	select {
	case r := <-reply:
		return r, nil
	case <-ctx.Done():
		return bus.Reply{}, ctx.Err()
	}
}

func (h *helms) Handed(m bus.Account, from string, gone bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if gone {
		from = "gone"
	}
	h.handed[m] = append(h.handed[m], from)
}

// machinesWorld is a server whose machine sailors are sent aboard through
// helms, with chat aboard: every sailor an adult who has accepted the
// Rules, a machine sailor speaking with Ann's facts.
func machinesWorld(t *testing.T) (*Server, *helms) {
	t.Helper()
	h := newHelms()
	srv := NewServer(t, Config{BoatOf: keelboats(t), Machines: h,
		Chat: func(f *bus.Frames) *chat.Hub {
			return chat.NewHub(f, aboard.Rules{Ties: aboard.NewTies(nil, nil)}, time.Now)
		},
		Talker: func(_ context.Context, a bus.Account) (aboard.Speaker, string, error) {
			return aboard.Speaker{Account: a, Human: a, Band: aboard.Adult, Rules: true}, "", nil
		},
	})
	h.srv = srv
	return srv, h
}

// machineKnock sends the machine sailor named machine aboard by a link's
// token, and reads until the knock's state is told.
func (v *viewer) machineKnock(token, machine string) pb.KnockState {
	v.t.Helper()
	v.knocking = nil
	v.command(&pb.Command{Body: &pb.Command_Knock{Knock: &pb.Knock{Token: token, Machine: machine}}})
	if !v.read(5*time.Second, func() bool { return v.knocking != nil }) {
		v.t.Fatal("no Knocking")
	}
	return v.knocking.GetState()
}

// TestMachineSailorsBoard: Ann makes Iron Mary's link; Bob, watching his
// Rover, sends it aboard. Neither Bob himself nor Rover aboard a person's
// boat may come. Ann, sailing her own boat, is shown the knock with the
// machine mark and its owner's name, and lets Rover aboard: its own boat
// leaves the water, and Bob's watch follows it aboard, where he reads the
// chat aboard; Carl, watching Iron Mary, sees the crew on deck and reads
// the machine sailors' chat too. Ann puts Rover ashore from watching Iron Mary: its boat is in the
// water again, and Bob's watch with it.
func TestMachineSailorsBoard(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv, helms := machinesWorld(t)
		annToken, ann := srv.Sailor("Ann Bonny")
		bobToken, bob := srv.Sailor("Bob Read")
		carlToken, _ := srv.Sailor("Carl Vane")
		mary, maryBoat := srv.MachineKind(t, "Iron Mary", ann, keelboat(t), near(0))
		rover, roverBoat := srv.MachineKind(t, "Rover", bob, keelboat(t), near(2))
		helms.names[bus.Account(rover)] = "Rover"
		hub := srv.Chat
		hub.Join(aboard.Speaker{Account: bus.Account(mary), Human: bus.Account(ann), Machine: true, Band: aboard.Adult, Rules: true}, "Iron Mary")
		hub.Join(aboard.Speaker{Account: bus.Account(rover), Human: bus.Account(bob), Machine: true, Band: aboard.Adult, Rules: true}, "Rover")

		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		a.keepAlive()
		b := dial(t, srv, bobToken, client.HelloWatch("Rover"))
		b.welcomed()
		b.keepAlive()
		c := dial(t, srv, carlToken, client.HelloWatch("Iron Mary"))
		c.welcomed()
		c.keepAlive()

		link := srv.MachineLink(mary, ann, "Iron Mary")
		if got := b.knock(link); got != pb.KnockState_KNOCK_STATE_CLOSED {
			t.Fatalf("Bob knocks on a machine sailor's boat himself: %v", got)
		}
		human := srv.Link(ann, "Ann Bonny")
		if got := b.machineKnock(human, "Rover"); got != pb.KnockState_KNOCK_STATE_CLOSED {
			t.Fatalf("Rover sent aboard a person's boat: %v", got)
		}
		if got := b.machineKnock(link, "Iron Mary"); got != pb.KnockState_KNOCK_STATE_CLOSED {
			t.Fatalf("Bob sends another's machine sailor: %v", got)
		}
		if got := b.machineKnock(link, "Rover"); got != pb.KnockState_KNOCK_STATE_WAITING || b.knocking.GetMachine() != "Rover" {
			t.Fatalf("Rover's knock: %v", b.knocking)
		}
		card := a.card()
		if !card.GetMachine() || card.GetSailor() != "Rover" || card.GetOwner() != "Bob Read" || card.GetSkipper() != "Iron Mary" {
			t.Fatalf("the card: %v", card)
		}
		a.command(&pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: card.GetId(), Let: true}}})
		if !b.read(5*time.Second, func() bool { return b.knocking.GetState() == pb.KnockState_KNOCK_STATE_LET }) {
			t.Fatalf("Rover let aboard: %v", b.knocking)
		}
		time.Sleep(time.Second / 10)
		if s, _ := slotOf(srv, bus.Account(rover)); s >= 0 {
			t.Fatal("Rover's own boat is still in the water")
		}
		// Bob's watch follows Rover aboard.
		w := b.welcomed()
		if w.GetBoat() != maryBoat || w.GetWatching().GetSailor() != "Rover" || !w.GetWatching().GetMine() {
			t.Fatalf("Bob's watch aboard: %v", w)
		}
		if !c.read(5*time.Second, func() bool { return c.crew != nil && len(c.crew.GetPeople()) == 2 }) {
			t.Fatal("Carl was not shown the crew")
		}
		if p := c.crew.GetPeople(); !p[1].GetMachine() || p[1].GetName() != "" {
			t.Fatalf("Carl's crew: %v", c.crew)
		}

		// The chat aboard, with only machine sailors aboard: Bob reads it,
		// and so does Carl, who owns neither.
		if s := hub.Say(bus.Account(mary), "Welcome aboard, Rover"); s.Refused != 0 || s.Heard != 1 {
			t.Fatalf("Iron Mary's line: %+v", s)
		}
		for _, v := range []*viewer{b, c} {
			if !v.read(5*time.Second, func() bool { return len(v.lines) > 0 }) || v.lines[0].GetText() != "Welcome aboard, Rover" || !v.lines[0].GetMachine() {
				t.Fatalf("what a spectator read: %v", v.lines)
			}
		}

		// Ann, watching Iron Mary, puts Rover ashore.
		time.Sleep(time.Second)
		a.send(client.Watch("Iron Mary"))
		a.welcomed()
		if !a.read(5*time.Second, func() bool { return a.crew != nil && len(a.crew.GetPeople()) == 2 }) {
			t.Fatal("Ann, watching, was not shown the crew")
		}
		if n := a.crew.GetPeople()[1].GetName(); n != "Rover" {
			t.Fatalf("Ann, watching her own, is told the names aboard: %q", n)
		}
		a.command(&pb.Command{Body: &pb.Command_Ashore{Ashore: &pb.GoAshore{Who: 1}}})
		w = b.welcomed()
		if w.GetBoat() == maryBoat || w.GetWatching().GetSailor() != "Rover" {
			t.Fatalf("Bob's watch ashore: %v", w)
		}
		time.Sleep(time.Second / 10)
		if s, _ := slotOf(srv, bus.Account(rover)); s < 0 {
			t.Fatal("Rover's own boat is not in the water")
		}
		_ = roverBoat
		// Put ashore, it knocks in vain this voyage.
		time.Sleep(time.Second)
		if got := b.machineKnock(link, "Rover"); got != pb.KnockState_KNOCK_STATE_CLOSED {
			t.Fatalf("Rover knocks again after being put ashore: %v", got)
		}
		_ = bob
	})
}

// TestAMachinesKnockLapses: with the skipper machine sailor's owner not in
// the game, nobody can let Rover aboard: its knock lapses.
func TestAMachinesKnockLapses(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv, _ := machinesWorld(t)
		_, ann := srv.Sailor("Ann Bonny")
		bobToken, bob := srv.Sailor("Bob Read")
		mary, _ := srv.MachineKind(t, "Iron Mary", ann, keelboat(t), near(0))
		srv.MachineKind(t, "Rover", bob, keelboat(t), near(2))
		b := dial(t, srv, bobToken, client.HelloWatch("Rover"))
		b.welcomed()
		b.keepAlive()
		link := srv.MachineLink(mary, ann, "Iron Mary")
		if got := b.machineKnock(link, "Rover"); got != pb.KnockState_KNOCK_STATE_WAITING {
			t.Fatalf("the knock: %v", got)
		}
		if !b.read(edge.KnockLapse+5*time.Second, func() bool { return b.knocking.GetState() != pb.KnockState_KNOCK_STATE_WAITING }) {
			t.Fatal("the knock did not lapse")
		}
		if got := b.knocking.GetState(); got != pb.KnockState_KNOCK_STATE_LAPSED {
			t.Fatalf("the knock: %v", got)
		}
	})
}

// TestPeopleAndMachineSailorsMix: people and machine sailors mix aboard
// only as one owner with their own. Bob's Rover is let aboard Ann's Iron
// Mary, and both owners and Carl, watching, read the machine sailors'
// chat; with
// Rover aboard, Ann may not come aboard herself. Rover put ashore, Ann
// comes aboard: then Bob's Gull is refused, as not taking crew, while
// Ann's own Pearl is let aboard; and from then on no spectator reads a
// word of the chat aboard, while Ann, aboard, does.
func TestPeopleAndMachineSailorsMix(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv, helms := machinesWorld(t)
		annToken, ann := srv.Sailor("Ann Bonny")
		bobToken, bob := srv.Sailor("Bob Read")
		carlToken, _ := srv.Sailor("Carl Vane")
		mary, maryBoat := srv.MachineKind(t, "Iron Mary", ann, keelboat(t), near(0))
		rover, _ := srv.MachineKind(t, "Rover", bob, keelboat(t), near(2))
		gull, _ := srv.MachineKind(t, "Gull", bob, keelboat(t), near(4))
		pearl, _ := srv.MachineKind(t, "Pearl", ann, keelboat(t), near(6))
		hub := srv.Chat
		for _, m := range []struct {
			id    store.AccountID
			owner store.AccountID
			name  string
		}{{mary, ann, "Iron Mary"}, {rover, bob, "Rover"}, {gull, bob, "Gull"}, {pearl, ann, "Pearl"}} {
			helms.names[bus.Account(m.id)] = m.name
			hub.Join(aboard.Speaker{Account: bus.Account(m.id), Human: bus.Account(m.owner), Machine: true, Band: aboard.Adult, Rules: true}, m.name)
		}

		a := dial(t, srv, annToken, client.HelloWatch("Iron Mary"))
		a.welcomed()
		a.keepAlive()
		b := dial(t, srv, bobToken, client.HelloWatch("Rover"))
		b.welcomed()
		b.keepAlive()
		c := dial(t, srv, carlToken, client.HelloWatch("Iron Mary"))
		c.welcomed()
		c.keepAlive()
		link := srv.MachineLink(mary, ann, "Iron Mary")
		if got := b.machineKnock(link, "Rover"); got != pb.KnockState_KNOCK_STATE_WAITING {
			t.Fatalf("Rover's knock: %v", b.knocking)
		}
		card := a.card()
		a.command(&pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: card.GetId(), Let: true}}})
		if w := b.welcomed(); w.GetBoat() != maryBoat {
			t.Fatalf("Bob's watch aboard: %v", w)
		}
		// Machine sailors alone aboard: every spectator reads.
		hub.Say(bus.Account(mary), "Welcome aboard, Rover")
		for _, v := range []*viewer{a, b, c} {
			if !v.read(5*time.Second, func() bool { return len(v.lines) == 1 }) {
				t.Fatalf("a spectator did not read the machine sailors' chat: %v", v.lines)
			}
		}
		// Another owner's machine sailor aboard: Ann may not come aboard.
		time.Sleep(time.Second)
		if got := a.comeAboard(); got != pb.KnockState_KNOCK_STATE_CLOSED {
			t.Fatalf("Ann coming aboard with Bob's Rover aboard: %v", got)
		}
		// Rover put ashore, she comes aboard.
		a.command(&pb.Command{Body: &pb.Command_Ashore{Ashore: &pb.GoAshore{Who: 1}}})
		b.welcomed()
		time.Sleep(time.Second)
		if got := a.comeAboard(); got != pb.KnockState_KNOCK_STATE_LET {
			t.Fatalf("Ann coming aboard her own machine sailor's boat: %v", got)
		}
		a.welcomed()
		time.Sleep(time.Second)
		// With Ann aboard, Bob's Gull is refused; her own Pearl is let aboard.
		b.send(client.Watch("Gull"))
		b.welcomed()
		time.Sleep(time.Second)
		if got := b.machineKnock(link, "Gull"); got != pb.KnockState_KNOCK_STATE_CLOSED {
			t.Fatalf("Bob's Gull with Ann aboard: %v", got)
		}
		if len(a.cards) != 0 {
			t.Fatalf("Ann was shown a card she could not accept: %v", a.cards)
		}
		if got := a.machineKnock(link, "Pearl"); got != pb.KnockState_KNOCK_STATE_WAITING {
			t.Fatalf("Ann's Pearl: %v", a.knocking)
		}
		card = a.card()
		a.command(&pb.Command{Body: &pb.Command_Answer{Answer: &pb.Answer{Knock: card.GetId(), Let: true}}})
		if !a.read(5*time.Second, func() bool { return a.crew != nil && len(a.crew.GetPeople()) == 3 }) {
			t.Fatalf("Pearl not aboard: %v", a.crew)
		}
		// With a person aboard, no spectator reads the chat.
		before := len(c.lines)
		if s := hub.Say(bus.Account(mary), "Ann is aboard now"); s.Refused != 0 || s.Heard != 2 {
			t.Fatalf("Iron Mary's line with Ann aboard: %+v", s)
		}
		if !a.read(5*time.Second, func() bool { return len(a.lines) >= 2 }) {
			t.Fatalf("Ann, aboard, did not hear: %v", a.lines)
		}
		c.read(2*time.Second, nil)
		if len(c.lines) != before || before != 1 {
			t.Fatalf("a spectator read the chat aboard: %v", c.lines)
		}
	})
}
