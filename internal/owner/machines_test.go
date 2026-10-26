// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// fakeMachines is the store's machine sailors and AI apps' grants in
// memory: each account's kind, the grants' ages, the lifetime written and
// the caps set.
type fakeMachines struct {
	mu    sync.Mutex
	kinds map[store.AccountID]store.Kind
	// ages are the unrevoked grants' ages, since their approval.
	ages []time.Duration
	// set is the lifetime last written, and memory what the lifetime in
	// memory was when it was written.
	set    time.Duration
	memory time.Duration
	life   *fakeLifetime
	caps   map[store.AccountID]int
}

func (f *fakeMachines) MachineCounts(_ context.Context, lifetime time.Duration) (store.MachineCounts, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	live := int64(0)
	for _, a := range f.ages {
		if a < lifetime {
			live++
		}
	}
	return store.MachineCounts{Total: 3, Week: 1, Grants: map[string]int64{"app": live}}, nil
}

func (f *fakeMachines) GrantsEndedBy(_ context.Context, _, d time.Duration) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := int64(0)
	for _, a := range f.ages {
		if a >= d {
			n++
		}
	}
	return n, nil
}

func (f *fakeMachines) SetGrantLifetime(_ context.Context, d time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.set, f.memory = d, f.life.Get()
	return nil
}

func (f *fakeMachines) SetMachineCap(_ context.Context, id store.AccountID, limit int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.kinds[id] != store.Human {
		return store.ErrNotFound
	}
	f.caps[id] = limit
	return nil
}

// fakeLifetime is the lifetime in memory.
type fakeLifetime struct {
	mu sync.Mutex
	d  time.Duration
}

func (l *fakeLifetime) Get() time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.d
}

func (l *fakeLifetime) Set(d time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.d = d
}

// machinesRig is the owner's tools with sign-in for AI apps running: a
// human account, account(1), and an AI one, account(2); four grants, 30
// seconds, a day, 30 days and 100 days old; a lifetime of 90 days; and the
// lifetime in memory as each call of the changed hook found it.
type machinesRig struct {
	*rig
	m       *fakeMachines
	life    *fakeLifetime
	changed []time.Duration
}

func newMachinesRig(t *testing.T) *machinesRig {
	t.Helper()
	r := &machinesRig{rig: newRig(t, 0), life: &fakeLifetime{d: 90 * 24 * time.Hour}}
	r.m = &fakeMachines{
		kinds: map[store.AccountID]store.Kind{store.AccountID(account(1)): store.Human, store.AccountID(account(2)): store.AI},
		ages:  []time.Duration{30 * time.Second, 24 * time.Hour, 30 * 24 * time.Hour, 100 * 24 * time.Hour},
		life:  r.life,
		caps:  map[store.AccountID]int{},
	}
	r.o.cfg.Machines, r.o.cfg.Lifetime = r.m, r.life
	r.o.cfg.LifetimeChanged = func() { r.changed = append(r.changed, r.life.Get()) }
	return r
}

