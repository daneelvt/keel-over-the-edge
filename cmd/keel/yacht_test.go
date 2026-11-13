// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/fleet/fleettest"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A machine sailor in the cruising yacht through keel's own agents'
// listener: it takes its owner's yacht from the fleet, goes to sea, sails
// a beat and then a reach in a breeze, making her way on each, and reefs,
// with the helm, the sheet and the reef alone.

// knotsSaid finds the speed a line of the report says, "7.4 kn".
var knotsSaid = regexp.MustCompile(`(\d+(?:\.\d+)?) kn\b`)

func TestAMachineSailorSailsTheYacht(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	// The account's boat whose crew sit on a cockpit's bench.
	var yacht *catalog.Boat
	for i := range cat.Boats {
		b := &cat.Boats[i]
		if b.Fleet != catalog.FleetAccount {
			continue
		}
		for _, s := range b.Stations {
			if s.Pose == catalog.StationPoseBench {
				yacht = b
			}
		}
	}
	if yacht == nil {
		t.Skip("the catalog has no boat with a bench")
	}
	synctest.Test(t, func(t *testing.T) {
		db := fleetDB{memDB: &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}, boats: &fleettest.Store{}}
		token, machine := db.machine("Iron Mary", "Ann Bonny", false)
		// Its owner's fleet: one yacht.
		owner := store.AccountID{0x01, 0x9a, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x82}
		db.boats.Owners = map[store.AccountID]store.AccountID{machine: owner}
		db.boats.Fleet = []store.Boat{{ID: store.BoatID{2}, Kind: string(yacht.ID), BoatLook: store.BoatLook{Number: 32}}}
		opt := db.with(serveOptions{})
		opt.openDB = db.open
		// Seed 1, its sea known: the wind and the waves alike every run.
		vars := map[string]string{"KEEL_DEV_COMMANDS": "1", "KEEL_WORLD_SEED": "1"}
		s := startServer(t, vars, newMemNet(), opt)
		time.Sleep(time.Second)
		res, err := s.client.Post(internalURL+"/debug/wind?knots=14&from=0", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		time.Sleep(2500 * time.Millisecond)
		cs := agentSession(t, s, token)

		// The yacht taken by her kind's name, ashore: to sea in her.
		text, refused := callTool(t, cs, "boat", map[string]any{"action": "take", "boat": yacht.Name})
		if refused || !strings.Contains(text, "Your boat is "+yacht.Name) {
			t.Fatalf("taking the yacht: %v %q", refused, text)
		}
		text, refused = callTool(t, cs, "observe", map[string]any{"detail": "full"})
		if refused || !strings.Contains(text, "Boat: "+yacht.Name+", full sail") {
			t.Fatalf("at sea in the yacht: %v %q", refused, text)
		}
		// The best speed said over a while of observing, kn.
		best := func(seconds int) (float64, string) {
			top := 0.0
			last := ""
			for range seconds / 3 {
				time.Sleep(3 * time.Second)
				last, _ = callTool(t, cs, "observe", map[string]any{"detail": "full"})
				if !strings.Contains(last, "sailing") {
					t.Fatalf("not sailing: %q", last)
				}
				for _, line := range strings.Split(last, "\n") {
					if !strings.HasPrefix(line, "Boat:") {
						continue
					}
					if m := knotsSaid.FindStringSubmatch(line); m != nil {
						if v, err := strconv.ParseFloat(m[1], 64); err == nil && v > top {
							top = v
						}
					}
				}
			}
			return top, last
		}

		// A beat, close-hauled, the boom in. (A boat starts heading east, the
		// wind from the north over its port side.)
		text, refused = callTool(t, cs, "steer", map[string]any{"wind_angle": 50, "side": "port", "boom": 10})
		if refused || !strings.Contains(text, "wind 50° port") {
			t.Fatalf("a beat: %v %q", refused, text)
		}
		v, last := best(60)
		if v < 4 {
			t.Fatalf("on a beat in 14 knots, at best %.1f knots: %q", v, last)
		}
		t.Logf("on a beat in 14 knots, at best %.1f knots", v)

		// A beam reach, the boom eased: her way gathered.
		text, refused = callTool(t, cs, "steer", map[string]any{"wind_angle": 90, "side": "port", "boom": 30})
		if refused || !strings.Contains(text, "wind 90° port") {
			t.Fatalf("a reach: %v %q", refused, text)
		}
		v, last = best(60)
		if v < 6 {
			t.Fatalf("on a reach in 14 knots, at best %.1f knots: %q", v, last)
		}
		t.Logf("on a reach in 14 knots, at best %.1f knots", v)

		// One reef, as the catalog words it.
		reef := strings.ToLower(yacht.Controls.Reef[1])
		text, refused = callTool(t, cs, "trim", map[string]any{"reef": 1})
		if refused || !strings.Contains(text, reef) {
			t.Fatalf("one reef: %v %q", refused, text)
		}
		// Her reef taken in over its time.
		time.Sleep(time.Duration(yacht.Physics.Rig.ReefTime+5) * time.Second)
		text, _ = callTool(t, cs, "observe", map[string]any{"detail": "full"})
		if !strings.Contains(text, "Boat: "+yacht.Name+", "+reef) || !strings.Contains(text, "sailing") {
			t.Fatalf("reefed on a reach: %q", text)
		}
		s.stop(t)
	})
}
