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

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/owner"
	"github.com/daneelvt/keel-over-the-edge/internal/review"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// adminFixture is an internal listener with the owner's real routes on
// the test database, its reports and chat's switches, and a sailor with a
// machine sailor and its token.
type adminFixture struct {
	srv        *httptest.Server
	st         *store.Store
	logs       *syncBuffer
	lifetime   *oauth.Lifetime
	switches   *aboard.Switches
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
	f.switches = aboard.NewSwitches(aboard.DefaultLifetime)
	o := owner.New(owner.Config{Weather: wcfg.Prepared, Accounts: st, Sessions: sessions, Hand: hand, Machines: st, Lifetime: f.lifetime, Log: log, Metrics: metrics,
		Switches: f.switches, Sail: st, ChatSettings: st, Reports: review.New(review.Config{Store: st, Hand: hand, Log: log, Metrics: metrics})})
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

// TestAdminReports: the queue, a report whole with its lines, and the
// owner's actions on it, each only told without -yes; what keel refuses
// is told and does nothing.
func TestAdminReports(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	_, hash := auth.NewToken()
	jack, err := f.st.CreateAccount(ctx, storetest.NewAccount("Calico Jack", "calicojack", hash))
	if err != nil {
		t.Fatal(err)
	}
	if out, _, err := f.admin(t, "", "reports"); err != nil || out != "No report is open.\n" {
		t.Fatalf("no reports: %v %q", err, out)
	}
	at := time.Now().Add(-time.Minute).UTC().Truncate(time.Microsecond)
	made, err := f.st.MakeReport(ctx, store.NewReport{
		Source: store.ReportByPlayer, Reason: store.ReasonChild, Note: "asked \x1b[31mher age",
		Reporter: jack, HasReporter: true, ReporterName: "Calico Jack",
		Reported: f.mary, HasReported: true, ReportedKind: store.AI, ReportedName: "Iron Mary", Owner: f.ann, HasOwner: true,
		Place: "aboard Calico Jack’s boat", People: []store.ReportPerson{{Name: "Calico Jack", Band: "13-17", Skipper: true}, {Name: "Iron Mary", Band: "adult", Machine: true}},
		Lines: []store.ReportLine{
			{Line: 7, At: at, Sender: f.mary, HasSender: true, Name: "Iron Mary", Machine: true, Text: "how old are you?", Reported: true},
			{Line: 8, At: at.Add(time.Second), Sender: jack, HasSender: true, Name: "Calico Jack", Text: "<b>twelve</b>"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	id := store.AccountID(made.ID).String()
	out, _, err := f.admin(t, "", "reports")
	for _, want := range []string{"1 report open.", "CHILD SAFETY  " + id, `"Calico Jack" reported "Iron Mary" (machine sailor)`, "2 lines held", "a child may be at risk"} {
		if err != nil || !strings.Contains(out, want) {
			t.Fatalf("reports, no %q: %v\n%s", want, err, out)
		}
	}
	out, _, err = f.admin(t, "", "report", id)
	for _, want := range []string{
		"CHILD SAFETY: report " + id, "its human " + f.ann.String(), `"Calico Jack" (13-17, skipper)`, `the note: "asked \x1b[31mher age"`,
		"-line 7 -at " + at.Format(time.RFC3339Nano) + `  "Iron Mary" (machine sailor): "how old are you?"  <- REPORTED`, `"<b>twelve</b>"`,
	} {
		if err != nil || !strings.Contains(out, want) {
			t.Fatalf("report, no %q: %v\n%s", want, err, out)
		}
	}
	if strings.Contains(out, "\x1b") {
		t.Fatalf("a control character reached the terminal:\n%s", out)
	}
	js, _, err := f.admin(t, "", "-json", "report", id)
	var rep owner.ReportJSON
	if err != nil || json.Unmarshal([]byte(js), &rep) != nil || len(rep.Lines) != 2 || rep.Owner != f.ann.String() {
		t.Fatalf("report as JSON: %v\n%s", err, js)
	}

	// Told first, then done: a line removed.
	out, _, err = f.admin(t, "", "act", id, "remove-line", "-line", "8", "-at", rep.Lines[1].At)
	if err != nil || !strings.Contains(out, "The line goes") || !strings.Contains(out, "Nothing is done yet") {
		t.Fatalf("remove-line, checked: %v\n%s", err, out)
	}
	if r, _ := f.st.Report(ctx, made.ID); len(r.Lines) != 2 {
		t.Fatalf("a check removed a line: %+v", r.Lines)
	}
	if out, _, err = f.admin(t, "", "act", id, "remove-line", "-line", "8", "-at", rep.Lines[1].At, "-yes"); err != nil || !strings.HasPrefix(out, "Done: ") {
		t.Fatalf("remove-line: %v\n%s", err, out)
	}
	if r, _ := f.st.Report(ctx, made.ID); len(r.Lines) != 1 || r.Lines[0].Line != 7 {
		t.Fatalf("after remove-line: %+v", r.Lines)
	}
	// A mute of 3 days, or of a line never held, refused.
	if _, errs, err := f.admin(t, "", "act", id, "mute-chat", "-days", "3", "-yes"); !errors.Is(err, errAdmin) || !strings.Contains(errs, "1, 7 or 30 days") {
		t.Fatalf("a mute of 3 days: %v %s", err, errs)
	}
	if _, _, err := f.admin(t, "", "act", id, "remove-line", "-line", "99", "-yes"); !errors.Is(err, errAdmin) {
		t.Fatalf("no such line: %v", err)
	}
	if _, _, err := f.admin(t, "", "act", id, "keelhaul", "-yes"); !errors.Is(err, errAdmin) {
		t.Fatalf("no such action: %v", err)
	}
	// The mute reaches the machine sailor's human, and closes the report.
	out, _, err = f.admin(t, "", "act", id, "mute-chat", "-days", "7", "-reason", "asked a child's age", "-note", "her age")
	if err != nil || !strings.Contains(out, "Ann Bonny’s chat is muted for 7 days") || !strings.Contains(out, "Nothing is done yet") {
		t.Fatalf("mute, checked: %v\n%s", err, out)
	}
	if out, _, err = f.admin(t, "", "act", id, "mute-chat", "-days", "7", "-reason", "asked a child's age", "-note", "her age", "-yes"); err != nil ||
		!strings.HasPrefix(out, "Done: Ann Bonny’s chat is muted") {
		t.Fatalf("mute: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "reports"); err != nil || out != "No report is open.\n" {
		t.Fatalf("after the mute: %v %q", err, out)
	}
	if out, _, err := f.admin(t, "", "report", id); err != nil || !strings.Contains(out, "closed ") || !strings.Contains(out, "mute-chat") {
		t.Fatalf("the report after the mute: %v\n%s", err, out)
	}
	// The report rested the human's chat, the game's doing; the rest is
	// the command's.
	acts, err := f.st.Actions(ctx, nil, 10)
	if err != nil || len(acts) != 3 || acts[2].Action != store.ActionRest {
		t.Fatalf("the record: %+v %v", acts, err)
	}
	for _, a := range acts[:2] {
		if a.Source != store.SourceCommand {
			t.Errorf("recorded as %s: %+v", a.Source, a)
		}
	}
	for _, c := range [][]string{{"report"}, {"report", "nine"}, {"act", id}, {"act"}, {"act", "nine", "warn"}, {"reports", "all"}} {
		if _, _, err := f.admin(t, "", c...); !errors.Is(err, errUsage) {
			t.Errorf("%v: %v", c, err)
		}
	}
}

// TestAdminChat: chat's switches, chat off only told without -yes; the
// countries as keel takes them, "" clearing them.
func TestAdminChat(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	if out, _, err := f.admin(t, "", "settings"); err != nil || !strings.HasSuffix(out, "\nchat on; shipmates' messages on; chat off in no country\n") {
		t.Fatalf("settings: %v %q", err, out)
	}
	if out, _, err := f.admin(t, "", "chat", "off"); err != nil || !strings.Contains(out, "Would set: chat off for everyone") ||
		!strings.Contains(out, "Nothing is done yet") || !f.switches.Chat() {
		t.Fatalf("chat off, checked: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "chat", "off", "-yes"); err != nil || !strings.Contains(out, "chat off; shipmates' messages on") || f.switches.Chat() {
		t.Fatalf("chat off: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "chat", "on"); err != nil || !f.switches.Chat() || !strings.Contains(out, "Done: chat on for everyone") {
		t.Fatalf("chat on: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "shipmates", "off"); err != nil || f.switches.ShipmateMessages() || !strings.Contains(out, "shipmates' messages off") {
		t.Fatalf("shipmates off: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "countries", "br, AU"); err != nil || !strings.Contains(out, "chat off in AU, BR") || !f.switches.ChatOffIn("BR") {
		t.Fatalf("countries: %v\n%s", err, out)
	}
	if _, errs, err := f.admin(t, "", "countries", "BRA"); !errors.Is(err, errAdmin) || !strings.Contains(errs, "two letters each") || !f.switches.ChatOffIn("AU") {
		t.Fatalf("a country of three letters: %v %s", err, errs)
	}
	if out, _, err := f.admin(t, "", "-json", "settings"); err != nil || !strings.Contains(out, `"chatCountries": [`) || !strings.Contains(out, `"shipmateMessages": false`) {
		t.Fatalf("settings as JSON: %v\n%s", err, out)
	}
	if out, _, err := f.admin(t, "", "countries", ""); err != nil || !strings.Contains(out, "chat off in no country") || f.switches.ChatOffIn("AU") {
		t.Fatalf("countries cleared: %v\n%s", err, out)
	}
	on, ship, countries, err := f.st.ChatSettings(ctx)
	if err != nil || !on || ship || len(countries) != 0 {
		t.Fatalf("the database: %v %v %v %v", on, ship, countries, err)
	}
	for _, c := range [][]string{{"chat"}, {"chat", "maybe"}, {"shipmates", "on", "now"}, {"countries"}, {"countries", "BR", "AU"}} {
		if _, _, err := f.admin(t, "", c...); !errors.Is(err, errUsage) {
			t.Errorf("%v: %v", c, err)
		}
	}
	acts, err := f.st.Actions(ctx, nil, 10)
	if err != nil || len(acts) != 5 {
		t.Fatalf("the record: %+v %v", acts, err)
	}
}
