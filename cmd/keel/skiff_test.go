// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/fleet/fleettest"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A machine sailor in the skiff through keel's own agents' listener: it
// takes its owner's skiff from the fleet, goes to sea, bears away onto a
// run and its report names the gennaker its crew sets; it comes up and the
// gennaker comes in; one reef, and on a run again it stays in.

// fleetDB is a memDB whose accounts keep a fleet, in memory.
type fleetDB struct {
	*memDB
	boats *fleettest.Store
}

func (d fleetDB) Boats(ctx context.Context, owner store.AccountID) ([]store.Boat, error) {
	return d.boats.Boats(ctx, owner)
}

func (d fleetDB) FleetOwner(ctx context.Context, id store.AccountID) (store.AccountID, error) {
	return d.boats.FleetOwner(ctx, id)
}

func (d fleetDB) GiveBoat(ctx context.Context, owner, sailor store.AccountID, boat store.BoatID) error {
	return d.boats.GiveBoat(ctx, owner, sailor, boat)
}

func (d fleetDB) SetBoatLook(ctx context.Context, owner store.AccountID, boat store.BoatID, l store.BoatLook) error {
	return d.boats.SetBoatLook(ctx, owner, boat, l)
}

func (d fleetDB) BoatNumberFree(ctx context.Context, kind string, number int, except store.BoatID) (bool, error) {
	return d.boats.BoatNumberFree(ctx, kind, number, except)
}

func (d fleetDB) open(context.Context, string, store.Options) (database, error) { return d, nil }

// gennakerOf is what a report in JSON says the crew is doing with the
// boat's downwind sail, "" in its bag.
func gennakerOf(t *testing.T, text string) string {
	t.Helper()
	var rep struct {
		Boat struct {
			Gennaker string `json:"gennaker"`
		} `json:"boat"`
	}
	if err := json.Unmarshal([]byte(text), &rep); err != nil {
		t.Fatalf("a report: %v %q", err, text)
	}
	return rep.Boat.Gennaker
}

