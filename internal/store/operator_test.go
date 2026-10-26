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

// operation is an action of the owner's on an account, from the page.
func operation(id store.AccountID, action, detail string) store.Operation {
	return store.Operation{
		Action:   store.Action{Action: action, Account: id, HasAccount: true, Detail: detail, Source: store.SourcePage, From: "127.0.0.1:1"},
		Lifetime: 90 * 24 * time.Hour,
	}
}

// TestStopMigration: the migration over the schema before it keeps every
// account unstopped and every grant revoked as it was, and its rules hold.
func TestStopMigration(t *testing.T) {
	ctx := context.Background()
	u := storetest.Empty(t)
	if _, err := store.Migrate(ctx, u, 16); err != nil {
		t.Fatal(err)
	}
	pool := storetest.PoolOn(t, u)
	human := uuidOf(t, pool, "INSERT INTO account (kind, saved_at) VALUES ('human', now()) RETURNING id")
	ai := uuidOf(t, pool, "INSERT INTO account (kind, owner_id, saved_at) VALUES ('ai', $1, now()) RETURNING id", human)
	must(t, pool, "INSERT INTO ai_grant (account_id, kind, approved_by, revoked_at, revoked_why) VALUES ($1, 'connection', $2, now(), 'owner')", ai, human)
	if _, err := store.Migrate(ctx, u, 0); err != nil {
		t.Fatal(err)
	}
	var stopped int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM account WHERE stopped_at IS NOT NULL OR stop_reason IS NOT NULL").Scan(&stopped); err != nil || stopped != 0 {
		t.Fatalf("stopped after the migration: %d %v", stopped, err)
	}
	// A stop has a reason of 1 to 500 characters, and only a stop does.
	refused(t, exec(t, pool, "UPDATE account SET stopped_at = now() WHERE id = $1", human), "23514")
	refused(t, exec(t, pool, "UPDATE account SET stop_reason = 'why' WHERE id = $1", human), "23514")
	refused(t, exec(t, pool, "UPDATE account SET stopped_at = now(), stop_reason = '' WHERE id = $1", human), "23514")
	refused(t, exec(t, pool, "UPDATE account SET stopped_at = now(), stop_reason = repeat('é', 501) WHERE id = $1", human), "23514")
	must(t, pool, "UPDATE account SET stopped_at = now(), stop_reason = repeat('é', 500) WHERE id = $1", human)
	must(t, pool, "UPDATE ai_grant SET revoked_why = 'operator'")
	refused(t, exec(t, pool, "UPDATE ai_grant SET revoked_why = 'nobody'"), "23514")
	// The record: an action on an account names it, the lifetime none.
	refused(t, exec(t, pool, "INSERT INTO account_action (action, source) VALUES ('stop', 'page')"), "23514")
	refused(t, exec(t, pool, "INSERT INTO account_action (action, account_id, source) VALUES ('lifetime', $1, 'page')", human), "23514")
	refused(t, exec(t, pool, "INSERT INTO account_action (action, account_id, source) VALUES ('stop', $1, 'cron')", human), "23514")
	must(t, pool, "INSERT INTO account_action (action, source) VALUES ('lifetime', 'command')")
}

