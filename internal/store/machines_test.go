// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestMachinesMigration: migrated from the schema before machine sailors,
// with accounts in it, every human account has its boat and a cap of one,
// and the lifetime is there, 90 days.
func TestMachinesMigration(t *testing.T) {
	ctx := context.Background()
	u := storetest.Empty(t)
	if _, err := store.Migrate(ctx, u, 14); err != nil {
		t.Fatal(err)
	}
	pool := storetest.PoolOn(t, u)
	for i, name := range []string{"Ann Bonny", "Mary Read"} {
		id := uuidOf(t, pool, "INSERT INTO account (kind, saved_at) VALUES ('human', now()) RETURNING id")
		must(t, pool, "INSERT INTO sailor (account_id, name, name_key, look) VALUES ($1, $2, $3, 'figure')", id, name, []string{"annbonny", "maryread"}[i])
	}
	if _, err := store.Migrate(ctx, u, 0); err != nil {
		t.Fatal(err)
	}
	var boats, capped int
	var lifetime time.Duration
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM boat WHERE kind = 'jolly-boat'),
		(SELECT count(*) FROM account WHERE machine_cap = 1)`).Scan(&boats, &capped); err != nil || boats != 2 || capped != 2 {
		t.Fatalf("boats %d, caps %d, %v", boats, capped, err)
	}
	s, err := store.Open(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if lifetime, err = s.GrantLifetime(ctx); err != nil || lifetime != 90*24*time.Hour {
		t.Fatalf("the lifetime: %v %v", lifetime, err)
	}
	if err := s.SetGrantLifetime(ctx, 30*time.Second); err == nil {
		t.Fatal("a lifetime under a minute")
	}
	if err := s.SetGrantLifetime(ctx, 401*24*time.Hour); err == nil {
		t.Fatal("a lifetime over 400 days")
	}
}

// TestMachineLook: an AI account's sailor has the machine look and all
// three of its choices; a human's has none of them.
func TestMachineLook(t *testing.T) {
	pool := storetest.Pool(t)
	human := uuidOf(t, pool, "INSERT INTO account (kind, saved_at) VALUES ('human', now()) RETURNING id")
	ai := uuidOf(t, pool, "INSERT INTO account (kind, owner_id, saved_at) VALUES ('ai', $1, now()) RETURNING id", human)
	refused(t, exec(t, pool, "INSERT INTO sailor (account_id, name, name_key, look) VALUES ($1, 'A', 'a', 'figure')", ai), integrity)
	refused(t, exec(t, pool, "INSERT INTO sailor (account_id, name, name_key, look, version, finish) VALUES ($1, 'A', 'a', 'machine', 'v', 'f')", ai), "23514")
	refused(t, exec(t, pool, "INSERT INTO sailor (account_id, name, name_key, look, version, finish, colour) VALUES ($1, 'B', 'b', 'machine', 'v', 'f', 'c')", human), integrity)
	refused(t, exec(t, pool, "INSERT INTO sailor (account_id, name, name_key, look, colour) VALUES ($1, 'B', 'b', 'figure', 'c')", human), "23514")
	must(t, pool, "INSERT INTO sailor (account_id, name, name_key, look, version, finish, colour) VALUES ($1, 'A', 'a', 'machine', 'v', 'f', 'c')", ai)
	must(t, pool, "INSERT INTO sailor (account_id, name, name_key, look) VALUES ($1, 'B', 'b', 'figure')", human)
}

// TestMachineCap: two machine sailors made at once for an account allowed
// one make one; the fleet gets a boat for each sailor and never loses one.
func TestMachineCap(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	owner, err := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("t")))))
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Go(func() {
			_, errs[i] = s.CreateMachine(ctx, owner, store.NewMachine{
				Name: "Machine " + string(rune('A'+i)), NameKey: "machine" + string(rune('a'+i)), Version: "v", Finish: "f", Colour: "c",
			}, "jolly-boat")
		})
	}
	wg.Wait()
	made, capped := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			made++
		case errors.Is(err, store.ErrCap):
			capped++
		default:
			t.Fatal(err)
		}
	}
	if made != 1 || capped != 7 {
		t.Fatalf("made %d, at the cap %d", made, capped)
	}
	if f, err := s.Fleet(ctx, owner); err != nil || f["jolly-boat"] != 2 {
		t.Fatalf("the fleet: %v %v", f, err)
	}
	if err := s.SetMachineCap(ctx, owner, 3); err != nil {
		t.Fatal(err)
	}
	ms, _ := s.Machines(ctx, owner)
	if _, err := s.CreateMachine(ctx, owner, store.NewMachine{Name: "B", NameKey: "b", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteMachine(ctx, owner, ms[0].ID); err != nil {
		t.Fatal(err)
	}
	if f, _ := s.Fleet(ctx, owner); f["jolly-boat"] != 3 {
		t.Fatalf("a boat lost with its machine sailor: %v", f)
	}
	if err := s.SetMachineCap(ctx, ms[0].ID, 2); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an AI account's cap: %v", err)
	}
	if _, err := s.CreateMachine(ctx, store.AccountID{1}, store.NewMachine{Name: "C", NameKey: "c", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("no owner: %v", err)
	}
}

func withBoat(a store.NewAccount) store.NewAccount {
	a.Boat = "jolly-boat"
	return a
}

// TestOneConnectionToken: a machine sailor has one live connection token
// at a time: a new one revokes the old in the same transaction, and the
// schema refuses a second live one.
func TestOneConnectionToken(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	owner, _ := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("t")))))
	m, err := s.CreateMachine(ctx, owner, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	g1, replaced, err := s.MakeConnection(ctx, owner, m, sha256.Sum256([]byte("1")))
	if err != nil || len(replaced) != 0 {
		t.Fatal(err)
	}
	_, replaced, err = s.MakeConnection(ctx, owner, m, sha256.Sum256([]byte("2")))
	if err != nil || len(replaced) != 1 || replaced[0] != g1 {
		t.Fatalf("replaced: %v %v", replaced, err)
	}
	pool := storetest.PoolOn(t, u)
	refused(t, exec(t, pool, "INSERT INTO ai_grant (account_id, kind, approved_by) VALUES ($1, 'connection', $2)", m, owner), "23505")
	other, _ := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Mary Read", "maryread", sha256.Sum256([]byte("u")))))
	if _, _, err := s.MakeConnection(ctx, other, m, sha256.Sum256([]byte("3"))); !errors.Is(err, store.ErrNoMachine) {
		t.Fatalf("another's machine sailor: %v", err)
	}
	// Deleting the human account takes its machine sailors, their grants
	// and tokens, and its boats.
	machines, err := s.DeleteAccount(ctx, owner)
	if err != nil || len(machines) != 1 || machines[0] != m {
		t.Fatalf("deleted: %v %v", machines, err)
	}
	var left int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM account WHERE id = $1 OR owner_id = $1) + (SELECT count(*) FROM ai_grant)
		+ (SELECT count(*) FROM oauth_token) + (SELECT count(*) FROM boat WHERE account_id = $1)`, owner).Scan(&left); err != nil || left != 0 {
		t.Fatalf("left: %d %v", left, err)
	}
}

