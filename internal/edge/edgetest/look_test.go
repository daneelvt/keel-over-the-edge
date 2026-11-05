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
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// TestLookChanged: a boat is sailed in its sailor's look, as the Welcome
// tells its sailor and the view tells another; changed in Port Royal's
// harbour, its sailor and its spectator are told, and the other sailor's
// view has the boat enter again in the new look.
func TestLookChanged(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		harbour := &physics.Harbour{X: 0, Y: 0, Radius: 300, MouthX: 600, MouthY: 0, Narrows: 100}
		srv := NewServer(t, Config{Capacity: 8, Terrain: &sim.Terrain{Harbour: harbour}})
		first := store.Look{Look: "cavalier", Version: "male", Skin: "tone-3", Hair: "black", Colour: "madder-red"}
		then := store.Look{Look: "oldsalt", Version: "female", Skin: "tone-5", Hair: "silver", Colour: "indigo-navy"}
		annToken, ann := srv.SailorAs("Ann", first)
		bobToken, _ := srv.SailorAs("Bob", then)
		catToken, _ := srv.Sailor("Cat")
		srv.Edge.SetVoyage(bus.Account(ann), true)
		sailor := dial(t, srv, annToken, client.Hello())
		if got := sailor.welcomed().GetLook(); got != Book.Code(first) {
			t.Fatalf("Ann's Welcome: look %#x, want %#x", got, Book.Code(first))
		}
		srv.Place(sailor.welcome.GetBoat(), physics.State{X: 50, Y: 20, Heading: 1})
		other := dial(t, srv, bobToken, client.Hello())
		other.welcomed()
		srv.Place(other.welcome.GetBoat(), physics.State{X: 400, Y: 300, Heading: 1})
		spectator := dial(t, srv, catToken, client.HelloWatch("Ann"))
		if w := spectator.welcomed(); w.GetLook() != Book.Code(first) || w.GetWatching().GetLook() != Book.Code(first) {
			t.Fatalf("the spectator's Welcome: %v", w)
		}
		annSeen := func() uint32 {
			for slot := range protocol.ViewSlots {
				if other.view.Has(slot) && other.view.Boats[slot].X < 20_000 {
					return other.view.Boats[slot].Look
				}
			}
			return 1 << 30
		}
		other.read(2*time.Second, func() bool { return annSeen() == Book.Code(first) })
		if annSeen() != Book.Code(first) {
			t.Fatalf("Bob sees Ann's look %#x", annSeen())
		}
		if err := srv.World.Bus().Commands.Players().TrySend(bus.Command{Op: bus.SetLook, Account: bus.Account(ann), Look: Book.Code(then)}); err != nil {
			t.Fatal(err)
		}
		for _, v := range []*viewer{sailor, spectator} {
			v.read(2*time.Second, func() bool { return len(v.looks) > 0 })
			if len(v.looks) != 1 || v.looks[0] != Book.Code(then) {
				t.Fatalf("told %#x", v.looks)
			}
		}
		other.read(2*time.Second, func() bool { return annSeen() == Book.Code(then) })
		if annSeen() != Book.Code(then) {
			t.Fatalf("Bob sees Ann's look %#x after the change", annSeen())
		}
	})
}
