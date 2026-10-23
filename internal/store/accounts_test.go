// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

func TestAccountAndSession(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	hash := sha256.Sum256([]byte("token"))
	made := storetest.NewAccount("Ann Bonny", "annbonny", hash)
	id, err := s.CreateAccount(ctx, made)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Session(ctx, hash)
	if err != nil {
		t.Fatal(err)
	}
	want := store.Account{ID: id, Kind: store.Human, Name: "Ann Bonny", Look: "figure", NoticesOff: []string{}}
	if !reflect.DeepEqual(got.Account, want) || time.Since(got.LastSeen) > time.Minute || got.Held || !got.ConfirmedUntil.Before(time.Now()) {
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
	h, err := s.AccountByUserHandle(ctx, made.UserHandle)
	if err != nil || h.ID != id || len(h.Passkeys) != 1 || !bytes.Equal(h.Passkeys[0].CredentialID, made.Passkey.CredentialID) ||
		h.Passkeys[0].MadeOn != "Mac · Chrome" || h.Passkeys[0].Flags != 0x45 {
		t.Fatalf("by its user handle: %+v, %v", h, err)
	}
	if _, err := s.AccountByUserHandle(ctx, make([]byte, 64)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an unknown handle: %v", err)
	}
	p, err := s.Profile(ctx, id)
	if err != nil || p.Name != "Ann Bonny" || p.RecoveryMade.IsZero() || time.Since(p.Created) > time.Minute {
		t.Fatalf("the profile: %+v, %v", p, err)
	}
	if free, err := s.NameFree(ctx, "annbonny"); err != nil || free {
		t.Fatalf("the name free: %v, %v", free, err)
	}
	if free, err := s.NameFree(ctx, "maryread"); err != nil || !free {
		t.Fatalf("another name free: %v, %v", free, err)
	}
}

// TestCreateAccountAllOrNothing makes the last statement fail, with a token
// hash already in use, and the passkey's, with its credential ID: nothing
// of the account is left, so no account is ever without a passkey.
func TestCreateAccountAllOrNothing(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	hash := sha256.Sum256([]byte("token"))
	first := storetest.NewAccount("First", "first", hash)
	if _, err := s.CreateAccount(ctx, first); err != nil {
		t.Fatal(err)
	}
	_, err := s.CreateAccount(ctx, storetest.NewAccount("Second", "second", hash))
	if err == nil || errors.Is(err, store.ErrNameTaken) {
		t.Fatalf("a token hash twice: %v", err)
	}
	again := storetest.NewAccount("Third", "third", sha256.Sum256([]byte("third")))
	again.Passkey.CredentialID = first.Passkey.CredentialID
	if _, err := s.CreateAccount(ctx, again); !errors.Is(err, store.ErrPasskeyTaken) {
		t.Fatalf("a passkey twice: %v", err)
	}
	if _, err := s.CreateAccount(ctx, storetest.NewAccount("FIRST", "first", sha256.Sum256([]byte("4")))); !errors.Is(err, store.ErrNameTaken) {
		t.Fatalf("a name twice: %v", err)
	}
	pool := storetest.PoolOn(t, u)
	for _, table := range []string{"account", "sailor", "session", "passkey"} {
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil || n != 1 {
			t.Errorf("%s: %d rows, %v", table, n, err)
		}
	}
}

// TestPasskeysAndRecovery: a passkey written back, added and removed while
// another remains; the recovery code spent once, ending every other
// session, and told at the next sign-in.
func TestPasskeysAndRecovery(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	hash := sha256.Sum256([]byte("token"))
	made := storetest.NewAccount("Ann Bonny", "annbonny", hash)
	id, err := s.CreateAccount(ctx, made)
	if err != nil {
		t.Fatal(err)
	}
	used := made.Passkey
	used.SignCount, used.CloneWarning, used.Flags, used.BackupState = 7, true, 0x5d, true
	if err := s.PasskeyUsed(ctx, id, used); err != nil {
		t.Fatal(err)
	}
	keys, _ := s.Passkeys(ctx, id)
	if len(keys) != 1 || keys[0].SignCount != 7 || !keys[0].CloneWarning || keys[0].Flags != 0x5d || !keys[0].BackupState || keys[0].BackupEligible {
		t.Fatalf("written back: %+v", keys)
	}
	if err := s.RemovePasskey(ctx, id, keys[0].ID); !errors.Is(err, store.ErrLastPasskey) {
		t.Fatalf("the last passkey: %v", err)
	}
	second := storetest.NewAccount("x", "x", [32]byte{}).Passkey
	if err := s.AddPasskey(ctx, id, second, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.AddPasskey(ctx, id, second, nil, nil); !errors.Is(err, store.ErrPasskeyTaken) {
		t.Fatalf("a passkey twice: %v", err)
	}
	if err := s.RemovePasskey(ctx, id, keys[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := s.RemovePasskey(ctx, id, keys[0].ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("gone already: %v", err)
	}

	// The recovery code: spent once, every session ended, a held one made.
	if _, err := s.Recover(ctx, sha256.Sum256([]byte("no code")), sha256.Sum256([]byte("t2"))); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("no such code: %v", err)
	}
	held := sha256.Sum256([]byte("held"))
	acc, err := s.Recover(ctx, made.RecoveryHash, held)
	if err != nil || acc.ID != id || acc.Name != "Ann Bonny" {
		t.Fatalf("recovered: %+v, %v", acc, err)
	}
	if _, err := s.Session(ctx, hash); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the other session: %v", err)
	}
	if got, err := s.Session(ctx, held); err != nil || !got.Held {
		t.Fatalf("the held session: %+v, %v", got, err)
	}
	if _, err := s.Recover(ctx, made.RecoveryHash, sha256.Sum256([]byte("t3"))); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("spent: %v", err)
	}
	if p, _ := s.Profile(ctx, id); !p.RecoveryMade.IsZero() {
		t.Fatalf("a spent code still shown: %v", p.RecoveryMade)
	}
	code := sha256.Sum256([]byte("new code"))
	third := storetest.NewAccount("y", "y", [32]byte{}).Passkey
	if err := s.AddPasskey(ctx, id, third, &held, &code); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Session(ctx, held); got.Held {
		t.Fatal("still held")
	}
	until := time.Now().Add(time.Minute).Truncate(time.Microsecond)
	if err := s.ConfirmSession(ctx, id, held, until); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Session(ctx, held); !got.ConfirmedUntil.Equal(until) {
		t.Fatalf("confirmed until %v, want %v", got.ConfirmedUntil, until)
	}
	if err := s.ConfirmSession(ctx, store.AccountID{9}, held, until); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another account's: %v", err)
	}
	at, err := s.SignIn(ctx, id, sha256.Sum256([]byte("signed in")))
	if err != nil || time.Since(at) > time.Minute {
		t.Fatalf("the next sign-in: %v, %v", at, err)
	}
	if at, err := s.SignIn(ctx, id, sha256.Sum256([]byte("again"))); err != nil || !at.IsZero() {
		t.Fatalf("the one after: %v, %v", at, err)
	}
	if n, err := s.EndOtherSessions(ctx, id, held); err != nil || n != 2 {
		t.Fatalf("the others ended: %d, %v", n, err)
	}
	if err := s.EndSession(ctx, held); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Session(ctx, held); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("ended: %v", err)
	}
	if _, err := s.Recover(ctx, code, sha256.Sum256([]byte("t4"))); err != nil {
		t.Fatalf("the new code: %v", err)
	}
}

