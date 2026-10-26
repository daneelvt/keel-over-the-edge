// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// fakeDoor records the accounts the machine sailors' door is told to
// forget.
type fakeDoor struct {
	mu     sync.Mutex
	forgot []store.AccountID
}

func (d *fakeDoor) ForgetAccounts(ids ...store.AccountID) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.forgot = append(d.forgot, ids...)
}

// fakeAgents are the machine sailors' agents a test tells of.
type fakeAgents map[bus.Account]AgentInfo

func (a fakeAgents) Agent(account bus.Account) (AgentInfo, bool) {
	info, ok := a[account]
	return info, ok
}

// joinMachine puts a machine sailor's boat at sea for account n, or a
// place in the queue, and returns the boat, 0 while it waits.
func (r *rig) joinMachine(t testing.TB, n byte, name string) uint64 {
	t.Helper()
	a := account(n)
	r.accounts.mu.Lock()
	r.accounts.by[store.AccountID(a)] = store.Account{ID: store.AccountID(a), Kind: store.AI, Name: name}
	r.accounts.mu.Unlock()
	reply := make(chan bus.Reply, 1)
	if err := r.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Join, Account: a, Conn: uint64(n), Machine: true, Reply: reply}); err != nil {
		t.Fatal(err)
	}
	r.w.Tick()
	return (<-reply).Boat
}

// TestPriorityGuarded: the priority control is the guard's, as every
// control is: refused from another computer, from another origin, and
// with a form's body, and nothing is set.
func TestPriorityGuarded(t *testing.T) {
	r := newRig(t, 0)
	r.join(t, 1, "Ann", store.Human, false)
	body := `{"account":"` + store.AccountID(account(1)).String() + `","on":true}`
	for name, c := range map[string]struct {
		host, site, ctype string
		want              int
	}{
		"off this computer":  {"keel.example:9090", "same-origin", "application/json", http.StatusForbidden},
		"a rebound name":     {"127.0.0.1.nip.io:9090", "same-origin", "application/json", http.StatusForbidden},
		"from another site":  {"localhost:9090", "cross-site", "application/json", http.StatusForbidden},
		"with a form's body": {"localhost:9090", "same-origin", "application/x-www-form-urlencoded", http.StatusUnsupportedMediaType},
	} {
		req := httptest.NewRequest("POST", "http://x/owner/api/priority", strings.NewReader(body))
		req.Host = c.host
		req.Header.Set("Content-Type", c.ctype)
		req.Header.Set("Sec-Fetch-Site", c.site)
		rec := httptest.NewRecorder()
		r.h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s: %d, want %d", name, rec.Code, c.want)
		}
	}
	if r.accounts.by[store.AccountID(account(1))].Priority || len(r.sessions.forgot) != 0 {
		t.Fatal("a refused control set the priority")
	}
	if testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues("priority")) != 0 {
		t.Fatal("a refused control was counted as done")
	}
}

// TestPriority: an account's priority, human or AI, is set in the database
// first, then the sessions' cache and the machine sailors' door forget the
// account, and the page shows it at once; the boat at sea keeps the place
// it was given. An id that is no account's is refused with 404, a body
// that is not an id with 400; each is counted.
func TestPriority(t *testing.T) {
	r := newRig(t, 0)
	door := &fakeDoor{}
	r.o.cfg.Door = door
	r.join(t, 1, "Ann", store.Human, false)
	r.joinMachine(t, 2, "Robot")
	ann, robot := store.AccountID(account(1)), store.AccountID(account(2))
	r.world(t) // the names are read, and kept for a minute
	for _, id := range []store.AccountID{ann, robot} {
		if code, body := r.do(t, "POST", "/owner/api/priority", PriorityRequest{Account: id.String(), On: true}); code != 200 {
			t.Fatalf("priority: %d %s", code, body)
		}
	}
	if !r.accounts.by[ann].Priority || !r.accounts.by[robot].Priority {
		t.Fatalf("not set: %+v, %+v", r.accounts.by[ann], r.accounts.by[robot])
	}
	if len(r.sessions.forgot) != 2 || r.sessions.forgot[0] != ann || r.sessions.forgot[1] != robot ||
		len(door.forgot) != 2 || door.forgot[0] != ann || door.forgot[1] != robot {
		t.Fatalf("the caches forgot %v and %v", r.sessions.forgot, door.forgot)
	}
	w := r.world(t)
	if !w.Boats[0].Priority || !w.Boats[1].Priority || w.Boats[0].Admitted || w.Boats[1].Admitted {
		t.Fatalf("the page shows %+v and %+v", w.Boats[0], w.Boats[1])
	}
	if f := r.w.Latest(); f.Priority[f.Live[0]] || f.Priority[f.Live[1]] {
		t.Fatal("a boat at sea was changed")
	}
	if code, _ := r.do(t, "POST", "/owner/api/priority", PriorityRequest{Account: ann.String(), On: false}); code != 200 {
		t.Fatal("unpriority")
	}
	if r.accounts.by[ann].Priority || len(door.forgot) != 3 {
		t.Fatal("the priority is not cleared")
	}
	if code, _ := r.do(t, "POST", "/owner/api/priority", PriorityRequest{Account: store.AccountID(account(9)).String(), On: true}); code != 404 {
		t.Fatalf("no such account: %d", code)
	}
	if code, _ := r.do(t, "POST", "/owner/api/priority", PriorityRequest{Account: "nobody", On: true}); code != 400 {
		t.Fatalf("not an account: %d", code)
	}
	if testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues("priority")) != 2 ||
		testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues("unpriority")) != 1 ||
		testutil.ToFloat64(r.metrics.OwnerRefused.WithLabelValues("priority")) != 2 {
		t.Fatal("the priority's actions are not counted")
	}
	if len(door.forgot) != 3 {
		t.Fatal("a refused control made the door forget")
	}
}

