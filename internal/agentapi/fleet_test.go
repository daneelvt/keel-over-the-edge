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
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// TestFleet: a machine sailor lists its owner's fleet, takes the keelboat
// to sea, is refused a new look at sea out of port, and ashore paints its
// boat and names it; a name refused is told why.
func TestFleet(t *testing.T) {
	h := newHarness(t, 8, 12, 90)
	mary := sailor(1, "Iron Mary")
	ann := store.AccountID{0x02}
	keel := 0
	for i := range h.sea.Boats {
		if h.sea.Boats[i].Fleet == catalog.FleetAccount {
			keel = i
		}
	}
	ms := &fleettest.Store{
		Owners: map[store.AccountID]store.AccountID{ann: ann, store.AccountID(mary.Account): ann},
		Names:  map[store.AccountID]string{ann: "Ann Bonny", store.AccountID(mary.Account): "Iron Mary"},
		Fleet: []store.Boat{
			{ID: store.BoatID{1}, Kind: string(h.sea.Boats[0].ID), BoatLook: store.BoatLook{Number: 1}, Held: true, Sailor: ann},
			{ID: store.BoatID{2}, Kind: string(h.sea.Boats[0].ID), BoatLook: store.BoatLook{Number: 2}},
			{ID: store.BoatID{3}, Kind: string(h.sea.Boats[keel].ID), BoatLook: store.BoatLook{Number: 7, Name: "Saltpeter"}},
		},
	}
	h.sea.Fleet = fleet.New(fleet.Config{Store: ms, Catalog: h.sea.Catalog, World: h.w.Bus, Log: slog.New(slog.DiscardHandler)})

	text, refused := h.call(t, mary, toolBoat, map[string]any{})
	for _, want := range []string{"Jolly boat 1, available\n", "Jolly boat 2, available (white lead, bleached canvas sails), the boat you take to sea", "Keelboat «Saltpeter» 7, available"} {
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
}
