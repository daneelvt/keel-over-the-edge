// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// fakeSail is the database's switches and links in memory: the links'
// ages, those ended, and each write with the switches in memory as it
// found them.
type fakeSail struct {
	mu       sync.Mutex
	ages     []time.Duration
	ended    []bool
	switches *aboard.Switches
	writes   []string
	actions  []store.Action
}

func (f *fakeSail) wrote(what string, a store.Action, sw *aboard.Switches) {
	f.writes = append(f.writes, what+" over "+onOff(sw.Links())+"/"+onOff(sw.Boarding())+"/"+sw.Lifetime().String())
	f.actions = append(f.actions, a)
}

func (f *fakeSail) SetLinkLifetime(_ context.Context, d time.Duration, a store.Action) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wrote("lifetime "+d.String(), a, f.switches)
	return nil
}

func (f *fakeSail) SetLinks(_ context.Context, on bool, a store.Action) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wrote("links "+onOff(on), a, f.switches)
	n := int64(0)
	if !on {
		for i := range f.ended {
			if !f.ended[i] {
				f.ended[i] = true
				n++
			}
		}
	}
	return n, nil
}

func (f *fakeSail) SetBoarding(_ context.Context, on bool, a store.Action) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wrote("boarding "+onOff(on), a, f.switches)
	return nil
}

func (f *fakeSail) CountLiveSailLinks(_ context.Context, life time.Duration) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := int64(0)
	for i, a := range f.ages {
		if !f.ended[i] && a < life {
			n++
		}
	}
	return n, nil
}

func (f *fakeSail) SailLinksEndedBy(_ context.Context, now, d time.Duration) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := int64(0)
	for i, a := range f.ages {
		if !f.ended[i] && a < now && a >= d {
			n++
		}
	}
	return n, nil
}

// sailRig is the owner's tools with three live links, a minute, two hours
// and a day less a minute old, under a day's lifetime.
func sailRig(t *testing.T) (*rig, *fakeSail) {
	t.Helper()
	r := newRig(t, 0)
	sw := aboard.NewSwitches(aboard.DefaultLifetime)
	f := &fakeSail{ages: []time.Duration{time.Minute, 2 * time.Hour, 24*time.Hour - time.Minute}, ended: make([]bool, 3), switches: sw}
	r.o.cfg.Switches, r.o.cfg.Sail = sw, f
	return r, f
}

func settingsCall(t *testing.T, r *rig, req any) (int, SettingsAnswer, string) {
	t.Helper()
	code, body := r.do(t, "POST", "/owner/api/settings", req)
	var a SettingsAnswer
	if code == 200 {
		if err := json.Unmarshal(body, &a); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
	}
	return code, a, string(body)
}

func seconds(d time.Duration) *int64 { s := int64(d / time.Second); return &s }
func yes(b bool) *bool               { return &b }

