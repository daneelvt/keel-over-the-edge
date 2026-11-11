// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestAboardSchema: a month of birth is plausible, a machine sailor has
// none and accepts no rules, a skipper has one live link, the owner's
// lifetime stays within its bounds, and the record takes the new actions.
func TestAboardSchema(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	ann, err := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("t")))))
	if err != nil {
		t.Fatal(err)
	}
	ai, err := s.CreateMachine(ctx, ann, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []int{189912, 200100, 200113, 210101, 2001} {
		refused(t, exec(t, pool, "UPDATE account SET born = $2 WHERE id = $1", ann, bad), "23514")
	}
	must(t, pool, "UPDATE account SET born = 200104, rules_at = now() WHERE id = $1", ann)
	refused(t, exec(t, pool, "UPDATE account SET born = 200104 WHERE id = $1", ai), "23514")
	refused(t, exec(t, pool, "UPDATE account SET rules_at = now() WHERE id = $1", ai), "23514")

	h := func(b byte) []byte { x := sha256.Sum256([]byte{b}); return x[:] }
	must(t, pool, "INSERT INTO sail_link (skipper_id, hash, made_at, expires_at) VALUES ($1, $2, now(), now() + interval '1 hour')", ann, h(1))
	refused(t, exec(t, pool, "INSERT INTO sail_link (skipper_id, hash, made_at, expires_at) VALUES ($1, $2, now(), now() + interval '1 hour')", ann, h(2)), "23505")
	refused(t, exec(t, pool, "INSERT INTO sail_link (skipper_id, hash, made_at, expires_at, ended_at) VALUES ($1, $2, now(), now() + interval '1 hour', now())", ann, h(1)), "23505")
	refused(t, exec(t, pool, "INSERT INTO sail_link (skipper_id, hash, made_at, expires_at, ended_at) VALUES ($1, $2, now(), now() + interval '1 hour', now())", ann, []byte("short")), "23514")
	refused(t, exec(t, pool, "INSERT INTO sail_link (skipper_id, hash, made_at, expires_at, ended_at) VALUES ($1, $2, now(), now(), now())", ann, h(3)), "23514")
	must(t, pool, "INSERT INTO sail_link (skipper_id, hash, made_at, expires_at, ended_at) VALUES ($1, $2, now(), now() + interval '1 hour', now())", ann, h(4))

	refused(t, exec(t, pool, "UPDATE setting SET link_lifetime = interval '4 minutes'"), "23514")
	refused(t, exec(t, pool, "UPDATE setting SET link_lifetime = interval '7 days 1 second'"), "23514")
	must(t, pool, "UPDATE setting SET link_lifetime = interval '7 days'")

	for _, a := range []string{"link-lifetime", "links", "boarding"} {
		must(t, pool, "INSERT INTO account_action (action, source) VALUES ($1, 'page')", a)
		refused(t, exec(t, pool, "INSERT INTO account_action (action, account_id, source) VALUES ($1, $2, 'page')", a, ann), "23514")
	}
	must(t, pool, "INSERT INTO account_action (action, account_id, kind, source) VALUES ('young', $1, 'human', 'game')", ann)
	refused(t, exec(t, pool, "INSERT INTO account_action (action, source) VALUES ('young', 'game')"), "23514")
	refused(t, exec(t, pool, "INSERT INTO account_action (action, source) VALUES ('older', 'page')"), "23514")
	refused(t, exec(t, pool, "INSERT INTO account_action (action, account_id, source) VALUES ('stop', $1, 'cron')", ann), "23514")

	// A ceremony keeps a new sailor's month of birth, and only a create.
	c := store.Ceremony{Hash: [32]byte{9}, Kind: store.CeremonyCreate, Name: "Mary Read", NameKey: "maryread", Look: storetest.Look,
		UserHandle: make([]byte, 64), Session: []byte("{}"), Build: "abc", Expires: time.Now().Add(time.Minute).Truncate(time.Microsecond), Born: 199912}
	if err := s.SaveCeremony(ctx, c); err != nil {
		t.Fatal(err)
	}
	got, err := s.TakeCeremony(ctx, c.Hash, store.CeremonyCreate)
	if err != nil || got.Born != 199912 {
		t.Fatalf("the ceremony's month of birth: %d, %v", got.Born, err)
	}
	if err := s.SaveCeremony(ctx, store.Ceremony{Hash: [32]byte{10}, Kind: store.CeremonyConfirm, Account: ann, HasAccount: true,
		Session: []byte("{}"), Build: "abc", Expires: time.Now(), Born: 199912}); err == nil {
		t.Fatal("a confirm with a month of birth")
	}
}

