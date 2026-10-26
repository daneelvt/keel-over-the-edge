// SPDX-License-Identifier: AGPL-3.0-only

package accounts_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

func TestLastActive(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	made := now.Add(-100 * 24 * time.Hour)
	for _, c := range []struct {
		seen    time.Time
		machine bool
		want    string
	}{
		{now, false, "today"},
		{now.Add(-24*time.Hour + time.Second), false, "today"},
		{now.Add(-24 * time.Hour), false, "1 day ago"},
		{now.Add(-48*time.Hour + time.Second), false, "1 day ago"},
		{now.Add(-41 * 24 * time.Hour), false, "41 days ago"},
		{made, true, accounts.Never},
		{made, false, "100 days ago"},
		{made.Add(time.Second), true, "99 days ago"},
	} {
		if got := accounts.LastActive(c.seen, made, c.machine, now); got != c.want {
			t.Errorf("seen %s, machine %v: %q, want %q", now.Sub(c.seen), c.machine, got, c.want)
		}
	}
}

// world is the world sailed, as the tests see it: the accounts at sea,
// and those taken out.
type world struct {
	mu               sync.Mutex
	sea              map[store.AccountID]accounts.Sea
	stopped, deleted []store.AccountID
}

func (w *world) Stopped(id store.AccountID) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopped = append(w.stopped, id)
}

func (w *world) Deleted(id store.AccountID) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.deleted = append(w.deleted, id)
}

func (w *world) Watching(store.AccountID) (string, bool) { return "", false }

func (w *world) Sea(id store.AccountID) (accounts.Sea, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	s, ok := w.sea[id]
	return s, ok
}

// forgot counts what the caches were told to forget.
type forgot struct {
	mu       sync.Mutex
	accounts []store.AccountID
	grants   [][16]byte
}

func (f *forgot) ForgetAccount(id store.AccountID) { f.ForgetAccounts(id) }
func (f *forgot) ForgetAccounts(ids ...store.AccountID) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.accounts = append(f.accounts, ids...)
}
func (f *forgot) ForgetGrants(ids ...[16]byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.grants = append(f.grants, ids...)
}

// helms are the machine sailors' helms, as the tests see them.
type helms struct {
	mu              sync.Mutex
	stopped, revoke map[store.AccountID]string
}

func (h *helms) Stop(id store.AccountID, words string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stopped[id] = words
}
func (h *helms) Revoked(id store.AccountID, words string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.revoke[id] = words
}

