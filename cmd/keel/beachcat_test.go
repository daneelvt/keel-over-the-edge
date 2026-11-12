// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/fleet/fleettest"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A machine sailor in the beach cat through keel's own agents' listener: it
// takes its owner's beach cat from the fleet, goes to sea, sails a reach in
// a breeze, her windward hull flying, and then a beat, and reefs, with the
// helm, the sheet and the reef alone.

func TestAMachineSailorSailsTheBeachCat(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	// The account's boat of two hulls.
	var beach *catalog.Boat
	for i := range cat.Boats {
		if b := &cat.Boats[i]; b.Fleet == catalog.FleetAccount && b.Physics.Hulls.HullSpacing > 0 {
			beach = b
			break
		}
	}
	if beach == nil {
		t.Skip("the catalog has no boat of two hulls")
	}
	synctest.Test(t, func(t *testing.T) {
		db := fleetDB{memDB: &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}, boats: &fleettest.Store{}}
		token, machine := db.machine("Iron Mary", "Ann Bonny", false)
		// Its owner's fleet: one beach cat.
		owner := store.AccountID{0x01, 0x9a, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x81}
		db.boats.Owners = map[store.AccountID]store.AccountID{machine: owner}
		db.boats.Fleet = []store.Boat{{ID: store.BoatID{2}, Kind: string(beach.ID), BoatLook: store.BoatLook{Number: 16}}}
		opt := db.with(serveOptions{})
		opt.openDB = db.open
		// Seed 1, its sea known: the wind and the waves alike every run.
		vars := map[string]string{"KEEL_DEV_COMMANDS": "1", "KEEL_WORLD_SEED": "1"}
		s := startServer(t, vars, newMemNet(), opt)
		time.Sleep(time.Second)
		res, err := s.client.Post(internalURL+"/debug/wind?knots=16&from=0", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		time.Sleep(2500 * time.Millisecond)
		cs := agentSession(t, s, token)

		// The beach cat taken by her kind's name, ashore: to sea in her.
		text, refused := callTool(t, cs, "boat", map[string]any{"action": "take", "boat": beach.Name})
		if refused || !strings.Contains(text, "Your boat is "+beach.Name) {
			t.Fatalf("taking the beach cat: %v %q", refused, text)
		}
		text, refused = callTool(t, cs, "observe", map[string]any{"detail": "full"})
		if refused || !strings.Contains(text, "Boat: "+beach.Name+", full sail") {
			t.Fatalf("at sea in the beach cat: %v %q", refused, text)
		}

		// A beam reach, the boom eased: way gathered, she lifts her windward
		// hull. (A boat starts heading east, the wind from the north over its
		// port side.)
		text, refused = callTool(t, cs, "steer", map[string]any{"wind_angle": 90, "side": "port", "boom": 24})
		if refused || !strings.Contains(text, "wind 90° port") {
			t.Fatalf("a reach: %v %q", refused, text)
		}
		flew := false
		for range 12 {
			time.Sleep(2500 * time.Millisecond)
			text, _ = callTool(t, cs, "observe", nil)
			if !strings.Contains(text, "sailing") {
				t.Fatalf("on a reach, not sailing: %q", text)
			}
			flew = flew || strings.Contains(text, "hull flying")
		}
		if !flew {
			t.Fatalf("on a reach in 16 knots, her hull never flew: %q", text)
		}

		// A beat, close-hauled, the boom in.
		text, refused = callTool(t, cs, "steer", map[string]any{"wind_angle": 55, "side": "port", "boom": 12})
		if refused || !strings.Contains(text, "wind 55° port") {
			t.Fatalf("a beat: %v %q", refused, text)
		}
		time.Sleep(20 * time.Second)
		text, refused = callTool(t, cs, "observe", map[string]any{"detail": "full"})
		if refused || !strings.Contains(text, " · sailing ·") || !strings.Contains(text, "Pilot: wind 55° port") {
			t.Fatalf("on a beat: %v %q", refused, text)
		}

		// One reef, as the catalog words it.
		reef := strings.ToLower(beach.Controls.Reef[1])
		text, refused = callTool(t, cs, "trim", map[string]any{"reef": 1})
		if refused || !strings.Contains(text, reef) {
			t.Fatalf("one reef: %v %q", refused, text)
		}
		// Her reef taken in over its time.
		time.Sleep(time.Duration(beach.Physics.Rig.ReefTime+5) * time.Second)
		text, _ = callTool(t, cs, "observe", map[string]any{"detail": "full"})
		if !strings.Contains(text, "Boat: "+beach.Name+", "+reef) || !strings.Contains(text, "sailing") {
			t.Fatalf("reefed on a beat: %q", text)
		}
		s.stop(t)
	})
}
