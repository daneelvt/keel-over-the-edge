// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// TestBoatChanged: a sailor takes their fleet's boat to sea, its look and
// name in their Welcome; another sailor sees it in its look and is told its
// name once it is near. Given a new look in port, its sailor is told, and
// the other sees it enter again; swapped for a boat of another kind, its
// sailor is welcomed again to the new boat, which the other sees.
func TestBoatChanged(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var ann store.AccountID
		first := edge.Boat{Kind: 0, Look: 12<<8 | 1, Name: "Saltpeter"}
		srv := NewServer(t, Config{Capacity: 8, Terrain: &sim.Terrain{Ports: []sim.Disc{{X: 0, Y: 0, R: 300}}},
			BoatOf: func(_ context.Context, a store.Account) edge.Boat {
				if a.ID == ann {
					return first
				}
				return edge.Boat{}
			}})
		annToken, id := srv.Sailor("Ann")
		ann = id
		bobToken, _ := srv.Sailor("Bob")
		sailor := dial(t, srv, annToken, client.Hello())
		if w := sailor.welcomed(); w.GetBoatLook() != first.Look || w.GetBoatName() != first.Name || w.GetKind() != 0 {
			t.Fatalf("Ann's Welcome: %v", w)
		}
		srv.Place(sailor.welcome.GetBoat(), physics.State{X: 50, Y: 20, Heading: 1})
		other := dial(t, srv, bobToken, client.Hello())
		other.welcomed()
		srv.Place(other.welcome.GetBoat(), physics.State{X: 80, Y: 20, Heading: 1})
		annIn := func() (uint32, protocol.Boat) {
			for slot := range protocol.ViewSlots {
				if other.view.Has(slot) {
					return uint32(slot), other.view.Boats[slot]
				}
			}
			return 0, protocol.Boat{BoatLook: 1 << 30}
		}
		seen := func(look uint32, name string, kind uint16) func() bool {
			return func() bool {
				slot, b := annIn()
				return b.BoatLook == look && b.Kind == kind && other.names[slot] == name
			}
		}
		if !other.read(2*time.Second, seen(first.Look, first.Name, 0)) {
			slot, b := annIn()
			t.Fatalf("Bob sees Ann's boat %+v named %q", b, other.names[slot])
		}

		// A new look in port.
		send := func(c bus.Command) {
			t.Helper()
			c.Account = bus.Account(ann)
			if err := srv.World.Bus().Commands.Players().TrySend(c); err != nil {
				t.Fatal(err)
			}
		}
		send(bus.Command{Op: bus.SetBoatLook, BoatLook: 311<<8 | 0x23, BoatName: "Kittiwake"})
		sailor.read(2*time.Second, func() bool { return len(sailor.boatLooks) > 0 })
		if len(sailor.boatLooks) != 1 || sailor.boatLooks[0].GetLook() != 311<<8|0x23 || sailor.boatLooks[0].GetName() != "Kittiwake" {
			t.Fatalf("Ann told %v", sailor.boatLooks)
		}
		if !other.read(2*time.Second, seen(311<<8|0x23, "Kittiwake", 0)) {
			slot, b := annIn()
			t.Fatalf("Bob sees Ann's boat %+v named %q after the change", b, other.names[slot])
		}

		// A swap for a keelboat.
		send(bus.Command{Op: bus.SetBoat, BoatKind: 1, BoatLook: 7 << 8, BoatName: ""})
		sailor.read(2*time.Second, func() bool { return sailor.welcomes > 1 })
		if w := sailor.welcome; sailor.welcomes != 2 || w.GetKind() != 1 || w.GetBoatLook() != 7<<8 || w.GetBoatName() != "" || !w.GetRejoined() {
			t.Fatalf("Ann's Welcome after the swap (%d): %v", sailor.welcomes, w)
		}
		if !other.read(2*time.Second, seen(7<<8, "", 1)) {
			slot, b := annIn()
			t.Fatalf("Bob sees Ann's boat %+v named %q after the swap", b, other.names[slot])
		}
		// Her snapshots go on, of the keelboat.
		n := sailor.snaps
		sailor.read(time.Second, func() bool { return sailor.snaps > n+3 })
		if sailor.snaps <= n+3 {
			t.Fatalf("Ann has %d snapshots after the swap", sailor.snaps-n)
		}
	})
}
