// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/owner"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// adminFixture is an internal listener with the owner's real routes on
// the test database, and a sailor with a machine sailor and its token.
type adminFixture struct {
	srv        *httptest.Server
	st         *store.Store
	logs       *syncBuffer
	lifetime   *oauth.Lifetime
	ann, mary  store.AccountID
	connection string
}

func newAdminFixture(t *testing.T) *adminFixture {
	t.Helper()
	ctx := context.Background()
	st, _ := storetest.Store(t, store.Options{})
	_, hash := auth.NewToken()
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
	f := &adminFixture{st: st, logs: &syncBuffer{}, lifetime: oauth.NewLifetime(oauth.DefaultLifetime), ann: ann, mary: mary, connection: connection}
	log := obs.NewLogger(f.logs, slog.LevelDebug, "test")
	metrics := obs.NewMetrics("test", "cat")
	sessions := auth.NewCache(st, auth.CacheConfig{})
	hand := accounts.New(accounts.Config{Store: st, Sessions: sessions, Lifetime: f.lifetime.Get, Log: log, Metrics: metrics})
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	wcfg, err := weather.ConfigOf(cat)
	if err != nil {
		t.Fatal(err)
	}
	o := owner.New(owner.Config{Weather: wcfg.Prepared, Accounts: st, Sessions: sessions, Hand: hand, Machines: st, Lifetime: f.lifetime, Log: log, Metrics: metrics})
	f.srv = httptest.NewServer(o.Handler())
	t.Cleanup(f.srv.Close)
	return f
}

// admin runs keel admin against the fixture's listener.
func (f *adminFixture) admin(t *testing.T, stdin string, args ...string) (string, string, error) {
	t.Helper()
	var out, errs bytes.Buffer
	addr := strings.TrimPrefix(f.srv.URL, "http://")
	err := adminWith(context.Background(), append([]string{"-addr", addr}, args...), env(nil), strings.NewReader(stdin), &out, &errs, f.srv.Client())
	return out.String(), errs.String(), err
}