// TestCeremonies: a ceremony is taken once, by its kind.
func TestCeremonies(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	id, err := s.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", [32]byte{1}))
	if err != nil {
		t.Fatal(err)
	}
	c := store.Ceremony{Hash: [32]byte{2}, Kind: store.CeremonyConfirm, Account: id, HasAccount: true,
		Session: []byte(`{"challenge":"x"}`), Build: "abc", Expires: time.Now().Add(time.Minute).Truncate(time.Microsecond)}
	if err := s.SaveCeremony(ctx, c); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TakeCeremony(ctx, c.Hash, store.CeremonyAdd); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another kind: %v", err)
	}
	got, err := s.TakeCeremony(ctx, c.Hash, store.CeremonyConfirm)
	if err != nil || !reflect.DeepEqual(got, c) {
		t.Fatalf("taken: %+v, %v, want %+v", got, err, c)
	}
	if _, err := s.TakeCeremony(ctx, c.Hash, store.CeremonyConfirm); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("taken twice: %v", err)
	}
	// A create keeps its sailor; a confirm needs its account.
	bad := store.Ceremony{Hash: [32]byte{3}, Kind: store.CeremonyCreate, Session: []byte("{}"), Build: "abc", Expires: time.Now()}
	if err := s.SaveCeremony(ctx, bad); err == nil {
		t.Fatal("a create without its sailor")
	}
	bad.Kind = store.CeremonyConfirm
	if err := s.SaveCeremony(ctx, bad); err == nil {
		t.Fatal("a confirm without its account")
	}
}

