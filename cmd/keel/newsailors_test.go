// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/config"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// memDB counts no new sailors: their store is tested against the test
// database. Its settings are the defaults.

func (noAccounts) NewSailorsFrom(context.Context, []byte, time.Time) (int64, time.Time, error) {
	return 0, time.Now(), nil
}
func (noAccounts) NewSailorSettings(context.Context) (int, bool, error) {
	return store.DefaultNewSailorsPerAddress, true, nil
}
func (noAccounts) SetNewSailorsPerAddress(context.Context, int, store.Action) error { return nil }
func (noAccounts) SetHumanCheck(context.Context, bool, store.Action) error          { return nil }
func (noAccounts) DeleteNewSailors(context.Context, time.Time) (int64, error)       { return 0, nil }

// TestAdminNewSailors: keel admin sets the new sailors an address a day
// and switches the human check, through the page's route, each recorded
// as the command's; keel loads both as it starts.
func TestAdminNewSailors(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	if out, _, err := f.admin(t, "", "newsailors", "2"); err != nil || !strings.Contains(out, "Done: 2 new sailors an address a day.") ||
		!strings.Contains(out, "new sailors: 2 an address a day; the human check on") || f.switches.NewSailorsPerAddress() != 2 {
		t.Fatalf("newsailors 2: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "humancheck", "off"); err != nil || !strings.Contains(out, "the human check off") || f.switches.HumanCheck() {
		t.Fatalf("humancheck off: %v\n%s", err, out)
	}
	if _, errs, err := f.admin(t, "", "newsailors", "1001"); err == nil || !strings.Contains(errs, "newSailorsPerAddress:") {
		t.Fatalf("newsailors 1001: %v %s", err, errs)
	}
	for _, c := range [][]string{{"newsailors"}, {"newsailors", "many"}, {"newsailors", "2", "3"}, {"humancheck"}, {"humancheck", "maybe"}} {
		if _, _, err := f.admin(t, "", c...); err == nil {
			t.Errorf("%v: no error", c)
		}
	}
	acts, err := f.st.Actions(ctx, nil, 10)
	if err != nil || len(acts) != 2 || acts[0].Action != store.ActionHumanCheck || acts[1].Action != store.ActionNewSailors ||
		acts[1].Detail != "2" || acts[0].Source != store.SourceCommand {
		t.Fatalf("the record: %+v %v", acts, err)
	}
	// As keel starts again: the database's settings.
	sw := aboard.NewSwitches(aboard.DefaultLifetime)
	if err := loadNewSailors(ctx, f.st, sw); err != nil || sw.NewSailorsPerAddress() != 2 || sw.HumanCheck() {
		t.Fatalf("loaded: %d %t %v", sw.NewSailorsPerAddress(), sw.HumanCheck(), err)
	}
}

// TestNewSailorsConfig: the address key is the setting's, or one made at
// start, with a warning; the human check only with both keys, its token
// to be for the play host.
func TestNewSailorsConfig(t *testing.T) {
	var logs bytes.Buffer
	log := obs.NewLogger(&logs, slog.LevelInfo, "test")
	key := bytes.Repeat([]byte{3}, 32)
	cfg, err := config.Load(env(map[string]string{
		"KEEL_DATABASE_URL": "postgres://x@127.0.0.1/keel", "KEEL_PLAY_ORIGIN": "https://play.example.com", "KEEL_ADDRESS_KEY": base64.StdEncoding.EncodeToString(key),
		"KEEL_TURNSTILE_SITEKEY": "the-site-key", "KEEL_TURNSTILE_SECRET": "the-secret",
	}))
	if err != nil {
		t.Fatal(err)
	}
	ns, err := newSailors(cfg, noAccounts{}, log)
	if err != nil || !bytes.Equal(ns.Key, key) || ns.Check == nil || ns.SiteKey != "the-site-key" ||
		ns.Script != config.DefaultTurnstileScript {
		t.Fatalf("%+v %v", ns, err)
	}
	if strings.Contains(logs.String(), "the-secret") || strings.Contains(logs.String(), base64.StdEncoding.EncodeToString(key)) {
		t.Fatalf("a secret logged: %s", logs.String())
	}
	logs.Reset()
	cfg, err = config.Load(env(map[string]string{"KEEL_DATABASE_URL": "postgres://x@127.0.0.1/keel", "KEEL_PLAY_ORIGIN": "https://play.example.com"}))
	if err != nil {
		t.Fatal(err)
	}
	ns, err = newSailors(cfg, noAccounts{}, log)
	if err != nil || len(ns.Key) != 32 || ns.Check != nil || !strings.Contains(logs.String(), "KEEL_ADDRESS_KEY is not set") ||
		!strings.Contains(logs.String(), "no human check") {
		t.Fatalf("unset: %+v %v\n%s", ns, err, logs.String())
	}
	again, _ := newSailors(cfg, noAccounts{}, log)
	if bytes.Equal(again.Key, ns.Key) {
		t.Fatal("two starts made one key")
	}
}

// TestNewSailorsJob: each hour, the rows of sailors made a day before or
// more are deleted, the rest kept.
func TestNewSailorsJob(t *testing.T) {
	ctx := context.Background()
	st, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	for i, name := range []string{"Ann Bonny", "Mary Read", "Jack Rackham"} {
		a := storetest.NewAccount(name, strings.ReplaceAll(strings.ToLower(name), " ", ""), sha256.Sum256([]byte{byte(i)}))
		k := sha256.Sum256([]byte("an address"))
		a.From = k[:]
		if _, err := st.CreateAccount(ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, "UPDATE new_sailor_from SET made_at = now() - interval '25 hours' WHERE ctid IN (SELECT ctid FROM new_sailor_from LIMIT 2)"); err != nil {
		t.Fatal(err)
	}
	p := &process{db: st}
	job := p.newSailorsJob()
	now := time.Date(2026, 11, 17, 10, 42, 0, 0, time.UTC)
	if due, ok := job.Due(now); !ok || !due.Equal(time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("due %v %t", due, ok)
	}
	if next := job.Next(now); !next.Equal(time.Date(2026, 11, 17, 11, 0, 0, 0, time.UTC)) {
		t.Fatalf("next %v", next)
	}
	res, err := job.Run(ctx, time.Now().Truncate(time.Hour))
	if err != nil || res.Skipped || res.Detail != "2 addresses of new sailors a day old forgotten" {
		t.Fatalf("%+v %v", res, err)
	}
	var left int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM new_sailor_from").Scan(&left); err != nil || left != 1 {
		t.Fatalf("left %d %v", left, err)
	}
	if res, err := job.Run(ctx, time.Now().Truncate(time.Hour)); err != nil || !res.Skipped {
		t.Fatalf("again: %+v %v", res, err)
	}
}
