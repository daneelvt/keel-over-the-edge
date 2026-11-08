// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/sha256"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// memDB keeps no links and no answers: sailing together's store is
// tested against the test database. Its switches are the defaults.

func (noAccounts) SetBorn(context.Context, store.AccountID, int32) error { return store.ErrNotFound }
func (noAccounts) AcceptRules(context.Context, store.AccountID) error    { return store.ErrNotFound }
func (noAccounts) MakeSailLink(context.Context, store.AccountID, [32]byte, time.Time, time.Time) error {
	return errNoAccounts
}
func (noAccounts) EndSailLink(context.Context, store.AccountID) (bool, error) { return false, nil }
func (noAccounts) LiveSailLink(context.Context, store.AccountID) (time.Time, time.Time, bool, error) {
	return time.Time{}, time.Time{}, false, nil
}
func (noAccounts) SailLink(context.Context, [32]byte) (store.SailLink, error) {
	return store.SailLink{}, store.ErrNotFound
}
func (noAccounts) Knocker(context.Context, store.AccountID) (store.Knocker, error) {
	return store.Knocker{}, store.ErrNotFound
}
func (noAccounts) SetLinkLifetime(context.Context, time.Duration, store.Action) error { return nil }
func (noAccounts) SetLinks(context.Context, bool, store.Action) (int64, error)        { return 0, nil }
func (noAccounts) SetBoarding(context.Context, bool, store.Action) error              { return nil }
func (noAccounts) CountLiveSailLinks(context.Context, time.Duration) (int64, error)   { return 0, nil }
func (noAccounts) SailLinksEndedBy(context.Context, time.Duration, time.Duration) (int64, error) {
	return 0, nil
}
func (noAccounts) SailSettings(context.Context) (time.Duration, bool, bool, error) {
	return aboard.DefaultLifetime, true, true, nil
}
func (noAccounts) DeleteSailLinks(context.Context, time.Time, time.Duration) (int64, error) {
	return 0, nil
}

// TestAdminSettings: keel admin tells the switches for sailing together
// and sets them through the page's own route; links off and linklife only
// say what they would do without -yes; each is recorded as the command's.
func TestAdminSettings(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	now := time.Now()
	if err := f.st.MakeSailLink(ctx, f.ann, sha256.Sum256([]byte("link")), now.Add(-2*time.Hour), now.Add(22*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if out, _, err := f.admin(t, "", "settings"); err != nil || out != "a link lasts 24h0m0s; links on; boarding on\nchat on; shipmates' messages on; chat off in no country\n" {
		t.Fatalf("settings: %v %q", err, out)
	}
	if out, _, err := f.admin(t, "", "linklife", "1h"); err != nil || !strings.Contains(out, "stops 1 working link") ||
		!strings.Contains(out, "Nothing is done yet") || f.switches.Lifetime() != aboard.DefaultLifetime {
		t.Fatalf("linklife, checked: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "linklife", "1h", "-yes"); err != nil || !strings.Contains(out, "a link lasts 1h0m0s; links on") || f.switches.Lifetime() != time.Hour {
		t.Fatalf("linklife: %v\n%s", err, out)
	}
	if _, errs, err := f.admin(t, "", "linklife", "8d", "-yes"); err == nil || !strings.Contains(errs, "lifetime:") {
		t.Fatalf("linklife of 8 days: %v %s", err, errs)
	}
	f.switches.SetLifetime(aboard.DefaultLifetime)
	if out, _, err := f.admin(t, "", "links", "off"); err != nil || !strings.Contains(out, "stops 1 working link") || !f.switches.Links() {
		t.Fatalf("links off, checked: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "links", "off", "-yes"); err != nil || !strings.Contains(out, "links off") || f.switches.Links() {
		t.Fatalf("links off: %v\n%s", err, out)
	}
	if l, err := f.st.SailLink(ctx, sha256.Sum256([]byte("link"))); err != nil || !l.Ended {
		t.Fatalf("the link after links off: %+v %v", l, err)
	}
	if out, _, err := f.admin(t, "", "links", "on"); err != nil || !f.switches.Links() || !strings.Contains(out, "links on") {
		t.Fatalf("links on: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "boarding", "off"); err != nil || f.switches.Boarding() || !strings.Contains(out, "boarding off") {
		t.Fatalf("boarding off: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "-json", "settings"); err != nil || !strings.Contains(out, `"boarding": false`) {
		t.Fatalf("settings as JSON: %v\n%s", err, out)
	}
	for _, c := range [][]string{{"links"}, {"links", "maybe"}, {"boarding", "on", "now"}, {"linklife"}, {"linklife", "soon"}} {
		if _, _, err := f.admin(t, "", c...); err == nil {
			t.Errorf("%v: no error", c)
		}
	}
	acts, err := f.st.Actions(ctx, nil, 10)
	if err != nil || len(acts) != 4 {
		t.Fatalf("the record: %+v %v", acts, err)
	}
	for _, a := range acts {
		if a.Source != store.SourceCommand {
			t.Errorf("recorded as %s: %+v", a.Source, a)
		}
	}
}