// TestMachineControlsGuarded: the lifetime and the cap are the guard's,
// as every control is: refused from another computer, from another
// origin, and with a form's body, and nothing is set.
func TestMachineControlsGuarded(t *testing.T) {
	r := newMachinesRig(t)
	bodies := map[string]string{
		"/owner/api/lifetime": `{"seconds":3600}`,
		"/owner/api/machines": `{"account":"` + store.AccountID(account(1)).String() + `","cap":5}`,
	}
	for path, body := range bodies {
		for name, c := range map[string]struct {
			host, site, ctype string
			want              int
		}{
			"off this computer":  {"keel.example:9090", "same-origin", "application/json", http.StatusForbidden},
			"a rebound name":     {"127.0.0.1.nip.io:9090", "same-origin", "application/json", http.StatusForbidden},
			"from another site":  {"localhost:9090", "cross-site", "application/json", http.StatusForbidden},
			"with a form's body": {"localhost:9090", "same-origin", "application/x-www-form-urlencoded", http.StatusUnsupportedMediaType},
			"with text":          {"localhost:9090", "same-origin", "text/plain", http.StatusUnsupportedMediaType},
		} {
			req := httptest.NewRequest("POST", "http://x"+path, strings.NewReader(body))
			req.Host = c.host
			req.Header.Set("Content-Type", c.ctype)
			req.Header.Set("Sec-Fetch-Site", c.site)
			rec := httptest.NewRecorder()
			r.h.ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Errorf("%s %s: %d, want %d", path, name, rec.Code, c.want)
			}
		}
	}
	if r.m.set != 0 || r.life.Get() != 90*24*time.Hour || len(r.changed) != 0 || len(r.m.caps) != 0 {
		t.Fatalf("a refused control set something: %v, %v, %v, %v", r.m.set, r.life.Get(), r.changed, r.m.caps)
	}
	if testutil.ToFloat64(r.metrics.OwnerRefused.WithLabelValues("request")) == 0 {
		t.Error("no refusal counted")
	}
}

// TestMachineCap: a human account's machine sailors allowed are set, from
// 0 to 50; an AI account, or an id that is no account's, is refused with
// 404, a cap out of bounds or a body that is not an id with 400; each is
// counted.
func TestMachineCap(t *testing.T) {
	r := newMachinesRig(t)
	human, ai := store.AccountID(account(1)), store.AccountID(account(2))
	for _, n := range []int{3, 0, store.MaxMachineCap} {
		code, body := r.do(t, "POST", "/owner/api/machines", MachinesRequest{Account: human.String(), Cap: n})
		var got MachinesRequest
		if code != 200 || json.Unmarshal(body, &got) != nil || got != (MachinesRequest{Account: human.String(), Cap: n}) {
			t.Fatalf("a cap of %d: %d %s", n, code, body)
		}
		if r.m.caps[human] != n {
			t.Fatalf("a cap of %d: the store has %d", n, r.m.caps[human])
		}
	}
	for name, c := range map[string]struct {
		req  MachinesRequest
		want int
	}{
		"an AI account":  {MachinesRequest{Account: ai.String(), Cap: 3}, http.StatusNotFound},
		"no account":     {MachinesRequest{Account: store.AccountID(account(9)).String(), Cap: 3}, http.StatusNotFound},
		"not an id":      {MachinesRequest{Account: "Ann", Cap: 3}, http.StatusBadRequest},
		"a cap below 0":  {MachinesRequest{Account: human.String(), Cap: -1}, http.StatusBadRequest},
		"a cap above 50": {MachinesRequest{Account: human.String(), Cap: store.MaxMachineCap + 1}, http.StatusBadRequest},
	} {
		if code, body := r.do(t, "POST", "/owner/api/machines", c.req); code != c.want {
			t.Errorf("%s: %d %s, want %d", name, code, body, c.want)
		}
	}
	if _, ok := r.m.caps[ai]; ok || r.m.caps[human] != store.MaxMachineCap {
		t.Fatalf("a refused cap was set: %v", r.m.caps)
	}
	if code, _ := r.do(t, "POST", "/owner/api/machines", map[string]any{"account": human.String(), "cap": 3, "more": 1}); code != http.StatusBadRequest {
		t.Errorf("a body with a field of another control's: %d", code)
	}
	if testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues("cap")) != 3 || testutil.ToFloat64(r.metrics.OwnerRefused.WithLabelValues("cap")) != 5 {
		t.Fatalf("the caps are not counted: %v done, %v refused",
			testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues("cap")), testutil.ToFloat64(r.metrics.OwnerRefused.WithLabelValues("cap")))
	}
}

// lifetimeAnswer is what the lifetime's control answers.
type lifetimeAnswer struct {
	Seconds int64 `json:"seconds"`
	Ends    int64 `json:"ends"`
	Set     bool  `json:"set"`
}