// TestSettings: settings.json tells the switches; a check changes
// nothing and counts the working links a change would stop; a change
// writes the database first, then memory, each recorded with where it
// came from; links off ends every live link; a lowered lifetime counts
// those it shortens to nothing and ends none.
func TestSettings(t *testing.T) {
	r, f := sailRig(t)
	code, body := r.do(t, "GET", "/owner/api/settings.json", nil)
	if code != 200 || strings.TrimSpace(string(body)) != `{"linkLifetime":86400,"links":true,"boarding":true,"chat":true,"shipmateMessages":true,"spectatorChat":true,"chatCountries":[]}` {
		t.Fatalf("settings.json: %d %s", code, body)
	}
	for _, s := range []int64{299, 604801, 0, -300} {
		if code, _, body := settingsCall(t, r, SettingsRequest{LinkLifetime: &s}); code != 400 || !strings.HasPrefix(body, "lifetime:") {
			t.Errorf("%d s: %d %s", s, code, body)
		}
	}
	if code, _, _ := settingsCall(t, r, SettingsRequest{}); code != 400 {
		t.Errorf("nothing: %d", code)
	}
	if code, _ := r.do(t, "POST", "/owner/api/settings", map[string]any{"links": false, "seconds": 60}); code != 400 {
		t.Errorf("another control's field: %d", code)
	}
	// Checked: an hour stops two; links off three; nothing changes.
	code, a, _ := settingsCall(t, r, SettingsRequest{LinkLifetime: seconds(time.Hour), Check: true})
	if code != 200 || a.Ended != 2 || !reflect.DeepEqual(a.Settings, SettingsJSON{LinkLifetime: 3600, Links: true, Boarding: true, Chat: true, ShipmateMessages: true, SpectatorChat: true, ChatCountries: []string{}}) || !strings.HasPrefix(a.Words, "Would set: a link lasts 1h0m0s.") {
		t.Fatalf("an hour checked: %d %+v", code, a)
	}
	code, a, _ = settingsCall(t, r, SettingsRequest{Links: yes(false), Check: true})
	if code != 200 || a.Ended != 3 || a.Settings.Links || !strings.Contains(a.Words, "3 working links") {
		t.Fatalf("links off checked: %d %+v", code, a)
	}
	if code, a, _ = settingsCall(t, r, SettingsRequest{LinkLifetime: seconds(aboard.MaxLifetime), Check: true}); code != 200 || a.Ended != 0 {
		t.Fatalf("a week checked: %d %+v", code, a)
	}
	if len(f.writes) != 0 || f.switches.Lifetime() != aboard.DefaultLifetime || !f.switches.Links() {
		t.Fatalf("a check changed something: %v", f.writes)
	}

	// Set from the command: the lifetime lowered to an hour stops two
	// links and ends none in the database.
	req := httptest.NewRequest("POST", "http://localhost:9090/owner/api/settings", strings.NewReader(`{"linkLifetime":3600,"boarding":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(SourceHeader, store.SourceCommand)
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("set: %d %s", rec.Code, rec.Body)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &a); err != nil || a.Ended != 2 || !reflect.DeepEqual(a.Settings, SettingsJSON{LinkLifetime: 3600, Links: true, Chat: true, ShipmateMessages: true, SpectatorChat: true, ChatCountries: []string{}}) ||
		!strings.HasPrefix(a.Words, "Done: a link lasts 1h0m0s; boarding off for everyone.") {
		t.Fatalf("set: %+v %v", a, err)
	}
	want := []string{"lifetime 1h0m0s over on/on/24h0m0s", "boarding off over on/on/1h0m0s"}
	if strings.Join(f.writes, ",") != strings.Join(want, ",") || f.ended[1] || f.ended[2] {
		t.Fatalf("the writes: %v, ended %v", f.writes, f.ended)
	}
	if f.actions[0].Detail != "1h0m0s" || f.actions[0].Source != store.SourceCommand || f.actions[1].Detail != "off" {
		t.Fatalf("the record: %+v", f.actions)
	}
	if f.switches.Lifetime() != time.Hour || f.switches.Boarding() || !f.switches.Links() {
		t.Fatal("memory after the set")
	}

	// Links off, from the page: the one link still working stops, and
	// every link ends.
	code, a, _ = settingsCall(t, r, SettingsRequest{Links: yes(false)})
	if code != 200 || a.Ended != 1 || a.Settings.Links {
		t.Fatalf("links off: %d %+v", code, a)
	}
	if f.ended[0] != true || f.ended[1] != true || f.switches.Links() || f.actions[2].Source != store.SourcePage {
		t.Fatalf("after links off: %v %v %+v", f.ended, f.switches.Links(), f.actions[2])
	}
	// Off already: nothing more stops.
	if code, a, _ = settingsCall(t, r, SettingsRequest{LinkLifetime: seconds(5 * time.Minute), Check: true}); code != 200 || a.Ended != 0 {
		t.Fatalf("a lower lifetime, links off: %d %+v", code, a)
	}
	code, body = r.do(t, "GET", "/owner/api/settings.json", nil)
	if code != 200 || strings.TrimSpace(string(body)) != `{"linkLifetime":3600,"links":false,"boarding":false,"chat":true,"shipmateMessages":true,"spectatorChat":true,"chatCountries":[]}` {
		t.Fatalf("settings.json after: %d %s", code, body)
	}
	for action, n := range map[string]float64{"link-lifetime": 1, "links": 1, "boarding": 1} {
		if got := testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues(action)); got != n {
			t.Errorf("%s counted %v", action, got)
		}
	}
	if got := testutil.ToFloat64(r.metrics.OwnerRefused.WithLabelValues("settings")); got != 5 {
		t.Errorf("refusals counted %v", got)
	}
}

// TestSettingsGuarded: the settings are the guard's, and without sailing
// together they are not served.
func TestSettingsGuarded(t *testing.T) {
	r, f := sailRig(t)
	req := httptest.NewRequest("POST", "http://x/owner/api/settings", strings.NewReader(`{"links":false}`))
	req.Host = "keel.example:9090"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || len(f.writes) != 0 {
		t.Fatalf("off this computer: %d, %v", rec.Code, f.writes)
	}
	r.o.cfg.Switches, r.o.cfg.Sail = nil, nil
	if code, _ := r.do(t, "GET", "/owner/api/settings.json", nil); code != http.StatusServiceUnavailable {
		t.Fatalf("not running: %d", code)
	}
	if code, _, _ := settingsCall(t, r, SettingsRequest{Links: yes(true)}); code != http.StatusServiceUnavailable {
		t.Fatalf("not running, set: %d", code)
	}
}

// fakeChat is the database's switches for chat: each write, with the
// switches in memory as it found them.
type fakeChat struct {
	mu       sync.Mutex
	switches *aboard.Switches
	writes   []string
	actions  []store.Action
}

func (f *fakeChat) wrote(what string, a store.Action) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, what+" over "+onOff(f.switches.Chat())+"/"+onOff(f.switches.ShipmateMessages())+"/"+strings.Join(f.switches.ChatCountries(), ","))
	f.actions = append(f.actions, a)
}

func (f *fakeChat) SetChatSwitch(_ context.Context, on bool, a store.Action) error {
	f.wrote("chat "+onOff(on), a)
	return nil
}

func (f *fakeChat) SetShipmateMessages(_ context.Context, on bool, a store.Action) error {
	f.wrote("shipmates "+onOff(on), a)
	return nil
}

func (f *fakeChat) SetSpectatorChat(_ context.Context, on bool, a store.Action) error {
	f.wrote("spectators "+onOff(on), a)
	return nil
}

func (f *fakeChat) SetChatCountries(_ context.Context, c []string, a store.Action) error {
	f.wrote("countries "+strings.Join(c, ","), a)
	return nil
}

// TestSettingsChat: chat's switches as settings.json tells them; a check
// changes nothing and tells no connection; a change writes the database
// first, then memory, and tells every connection once; the countries are
// two letters each, upper case, sorted, and an empty list clears them.
func TestSettingsChat(t *testing.T) {
	r, sail := sailRig(t)
	f := &fakeChat{switches: r.o.cfg.Switches}
	told := 0
	r.o.cfg.ChatSettings, r.o.cfg.ChatChanged = f, func() { told++ }
	sw := r.o.cfg.Switches

	code, a, _ := settingsCall(t, r, SettingsRequest{Chat: yes(false), Check: true})
	if code != 200 || a.Settings.Chat || a.Words != "Would set: chat off for everyone." {
		t.Fatalf("chat off checked: %d %+v", code, a)
	}
	if len(f.writes) != 0 || told != 0 || !sw.Chat() {
		t.Fatalf("a check changed something: %v, told %d", f.writes, told)
	}
	code, a, _ = settingsCall(t, r, SettingsRequest{Chat: yes(false)})
	if code != 200 || a.Settings.Chat || sw.Chat() || !strings.HasPrefix(a.Words, "Done: chat off for everyone.") || told != 1 {
		t.Fatalf("chat off: %d %+v, told %d", code, a, told)
	}
	if f.writes[0] != "chat off over on/on/" || f.actions[0].Detail != "off" || f.actions[0].Source != store.SourcePage {
		t.Fatalf("the write: %v %+v", f.writes, f.actions)
	}

	// The countries checked as the server takes them.
	for _, c := range [][]string{{"BRA"}, {"B"}, {"b1"}, {""}, {"BR", "ÉS"}} {
		if code, _, body := settingsCall(t, r, SettingsRequest{ChatCountries: &c}); code != 400 || !strings.HasPrefix(body, "chatCountries:") {
			t.Errorf("%q: %d %s", c, code, body)
		}
	}
	if len(f.writes) != 1 || told != 1 {
		t.Fatalf("a refusal wrote: %v, told %d", f.writes, told)
	}
	// Shipmates' messages and the countries together: told once.
	c := []string{" au", "br", "AU"}
	code, a, _ = settingsCall(t, r, SettingsRequest{ShipmateMessages: yes(false), ChatCountries: &c})
	if code != 200 || told != 2 || a.Settings.ShipmateMessages || strings.Join(a.Settings.ChatCountries, ",") != "AU,BR" ||
		!strings.HasPrefix(a.Words, "Done: shipmates' messages off for everyone; chat off in AU, BR.") {
		t.Fatalf("shipmates and countries: %d %+v, told %d", code, a, told)
	}
	if !sw.ChatOffIn("BR") || sw.ChatOffIn("NZ") || sw.ShipmateMessages() || f.actions[2].Detail != "AU,BR" {
		t.Fatalf("memory after: %v %+v", sw.ChatCountries(), f.actions)
	}
	code, body := r.do(t, "GET", "/owner/api/settings.json", nil)
	if code != 200 || strings.TrimSpace(string(body)) != `{"linkLifetime":86400,"links":true,"boarding":true,"chat":false,"shipmateMessages":false,"spectatorChat":true,"chatCountries":["AU","BR"]}` {
		t.Fatalf("settings.json after: %d %s", code, body)
	}
	none := []string{}
	if code, a, _ = settingsCall(t, r, SettingsRequest{ChatCountries: &none, Chat: yes(true)}); code != 200 || told != 3 || len(a.Settings.ChatCountries) != 0 ||
		!a.Settings.Chat || !strings.Contains(a.Words, "chat off in no country") || sw.ChatOffIn("BR") {
		t.Fatalf("countries cleared: %d %+v", code, a)
	}
	// Spectators' reading of machine sailors' chat: off and on again,
	// written first, then memory, every connection told.
	if code, a, _ = settingsCall(t, r, SettingsRequest{SpectatorChat: yes(false), Check: true}); code != 200 || a.Settings.SpectatorChat ||
		a.Words != "Would set: spectators reading machine sailors' chat off for everyone." || !sw.SpectatorChat() || told != 3 {
		t.Fatalf("spectators off checked: %d %+v", code, a)
	}
	if code, a, _ = settingsCall(t, r, SettingsRequest{SpectatorChat: yes(false)}); code != 200 || a.Settings.SpectatorChat || sw.SpectatorChat() || told != 4 ||
		f.writes[len(f.writes)-1] != "spectators off over on/off/" || f.actions[len(f.actions)-1].Detail != "off" {
		t.Fatalf("spectators off: %d %+v, %v", code, a, f.writes)
	}
	if code, a, _ = settingsCall(t, r, SettingsRequest{SpectatorChat: yes(true)}); code != 200 || !a.Settings.SpectatorChat || !sw.SpectatorChat() || told != 5 {
		t.Fatalf("spectators on: %d %+v", code, a)
	}
	// Links' switches alone tell no connection about chat.
	if code, _, _ = settingsCall(t, r, SettingsRequest{Boarding: yes(false)}); code != 200 || told != 5 || len(sail.writes) != 1 {
		t.Fatalf("boarding off told chat: %d, told %d", code, told)
	}
	for action, n := range map[string]float64{store.ActionChat: 2, store.ActionShipmateMessages: 1, store.ActionChatCountries: 2, store.ActionSpectatorChat: 2} {
		if got := testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues(action)); got != n {
			t.Errorf("%s counted %v", action, got)
		}
	}

	// Without chat's store, its switches are refused, and the others not.
	r.o.cfg.ChatSettings = nil
	if code, _, _ := settingsCall(t, r, SettingsRequest{Chat: yes(false)}); code != 503 || !sw.Chat() {
		t.Fatalf("chat not running: %d", code)
	}
	if code, _, _ := settingsCall(t, r, SettingsRequest{Boarding: yes(true)}); code != 200 {
		t.Fatalf("boarding, chat not running: %d", code)
	}
}