// TestStopAndStart: a stop ends the account's sessions, revokes its
// machine sailors' live grants by the operator, and hides the account
// from every session; the record keeps it; a start lets it in again, the
// grants still revoked; a stop and a start of one account at once run
// one after the other.
func TestStopAndStart(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	token := sha256.Sum256([]byte("t"))
	ann, err := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Ann Bonny", "annbonny", token)))
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.CreateMachine(ctx, ann, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.MakeConnection(ctx, ann, m, sha256.Sum256([]byte("c"))); err != nil {
		t.Fatal(err)
	}
	op := operation(ann, store.ActionStop, "spam")
	op.Check = true
	checked, err := s.Stop(ctx, op)
	if err != nil || checked.Sessions != 1 || checked.Grants != 1 || len(checked.Machines) != 1 {
		t.Fatalf("checked: %+v %v", checked, err)
	}
	if _, err := s.Session(ctx, token); err != nil {
		t.Fatalf("a check stopped it: %v", err)
	}
	out, err := s.Stop(ctx, operation(ann, store.ActionStop, "spam"))
	if err != nil || out.Grants != 1 || len(out.Revoked) != 1 {
		t.Fatalf("stopped: %+v %v", out, err)
	}
	if _, err := s.Session(ctx, token); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("its session: %v", err)
	}
	tg, err := s.TokenGrant(ctx, sha256.Sum256([]byte("c")))
	if err != nil || !tg.Stopped || tg.RevokedWhy != store.RevokedOperator {
		t.Fatalf("its machine sailor's token: %+v %v", tg, err)
	}
	stopped, err := s.Stopped(ctx)
	if err != nil || len(stopped) != 2 || stopped[ann] != store.Human || stopped[m] != store.AI {
		t.Fatalf("stopped: %v %v", stopped, err)
	}
	if _, err := s.Stop(ctx, operation(ann, store.ActionStop, "again")); !errors.Is(err, store.ErrStopped) {
		t.Fatalf("stopped twice: %v", err)
	}
	h, _ := s.AccountByUserHandle(ctx, mustCard(t, s, ann))
	if !h.Stopped {
		t.Fatal("a sign-in does not see the stop")
	}
	started, err := s.Start(ctx, operation(ann, store.ActionStart, ""))
	if err != nil || len(started.Freed) != 2 {
		t.Fatalf("started: %+v %v", started, err)
	}
	if tg, _ := s.TokenGrant(ctx, sha256.Sum256([]byte("c"))); tg.Stopped || tg.Revoked.IsZero() {
		t.Fatalf("its token after the start: %+v", tg)
	}
	acts, err := s.Actions(ctx, &ann, 10)
	if err != nil || len(acts) != 2 || acts[0].Action != store.ActionStart || acts[1].Action != store.ActionStop ||
		acts[1].Detail != "spam" || acts[1].Name != "Ann Bonny" || acts[1].Kind != store.Human || acts[1].Source != store.SourcePage {
		t.Fatalf("the record: %+v %v", acts, err)
	}

	// At once: every stop and start succeeds or is refused for the state
	// the one before it left, never both or neither.
	var wg sync.WaitGroup
	errs := make([]error, 16)
	for i := range errs {
		wg.Go(func() {
			if i%2 == 0 {
				_, errs[i] = s.Stop(ctx, operation(ann, store.ActionStop, "race"))
			} else {
				_, errs[i] = s.Start(ctx, operation(ann, store.ActionStart, ""))
			}
		})
	}
	wg.Wait()
	ok := 0
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case !errors.Is(err, store.ErrStopped) && !errors.Is(err, store.ErrNotStopped):
			t.Fatal(err)
		}
	}
	acts, _ = s.Actions(ctx, &ann, 100)
	if len(acts) != 2+ok {
		t.Fatalf("%d actions recorded for %d done", len(acts), ok)
	}
	for i := 1; i < len(acts); i++ {
		if acts[i].Action == acts[i-1].Action {
			t.Fatalf("two %ss in a row", acts[i].Action)
		}
	}
}

func mustCard(t *testing.T, s *store.Store, id store.AccountID) []byte {
	t.Helper()
	p, err := s.Profile(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return p.UserHandle
}

// TestTheRecordOutlivesADeletion: an account deleted by the owner leaves
// its record, its name as it was; two years on, the record goes.
func TestTheRecordOutlivesADeletion(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	ann, err := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("t")))))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateMachine(ctx, ann, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat"); err != nil {
		t.Fatal(err)
	}
	out, err := s.Delete(ctx, operation(ann, store.ActionDelete, "asked by mail"))
	if err != nil || len(out.Machines) != 1 {
		t.Fatalf("deleted: %+v %v", out, err)
	}
	pool := storetest.PoolOn(t, u)
	var accounts int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM account").Scan(&accounts); err != nil || accounts != 0 {
		t.Fatalf("%d accounts left: %v", accounts, err)
	}
	if free, _ := s.NameFree(ctx, "ironmary"); !free {
		t.Fatal("its machine sailor's name is still taken")
	}
	acts, err := s.Actions(ctx, &ann, 10)
	if err != nil || len(acts) != 1 || acts[0].Name != "Ann Bonny" || acts[0].Detail != "asked by mail" {
		t.Fatalf("the record: %+v %v", acts, err)
	}
	if err := s.RecordAction(ctx, store.Action{Action: store.ActionLifetime, Detail: "1h0m0s", Source: store.SourceCommand}); err != nil {
		t.Fatal(err)
	}
	must(t, pool, "UPDATE account_action SET at = now() - interval '731 days' WHERE action = 'delete'")
	if n, err := s.DeleteActions(ctx, time.Now().Add(-store.ActionKeep)); err != nil || n != 1 {
		t.Fatalf("deleted %d actions: %v", n, err)
	}
	if acts, _ := s.Actions(ctx, nil, 10); len(acts) != 1 || acts[0].Action != store.ActionLifetime || acts[0].HasAccount {
		t.Fatalf("left: %+v", acts)
	}
}