// TestLifetime: the lifetime is from a minute to 400 days; checked, it
// only counts the grants it would end at once; set, it is written to the
// store, then to memory, then the changed hook is called, and the page's
// accounts show it with the grants it leaves live.
func TestLifetime(t *testing.T) {
	r := newMachinesRig(t)
	was := 90 * 24 * time.Hour
	lifetime := func(seconds int64, check bool) (int, lifetimeAnswer) {
		t.Helper()
		code, body := r.do(t, "POST", "/owner/api/lifetime", LifetimeRequest{Seconds: seconds, Check: check})
		var a lifetimeAnswer
		if code == 200 {
			if err := json.Unmarshal(body, &a); err != nil {
				t.Fatalf("%s: %v", body, err)
			}
		}
		return code, a
	}
	day := int64(24 * 60 * 60)
	for _, s := range []int64{59, 400*day + 1, 0, -60} {
		for _, check := range []bool{true, false} {
			if code, _ := lifetime(s, check); code != http.StatusBadRequest {
				t.Errorf("%d s, check %v: %d", s, check, code)
			}
		}
	}
	// The bounds themselves are allowed: checked, nothing is set.
	for s, ends := range map[int64]int64{60: 3, 400 * day: 0, 7 * day: 2} {
		code, a := lifetime(s, true)
		if code != 200 || a != (lifetimeAnswer{Seconds: s, Ends: ends}) {
			t.Errorf("%d s checked: %d %+v, want %d ended", s, code, a, ends)
		}
	}
	if r.m.set != 0 || r.life.Get() != was || len(r.changed) != 0 {
		t.Fatalf("a check set the lifetime: %v, %v, %v", r.m.set, r.life.Get(), r.changed)
	}
	// Set to a week: the store first, the memory then, the hook last.
	week := 7 * 24 * time.Hour
	code, a := lifetime(7*day, false)
	if code != 200 || a != (lifetimeAnswer{Seconds: 7 * day, Ends: 2, Set: true}) {
		t.Fatalf("set to a week: %d %+v", code, a)
	}
	if r.m.set != week || r.m.memory != was {
		t.Errorf("the store was written %v with %v in memory, want %v with %v", r.m.set, r.m.memory, week, was)
	}
	if r.life.Get() != week {
		t.Errorf("the lifetime in memory is %v", r.life.Get())
	}
	if len(r.changed) != 1 || r.changed[0] != week {
		t.Errorf("the changed hook was called %v times, finding %v", len(r.changed), r.changed)
	}
	code, body := r.do(t, "GET", "/owner/api/accounts.json", nil)
	var acc accountsJSON
	if code != 200 || json.Unmarshal(body, &acc) != nil || acc.Machines == nil ||
		acc.Machines.Lifetime != 7*day || acc.Machines.Grants["app"] != 2 || acc.Machines.Total != 3 || acc.Machines.Week != 1 {
		t.Errorf("accounts.json after the lifetime set: %d %s", code, body)
	}
	if testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues("lifetime")) != 1 || testutil.ToFloat64(r.metrics.OwnerRefused.WithLabelValues("lifetime")) != 8 {
		t.Errorf("the lifetime's controls are not counted")
	}
}

// TestMachinesNotRunning: without sign-in for AI apps, accounts.json has
// no machine sailors and the two controls are refused.
func TestMachinesNotRunning(t *testing.T) {
	r := newRig(t, 0)
	if code, body := r.do(t, "GET", "/owner/api/accounts.json", nil); code != 200 || strings.Contains(string(body), "machines") {
		t.Errorf("accounts.json: %d %s", code, body)
	}
	if code, _ := r.do(t, "POST", "/owner/api/lifetime", LifetimeRequest{Seconds: 3600}); code != http.StatusServiceUnavailable {
		t.Errorf("the lifetime: %d", code)
	}
	if code, _ := r.do(t, "POST", "/owner/api/machines", MachinesRequest{Account: store.AccountID(account(1)).String(), Cap: 3}); code != http.StatusServiceUnavailable {
		t.Errorf("the cap: %d", code)
	}
}
