// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"errors"
	"regexp"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// codeForm is a link's code: ten characters of lower-case base32.
var codeForm = regexp.MustCompile(`^[a-z2-7]{10}$`)

// TestWatchCodesMigration: migrated from the schema before links to
// watch, every account has its sailor's code and every human its fleet's,
// each of the form and none the same.
func TestWatchCodesMigration(t *testing.T) {
	ctx := context.Background()
	u := storetest.Empty(t)
	if _, err := store.Migrate(ctx, u, 28); err != nil {
		t.Fatal(err)
	}
	pool := storetest.PoolOn(t, u)
	var humans [][16]byte
	for range 20 {
		h := uuidOf(t, pool, "INSERT INTO account (kind, saved_at) VALUES ('human', now()) RETURNING id")
		humans = append(humans, h)
		must(t, pool, "INSERT INTO account (kind, owner_id, saved_at) VALUES ('ai', $1, now())", h)
	}
	if _, err := store.Migrate(ctx, u, 0); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	rows, err := pool.Query(ctx, "SELECT kind, watch_code, coalesce(fleet_code, '') FROM account")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var kind, w, f string
		if err := rows.Scan(&kind, &w, &f); err != nil {
			t.Fatal(err)
		}
		n++
		if !codeForm.MatchString(w) || seen[w] {
			t.Fatalf("a %s's sailor code %q", kind, w)
		}
		seen[w] = true
		switch {
		case kind == "ai" && f != "":
			t.Fatalf("a machine sailor's fleet code %q", f)
		case kind == "human" && (!codeForm.MatchString(f) || seen[f]):
			t.Fatalf("a human's fleet code %q", f)
		}
		seen[f] = true
	}
	if n != 40 {
		t.Fatalf("%d accounts", n)
	}
	// A machine sailor never has a fleet's code; a human always has one.
	refused(t, exec(t, pool, "UPDATE account SET fleet_code = 'aaaaaaaaaa' WHERE kind = 'ai'"), "23514")
	refused(t, exec(t, pool, "UPDATE account SET fleet_code = NULL WHERE id = $1", humans[0]), "23514")
}

// TestLinkCodes: an account made, human or machine, has its codes; each
// finds its sailor or fleet; a new code stops the old one; a code is the
// account's own to replace, or its machine sailors'; a deleted account's
// codes find nothing.
func TestLinkCodes(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	ann, err := s.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", [32]byte{1}))
	if err != nil {
		t.Fatal(err)
	}
	bob, err := s.CreateAccount(ctx, storetest.NewAccount("Bob", "bob", [32]byte{2}))
	if err != nil {
		t.Fatal(err)
	}
	mary, err := s.CreateMachine(ctx, ann, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	codes, err := s.LinkCodes(ctx, ann)
	if err != nil || !codeForm.MatchString(codes.Sailor) || !codeForm.MatchString(codes.Fleet) {
		t.Fatalf("Ann's codes %+v %v", codes, err)
	}
	machine, err := s.LinkCodes(ctx, mary)
	if err != nil || !codeForm.MatchString(machine.Sailor) || machine.Fleet != "" {
		t.Fatalf("Iron Mary's codes %+v %v", machine, err)
	}
	list, err := s.Machines(ctx, ann)
	if err != nil || len(list) != 1 || list[0].WatchCode != machine.Sailor {
		t.Fatalf("Ann's machine sailors %+v %v", list, err)
	}
	if got, err := s.LinkTarget(ctx, codes.Sailor); err != nil || got.ID != ann || got.Name != "Ann Bonny" || got.Kind != store.Human {
		t.Fatalf("Ann's link %+v %v", got, err)
	}
	if got, err := s.LinkTarget(ctx, machine.Sailor); err != nil || got.ID != mary || got.Owner != ann || got.Kind != store.AI {
		t.Fatalf("Iron Mary's link %+v %v", got, err)
	}
	if got, err := s.FleetLinkOwner(ctx, codes.Fleet); err != nil || got != ann {
		t.Fatalf("Ann's fleet %v %v", got, err)
	}
	if _, err := s.LinkTarget(ctx, codes.Fleet); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a fleet's code as a sailor's: %v", err)
	}
	if _, err := s.FleetLinkOwner(ctx, codes.Sailor); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a sailor's code as a fleet's: %v", err)
	}
	sailors, err := s.SailorsByID(ctx, []store.AccountID{mary})
	if err != nil || sailors[mary].Code != machine.Sailor {
		t.Fatalf("Iron Mary's sailor %+v %v", sailors, err)
	}

	// New codes: the old ones find nothing.
	fresh, err := s.NewWatchCode(ctx, ann, ann)
	if err != nil || !codeForm.MatchString(fresh) || fresh == codes.Sailor {
		t.Fatalf("Ann's new code %q %v", fresh, err)
	}
	if _, err := s.LinkTarget(ctx, codes.Sailor); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Ann's old link: %v", err)
	}
	if got, err := s.LinkTarget(ctx, fresh); err != nil || got.ID != ann {
		t.Fatalf("Ann's new link %+v %v", got, err)
	}
	freshMary, err := s.NewWatchCode(ctx, ann, mary)
	if err != nil || freshMary == machine.Sailor {
		t.Fatalf("Iron Mary's new code %q %v", freshMary, err)
	}
	if _, err := s.LinkTarget(ctx, machine.Sailor); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Iron Mary's old link: %v", err)
	}
	freshFleet, err := s.NewFleetCode(ctx, ann)
	if err != nil || freshFleet == codes.Fleet {
		t.Fatalf("Ann's new fleet code %q %v", freshFleet, err)
	}
	if _, err := s.FleetLinkOwner(ctx, codes.Fleet); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Ann's old fleet link: %v", err)
	}
	// Only the account's own, and its own machine sailors'.
	for _, c := range []struct{ owner, id store.AccountID }{{bob, ann}, {bob, mary}, {mary, mary}} {
		if _, err := s.NewWatchCode(ctx, c.owner, c.id); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("another's code replaced: %v", err)
		}
	}
	if _, err := s.NewFleetCode(ctx, mary); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a machine sailor's fleet: %v", err)
	}

	// Deleted, with its machine sailors, its codes find nothing.
	if _, err := s.DeleteAccount(ctx, ann); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LinkTarget(ctx, freshMary); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a deleted machine sailor's link: %v", err)
	}
	if _, err := s.LinkTarget(ctx, fresh); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a deleted account's link: %v", err)
	}
	if _, err := s.FleetLinkOwner(ctx, freshFleet); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a deleted account's fleet: %v", err)
	}
}