// TestDeleteAccount: an account goes with its sailor, passkeys, sessions
// and ceremonies; its name is free; its credits keep their places under no
// name; other accounts are left as they were.
func TestDeleteAccount(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	world, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ann, err := s.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", [32]byte{1}))
	if err != nil {
		t.Fatal(err)
	}
	mary, err := s.CreateAccount(ctx, storetest.NewAccount("Mary Read", "maryread", [32]byte{2}))
	if err != nil {
		t.Fatal(err)
	}
	pool := storetest.PoolOn(t, u)
	for i, a := range []store.AccountID{ann, mary} {
		must(t, pool, `INSERT INTO charting (world_id, subject, number, account_id, sailor, account_kind, boat, tick, worth)
			VALUES ($1, 'island', $2, $3, (SELECT name FROM sailor WHERE account_id = $3), 'human', 1, 1, 1)`, world.ID, i, a)
		must(t, pool, `INSERT INTO news_item (world_id, news_column, account_id, sailor, account_kind, subject, number, title, what, worth, x, y)
			VALUES ($1, 'discoveries', $3, (SELECT name FROM sailor WHERE account_id = $3), 'human', 'island', $2, 'T', 'w', 1, 0, 0)`, world.ID, i, a)
	}
	if err := s.SaveCeremony(ctx, store.Ceremony{Hash: [32]byte{3}, Kind: store.CeremonyAdd, Account: ann, HasAccount: true,
		Session: []byte("{}"), Build: "abc", Expires: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteAccount(ctx, ann); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteAccount(ctx, ann); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted twice: %v", err)
	}
	for table, want := range map[string]int{"account": 1, "sailor": 1, "session": 1, "passkey": 1, "webauthn_ceremony": 0} {
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil || n != want {
			t.Errorf("%s: %d rows, want %d (%v)", table, n, want, err)
		}
	}
	rows, err := s.Chartings(ctx, world.ID)
	if err != nil || len(rows) != 2 {
		t.Fatalf("chartings %+v, %v", rows, err)
	}
	if rows[0].Account != ann || rows[0].Sailor != "" || rows[0].AccountKind != "human" || !rows[0].Credited || rows[1].Sailor != "Mary Read" {
		t.Fatalf("the credits: %+v", rows)
	}
	items, _ := s.News(ctx, world.ID, nil, 10)
	for _, it := range items {
		if (it.Number == 0) != (it.Sailor == "") {
			t.Errorf("an item: %+v", it)
		}
	}
	if _, err := s.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", [32]byte{4})); err != nil {
		t.Fatalf("the name once freed: %v", err)
	}
	n, err := s.AccountCounts(ctx)
	if err != nil || n.Total != 2 || n.Week != 2 || n.Today != 2 {
		t.Fatalf("counted %+v, %v", n, err)
	}
}

// TestTools: the owner's flag is set and cleared on a human account, read
// with the session and with the account, and never set on an AI's.
func TestTools(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	hash := sha256.Sum256([]byte("token"))
	id, err := s.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", hash))
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.CreateAccount(ctx, storetest.NewAccount("Mary Read", "maryread", sha256.Sum256([]byte("other"))))
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
	// An AI account, owned by a human's, which is saved from the start.
	pool := storetest.PoolOn(t, u)
	ai := uuidOf(t, pool, "INSERT INTO account (kind, owner_id) VALUES ('ai', $1) RETURNING id", id)
	if err := s.SetTools(ctx, ai, true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an AI's: %v", err)
	}
	if got, err := s.Accounts(ctx, []store.AccountID{ai}); err != nil || got[ai].Kind != store.AI || got[ai].Name != "" {
		t.Fatalf("an AI's account: %+v, %v", got, err)
	}
}
