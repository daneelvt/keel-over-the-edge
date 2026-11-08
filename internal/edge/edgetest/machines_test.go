// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
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
