// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/fleet"
	"github.com/daneelvt/keel-over-the-edge/internal/fleet/fleettest"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// TestFleet: a machine sailor lists its owner's fleet, takes the keelboat
// to sea, is refused a new look at sea out of port, and ashore paints its
// boat and names it; a name refused is told why. Then it takes the tall
// ship to sea and braces her yards with trim: its boom is their angle off
// the centreline, from braced up sharp to square.
func TestFleet(t *testing.T) {
	h := newHarness(t, 8, 12, 90)
	mary := sailor(1, "Iron Mary")
	ann := store.AccountID{0x02}
	keel, ship := 0, 0
	for i := range h.sea.Boats {
		sq := &h.sea.Boats[i].Physics.Square
		switch {
		case h.sea.Boats[i].Fleet != catalog.FleetAccount:
		case sq.SquareForeArea+sq.SquareAfterArea > 0:
			ship = i
		case keel == 0:
			keel = i
		}
	}
	if ship == keel {
		t.Fatal("one boat for the account")
	}
	ms := &fleettest.Store{
		Owners: map[store.AccountID]store.AccountID{ann: ann, store.AccountID(mary.Account): ann},
		Names:  map[store.AccountID]string{ann: "Ann Bonny", store.AccountID(mary.Account): "Iron Mary"},
		Fleet: []store.Boat{
			{ID: store.BoatID{1}, Kind: string(h.sea.Boats[0].ID), BoatLook: store.BoatLook{Number: 1}, Held: true, Sailor: ann},
			{ID: store.BoatID{2}, Kind: string(h.sea.Boats[0].ID), BoatLook: store.BoatLook{Number: 2}},
			{ID: store.BoatID{3}, Kind: string(h.sea.Boats[keel].ID), BoatLook: store.BoatLook{Number: 7, Name: "Saltpeter"}},
			{ID: store.BoatID{4}, Kind: string(h.sea.Boats[ship].ID), BoatLook: store.BoatLook{Number: 1, Name: "Resolution"}},
		},
	}
	h.sea.Fleet = fleet.New(fleet.Config{Store: ms, Catalog: h.sea.Catalog, World: h.w.Bus, Log: slog.New(slog.DiscardHandler)})

	text, refused := h.call(t, mary, toolBoat, map[string]any{})
	for _, want := range []string{"Jolly boat 1, available\n", "Jolly boat 2, available (white lead, bleached canvas sails), the boat you take to sea", "Keelboat «Saltpeter» 7, available",
		"Tall ship «Resolution» 1, available\n"} {
		if refused || !strings.Contains(text, want) {
			t.Fatalf("the list lacks %q: %s", want, text)
		}
	}
	text, refused = h.call(t, mary, toolBoat, map[string]any{"action": "take", "boat": "keelboat"})
	if refused || !strings.Contains(text, "Your boat is Keelboat «Saltpeter» 7.") || !strings.Contains(text, "At sea") {
		t.Fatalf("take: %s", text)
	}
	f := h.w.Bus().Frames.Acquire()
	kinds := map[bus.Account]uint16{}
	for _, s := range f.Live {
		kinds[f.Owner[s]] = f.Kind[s]
	}
	f.Release()
	if kinds[bus.Account(mary.Account)] != uint16(keel) {
		t.Fatalf("Mary sails a boat of kind %d", kinds[bus.Account(mary.Account)])
	}
	text, refused = h.call(t, mary, toolBoat, map[string]any{"action": "look", "paint": "Red ochre"})
	if !refused || !strings.Contains(text, "Only in port") {
		t.Fatalf("a look at sea: %v %s", refused, text)
	}
	if text, refused = h.call(t, mary, toolBoat, map[string]any{"action": "leave"}); refused {
		t.Fatalf("leave: %s", text)
	}
	text, refused = h.call(t, mary, toolBoat, map[string]any{"paint": "red ochre", "cloth": "tanbark", "name": "Kittiwake", "number": 12})
	if refused || !strings.Contains(text, "Keelboat «Kittiwake» 12, red ochre, tanbark sails") {
		t.Fatalf("a look ashore: %s", text)
	}
	// The orders' budget rests a moment.
	time.Sleep(1500 * time.Millisecond)
	text, refused = h.call(t, mary, toolBoat, map[string]any{"action": "look", "name": "K"})
	if !refused || !strings.Contains(text, "too short") {
		t.Fatalf("a short name: %s", text)
	}
	text, refused = h.call(t, mary, toolBoat, map[string]any{"action": "look", "paint": "puce"})
	if !refused || !strings.Contains(text, "No paint called") {
		t.Fatalf("no such paint: %s", text)
	}
	text, _ = h.call(t, mary, toolBoat, map[string]any{"action": "look"})
	if !strings.Contains(text, "Paints: white lead, bright varnish") || !strings.Contains(text, "Cloths: bleached canvas") {
		t.Fatalf("the choices: %s", text)
	}

	// The tall ship: taken ashore, she goes to sea, and trim braces her
	// yards.
	time.Sleep(1500 * time.Millisecond)
	text, refused = h.call(t, mary, toolBoat, map[string]any{"action": "take", "boat": "tall ship"})
	if refused || !strings.Contains(text, "Your boat is Tall ship «Resolution» 1.") {
		t.Fatalf("take her: %s", text)
	}
	f = h.w.Bus().Frames.Acquire()
	for _, s := range f.Live {
		kinds[f.Owner[s]] = f.Kind[s]
	}
	f.Release()
	if kinds[bus.Account(mary.Account)] != uint16(ship) {
		t.Fatalf("Mary sails a boat of kind %d", kinds[bus.Account(mary.Account)])
	}
	sharp := int(h.sea.Boats[ship].Physics.Square.BraceSharp)
	for _, c := range []struct {
		boom int
		want string
	}{{60, "yards 60°"}, {sharp - 10, "yards braced sharp"}, {95, "yards square"}} {
		time.Sleep(1500 * time.Millisecond)
		text, refused = h.call(t, mary, toolTrim, map[string]any{"boom": c.boom})
		if refused || !strings.Contains(text, c.want) {
			t.Fatalf("trim %d: %s", c.boom, text)
		}
	}
	text, _ = h.call(t, mary, toolObserve, map[string]any{"detail": "full"})
	if !strings.Contains(text, "Boat: Tall ship, plain sail, yards ") {
		t.Fatalf("her report: %s", text)
	}
}

// A boat's downwind sail is told as its crew works it, and not at all in
// its bag.
func TestGennakerWords(t *testing.T) {
	for _, c := range []struct {
		hoist, target float64
		want          string
	}{{0, 0, ""}, {0, 1, "gennaker going up"}, {0.6, 1, "gennaker going up"}, {1, 1, "gennaker set"}, {0.4, 0, "gennaker coming in"}} {
		st := physics.State{Hoist: c.hoist, HoistTarget: c.target}
		if got := gennakerWords(&st); got != c.want {
			t.Errorf("hoisted %v, aimed %v: %q, not %q", c.hoist, c.target, got, c.want)
		}
	}
}