type fixture struct {
	st    *store.Store
	u     string
	hand  *accounts.Accounts
	world *world
	cache *forgot
	helms *helms
	ann   store.AccountID
	mary  store.AccountID
	// session is Ann's session token; connection Mary's connection token.
	session, connection string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	st, u := storetest.Store(t, store.Options{})
	session, hash := auth.NewToken()
	ann, err := st.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", hash))
	if err != nil {
		t.Fatal(err)
	}
	mary, err := st.CreateMachine(ctx, ann, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v1", Finish: "f1", Colour: "c1"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	connection, chash := oauth.NewToken(oauth.KindConnection)
	if _, _, err := st.MakeConnection(ctx, ann, mary, chash); err != nil {
		t.Fatal(err)
	}
	f := &fixture{st: st, u: u, world: &world{sea: map[store.AccountID]accounts.Sea{}}, cache: &forgot{},
		helms: &helms{stopped: map[store.AccountID]string{}, revoke: map[store.AccountID]string{}},
		ann:   ann, mary: mary, session: session, connection: connection}
	f.world.sea[ann] = accounts.Sea{Boat: 1}
	f.world.sea[mary] = accounts.Sea{Queued: true, Position: 1, Machine: true}
	f.hand = accounts.New(accounts.Config{
		Store: st, Sessions: f.cache, Door: f.cache, Agents: f.helms, World: func() accounts.World { return f.world },
	})
	return f
}

// TestSearch: an account is found by its sailor's name, in any case and
// spacing or by a letter that looks alike, or by part of it; by a machine
// sailor's name, shown under its human; by its ID; by a token of either
// kind, whose state is told; and nothing typed lists every account.
func TestSearch(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	only := func(text string) accounts.Result {
		t.Helper()
		res, err := f.hand.Search(ctx, text, "", 0)
		if err != nil {
			t.Fatalf("%q: %v", text, err)
		}
		if len(res.Accounts) != 1 || res.Accounts[0].ID != f.ann.String() || len(res.Accounts[0].Machines) != 1 {
			t.Fatalf("%q: %+v", text, res)
		}
		return res
	}
	for _, text := range []string{"Ann Bonny", "  ANN   bonny ", "ann b", "bonn", "Аnn"} { // the last with a Cyrillic А
		if r := only(text); r.Found != accounts.FoundName || !r.Accounts[0].Matched || r.Accounts[0].Machines[0].Matched {
			t.Errorf("%q: %+v", text, r)
		}
	}
	if r := only("iron"); r.Accounts[0].Matched || !r.Accounts[0].Machines[0].Matched {
		t.Errorf("a machine sailor's name: %+v", r)
	}
	if r := only(f.mary.String()); r.Found != accounts.FoundID || !r.Accounts[0].Machines[0].Matched {
		t.Errorf("by ID: %+v", r)
	}
	r := only(f.connection)
	if r.Found != accounts.FoundToken || !strings.Contains(r.Note, "A connection token") || !strings.Contains(r.Note, "it works until") {
		t.Errorf("a connection token: %+v", r)
	}
	if strings.Contains(r.Note, f.connection) {
		t.Error("the token echoed")
	}
	if r := only(f.session); r.Found != accounts.FoundSession {
		t.Errorf("a session's token: %+v", r)
	}
	r = only("")
	if r.Found != accounts.FoundAll || r.Total != 1 || r.Pages != 1 {
		t.Errorf("every account: %+v", r)
	}
	if r.Accounts[0].LastActive != accounts.AtSeaNow || !r.Accounts[0].Machines[0].Queued || r.Accounts[0].Machines[0].LastActive != accounts.Never {
		t.Errorf("where they are: %+v", r.Accounts[0])
	}
	if res, err := f.hand.Search(ctx, "", "sideways", 0); !errors.Is(err, accounts.ErrSort) {
		t.Errorf("an unknown sort: %+v %v", res, err)
	}
	// A token revoked says so; one whose rows are gone, that nothing is
	// known of it.
	if _, err := f.hand.Revoke(ctx, accounts.Request{Account: f.mary, Reason: "leaked"}); err != nil {
		t.Fatal(err)
	}
	if r := only(f.connection); !strings.Contains(r.Note, "revoked by the game's operator") {
		t.Errorf("a token revoked: %+v", r)
	}
	gone, _ := oauth.NewToken(oauth.KindAccess)
	if r, err := f.hand.Search(ctx, gone, "", 0); err != nil || r.Found != accounts.FoundToken || len(r.Accounts) != 0 ||
		!strings.Contains(r.Note, "Nothing is known of this token") {
		t.Errorf("a token unknown: %+v %v", r, err)
	}
	if r, err := f.hand.Search(ctx, "nobody", "", 0); err != nil || len(r.Accounts) != 0 || r.Total != 0 {
		t.Errorf("nobody: %+v %v", r, err)
	}
}

// TestStopReachesEverything: a stop reaches the set, the caches, the
// world and the helms, and its words count what it did; a revoke sends
// the machine sailor's boat into its grace, stopping nothing.
func TestStopReachesEverything(t *testing.T) {
	ctx := context.Background()
	f := newFixture(t)
	if _, err := f.hand.Stop(ctx, accounts.Request{Account: f.ann, Reason: " "}); !errors.Is(err, accounts.ErrReason) {
		t.Fatalf("no reason: %v", err)
	}
	if _, err := f.hand.Stop(ctx, accounts.Request{Account: f.ann, Reason: strings.Repeat("é", 501)}); !errors.Is(err, accounts.ErrReason) {
		t.Fatalf("a reason too long: %v", err)
	}
	checked, err := f.hand.Stop(ctx, accounts.Request{Account: f.ann, Reason: "spam", Check: true})
	if err != nil || checked.Done || checked.Words != "Ann Bonny and 1 machine sailor stop; 1 session ends; 1 grant is revoked; 1 boat leaves the water." {
		t.Fatalf("checked: %+v %v", checked, err)
	}
	if f.hand.Stopped().Has(f.ann) || len(f.world.stopped) != 0 {
		t.Fatal("a check acted")
	}
	done, err := f.hand.Stop(ctx, accounts.Request{Account: f.ann, Reason: "spam", Source: store.SourceCommand})
	if err != nil || !done.Done || done.Words != checked.Words {
		t.Fatalf("stopped: %+v %v", done, err)
	}
	if !f.hand.Stopped().Has(f.ann) || !f.hand.Stopped().Has(f.mary) || f.hand.Stopped().Count(store.AI) != 1 {
		t.Fatal("the set")
	}
	if len(f.world.stopped) != 2 || f.helms.stopped[f.mary] != accounts.AgentStopped || len(f.cache.grants) != 1 {
		t.Fatalf("reached: %v %v %v", f.world.stopped, f.helms.stopped, f.cache.grants)
	}
	acts, _ := f.hand.Actions(ctx, &f.ann)
	if len(acts) != 1 || acts[0].Source != store.SourceCommand || acts[0].Detail != "spam" {
		t.Fatalf("the record: %+v", acts)
	}
	if _, err := f.hand.Start(ctx, accounts.Request{Account: f.ann}); err != nil {
		t.Fatal(err)
	}
	if f.hand.Stopped().Has(f.ann) || f.hand.Stopped().Has(f.mary) {
		t.Fatal("still stopped after the start")
	}
	if _, err := f.hand.Revoke(ctx, accounts.Request{Account: f.ann, Reason: "leaked"}); err != nil {
		t.Fatal(err)
	}
	if f.helms.revoke[f.mary] != accounts.AgentRevoked || f.hand.Stopped().Has(f.mary) {
		t.Fatalf("revoked: %v", f.helms.revoke)
	}
}

// TestOwnersDeletionIsThePlayers: the owner's deletion, its name typed
// again, leaves what the player's own leaves: nothing of the account, its
// machine sailor, their grants or tokens, the names free; a flagged
// account is not deleted.
func TestOwnersDeletionIsThePlayers(t *testing.T) {
	ctx := context.Background()
	rows := func(f *fixture) int {
		var n int
		if err := storetest.PoolOn(t, f.u).QueryRow(ctx, `SELECT (SELECT count(*) FROM account) + (SELECT count(*) FROM sailor) +
			(SELECT count(*) FROM session) + (SELECT count(*) FROM passkey) + (SELECT count(*) FROM ai_grant) +
			(SELECT count(*) FROM oauth_token) + (SELECT count(*) FROM boat)`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	byPlayer := newFixture(t)
	if err := byPlayer.hand.DeleteByPlayer(ctx, byPlayer.ann); err != nil {
		t.Fatal(err)
	}
	byOwner := newFixture(t)
	if _, err := byOwner.st.Card(ctx, byOwner.ann); err != nil {
		t.Fatal(err)
	}
	if err := byOwner.st.SetTools(ctx, byOwner.ann, true); err != nil {
		t.Fatal(err)
	}
	if _, err := byOwner.hand.Delete(ctx, accounts.Request{Account: byOwner.ann, Name: "ann bonny", Reason: "asked"}); !errors.Is(err, accounts.ErrFlagged) {
		t.Fatalf("a flagged account: %v", err)
	}
	_ = byOwner.st.SetTools(ctx, byOwner.ann, false)
	if _, err := byOwner.hand.Delete(ctx, accounts.Request{Account: byOwner.ann, Name: "Mary", Reason: "asked"}); !errors.Is(err, accounts.ErrName) {
		t.Fatalf("the wrong name: %v", err)
	}
	if _, err := byOwner.hand.Delete(ctx, accounts.Request{Account: byOwner.ann, Name: " ANN bonny ", Reason: "asked"}); err != nil {
		t.Fatal(err)
	}
	if a, b := rows(byPlayer), rows(byOwner); a != 0 || b != 0 {
		t.Fatalf("rows left: by the player %d, by the owner %d", a, b)
	}
	for _, f := range []*fixture{byPlayer, byOwner} {
		if len(f.world.deleted) != 2 || f.helms.stopped[f.mary] != accounts.AgentDeleted {
			t.Errorf("reached: %v %v", f.world.deleted, f.helms.stopped)
		}
		for _, key := range []string{"annbonny", "ironmary"} {
			if free, _ := f.st.NameFree(ctx, key); !free {
				t.Errorf("%s is still taken", key)
			}
		}
	}
	if acts, _ := byPlayer.hand.Actions(ctx, &byPlayer.ann); len(acts) != 0 {
		t.Errorf("a player's deletion recorded: %+v", acts)
	}
	if acts, _ := byOwner.hand.Actions(ctx, &byOwner.ann); len(acts) != 1 || acts[0].Action != store.ActionDelete || acts[0].Detail != "asked" {
		t.Errorf("the owner's deletion's record: %+v", acts)
	}
}
