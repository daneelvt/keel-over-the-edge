// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// TestCrewsInSight: Bob sails near Ann's keelboat. As two come aboard her
// (one a machine sailor), he is told who is aboard her, by her view slot:
// seats, looks and machine marks, and never a name or anything of his own;
// again when she hands the controls over, and when one goes ashore; with
// nobody once he is out of her near band, and her crew again as he comes
// back; with nobody when the last goes ashore. Ann, aboard her own boat,
// is told her crew with their names, as before.
func TestCrewsInSight(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{BoatOf: keelboats(t)})
		annToken, _ := srv.Sailor("Ann Bonny")
		bobToken, _ := srv.Sailor("Bob Read")
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		srv.Place(a.welcome.GetBoat(), physics.State{X: 50, Y: 20, Heading: 1})
		b := dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		srv.Place(b.welcome.GetBoat(), physics.State{X: 90, Y: 20, Heading: 1})
		annSlot := func() int {
			for slot := range protocol.ViewSlots {
				if b.view.Has(slot) {
					return slot
				}
			}
			return -1
		}
		if !b.read(3*time.Second, func() bool { return annSlot() >= 0 && !b.view.Boats[annSlot()].Far() }) {
			t.Fatal("Bob does not see Ann's boat near")
		}
		if len(b.crews) != 0 {
			t.Fatalf("a crew told for a boat with only its skipper aboard: %v", b.crews)
		}
		boat := a.welcome.GetBoat()
		dev := srv.World.Bus().Commands.Developer()
		send := func(c bus.Command) {
			t.Helper()
			if err := dev.TrySend(c); err != nil {
				t.Fatal(err)
			}
		}
		var cyd, dot bus.Account
		cyd[15], dot[15] = 0xc1, 0xd1
		send(bus.Command{Op: bus.Board, Boat: boat, Account: cyd, Conn: 9001, Name: "Cyd", Look: 7})
		send(bus.Command{Op: bus.Board, Boat: boat, Account: dot, Conn: 9002, Name: "Dot", Look: 9, Machine: true})

		// Everyone a person may be told of someone not aboard: no name, nothing of the connection's.
		private := func(c *pb.Crew) {
			t.Helper()
			for _, p := range c.GetPeople() {
				if p.GetName() != "" || p.GetYou() || p.GetMuted() || p.GetBlocked() || p.GetShipmate() {
					t.Fatalf("someone not aboard was told %v", p)
				}
			}
		}
		crewOf := func(n int, holder uint32) func() bool {
			return func() bool {
				c := b.crews[uint32(annSlot())]
				return c != nil && len(c.GetPeople()) == n && c.GetHolder() == holder
			}
		}
		if !b.read(3*time.Second, crewOf(3, 0)) {
			t.Fatalf("Bob was not told Ann's crew: %v", b.crews)
		}
		c := b.crews[uint32(annSlot())]
		private(c)
		p := c.GetPeople()
		if p[0].GetSeat() != 0 || p[1].GetSeat() != 1 || p[2].GetSeat() != 2 || p[1].GetLook() != 7 || p[2].GetLook() != 9 ||
			p[1].GetMachine() || !p[2].GetMachine() || p[0].GetLook() != b.view.Boats[annSlot()].Look {
			t.Fatalf("Ann's crew as Bob is told it: %v", c)
		}
		// Ann, aboard, is told hers with their names.
		if !a.read(3*time.Second, func() bool { return a.crew != nil && len(a.crew.GetPeople()) == 3 }) ||
			a.crew.GetPeople()[1].GetName() != "Cyd" || a.crew.GetPeople()[2].GetName() != "Dot" {
			t.Fatalf("Ann's own crew: %v", a.crew)
		}
		told := len(b.allCrews)

		// The controls handed to Cyd: told again, the holder in it.
		send(bus.Command{Op: bus.SetHolder, Boat: boat, Account: cyd})
		if !b.read(3*time.Second, crewOf(3, 1)) {
			t.Fatalf("Bob was not told the controls changed hands: %v", b.crews)
		}
		// Nothing more while nothing changes.
		b.read(time.Second, nil)
		if n := len(b.allCrews); n != told+1 {
			t.Fatalf("%d crews told for one change", n-told)
		}

		// Dot goes ashore.
		send(bus.Command{Op: bus.Ashore, Account: dot, Why: bus.AshoreChose})
		if !b.read(3*time.Second, crewOf(2, 1)) {
			t.Fatalf("Bob was not told one went ashore: %v", b.crews)
		}
		private(b.crews[uint32(annSlot())])

		// Out of her near band and back.
		srv.Place(b.welcome.GetBoat(), physics.State{X: 550, Y: 20, Heading: 1})
		if !b.read(5*time.Second, func() bool { return annSlot() >= 0 && b.view.Boats[annSlot()].Far() && len(b.crews) == 0 }) {
			t.Fatalf("Bob still holds the crew of a boat in his far band: %v", b.crews)
		}
		srv.Place(b.welcome.GetBoat(), physics.State{X: 90, Y: 20, Heading: 1})
		if !b.read(5*time.Second, crewOf(2, 1)) {
			t.Fatalf("Bob was not told the crew again as Ann's boat came near: %v", b.crews)
		}

		// The last goes ashore: nobody.
		send(bus.Command{Op: bus.Ashore, Account: cyd, Why: bus.AshoreChose})
		if !b.read(3*time.Second, func() bool { return len(b.crews) == 0 }) {
			t.Fatalf("Bob still holds a crew with only the skipper aboard: %v", b.crews)
		}
		for _, c := range b.allCrews {
			private(c)
		}
	})
}