// page posts to a route as the world page does.
func (f *adminFixture) page(t *testing.T, path, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", f.srv.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	res, err := f.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// TestAdmin: each of keel admin's commands, through the page's own routes,
// answering what the page is answered; what it refuses; a lifetime, a
// stop or a deletion without -yes does nothing.
func TestAdmin(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	out, _, err := f.admin(t, "", "search", "bonny")
	if err != nil || !strings.Contains(out, f.ann.String()) || !strings.Contains(out, "Iron Mary") || !strings.Contains(out, "found") {
		t.Fatalf("search: %v\n%s", err, out)
	}
	// The same answer as the page's, as JSON.
	js, _, err := f.admin(t, "", "-json", "search", "bonny")
	status, body := f.page(t, "/owner/api/accounts/search", `{"text":"bonny"}`)
	var a, b accounts.Result
	if err != nil || status != 200 || json.Unmarshal([]byte(js), &a) != nil || json.Unmarshal([]byte(body), &b) != nil ||
		a.Total != b.Total || len(a.Accounts) != 1 || a.Accounts[0].ID != b.Accounts[0].ID {
		t.Fatalf("the command's and the page's: %v %d\n%s\n%s", err, status, js, body)
	}
	// A token read from the standard input, kept out of every log.
	if out, _, err := f.admin(t, f.connection+"\n", "search", "-"); err != nil || !strings.Contains(out, "A connection token") {
		t.Fatalf("a token: %v\n%s", err, out)
	}
	if strings.Contains(f.logs.String(), f.connection) {
		t.Fatal("the token logged")
	}
	if out, _, err := f.admin(t, "", "show", f.mary.String()); err != nil || !strings.Contains(out, "its human: Ann Bonny") ||
		!strings.Contains(out, "connection token made") {
		t.Fatalf("show: %v\n%s", err, out)
	}

	// Without -yes, a stop is only told.
	out, _, err = f.admin(t, "", "stop", f.ann.String(), "-reason", "a test")
	if err != nil || !strings.Contains(out, "Ann Bonny and 1 machine sailor stop") || !strings.Contains(out, "run it again with -yes") {
		t.Fatalf("stop, checked: %v\n%s", err, out)
	}
	if stopped, _ := f.st.Stopped(ctx); len(stopped) != 0 {
		t.Fatal("stopped without -yes")
	}
	if _, errs, err := f.admin(t, "", "stop", f.ann.String()); !errors.Is(err, errAdmin) || !strings.Contains(errs, "a reason is required") {
		t.Fatalf("stop with no reason: %v %s", err, errs)
	}
	if out, _, err := f.admin(t, "", "stop", f.ann.String(), "-reason", "a test", "-yes"); err != nil || !strings.HasPrefix(out, "Done: ") {
		t.Fatalf("stop: %v\n%s", err, out)
	}
	if stopped, _ := f.st.Stopped(ctx); len(stopped) != 2 {
		t.Fatalf("stopped: %v", stopped)
	}
	if out, _, err := f.admin(t, "", "start", f.ann.String()); err != nil || !strings.Contains(out, "start again") {
		t.Fatalf("start: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "revoke", f.mary.String(), "-reason", "leaked", "-yes"); err != nil || !strings.Contains(out, "0 grants of Iron Mary are revoked") {
		t.Fatalf("revoke: %v\n%s", err, out)
	}
	for _, c := range [][]string{{"flag", f.ann.String(), "on"}, {"priority", f.mary.String(), "on"}, {"cap", f.ann.String(), "3"}} {
		if out, _, err := f.admin(t, "", c...); err != nil {
			t.Fatalf("%v: %v\n%s", c, err, out)
		}
	}
	if c, _ := f.st.Card(ctx, f.ann); !c.Tools || c.Cap != 3 {
		t.Fatalf("flag and cap: %+v", c)
	}
	// A flagged account is not deleted.
	if _, errs, err := f.admin(t, "", "delete", f.ann.String(), "-name", "Ann Bonny", "-reason", "asked", "-yes"); !errors.Is(err, errAdmin) ||
		!strings.Contains(errs, "clear its flag") {
		t.Fatalf("delete a flagged account: %v %s", err, errs)
	}

	// The lifetime, told first.
	if out, _, err := f.admin(t, "", "lifetime", "30d"); err != nil || !strings.Contains(out, "ends 0 live grants") || f.lifetime.Get() != oauth.DefaultLifetime {
		t.Fatalf("lifetime, checked: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "lifetime", "30d", "-yes"); err != nil || f.lifetime.Get() != 30*24*time.Hour {
		t.Fatalf("lifetime: %v\n%s", err, out)
	}
	out, _, err = f.admin(t, "", "actions", f.ann.String())
	for _, want := range []string{"stop", "start", "flag", "cap", "by the command"} {
		if err != nil || !strings.Contains(out, want) {
			t.Fatalf("actions, no %q: %v\n%s", want, err, out)
		}
	}
	if out, _, _ := f.admin(t, "", "actions"); !strings.Contains(out, "lifetime") || !strings.Contains(out, "720h0m0s") {
		t.Fatalf("every action:\n%s", out)
	}
	for _, c := range [][]string{{}, {"sideways"}, {"show"}, {"show", "x"}, {"flag", f.ann.String()}, {"cap", f.ann.String(), "x"}, {"lifetime", "soon"}} {
		if _, _, err := f.admin(t, "", c...); !errors.Is(err, errUsage) {
			t.Errorf("%v: %v", c, err)
		}
	}
}

// TestAccountRoutesGuarded: the Accounts tab's routes refuse another
// Host, another site, and a body not JSON, as every control does; a
// check acts on nothing.
func TestAccountRoutesGuarded(t *testing.T) {
	f := newAdminFixture(t)
	body := `{"account":"` + f.ann.String() + `","reason":"x","check":true}`
	for name, req := range map[string]func() *http.Request{
		"another host": func() *http.Request {
			r, _ := http.NewRequest("POST", f.srv.URL+"/owner/api/accounts/stop", strings.NewReader(body))
			r.Host = "keel.example.com"
			r.Header.Set("Content-Type", "application/json")
			return r
		},
		"another site": func() *http.Request {
			r, _ := http.NewRequest("POST", f.srv.URL+"/owner/api/accounts/stop", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Sec-Fetch-Site", "cross-site")
			return r
		},
		"a form": func() *http.Request {
			r, _ := http.NewRequest("POST", f.srv.URL+"/owner/api/accounts/stop", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			return r
		},
	} {
		res, err := f.srv.Client().Do(req())
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode/100 != 4 {
			t.Errorf("%s: %d", name, res.StatusCode)
		}
	}
	for _, path := range []string{"/owner/api/accounts/stop", "/owner/api/accounts/revoke", "/owner/api/accounts/delete"} {
		b := body
		if strings.HasSuffix(path, "delete") {
			b = `{"account":"` + f.ann.String() + `","name":"Ann Bonny","reason":"x","check":true}`
		}
		status, out := f.page(t, path, b)
		var d accounts.Done
		if status != 200 || json.Unmarshal([]byte(out), &d) != nil || d.Done || d.Words == "" {
			t.Fatalf("%s checked: %d %s", path, status, out)
		}
	}
	ctx := context.Background()
	if c, err := f.st.Card(ctx, f.ann); err != nil || !c.Stopped.IsZero() {
		t.Fatalf("after the checks: %+v %v", c, err)
	}
	if acts, _ := f.st.Actions(ctx, nil, 10); len(acts) != 0 {
		t.Fatalf("checks recorded: %+v", acts)
	}
}