// TestSearchAccounts: humans found by their own names' keys or their
// machine sailors', exactly or in part, the exact first; every human
// otherwise, by last active; %, _ and \ typed are themselves.
func TestSearchAccounts(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	make1 := func(name, key string) store.AccountID {
		id, err := s.CreateAccount(ctx, storetest.NewAccount(name, key, sha256.Sum256([]byte(key))))
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	ann, annie, mary := make1("Ann", "ann"), make1("Annie Bonny", "anniebonny"), make1("Mary_Read", "mary_read")
	must(t, pool, "UPDATE account SET machine_cap = 2")
	iron, err := s.CreateMachine(ctx, mary, store.NewMachine{Name: "Iron Ann", NameKey: "ironann", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	must(t, pool, "UPDATE account SET last_seen_at = now() - interval '3 days' WHERE id = $1", annie)
	must(t, pool, "UPDATE account SET last_seen_at = now() + interval '1 minute' WHERE id = $1", iron)
	search := func(sr store.Search) []store.AccountID {
		sr.Limit = 50
		found, total, err := s.SearchAccounts(ctx, sr)
		if err != nil || int(total) != len(found) {
			t.Fatalf("%+v: %v (%d of %d)", sr, err, len(found), total)
		}
		out := make([]store.AccountID, len(found))
		for i, f := range found {
			out[i] = f.ID
		}
		return out
	}
	same := func(got []store.AccountID, want ...store.AccountID) bool {
		if len(got) != len(want) {
			return false
		}
		for i := range got {
			if got[i] != want[i] {
				return false
			}
		}
		return true
	}
	if got := search(store.Search{Key: "ann", Part: true, Pattern: "%ann%", Sort: store.SortActiveOld}); !same(got, ann, annie, mary) {
		t.Errorf("part of ann: %v", got)
	}
	if got := search(store.Search{Key: "ann", Sort: store.SortActiveOld}); !same(got, ann) {
		t.Errorf("ann exactly: %v", got)
	}
	if got := search(store.Search{Key: "_", Part: true, Pattern: `%\_%`, Sort: store.SortMade}); !same(got, mary) {
		t.Errorf("an underscore: %v", got)
	}
	if got := search(store.Search{Key: "%", Part: true, Pattern: `%\%%`, Sort: store.SortMade}); len(got) != 0 {
		t.Errorf("a percent: %v", got)
	}
	if got := search(store.Search{Every: true, Sort: store.SortActiveOld}); !same(got, annie, ann, mary) && !same(got, annie, mary, ann) {
		t.Errorf("every, oldest active first: %v", got)
	}
	if got := search(store.Search{Every: true, Sort: store.SortMachines}); len(got) != 3 || got[0] != mary {
		t.Errorf("by the machine sailors' calls: %v", got)
	}
	// A machine sailor's call marks it active, by its grant's use.
	if _, _, err := s.MakeConnection(ctx, mary, iron, sha256.Sum256([]byte("c"))); err != nil {
		t.Fatal(err)
	}
	tg, _ := s.TokenGrant(ctx, sha256.Sum256([]byte("c")))
	later := time.Now().Add(time.Hour)
	if err := s.GrantUsed(ctx, tg.Grant, later); err != nil {
		t.Fatal(err)
	}
	c, err := s.Card(ctx, iron)
	if err != nil || c.LastSeen.Sub(later).Abs() > time.Millisecond || c.Owner != mary || c.OwnerName != "Mary_Read" {
		t.Fatalf("its card: %+v %v", c, err)
	}
}

// TestSignInIsActive: a sign-in and a recovery code used each record the
// account active.
func TestSignInIsActive(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	made := storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("t")))
	ann, err := s.CreateAccount(ctx, made)
	if err != nil {
		t.Fatal(err)
	}
	old := func() {
		must(t, pool, "UPDATE account SET last_seen_at = now() - interval '40 days'")
	}
	seen := func() time.Time {
		c, err := s.Card(ctx, ann)
		if err != nil {
			t.Fatal(err)
		}
		return c.LastSeen
	}
	old()
	if _, err := s.SignIn(ctx, ann, sha256.Sum256([]byte("u"))); err != nil {
		t.Fatal(err)
	}
	if time.Since(seen()) > time.Minute {
		t.Fatal("a sign-in is not active")
	}
	old()
	if _, err := s.Recover(ctx, made.RecoveryHash, sha256.Sum256([]byte("v"))); err != nil {
		t.Fatal(err)
	}
	if time.Since(seen()) > time.Minute {
		t.Fatal("a recovery code used is not active")
	}
}
