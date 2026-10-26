// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A stop, a revoke and their effects at once, through the world page's
// own routes, on a memDB that keeps who is stopped and which machine
// sailor is whose.

// memStops are a memDB's stops: the accounts stopped, each machine
// sailor's human, and the tokens revoked.
type memStops struct {
	mu      sync.Mutex
	stopped map[store.AccountID]bool
	owners  map[store.AccountID]store.AccountID
}

func (d *memDB) stopsLocked() *memStops {
	if d.stops.stopped == nil {
		d.stops.stopped, d.stops.owners = map[store.AccountID]bool{}, map[store.AccountID]store.AccountID{}
	}
	return &d.stops
}

// machineFor makes a machine sailor of a human's, or a new token for one
// made already, and returns the token.
func (d *memDB) machineFor(name string, human store.AccountID, id *store.AccountID) string {
	token, hash := oauth.NewToken(oauth.KindConnection)
	if *id == (store.AccountID{}) {
		copy(id[:], hash[:16])
		id[6], id[8] = 0x70|id[6]&0x0f, 0x80|id[8]&0x3f
	}
	d.stops.mu.Lock()
	d.stopsLocked().owners[*id] = human
	d.stops.mu.Unlock()
	d.tokens.mu.Lock()
	defer d.tokens.mu.Unlock()
	if d.tokens.tokens == nil {
		d.tokens.tokens = map[[32]byte]store.TokenGrant{}
	}
	d.tokens.tokens[hash] = store.TokenGrant{
		Kind: store.TokenConnection, GrantKind: store.GrantConnection, Grant: [16]byte(hash[16:]), Approved: time.Now(),
		Account: *id, Name: name, OwnerName: "Ann",
	}
	return token
}

func (d *memDB) isStopped(id store.AccountID) bool {
	d.stops.mu.Lock()
	defer d.stops.mu.Unlock()
	s := d.stopsLocked()
	return s.stopped[id] || s.stopped[s.owners[id]]
}

// target is an account as an action finds it.
func (d *memDB) target(id store.AccountID) store.Target {
	d.stops.mu.Lock()
	defer d.stops.mu.Unlock()
	s := d.stopsLocked()
	t := store.Target{ID: id, Kind: store.Human, Name: "Ann", Stopped: s.stopped[id]}
	if owner, ok := s.owners[id]; ok {
		t.Kind, t.Owner, t.Name, t.OwnerStopped = store.AI, owner, "a machine sailor", s.stopped[owner]
		return t
	}
	for m, owner := range s.owners {
		if owner == id {
			t.Machines = append(t.Machines, m)
		}
	}
	return t
}

// revoke revokes the live tokens of the accounts given.
func (d *memDB) revoke(ids []store.AccountID, check bool) (n int64, grants [][16]byte) {
	d.tokens.mu.Lock()
	defer d.tokens.mu.Unlock()
	for h, t := range d.tokens.tokens {
		for _, id := range ids {
			if t.Account == id && t.Revoked.IsZero() {
				n++
				grants = append(grants, t.Grant)
				if !check {
					t.Revoked, t.RevokedWhy = time.Now(), store.RevokedOperator
					d.tokens.tokens[h] = t
				}
			}
		}
	}
	return n, grants
}

func (d *memDB) Stop(_ context.Context, op store.Operation) (store.Operated, error) {
	out := store.Operated{Target: d.target(op.Account)}
	if out.Stopped {
		return out, store.ErrStopped
	}
	holders := out.Machines
	if out.Kind == store.AI {
		holders = []store.AccountID{out.ID}
	}
	out.Grants, out.Revoked = d.revoke(holders, op.Check)
	if !op.Check {
		d.stops.mu.Lock()
		d.stopsLocked().stopped[op.Account] = true
		d.stops.mu.Unlock()
	}
	return out, nil
}

func (d *memDB) Start(_ context.Context, op store.Operation) (store.Operated, error) {
	out := store.Operated{Target: d.target(op.Account)}
	if !out.Stopped {
		return out, store.ErrNotStopped
	}
	out.Freed = append([]store.AccountID{out.ID}, out.Machines...)
	if !op.Check {
		d.stops.mu.Lock()
		delete(d.stopsLocked().stopped, op.Account)
		d.stops.mu.Unlock()
	}
	return out, nil
}