// TestOAuthLeftovers: the job deletes requests and codes an hour past
// expiry, access tokens a day past, grants ended thirty days ago with
// their tokens, and registered clients with no grant unused for thirty
// days; it keeps the rest.
func TestOAuthLeftovers(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	owner, _ := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("t")))))
	m, _ := s.CreateMachine(ctx, owner, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	old := uuidOf(t, pool, "INSERT INTO ai_grant (account_id, kind, approved_by, approved_at) VALUES ($1, 'connection', $2, now() - interval '200 days') RETURNING id", m, owner)
	live := uuidOf(t, pool, "INSERT INTO ai_grant (account_id, kind, client_id, client_name, redirect_uri, approved_by) VALUES ($1, 'app', 'keelote_cl_x', 'X', 'https://x/cb', $2) RETURNING id", m, owner)
	must(t, pool, "INSERT INTO oauth_token (hash, grant_id, kind, pair) VALUES ($1, $2, 'connection', $2)", hashOf("old"), old)
	must(t, pool, "INSERT INTO oauth_token (hash, grant_id, kind, pair, expires_at) VALUES ($1, $2, 'access', $2, now() - interval '2 days')", hashOf("a1"), live)
	must(t, pool, "INSERT INTO oauth_token (hash, grant_id, kind, pair, expires_at) VALUES ($1, $2, 'access', $2, now() - interval '2 hours')", hashOf("a2"), live)
	must(t, pool, "INSERT INTO oauth_client (client_id, name, redirect_uris, metadata, last_used_at) VALUES ('keelote_cl_x', 'X', '{https://x/cb}', '{}', now() - interval '60 days')")
	must(t, pool, "INSERT INTO oauth_client (client_id, name, redirect_uris, metadata, last_used_at) VALUES ('keelote_cl_y', 'Y', '{https://y/cb}', '{}', now() - interval '60 days')")
	must(t, pool, "INSERT INTO oauth_request (handle_hash, client_id, client_name, registered, redirect_uri, code_challenge, expires_at) VALUES ($1, 'c', 'C', false, 'https://c', $2, now() - interval '2 hours')",
		hashOf("r"), "0123456789012345678901234567890123456789012")
	c, err := s.DeleteOAuthLeftovers(ctx, time.Now(), 90*24*time.Hour)
	if err != nil || c.Requests != 1 || c.AccessTokens != 1 || c.Grants != 1 || c.Clients != 1 {
		t.Fatalf("deleted: %+v %v", c, err)
	}
	var tokens, clients int
	if err := pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM oauth_token), (SELECT count(*) FROM oauth_client)").Scan(&tokens, &clients); err != nil || tokens != 1 || clients != 1 {
		t.Fatalf("kept: %d tokens, %d clients, %v", tokens, clients, err)
	}
}

// TestGrantsEndedBy: a shorter lifetime counts the grants live now that it
// would end, not those the lifetime has ended already.
func TestGrantsEndedBy(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	owner, _ := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("t")))))
	m, _ := s.CreateMachine(ctx, owner, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	for _, age := range []string{"200 days", "10 days", "1 hour"} {
		must(t, pool, "INSERT INTO ai_grant (account_id, kind, client_id, client_name, redirect_uri, approved_by, approved_at) VALUES ($1, 'app', 'c', 'C', 'https://c', $2, now() - $3::interval)", m, owner, age)
	}
	day := 24 * time.Hour
	for d, want := range map[time.Duration]int64{5 * day: 1, 2 * time.Minute: 2, 400 * day: 0} {
		if n, err := s.GrantsEndedBy(ctx, 90*day, d); err != nil || n != want {
			t.Errorf("a lifetime of %v ends %d, want %d (%v)", d, n, want, err)
		}
	}
}
