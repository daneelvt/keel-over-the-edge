// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// crewWorld is a world whose boats carry three people, the skipper
// included.
func crewWorld(t testing.TB, capacity, limit int) *World {
	t.Helper()
	w, err := New(Config{Capacity: capacity, Kinds: kinds(t), Workers: 1, Tick: 100, Limit: limit, Capacities: []int{3}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w
}

// seats lists who is aboard the boat in slot s, by account number, in seat
// order.
func seats(f *bus.Frame, s int32) []byte {
	var out []byte
	lo, hi := f.CrewOf(s)
	for _, a := range f.Crew[lo:hi] {
		out = append(out, a.Account[15])
	}
	return out
}

func TestBoardingAndGoingAshore(t *testing.T) {
	w := crewWorld(t, 8, 0)
	skipper := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 11})
	own := do(t, w, bus.Command{Op: bus.Join, Account: acct(2), Conn: 12})
	if skipper.Result != bus.Joined || own.Result != bus.Joined {
		t.Fatalf("joins: %+v %+v", skipper, own)
	}
	deck := w.Latest().Deck[skipper.Slot]

	// Let aboard: the knocker's own boat leaves the water at once.
	r := do(t, w, bus.Command{Op: bus.Board, Boat: skipper.Boat, Account: acct(2), Conn: 12, Look: 7, Name: "Tom"})
	if r.Result != bus.Crewed || r.Slot != skipper.Slot {
		t.Fatalf("board: %+v", r)
	}
	f := w.Latest()
	if slotOf(f, own.Boat) >= 0 {
		t.Fatal("the knocker's own boat is still in the water")
	}
	if got := seats(f, skipper.Slot); string(got) != "\x02" || f.Crew[0].Seat != 1 || f.Crew[0].Name != "Tom" {
		t.Fatalf("aboard: %v %+v", got, f.Crew)
	}
	if f.Deck[skipper.Slot] == deck {
		t.Fatal("the deck's count did not move")
	}
	gone := false
	for _, e := range f.Events {
		gone = gone || e.Op == bus.Leave && e.Reply.Result == bus.Gone && e.Boat == own.Boat
	}
	if !gone {
		t.Fatalf("no Leave for the knocker's boat: %+v", f.Events)
	}

	// A third aboard fills the boat; a fourth finds no room.
	if r := do(t, w, bus.Command{Op: bus.Board, Boat: skipper.Boat, Account: acct(3), Conn: 13}); r.Result != bus.Crewed {
		t.Fatalf("board a third: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.Board, Boat: skipper.Boat, Account: acct(4), Conn: 14}); r.Result != bus.NoRoom {
		t.Fatalf("board a fourth: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.Board, Boat: skipper.Boat, Account: acct(1), Conn: 11}); r.Result != bus.Stale {
		t.Fatalf("the skipper aboard their own boat: %+v", r)
	}

	// A Join from someone aboard is aboard again.
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(2), Conn: 22}); r.Result != bus.Crewed || r.Boat != skipper.Boat {
		t.Fatalf("join while aboard: %+v", r)
	}

	// Going ashore puts the own boat in the water.
	r = do(t, w, bus.Command{Op: bus.Ashore, Account: acct(3), Boat: skipper.Boat, Why: bus.AshoreChose})
	if r.Result != bus.Joined {
		t.Fatalf("ashore: %+v", r)
	}
	f = w.Latest()
	if f.Owner[r.Slot] != acct(3) || f.Conn[r.Slot] != 13 || string(seats(f, skipper.Slot)) != "\x02" {
		t.Fatalf("ashore: owner %v conn %d aboard %v", f.Owner[r.Slot], f.Conn[r.Slot], seats(f, skipper.Slot))
	}

	// The skipper's boat leaving puts everyone aboard ashore, each in a
	// boat of their own.
	if r := do(t, w, bus.Command{Op: bus.Leave, Boat: skipper.Boat}); r.Result != bus.Left {
		t.Fatalf("leave: %+v", r)
	}
	f = w.Latest()
	if len(f.Crew) != 0 || afloatIn(f, acct(2)) < 0 {
		t.Fatalf("after the boat left: crew %+v, Tom afloat %d", f.Crew, afloatIn(f, acct(2)))
	}
	landed := false
	for _, e := range f.Events {
		landed = landed || e.Op == bus.Ashore && e.Why == bus.AshoreLeft && e.Account == acct(2) && e.Reply.Result == bus.Joined
	}
	if !landed {
		t.Fatalf("no Ashore for Tom: %+v", f.Events)
	}
}