// TestBornAndRules: a month of birth is kept as an account is made, or
// given once by an older account; the Rules of the sea are accepted once;
// the session and a knock read both.
func TestBornAndRules(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	made := withBoat(storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("ann"))))
	made.Born = 200104
	ann, err := s.CreateAccount(ctx, made)
	if err != nil {
		t.Fatal(err)
	}
	older, err := s.CreateAccount(ctx, storetest.NewAccount("Mary Read", "maryread", sha256.Sum256([]byte("mary"))))
	if err != nil {
		t.Fatal(err)
	}
	ai, err := s.CreateMachine(ctx, ann, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	sess, err := s.Session(ctx, sha256.Sum256([]byte("ann")))
	if err != nil || sess.Born != 200104 || sess.Rules {
		t.Fatalf("ann's session: %+v, %v", sess.Account, err)
	}
	if err := s.SetBorn(ctx, ann, 199001); !errors.Is(err, store.ErrAnswered) {
		t.Fatalf("answered twice: %v", err)
	}
	k, err := s.Knocker(ctx, older)
	if err != nil || k.Born != 0 || k.Rules || k.Name != "Mary Read" || k.Kind != store.Human || k.Look != storetest.Look {
		t.Fatalf("mary before: %+v, %v", k, err)
	}
	if err := s.SetBorn(ctx, older, 199506); err != nil {
		t.Fatal(err)
	}
	if err := s.SetBorn(ctx, older, 199507); !errors.Is(err, store.ErrAnswered) {
		t.Fatalf("mary answered twice: %v", err)
	}
	if err := s.SetBorn(ctx, ai, 199507); !errors.Is(err, store.ErrNotHuman) {
		t.Fatalf("a machine sailor's: %v", err)
	}
	if err := s.SetBorn(ctx, store.AccountID{1}, 199507); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("no account's: %v", err)
	}
	if err := s.AcceptRules(ctx, older); err != nil {
		t.Fatal(err)
	}
	if err := s.AcceptRules(ctx, older); err != nil {
		t.Fatalf("accepted again: %v", err)
	}
	if err := s.AcceptRules(ctx, ai); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a machine sailor's rules: %v", err)
	}
	k, err = s.Knocker(ctx, older)
	if err != nil || k.Born != 199506 || !k.Rules {
		t.Fatalf("mary after: %+v, %v", k, err)
	}
	sess, err = s.Session(ctx, sha256.Sum256([]byte("mary")))
	if err != nil || sess.Born != 199506 || !sess.Rules {
		t.Fatalf("mary's session: %+v, %v", sess.Account, err)
	}
	if _, err := s.Knocker(ctx, store.AccountID{1}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("no knocker: %v", err)
	}
}