func (d *memDB) Revoke(_ context.Context, op store.Operation) (store.Operated, error) {
	out := store.Operated{Target: d.target(op.Account)}
	holders := out.Machines
	if out.Kind == store.AI {
		holders = []store.AccountID{out.ID}
	}
	out.Grants, out.Revoked = d.revoke(holders, op.Check)
	return out, nil
}

// Session is a session's account, none for a stopped account's.
func (d *memDB) Session(ctx context.Context, hash [32]byte) (store.Session, error) {
	if d.sessions == nil {
		return store.Session{}, store.ErrNotFound
	}
	s, err := d.sessions.Session(ctx, hash)
	if err == nil && d.isStopped(s.ID) {
		return store.Session{}, store.ErrNotFound
	}
	return s, err
}

func (d *memDB) TokenGrant(_ context.Context, hash [32]byte) (store.TokenGrant, error) {
	d.tokens.mu.Lock()
	t, ok := d.tokens.tokens[hash]
	d.tokens.mu.Unlock()
	if !ok {
		return store.TokenGrant{}, store.ErrNotFound
	}
	t.Stopped = d.isStopped(t.Account)
	return t, nil
}

// owned posts one of the world page's controls, as the page does.
func owned(t *testing.T, s *server, path string, body any) (int, string) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", internalURL+path, strings.NewReader(string(b)))
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(out)
}

// seen is the world page's view of the sea: each account's boat, and its
// grace, and the accounts waiting.
func seen(t *testing.T, s *server) (boats map[string]float64, waiting []string) {
	t.Helper()
	res, err := s.client.Get(internalURL + "/owner/api/world.json")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var w struct {
		Boats []struct {
			Account string
			Grace   float64
		}
		Queue []struct{ Account string }
	}
	if err := json.NewDecoder(res.Body).Decode(&w); err != nil {
		t.Fatal(err)
	}
	boats = map[string]float64{}
	for _, b := range w.Boats {
		boats[b.Account] = b.Grace
	}
	for _, q := range w.Queue {
		waiting = append(waiting, q.Account)
	}
	return boats, waiting
}

