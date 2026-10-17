// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

func TestGuestAndSession(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	hash := sha256.Sum256([]byte("token"))
	id, err := s.CreateGuest(ctx, store.Guest{Name: "Ann Bonny", NameKey: "annbonny", Look: "figure", TokenHash: hash})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Session(ctx, hash)
	if err != nil {
		t.Fatal(err)
	}
	want := store.Account{ID: id, Kind: store.Human, Saved: false, Name: "Ann Bonny", Look: "figure"}
	if got.Account != want || time.Since(got.LastSeen) > time.Minute {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if _, err := s.Session(ctx, sha256.Sum256([]byte("other"))); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an unknown token: %v", err)
	}
	if len(id.String()) != 36 || id.String()[14] != '7' {
		t.Fatalf("id %s", id)
	}
	time.Sleep(10 * time.Millisecond)
	if err := s.Touch(ctx, hash); err != nil {
		t.Fatal(err)
	}
	later, err := s.Session(ctx, hash)
	if err != nil || !later.LastSeen.After(got.LastSeen) {
		t.Fatalf("touched: %v → %v, %v", got.LastSeen, later.LastSeen, err)
	}
}

// TestCreateGuestAllOrNothing makes the last statement fail, with a token
// hash already in use: nothing of the guest is left.
func TestCreateGuestAllOrNothing(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	hash := sha256.Sum256([]byte("token"))
	if _, err := s.CreateGuest(ctx, store.Guest{Name: "First", NameKey: "first", Look: "a", TokenHash: hash}); err != nil {
		t.Fatal(err)
	}
	_, err := s.CreateGuest(ctx, store.Guest{Name: "Second", NameKey: "second", Look: "a", TokenHash: hash})
	if err == nil || errors.Is(err, store.ErrNameTaken) {
		t.Fatalf("a token hash twice: %v", err)
	}
	pool, err := pgxpool.New(ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for _, table := range []string{"account", "sailor", "session"} {
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil || n != 1 {
			t.Errorf("%s: %d rows, %v", table, n, err)
		}
	}
}

// TestTools: the owner's flag is set and cleared on a human account, read
// with the session and with the account, and never set on an AI's.
func TestTools(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	hash := sha256.Sum256([]byte("token"))
	id, err := s.CreateGuest(ctx, store.Guest{Name: "Ann Bonny", NameKey: "annbonny", Look: "figure", TokenHash: hash})
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateGuest(ctx, store.Guest{Name: "Mary Read", NameKey: "maryread", Look: "figure", TokenHash: sha256.Sum256([]byte("other"))})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := s.Session(ctx, hash); err != nil || got.Tools {
		t.Fatalf("a new account: %+v, %v", got.Account, err)
	}
	if err := s.SetTools(ctx, id, true); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Session(ctx, hash); err != nil || !got.Tools {
		t.Fatalf("flagged: %+v, %v", got.Account, err)
	}
	accounts, err := s.Accounts(ctx, []store.AccountID{id, other, {9}})
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 2 || !accounts[id].Tools || accounts[id].Name != "Ann Bonny" || accounts[other].Tools || accounts[other].Kind != store.Human {
		t.Fatalf("the accounts: %+v", accounts)
	}
	if err := s.SetTools(ctx, id, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Session(ctx, hash); got.Tools {
		t.Fatal("cleared, still flagged")
	}
	if err := s.SetTools(ctx, store.AccountID{9}, true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("no such account: %v", err)
	}
	// An AI account, owned by a saved human's.
	pool := storetest.PoolOn(t, u)
	must(t, pool, "UPDATE account SET saved_at = now() WHERE id = $1", id)
	ai := uuidOf(t, pool, "INSERT INTO account (kind, owner_id) VALUES ('ai', $1) RETURNING id", id)
	if err := s.SetTools(ctx, ai, true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an AI's: %v", err)
	}
	if got, err := s.Accounts(ctx, []store.AccountID{ai}); err != nil || got[ai].Kind != store.AI || got[ai].Name != "" {
		t.Fatalf("an AI's account: %+v, %v", got, err)
	}
}