// TestPriorityWithoutDoor: without sign-in for AI apps there is no door
// to tell, and the priority is set all the same.
func TestPriorityWithoutDoor(t *testing.T) {
	r := newRig(t, 0)
	r.join(t, 1, "Ann", store.Human, false)
	id := store.AccountID(account(1))
	if code, body := r.do(t, "POST", "/owner/api/priority", PriorityRequest{Account: id.String(), On: true}); code != 200 || !r.accounts.by[id].Priority {
		t.Fatalf("priority: %d %s", code, body)
	}
}

// TestViewKinds: the view tells a machine sailor's boat from a human's
// by the world's own mark, with its agent's app, last call and wait;
// each place in the queue its kind and its position among its kind's;
// and the boats and places of each kind, the cap and the reserve, and
// the agents' rules, as configured.
func TestViewKinds(t *testing.T) {
	r := newRig(t, 4) // a cap of 2, a reserve of 1
	now := time.Now()
	r.o.cfg.Agents = fakeAgents{
		account(2): {App: "claude-ai", LastCall: now.Add(-12 * time.Second), Waiting: 20 * time.Second, Refusals: 3},
	}
	r.o.cfg.AICap, r.o.cfg.AIReserve = r.w.AICap(), r.w.AIReserve()
	r.o.cfg.AISilence, r.o.cfg.AIOrders, r.o.cfg.AILooks = 3*time.Minute, "2 a second, a burst of 5", "4 a second, a burst of 10"
	r.join(t, 1, "Ann", store.Human, false)
	r.joinMachine(t, 2, "Robot")
	r.joinMachine(t, 3, "Unheard") // at sea, its agent not known to the page
	r.join(t, 4, "Bob", store.Human, false)
	// The world is full: these wait.
	r.joinMachine(t, 5, "Robot 2")
	r.join(t, 6, "Cat", store.Human, false)
	r.joinMachine(t, 7, "Robot 3")
	w := r.world(t)
	if len(w.Boats) != 4 || len(w.Queue) != 3 {
		t.Fatalf("%d boats, %d waiting", len(w.Boats), len(w.Queue))
	}
	for i, machine := range []bool{false, true, true, false} {
		if w.Boats[i].Machine != machine {
			t.Errorf("boat %d's machine is %v", i, w.Boats[i].Machine)
		}
	}
	if w.Boats[0].Agent != nil || w.Boats[2].Agent != nil {
		t.Fatalf("an agent told of a human or an unknown: %+v, %+v", w.Boats[0].Agent, w.Boats[2].Agent)
	}
	a := w.Boats[1].Agent
	if a == nil || a.App != "claude-ai" || a.SinceCall == nil || *a.SinceCall < 11 || *a.SinceCall > 14 || a.Waiting != 20 || a.Refusals != 3 {
		t.Fatalf("the agent %+v", a)
	}
	wantQueue := []struct {
		machine  bool
		position int
	}{{true, 1}, {false, 1}, {true, 2}}
	f := r.w.Latest()
	for i, q := range wantQueue {
		if w.Queue[i].Machine != q.machine || w.Queue[i].Position != q.position {
			t.Errorf("place %d: %+v", i, w.Queue[i])
		}
		if pos, _ := bus.QueuePlace(f.Queue, i); int(pos) != w.Queue[i].Position {
			t.Errorf("place %d: position %d, the queue's %d", i, w.Queue[i].Position, pos)
		}
	}
	want := admissionJSON{Humans: 2, Machines: 2, HumansWaiting: 1, MachinesWaiting: 2, AICap: 2, AIReserve: 1,
		AISilence: 180, AIOrders: "2 a second, a burst of 5", AILooks: "4 a second, a burst of 10"}
	if w.Admission != want {
		t.Fatalf("admission %+v, want %+v", w.Admission, want)
	}
}