func TestAMachineSailorSailsTheSkiff(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	// The account's boat with a downwind sail its crew sets.
	var skiff *catalog.Boat
	for i := range cat.Boats {
		if b := &cat.Boats[i]; b.Fleet == catalog.FleetAccount && b.Physics.Downwind.DownwindArea > 0 {
			skiff = b
			break
		}
	}
	if skiff == nil {
		t.Skip("the catalog has no boat with a downwind sail")
	}
	synctest.Test(t, func(t *testing.T) {
		db := fleetDB{memDB: &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}, boats: &fleettest.Store{}}
		token, machine := db.machine("Iron Mary", "Ann Bonny", false)
		// Its owner's fleet: one skiff, no sailor's yet.
		owner := store.AccountID{0x01, 0x9a, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x80}
		db.boats.Owners = map[store.AccountID]store.AccountID{machine: owner}
		db.boats.Fleet = []store.Boat{{ID: store.BoatID{1}, Kind: string(skiff.ID), BoatLook: store.BoatLook{Number: 29}}}
		opt := db.with(serveOptions{})
		opt.openDB = db.open
		vars := map[string]string{"KEEL_DEV_COMMANDS": "1", "KEEL_WORLD_SEED": "1"}
		s := startServer(t, vars, newMemNet(), opt)
		time.Sleep(time.Second)
		res, err := s.client.Post(internalURL+"/debug/wind?knots=10&from=0", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		time.Sleep(2500 * time.Millisecond)
		cs := agentSession(t, s, token)

		// The skiff taken by its kind's name, ashore: to sea in it.
		text, refused := callTool(t, cs, "boat", map[string]any{"action": "take", "boat": skiff.Name})
		if refused || !strings.Contains(text, "Your boat is "+skiff.Name) {
			t.Fatalf("taking the skiff: %v %q", refused, text)
		}
		text, refused = callTool(t, cs, "observe", map[string]any{"detail": "full"})
		if refused || !strings.Contains(text, "Boat: "+skiff.Name+", full sail") {
			t.Fatalf("at sea in the skiff: %v %q", refused, text)
		}

		// A run, the boom well out: the crew sets the gennaker. (A boat
		// starts heading east, the wind from the north over its port side.)
		text, refused = callTool(t, cs, "steer", map[string]any{"wind_angle": 150, "side": "same", "boom": 70})
		if refused || !strings.Contains(text, "wind 150° port") {
			t.Fatalf("a run: %v %q", refused, text)
		}
		time.Sleep(20 * time.Second)
		text, refused = callTool(t, cs, "observe", nil)
		if refused || !strings.Contains(text, "Boat: gennaker set · sailing ·") {
			t.Fatalf("on a run: %v %q", refused, text)
		}
		if text, _ = callTool(t, cs, "observe", map[string]any{"format": "json"}); gennakerOf(t, text) != "gennaker set" {
			t.Fatalf("on a run, the report's gennaker: %q", text)
		}

		// Up onto a reach, the boom in: the crew takes it in.
		text, refused = callTool(t, cs, "steer", map[string]any{"wind_angle": 75, "boom": 30})
		if refused || !strings.Contains(text, "wind 75° port") {
			t.Fatalf("a reach: %v %q", refused, text)
		}
		time.Sleep(3 * time.Second)
		if text, _ = callTool(t, cs, "observe", nil); !strings.Contains(text, "Boat: gennaker coming in · sailing ·") {
			t.Fatalf("coming up: %q", text)
		}
		time.Sleep(15 * time.Second)
		if text, _ = callTool(t, cs, "observe", nil); !strings.Contains(text, "Boat: sailing ·") {
			t.Fatalf("on a reach: %q", text)
		}
		if text, _ = callTool(t, cs, "observe", map[string]any{"format": "json"}); gennakerOf(t, text) != "" {
			t.Fatalf("on a reach, the report's gennaker: %q", text)
		}

		// One reef keeps it in its bag, on a run again. Borne away with the
		// boom where it is, then eased, as a sailor on the wire does: eased
		// at once in the turn, the sail emptied under her sailor takes her
		// over to windward.
		reef := strings.ToLower(skiff.Controls.Reef[1])
		text, refused = callTool(t, cs, "trim", map[string]any{"reef": 1})
		if refused || !strings.Contains(text, reef) {
			t.Fatalf("one reef: %v %q", refused, text)
		}
		text, refused = callTool(t, cs, "steer", map[string]any{"wind_angle": 150})
		if refused || !strings.Contains(text, "wind 150° port") {
			t.Fatalf("a run again: %v %q", refused, text)
		}
		time.Sleep(8 * time.Second)
		if text, refused = callTool(t, cs, "trim", map[string]any{"boom": 70}); refused {
			t.Fatalf("eased on a run: %q", text)
		}
		// Watched until the reef is in: the crew never sets it.
		for range 6 {
			time.Sleep(5 * time.Second)
			text, _ = callTool(t, cs, "observe", nil)
			if !strings.Contains(text, " · sailing · heading") || strings.Contains(text, "gennaker set") || strings.Contains(text, "gennaker going up") {
				t.Fatalf("reefed on a run: %q", text)
			}
		}
		text, _ = callTool(t, cs, "observe", map[string]any{"detail": "full"})
		if !strings.Contains(text, "Boat: "+skiff.Name+", "+reef+" · sailing ·") || !strings.Contains(text, "Pilot: wind 150° port") {
			t.Fatalf("reefed on a run: %q", text)
		}
		if text, _ = callTool(t, cs, "observe", map[string]any{"format": "json"}); gennakerOf(t, text) != "" {
			t.Fatalf("reefed on a run, the report's gennaker: %q", text)
		}
		s.stop(t)
	})
}
