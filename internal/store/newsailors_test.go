// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestNewSailorsFrom: a sailor made from an address leaves a row of its
// key, with no account in it, counted for a day; rows a day old are
// deleted, and a store opened again counts what the database holds.
func TestNewSailorsFrom(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	key := func(b byte) []byte { k := sha256.Sum256([]byte{b}); return k[:] }
	here, there := key(1), key(2)
	for i := range 3 {
		a := storetest.NewAccount("Sailor "+string(rune('A'+i)), "sailor"+string(rune('a'+i)), sha256.Sum256([]byte{byte(i)}))
		a.From = here
		if _, err := s.CreateAccount(ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	// Made with no address: no row.
	if _, err := s.CreateAccount(ctx, storetest.NewAccount("Mary Read", "maryread", sha256.Sum256([]byte("m")))); err != nil {
		t.Fatal(err)
	}
	// A name taken leaves no row either: the transaction is undone.
	taken := storetest.NewAccount("Sailor A", "sailora", sha256.Sum256([]byte("again")))
	taken.From = here
	if _, err := s.CreateAccount(ctx, taken); err != store.ErrNameTaken {
		t.Fatalf("a name taken: %v", err)
	}
	day := time.Now().Add(-store.NewSailorWindow)
	if n, oldest, err := s.NewSailorsFrom(ctx, here, day); err != nil || n != 3 || time.Since(oldest) > time.Minute {
		t.Fatalf("from here: %d, %v, %v", n, oldest, err)
	}
	if n, _, err := s.NewSailorsFrom(ctx, there, day); err != nil || n != 0 {
		t.Fatalf("from there: %d, %v", n, err)
	}
	// The table holds keys and times alone.
	var cols int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.columns WHERE table_name = 'new_sailor_from'").Scan(&cols); err != nil || cols != 2 {
		t.Fatalf("new_sailor_from has %d columns: %v", cols, err)
	}
	refused(t, exec(t, pool, "INSERT INTO new_sailor_from (key) VALUES ($1)", []byte("short")), "23514")

	// Two of here's rows a day old and more: no longer counted, the oldest
	// left the one counted, and deleted.
	must(t, pool, "UPDATE new_sailor_from SET made_at = now() - interval '25 hours' WHERE ctid IN (SELECT ctid FROM new_sailor_from LIMIT 2)")
	n, oldest, err := s.NewSailorsFrom(ctx, here, day)
	if err != nil || n != 1 || time.Since(oldest) > time.Minute {
		t.Fatalf("after a day: %d, %v, %v", n, oldest, err)
	}
	if gone, err := s.DeleteNewSailors(ctx, time.Now().Add(-store.NewSailorWindow)); err != nil || gone != 2 {
		t.Fatalf("deleted %d, %v", gone, err)
	}
	// Opened again, as after a restart: the count is the database's.
	again, err := store.Open(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if n, _, err := again.NewSailorsFrom(ctx, here, day); err != nil || n != 1 {
		t.Fatalf("opened again: %d, %v", n, err)
	}
	var left []byte
	if err := pool.QueryRow(ctx, "SELECT key FROM new_sailor_from").Scan(&left); err != nil || !bytes.Equal(left, here) {
		t.Fatalf("the row left: %x, %v", left, err)
	}
}

// TestNewSailorSettings: 20 and on to start, each change recorded, the
// limit within 1 to 1000.
func TestNewSailorSettings(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	n, check, err := s.NewSailorSettings(ctx)
	if err != nil || n != store.DefaultNewSailorsPerAddress || !check {
		t.Fatalf("to start: %d %t %v", n, check, err)
	}
	a := store.Action{Source: store.SourcePage, From: "127.0.0.1"}
	if err := s.SetNewSailorsPerAddress(ctx, 2, a); err != nil {
		t.Fatal(err)
	}
	a.Source = store.SourceCommand
	if err := s.SetHumanCheck(ctx, false, a); err != nil {
		t.Fatal(err)
	}
	if n, check, err = s.NewSailorSettings(ctx); err != nil || n != 2 || check {
		t.Fatalf("set: %d %t %v", n, check, err)
	}
	for _, bad := range []int{0, 1001} {
		refused(t, exec(t, pool, "UPDATE setting SET new_sailors_per_address = $1", bad), "23514")
	}
	must(t, pool, "UPDATE setting SET new_sailors_per_address = 1000")
	acts, err := s.Actions(ctx, nil, 10)
	if err != nil || len(acts) != 2 || acts[0].Action != store.ActionHumanCheck || acts[1].Action != store.ActionNewSailors ||
		acts[0].HasAccount || acts[1].Source != store.SourcePage {
		t.Fatalf("the record: %+v, %v", acts, err)
	}
	ann, err := s.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("t"))))
	if err != nil {
		t.Fatal(err)
	}
	for _, act := range []string{store.ActionNewSailors, store.ActionHumanCheck} {
		refused(t, exec(t, pool, "INSERT INTO account_action (action, account_id, source) VALUES ($1, $2, 'page')", act, ann), "23514")
	}
}