func TestTheControlsChangeHands(t *testing.T) {
	w := crewWorld(t, 8, 0)
	skipper := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 11})
	do(t, w, bus.Command{Op: bus.Board, Boat: skipper.Boat, Account: acct(2), Conn: 12})
	s := skipper.Slot
	f := w.Latest()
	gen, held := f.Gen[s], f.Control[s]

	// To a stranger: nothing moves.
	if r := do(t, w, bus.Command{Op: bus.SetHolder, Boat: skipper.Boat, Account: acct(9)}); r.Result != bus.Stale {
		t.Fatalf("to a stranger: %+v", r)
	}
	r := do(t, w, bus.Command{Op: bus.SetHolder, Boat: skipper.Boat, Account: acct(2)})
	f = w.Latest()
	if r.Result != bus.Done || f.Holder[s] != acct(2) || f.Gen[s] == gen || r.Gen != f.Gen[s] {
		t.Fatalf("handed: %+v holder %v gen %d→%d", r, f.Holder[s], gen, f.Gen[s])
	}
	// The controls in force are kept, stamped for the new generation.
	if c := f.Control[s]; c.HelmIndex() != held.HelmIndex() || c.SheetIndex() != held.SheetIndex() || c.Gen() != f.Gen[s] {
		t.Fatalf("controls %x, were %x", c, held)
	}
	// A word the skipper's writer stores now, of the old generation, is
	// never applied.
	w.Bus().Controls.StoreHand(s, bus.Pack(uint32(f.Tick+1), 0, 0, gen))
	w.Tick()
	if c := w.Latest().Control[s]; c.HelmIndex() != held.HelmIndex() {
		t.Fatalf("the former holder steered: %x", c)
	}
	// The holder's words are.
	g := w.Latest().Gen[s]
	w.Bus().Controls.StoreHand(s, bus.Pack(uint32(w.Now()+1), 0, 0, g))
	w.Tick()
	if c := w.Latest().Control[s]; c.HelmIndex() != 0 {
		t.Fatalf("the holder did not steer: %x", c)
	}

	// The holder's connection ending gives the controls back the same tick.
	if r := do(t, w, bus.Command{Op: bus.Disconnect, Account: acct(2), Conn: 12}); r.Result != bus.Done {
		t.Fatalf("disconnect: %+v", r)
	}
	f = w.Latest()
	if f.Holder[s] != (bus.Account{}) || f.Crew[0].Grace == 0 {
		t.Fatalf("after the holder went: holder %v crew %+v", f.Holder[s], f.Crew)
	}
	// Back within the grace, still aboard; after it, ashore with no boat.
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(2), Conn: 32}); r.Result != bus.Crewed {
		t.Fatalf("back: %+v", r)
	}
	do(t, w, bus.Command{Op: bus.Disconnect, Account: acct(2), Conn: 32})
	w.Skip(w.Grace())
	w.Tick()
	if f := w.Latest(); len(f.Crew) != 0 || afloatIn(f, acct(2)) >= 0 {
		t.Fatalf("after the grace: crew %+v", f.Crew)
	}
}

func TestCrewInTheSnapshot(t *testing.T) {
	w := crewWorld(t, 8, 0)
	skipper := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 11})
	do(t, w, bus.Command{Op: bus.Board, Boat: skipper.Boat, Account: acct(2), Conn: 12, Look: 5, Name: "Tom", BoatLook: 3, BoatName: "Spray"})
	do(t, w, bus.Command{Op: bus.SetHolder, Boat: skipper.Boat, Account: acct(2)})
	f := w.Latest()
	b := AppendSnapshot(nil, f)
	v := crewWorld(t, 8, 0)
	if err := v.Load(b); err != nil {
		t.Fatal(err)
	}
	g := v.Latest()
	if Digest(g) != Digest(f) || len(g.Crew) != 1 || g.Crew[0] != f.Crew[0] || g.Holder[skipper.Slot] != acct(2) {
		t.Fatalf("restored %+v holder %v", g.Crew, g.Holder[skipper.Slot])
	}
	if f.HelmLook(skipper.Slot) != 5 {
		t.Fatalf("the helm's look %d", f.HelmLook(skipper.Slot))
	}
}
