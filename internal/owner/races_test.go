// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// fakeRacing is the racing settings in memory, and each write's record.
type fakeRacing struct {
	s       store.RaceSettings
	actions []store.Action
}

func (f *fakeRacing) RaceSettings(context.Context) (store.RaceSettings, error) { return f.s, nil }
func (f *fakeRacing) SetRaceSettings(_ context.Context, s store.RaceSettings, a store.Action) error {
	f.s = s
	f.actions = append(f.actions, a)
	return nil
}

// TestRacingSettings: races tells the settings; a check changes nothing;
// a change is written with its record; values out of range and boats not
// the catalog's are refused with the reason.
func TestRacingSettings(t *testing.T) {
	r := newRig(t, 0)
	f := &fakeRacing{s: store.RaceSettings{Ahead: 2, Daily: 8, Made: 8, Owned: 3, Cutoff: 3 * time.Hour, Every: 3,
		Boats: []string{"one", "one", "two"}, GreenhornUS: 50}}
	r.o.cfg.Racing, r.o.cfg.RaceBoats = f, []string{"one", "two"}
	code, body := r.do(t, "GET", "/owner/api/races", nil)
	if code != 200 || strings.TrimSpace(string(body)) != `{"ahead":2,"daily":8,"made":8,"owned":3,"cutoff":10800,"every":3,"boats":["one","one","two"],"greenhornUS":50}` {
		t.Fatalf("races: %d %s", code, body)
	}
	for _, bad := range []map[string]any{
		{"daily": 0}, {"ahead": 21}, {"every": 5}, {"cutoff": 86401}, {"boats": []string{"three"}}, {"boats": []string{}},
		{"greenhornUS": 101}, {}, {"daily": 6, "seconds": 1},
	} {
		if code, body := r.do(t, "POST", "/owner/api/races", bad); code != 400 {
			t.Errorf("%v: %d %s", bad, code, body)
		}
	}
	code, body = r.do(t, "POST", "/owner/api/races", map[string]any{"daily": 6, "boats": []string{"two"}, "check": true})
	var a RacesAnswer
	if err := json.Unmarshal(body, &a); code != 200 || err != nil || a.Settings.Daily != 6 || !strings.HasPrefix(a.Words, "Would set: races started a day 6;") {
		t.Fatalf("checked: %d %s", code, body)
	}
	if f.s.Daily != 8 || len(f.actions) != 0 {
		t.Fatal("a check changed something")
	}
	code, body = r.do(t, "POST", "/owner/api/races", map[string]any{"daily": 6, "cutoff": 7200})
	if err := json.Unmarshal(body, &a); code != 200 || err != nil || !strings.HasPrefix(a.Words, "Done:") {
		t.Fatalf("set: %d %s", code, body)
	}
	if f.s.Daily != 6 || f.s.Cutoff != 2*time.Hour || f.s.Ahead != 2 || len(f.actions) != 1 || f.actions[0].Source != store.SourcePage {
		t.Fatalf("written %+v, recorded %+v", f.s, f.actions)
	}
}
