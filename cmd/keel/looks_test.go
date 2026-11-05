// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// SetLook keeps a sailor's look: a machine sailor's in its tokens' grants,
// which carry it as the database's do.
func (d *memDB) SetLook(_ context.Context, id store.AccountID, l store.Look) error {
	d.tokens.mu.Lock()
	defer d.tokens.mu.Unlock()
	found := false
	for hash, t := range d.tokens.tokens {
		if t.Account == id {
			t.Look = l
			d.tokens.tokens[hash] = t
			found = true
		}
	}
	if !found {
		return errNoAccounts
	}
	return nil
}

// lookOf is the look a memDB keeps for a machine sailor.
func (d *memDB) lookOf(id store.AccountID) store.Look {
	d.tokens.mu.Lock()
	defer d.tokens.mu.Unlock()
	for _, t := range d.tokens.tokens {
		if t.Account == id {
			return t.Look
		}
	}
	return store.Look{}
}

// TestAMachineSailorChangesItsLook: through keel's own agents' listener, a
// machine sailor's agent reads its look, changes it ashore, where it is
// kept and read again with its token, is refused a change in Port Royal's
// roads, and changes it in Port Royal's basin.
func TestAMachineSailorChangesItsLook(t *testing.T) {
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	world, err := worldgen.Generate(1, cat)
	if err != nil {
		t.Fatal(err)
	}
	harbour, ok := world.Harbour()
	if !ok {
		t.Fatal("seed 1 has no harbour")
	}
	roads, basin := world.Start.Places[0], world.Start.Moorings[0]
	if physics.InHarbour(&harbour, roads[0], roads[1]) || !physics.InHarbour(&harbour, basin.X, basin.Y) {
		t.Fatal("the roads are in the harbour, or the first mooring is not")
	}
	synctest.Test(t, func(t *testing.T) {
		d := &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}
		gen := func(uint64) (*worldgen.Bundle, error) { return world, nil }
		s := startServer(t, map[string]string{"KEEL_DEV_COMMANDS": "1"}, newMemNet(), d.with(serveOptions{generate: gen}))
		time.Sleep(5 * time.Second)
		token, id := d.machine("Iron Mary", "Ann Bonny", false)
		cs := agentSession(t, s, token)
		place := func(east, north float64) {
			t.Helper()
			time.Sleep(3 * time.Second)
			res, err := s.client.Post(internalURL+fmt.Sprintf("/debug/place?account=%x&east=%.1f&north=%.1f&heading=0", id[:], east, north), "", nil)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode != http.StatusOK {
				t.Fatalf("placing the boat: %d", res.StatusCode)
			}
			time.Sleep(time.Second / 10)
		}

		text, refused := callTool(t, cs, "boat", map[string]any{"action": "sailor_look"})
		if refused || !strings.Contains(text, "You are a machine sailor: ") || !strings.Contains(text, "only at Port Royal") {
			t.Fatalf("told: %v %q", refused, text)
		}
		text, refused = callTool(t, cs, "boat", map[string]any{"action": "sailor_look", "version": "male", "finish": "brass", "colour": "sea green"})
		want := store.Look{Look: store.MachineLook, Version: "male", Finish: "brass", Colour: "sea-green", Chosen: true}
		if refused || !strings.Contains(text, "male, brass, in sea green") || d.lookOf(id) != want {
			t.Fatalf("ashore: %v %q, kept %+v", refused, text, d.lookOf(id))
		}
		// The door read the token's grant again: the look is the new one.
		if text, _ := callTool(t, cs, "handbook", map[string]any{"topic": "start"}); !strings.Contains(text, "You are a machine sailor: male, brass, in sea green.") {
			t.Fatalf("the handbook's start: %q", text)
		}
		if text, refused := callTool(t, cs, "observe", nil); refused || !strings.Contains(text, "At sea") {
			t.Fatalf("observe: %v %q", refused, text)
		}

		place(roads[0], roads[1])
		text, refused = callTool(t, cs, "boat", map[string]any{"action": "sailor_look", "finish": "iron"})
		if !refused || text != "Only at Port Royal: change your look before you sail, or in its harbour." || d.lookOf(id) != want {
			t.Fatalf("in the roads: %v %q, kept %+v", refused, text, d.lookOf(id))
		}

		place(basin.X, basin.Y)
		text, refused = callTool(t, cs, "boat", map[string]any{"action": "sailor_look", "finish": "iron"})
		want.Finish = "iron"
		if refused || !strings.Contains(text, "in Port Royal's harbour") || !strings.Contains(text, "male, iron, in sea green") || d.lookOf(id) != want {
			t.Fatalf("in the basin: %v %q, kept %+v", refused, text, d.lookOf(id))
		}
		s.stop(t)
	})
}