// doorSays posts a call to the MCP address with a token, and returns the
// status and the refusal's words.
func doorSays(t *testing.T, s *server, token string) (int, string) {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"handbook","arguments":{}}}`
	req, _ := http.NewRequest("POST", "http://127.0.0.1:8081/mcp", strings.NewReader(body))
	req.Host = agentsHost
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := s.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	return res.StatusCode, res.Header.Get("WWW-Authenticate")
}

// TestAStopAtSea: a human at sea and its machine sailor at sea, with a
// call waiting: a stop closes the human's connection with 4003 and its
// reason, both boats leave the water within a second with no grace, the
// waiting call ends in the stop's words, and the agent's next call is
// refused at the door; the human cannot connect again until a start. A
// revoke sends a machine sailor's boat into its grace, ends its waiting
// call, and a new token within the grace sails the same boat on.
func TestAStopAtSea(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}
		cookie, ann := db.sessions.Add("Ann", "human")
		s := again(t, map[string]string{"KEEL_WORLD_SEED": "1"}, db)
		ws, in, _ := connect(t, s, cookie)
		var mary store.AccountID
		token := db.machineFor("Iron Mary", ann, &mary)
		cs := agentSession(t, s, token)
		if text, refused := callTool(t, cs, "observe", nil); refused || !strings.Contains(text, "At sea") {
			t.Fatalf("observe: %v %q", refused, text)
		}
		waited := make(chan string, 1)
		go func() {
			text, refused := callTool(t, cs, "observe", map[string]any{"wait": 25})
			if !refused {
				text = "not refused: " + text
			}
			waited <- text
		}()
		time.Sleep(2 * time.Second)
		if boats, _ := seen(t, s); len(boats) != 2 {
			t.Fatalf("at sea: %v", boats)
		}

		status, body := owned(t, s, "/owner/api/accounts/stop", map[string]any{"account": ann.String(), "reason": "a test"})
		if status != 200 || !strings.Contains(body, `"done":true`) {
			t.Fatalf("stop: %d %s", status, body)
		}
		for range in.C {
		}
		if ce, ok := errors.AsType[websocket.CloseError](in.Err()); !ok || ce.Code != edge.CloseRemoved || ce.Reason != edge.ReasonStopped {
			t.Fatalf("the connection closed with %v", in.Err())
		}
		_ = ws
		if text := <-waited; text != accounts.AgentStopped {
			t.Fatalf("the waiting call: %q", text)
		}
		time.Sleep(time.Second)
		if boats, waiting := seen(t, s); len(boats) != 0 || len(waiting) != 0 {
			t.Fatalf("a second after the stop: %v %v", boats, waiting)
		}
		if status, words := doorSays(t, s, token); status != 401 || !strings.Contains(words, oauth.WordsStopped) {
			t.Fatalf("the next call: %d %q", status, words)
		}
		h := http.Header{}
		h.Set("Cookie", auth.CookieName+"="+cookie)
		if _, res, err := websocket.Dial(t.Context(), "ws://127.0.0.1:8080/ws", &websocket.DialOptions{HTTPClient: s.client, HTTPHeader: h}); err == nil ||
			res == nil || res.StatusCode/100 != 4 {
			t.Fatalf("connecting again: %v", err)
		}

		// Started again, Ann sails; a revoke of Mary's new token sends her
		// boat into its grace, and a token made within it keeps the boat.
		if status, body := owned(t, s, "/owner/api/accounts/start", map[string]any{"account": ann.String()}); status != 200 {
			t.Fatalf("start: %d %s", status, body)
		}
		connect(t, s, cookie)
		token = db.machineFor("Iron Mary", ann, &mary)
		cs = agentSession(t, s, token)
		if text, refused := callTool(t, cs, "observe", nil); refused || !strings.Contains(text, "At sea") {
			t.Fatalf("observe after the start: %v %q", refused, text)
		}
		go func() {
			text, _ := callTool(t, cs, "observe", map[string]any{"wait": 25})
			waited <- text
		}()
		time.Sleep(2 * time.Second)
		if status, body := owned(t, s, "/owner/api/accounts/revoke", map[string]any{"account": mary.String(), "reason": "leaked"}); status != 200 {
			t.Fatalf("revoke: %d %s", status, body)
		}
		if text := <-waited; text != accounts.AgentRevoked {
			t.Fatalf("the waiting call after the revoke: %q", text)
		}
		time.Sleep(time.Second)
		if boats, _ := seen(t, s); len(boats) != 2 || boats[mary.String()] == 0 {
			t.Fatalf("after the revoke: %v", boats)
		}
		token = db.machineFor("Iron Mary", ann, &mary)
		cs = agentSession(t, s, token)
		if text, refused := callTool(t, cs, "observe", nil); refused || strings.Contains(text, "you are in the water") {
			t.Fatalf("observe with a new token: %v %q", refused, text)
		}
		time.Sleep(time.Second)
		if boats, _ := seen(t, s); len(boats) != 2 || boats[mary.String()] != 0 {
			t.Fatalf("with a new token: %v", boats)
		}
		s.stop(t)
	})
}

// TestAStopInTheQueue: a machine sailor waiting for a place, stopped on
// its own, leaves the queue at once.
func TestAStopInTheQueue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}
		cookie, ann := db.sessions.Add("Ann", "human")
		s := again(t, map[string]string{"KEEL_WORLD_SEED": "1", "KEEL_BOAT_LIMIT": "1"}, db)
		connect(t, s, cookie)
		var mary store.AccountID
		cs := agentSession(t, s, db.machineFor("Iron Mary", ann, &mary))
		if text, _ := callTool(t, cs, "observe", nil); !strings.Contains(text, "in line") {
			t.Fatalf("observe: %q", text)
		}
		time.Sleep(time.Second)
		if _, waiting := seen(t, s); len(waiting) != 1 {
			t.Fatalf("waiting: %v", waiting)
		}
		if status, body := owned(t, s, "/owner/api/accounts/stop", map[string]any{"account": mary.String(), "reason": "a test"}); status != 200 {
			t.Fatalf("stop: %d %s", status, body)
		}
		time.Sleep(time.Second)
		if boats, waiting := seen(t, s); len(waiting) != 0 || len(boats) != 1 {
			t.Fatalf("after the stop: %v %v", boats, waiting)
		}
		s.stop(t)
	})
}