// TestSailLinks: a new link ends the skipper's old one in the same
// transaction; a link is found by its hash; links end one at a time or
// all at once; the lifetime in force counts and shortens them; they are
// deleted a day after they stop working, and with their skipper.
func TestSailLinks(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	ann, err := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("ann")))))
	if err != nil {
		t.Fatal(err)
	}
	mary, err := s.CreateAccount(ctx, storetest.NewAccount("Mary Read", "maryread", sha256.Sum256([]byte("mary"))))
	if err != nil {
		t.Fatal(err)
	}
	ai, err := s.CreateMachine(ctx, ann, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Truncate(time.Microsecond)
	day := 24 * time.Hour
	first, second, third := sha256.Sum256([]byte("1")), sha256.Sum256([]byte("2")), sha256.Sum256([]byte("3"))
	if _, _, ok, err := s.LiveSailLink(ctx, ann); ok || err != nil {
		t.Fatalf("a link before any: %v %v", ok, err)
	}
	if err := s.MakeSailLink(ctx, ann, first, now, now.Add(day)); err != nil {
		t.Fatal(err)
	}
	l, err := s.SailLink(ctx, first)
	if err != nil || l.Skipper != ann || l.Name != "Ann Bonny" || l.Kind != store.Human || l.Look != storetest.Look ||
		!l.Made.Equal(now) || !l.Expires.Equal(now.Add(day)) || l.Ended {
		t.Fatalf("the first link: %+v, %v", l, err)
	}
	if err := s.MakeSailLink(ctx, ann, second, now, now.Add(day)); err != nil {
		t.Fatal(err)
	}
	if l, err := s.SailLink(ctx, first); err != nil || !l.Ended {
		t.Fatalf("the first link after the second: %+v, %v", l, err)
	}
	if err := s.MakeSailLink(ctx, mary, second, now, now.Add(day)); !errors.Is(err, store.ErrTokenTaken) {
		t.Fatalf("a hash taken: %v", err)
	}
	if err := s.MakeSailLink(ctx, ai, third, now, now.Add(day)); !errors.Is(err, store.ErrNotHuman) {
		t.Fatalf("a machine sailor's link: %v", err)
	}
	if _, err := s.SailLink(ctx, third); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("no link: %v", err)
	}
	made, expires, ok, err := s.LiveSailLink(ctx, ann)
	if err != nil || !ok || !made.Equal(now) || !expires.Equal(now.Add(day)) {
		t.Fatalf("ann's live link: %v %v %v %v", made, expires, ok, err)
	}
	// Mary's was made two hours ago: an hour's lifetime stops it, not
	// ann's.
	if err := s.MakeSailLink(ctx, mary, third, now.Add(-2*time.Hour), now.Add(day)); err != nil {
		t.Fatal(err)
	}
	if n, err := s.CountLiveSailLinks(ctx, day); err != nil || n != 2 {
		t.Fatalf("live under a day: %d, %v", n, err)
	}
	if n, err := s.CountLiveSailLinks(ctx, time.Hour); err != nil || n != 1 {
		t.Fatalf("live under an hour: %d, %v", n, err)
	}
	if n, err := s.SailLinksEndedBy(ctx, day, time.Hour); err != nil || n != 1 {
		t.Fatalf("stopped by an hour: %d, %v", n, err)
	}
	if n, err := s.SailLinksEndedBy(ctx, time.Hour, day); err != nil || n != 0 {
		t.Fatalf("stopped by a longer lifetime: %d, %v", n, err)
	}
	if ended, err := s.EndSailLink(ctx, mary); err != nil || !ended {
		t.Fatalf("mary's ended: %v %v", ended, err)
	}
	if ended, err := s.EndSailLink(ctx, mary); err != nil || ended {
		t.Fatalf("mary's ended twice: %v %v", ended, err)
	}
	if _, _, ok, _ := s.LiveSailLink(ctx, mary); ok {
		t.Fatal("mary's live link after its end")
	}
	if err := s.MakeSailLink(ctx, mary, sha256.Sum256([]byte("4")), now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if n, err := s.EndAllSailLinks(ctx); err != nil || n != 2 {
		t.Fatalf("all ended: %d, %v", n, err)
	}
	if n, err := s.CountLiveSailLinks(ctx, day); err != nil || n != 0 {
		t.Fatalf("live after all ended: %d, %v", n, err)
	}

	// The sweep: nothing stopped a day ago yet; then everything ended.
	if n, err := s.DeleteSailLinks(ctx, time.Now().Add(-day), day); err != nil || n != 0 {
		t.Fatalf("deleted a day early: %d, %v", n, err)
	}
	if err := s.MakeSailLink(ctx, ann, sha256.Sum256([]byte("5")), now, now.Add(2*day)); err != nil {
		t.Fatal(err)
	}
	if n, err := s.DeleteSailLinks(ctx, time.Now().Add(time.Second), day); err != nil || n != 4 {
		t.Fatalf("the ended deleted: %d, %v", n, err)
	}
	// One that works on stays until its lifetime is up; then a day more.
	if n, err := s.DeleteSailLinks(ctx, now.Add(day-time.Second), day); err != nil || n != 0 {
		t.Fatalf("a live one deleted: %d, %v", n, err)
	}
	if n, err := s.DeleteSailLinks(ctx, now.Add(day+time.Second), day); err != nil || n != 1 {
		t.Fatalf("one past its lifetime: %d, %v", n, err)
	}

	// A deleted skipper's links go with it.
	if err := s.MakeSailLink(ctx, mary, sha256.Sum256([]byte("6")), now, now.Add(day)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteAccount(ctx, mary); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM sail_link").Scan(&n); err != nil || n != 0 {
		t.Fatalf("links after the deletion: %d, %v", n, err)
	}
}

