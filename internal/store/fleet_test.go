// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestFleetMigration: migrated from the schema before boats had looks,
// every boat has a number of its kind in the order the boats were made,
// and every human account a keelboat, numbered in the order the accounts
// were made.
func TestFleetMigration(t *testing.T) {
	ctx := context.Background()
	u := storetest.Empty(t)
	if _, err := store.Migrate(ctx, u, 22); err != nil {
		t.Fatal(err)
	}
	pool := storetest.PoolOn(t, u)
	var ids [][16]byte
	for i, name := range []string{"Ann Bonny", "Mary Read"} {
		id := uuidOf(t, pool, "INSERT INTO account (kind, saved_at, created_at) VALUES ('human', now(), now() + $1 * interval '1 second') RETURNING id", i)
		must(t, pool, "INSERT INTO sailor (account_id, name, name_key, look) VALUES ($1, $2, $3, 'figure')", id, name, []string{"annbonny", "maryread"}[i])
		must(t, pool, "INSERT INTO boat (account_id, kind, made_at) VALUES ($1, 'jolly-boat', now() + $2 * interval '1 second')", id, i)
		ids = append(ids, id)
	}
	if _, err := store.Migrate(ctx, u, 0); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i, id := range ids {
		boats, err := s.Boats(ctx, id)
		if err != nil || len(boats) != 2 {
			t.Fatalf("account %d's boats: %+v %v", i, boats, err)
		}
		for _, b := range boats {
			if b.Number != i+1 || b.Paint != 0 || b.Cloth != 0 || b.Name != "" || b.Held {
				t.Errorf("account %d's %s: %+v", i, b.Kind, b)
			}
		}
	}
}

// TestFleet: an account made with its fleet has a boat of each kind given,
// numbered the lowest free of its kind; a boat is one sailor's at a time,
// and a sailor's one boat; a boat's look is kept, its number unique within
// its kind; a machine sailor sails from its owner's fleet.
func TestFleet(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	newAccount := func(name, key string) store.AccountID {
		a := withBoat(storetest.NewAccount(name, key, sha256.Sum256([]byte(key))))
		a.Shared = []string{"keelboat"}
		id, err := s.CreateAccount(ctx, a)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	ann, mary := newAccount("Ann Bonny", "annbonny"), newAccount("Mary Read", "maryread")
	ai, err := s.CreateMachine(ctx, ann, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	boats, err := s.Boats(ctx, ann)
	if err != nil || len(boats) != 3 {
		t.Fatalf("Ann's boats: %+v %v", boats, err)
	}
	numbers := map[string][]int{}
	for _, b := range boats {
		numbers[b.Kind] = append(numbers[b.Kind], b.Number)
	}
	if n := numbers["jolly-boat"]; len(n) != 2 || n[0] != 1 || n[1] != 3 || numbers["keelboat"][0] != 1 {
		t.Fatalf("Ann's numbers: %v (Mary's Jolly boat is 2)", numbers)
	}
	if mb, _ := s.Boats(ctx, mary); len(mb) != 2 || mb[0].Number != 2 && mb[1].Number != 2 {
		t.Fatalf("Mary's boats: %+v", mb)
	}
	if o, err := s.FleetOwner(ctx, ai); err != nil || o != ann {
		t.Fatalf("the machine sailor's fleet: %v %v", o, err)
	}
	if o, err := s.FleetOwner(ctx, ann); err != nil || o != ann {
		t.Fatalf("Ann's own fleet: %v %v", o, err)
	}

	var keel, jolly store.BoatID
	for _, b := range boats {
		if b.Kind == "keelboat" {
			keel = b.ID
		} else if jolly == (store.BoatID{}) {
			jolly = b.ID
		}
	}
	// The keelboat Ann's, then her machine sailor's: hers no more.
	if err := s.GiveBoat(ctx, ann, ann, keel); err != nil {
		t.Fatal(err)
	}
	if err := s.GiveBoat(ctx, ann, ann, jolly); err != nil {
		t.Fatal(err)
	}
	if err := s.GiveBoat(ctx, ann, ai, keel); err != nil {
		t.Fatal(err)
	}
	if err := s.GiveBoat(ctx, mary, mary, keel); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another account's boat given: %v", err)
	}
	held := map[store.AccountID]int{}
	boats, _ = s.Boats(ctx, ann)
	for _, b := range boats {
		if b.Held {
			held[b.Sailor]++
			if b.ID == keel && (b.Sailor != ai || b.SailorName != "Iron Mary" || !b.Machine) {
				t.Errorf("the keelboat: %+v", b)
			}
		}
	}
	if held[ann] != 1 || held[ai] != 1 {
		t.Fatalf("the boats held: %v", held)
	}
	// Ann takes the keelboat back: her Jolly boat is free again.
	if err := s.GiveBoat(ctx, ann, ann, keel); err != nil {
		t.Fatal(err)
	}
	boats, _ = s.Boats(ctx, ann)
	for _, b := range boats {
		if b.Held != (b.ID == keel) || b.Held && b.Sailor != ann {
			t.Errorf("after the keelboat went back: %+v", b)
		}
	}

	if err := s.SetBoatLook(ctx, ann, keel, store.BoatLook{Paint: 3, Cloth: 2, Number: 311, Name: "Saltpeter"}); err != nil {
		t.Fatal(err)
	}
	mb, _ := s.Boats(ctx, mary)
	var marysKeel store.BoatID
	for _, b := range mb {
		if b.Kind == "keelboat" {
			marysKeel = b.ID
		}
	}
	if err := s.SetBoatLook(ctx, mary, marysKeel, store.BoatLook{Number: 311}); !errors.Is(err, store.ErrNumberTaken) {
		t.Fatalf("a keelboat's number taken twice: %v", err)
	}
	if free, err := s.BoatNumberFree(ctx, "keelboat", 311, marysKeel); err != nil || free {
		t.Fatalf("311 free for Mary: %v %v", free, err)
	}
	if free, err := s.BoatNumberFree(ctx, "keelboat", 311, keel); err != nil || !free {
		t.Fatalf("311 not free for Ann's own: %v %v", free, err)
	}
	if free, _ := s.BoatNumberFree(ctx, "jolly-boat", 311, keel); !free {
		t.Fatal("a number of one kind taken by another's")
	}
	if err := s.SetBoatLook(ctx, mary, keel, store.BoatLook{Number: 5}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another account's boat changed: %v", err)
	}
	boats, _ = s.Boats(ctx, ann)
	for _, b := range boats {
		if b.ID == keel && (b.Paint != 3 || b.Cloth != 2 || b.Number != 311 || b.Name != "Saltpeter") {
			t.Fatalf("the keelboat's look: %+v", b)
		}
	}
	// A name cleared; and the keelboat's number 1 free again, the next
	// keelboat made takes it.
	if err := s.SetBoatLook(ctx, ann, keel, store.BoatLook{Number: 311}); err != nil {
		t.Fatal(err)
	}
	third := newAccount("Anne Read", "anneread")
	tb, _ := s.Boats(ctx, third)
	for _, b := range tb {
		if b.Kind == "keelboat" && b.Number != 1 {
			t.Fatalf("the third keelboat: %+v", b)
		}
	}
	// A sailor deleted lets their boat go.
	if err := s.DeleteMachine(ctx, ann, ai); err != nil {
		t.Fatal(err)
	}
}