// TestMachineSailLinks: a machine sailor's link is made by its owner
// alone, ends the one before, and is found with its owner.
func TestMachineSailLinks(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	ann, err := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("ann")))))
	if err != nil {
		t.Fatal(err)
	}
	bob, err := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Bob Read", "bobread", sha256.Sum256([]byte("bob")))))
	if err != nil {
		t.Fatal(err)
	}
	ai, err := s.CreateMachine(ctx, ann, store.NewMachine{Name: "Iron Mary", NameKey: "ironmary", Version: "v", Finish: "f", Colour: "c"}, "jolly-boat")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Truncate(time.Microsecond)
	first, second := sha256.Sum256([]byte("m1")), sha256.Sum256([]byte("m2"))
	if err := s.MakeMachineSailLink(ctx, bob, ai, first, now, now.Add(time.Hour)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another's machine sailor's link: %v", err)
	}
	if err := s.MakeMachineSailLink(ctx, ann, ann, first, now, now.Add(time.Hour)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a human's link as a machine sailor's: %v", err)
	}
	if mine, err := s.OwnsMachine(ctx, ann, ai); err != nil || !mine {
		t.Fatalf("Ann owns Iron Mary: %v %v", mine, err)
	}
	if mine, err := s.OwnsMachine(ctx, bob, ai); err != nil || mine {
		t.Fatalf("Bob owns Iron Mary: %v %v", mine, err)
	}
	if err := s.MakeMachineSailLink(ctx, ann, ai, first, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.MakeMachineSailLink(ctx, ann, ai, second, now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if l, err := s.SailLink(ctx, first); err != nil || !l.Ended {
		t.Fatalf("the first link after the second: %+v %v", l, err)
	}
	l, err := s.SailLink(ctx, second)
	if err != nil || l.Skipper != ai || l.Owner != ann || l.Kind != store.AI || l.Name != "Iron Mary" || l.Ended {
		t.Fatalf("the machine sailor's link: %+v %v", l, err)
	}
	if l, err := s.SailLink(ctx, sha256.Sum256([]byte("none"))); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("no link: %+v %v", l, err)
	}
}

// TestSailSettings: the owner's switches start on with a day's lifetime;
// each is set with its entry in the record; links off ends every live
// link.
func TestSailSettings(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	life, links, boarding, err := s.SailSettings(ctx)
	if err != nil || life != 24*time.Hour || !links || !boarding {
		t.Fatalf("the settings at first: %v %v %v %v", life, links, boarding, err)
	}
	ann, err := s.CreateAccount(ctx, withBoat(storetest.NewAccount("Ann Bonny", "annbonny", sha256.Sum256([]byte("ann")))))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := s.MakeSailLink(ctx, ann, sha256.Sum256([]byte("1")), now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	a := store.Action{Source: store.SourceCommand, From: "127.0.0.1:1"}
	if err := s.SetLinkLifetime(ctx, 5*time.Minute, store.Action{Detail: "5m0s", Source: store.SourcePage}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLinkLifetime(ctx, time.Minute, a); err == nil {
		t.Fatal("a lifetime of a minute")
	}
	if err := s.SetBoarding(ctx, false, a); err != nil {
		t.Fatal(err)
	}
	ended, err := s.SetLinks(ctx, false, a)
	if err != nil || ended != 1 {
		t.Fatalf("links off: %d, %v", ended, err)
	}
	life, links, boarding, err = s.SailSettings(ctx)
	if err != nil || life != 5*time.Minute || links || boarding {
		t.Fatalf("the settings set: %v %v %v %v", life, links, boarding, err)
	}
	if l, err := s.SailLink(ctx, sha256.Sum256([]byte("1"))); err != nil || !l.Ended {
		t.Fatalf("the link after links off: %+v, %v", l, err)
	}
	if ended, err := s.SetLinks(ctx, true, a); err != nil || ended != 0 {
		t.Fatalf("links on: %d, %v", ended, err)
	}
	acts, err := s.Actions(ctx, nil, 10)
	if err != nil || len(acts) != 4 {
		t.Fatalf("the record: %+v, %v", acts, err)
	}
	want := []string{store.ActionLinks, store.ActionLinks, store.ActionBoarding, store.ActionLinkLifetime}
	for i, act := range acts {
		if act.Action != want[i] || act.HasAccount {
			t.Errorf("action %d: %+v, want %s", i, act, want[i])
		}
	}
	if acts[3].Detail != "5m0s" || acts[3].Source != store.SourcePage || acts[0].Source != store.SourceCommand {
		t.Errorf("the record's details: %+v", acts)
	}
}
