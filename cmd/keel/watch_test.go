// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// memWatching is who lets anyone watch them always, in a memDB.
type memWatching struct {
	mu     sync.Mutex
	always map[store.AccountID]bool
}

func (d *memDB) WatchTarget(ctx context.Context, key string) (store.WatchTarget, error) {
	d.tokens.mu.Lock()
	for _, g := range d.tokens.tokens {
		if moderation.Key(g.Name) == key {
			d.tokens.mu.Unlock()
			d.stops.mu.Lock()
			owner := d.stopsLocked().owners[g.Account]
			d.stops.mu.Unlock()
			return store.WatchTarget{ID: g.Account, Kind: store.AI, Owner: owner, Name: g.Name, Stopped: d.isStopped(g.Account)}, nil
		}
	}
	d.tokens.mu.Unlock()
	if d.sessions == nil {
		return store.WatchTarget{}, store.ErrNotFound
	}
	t, err := d.sessions.Target(ctx, key)
	if err != nil {
		return store.WatchTarget{}, err
	}
	d.watching.mu.Lock()
	defer d.watching.mu.Unlock()
	return store.WatchTarget{ID: t.ID, Kind: t.Kind, Name: t.Name, Always: d.watching.always[t.ID], Stopped: d.isStopped(t.ID)}, nil
}

func (d *memDB) SetSpectators(_ context.Context, id store.AccountID, on bool) error {
	d.watching.mu.Lock()
	defer d.watching.mu.Unlock()
	if d.watching.always == nil {
		d.watching.always = map[store.AccountID]bool{}
	}
	d.watching.always[id] = on
	return nil
}

func (d *memDB) SpectatorsAllowed(context.Context) ([]store.AccountID, error) {
	d.watching.mu.Lock()
	defer d.watching.mu.Unlock()
	var ids []store.AccountID
	for id, on := range d.watching.always {
		if on {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func (d *memDB) SailorsByID(ctx context.Context, ids []store.AccountID) (map[store.AccountID]store.Sailor, error) {
	out := map[store.AccountID]store.Sailor{}
	d.tokens.mu.Lock()
	for _, g := range d.tokens.tokens {
		out[g.Account] = store.Sailor{Name: g.Name, Kind: store.AI}
	}
	d.tokens.mu.Unlock()
	d.stops.mu.Lock()
	for id, s := range out {
		s.Owner = d.stopsLocked().owners[id]
		out[id] = s
	}
	d.stops.mu.Unlock()
	if d.sessions != nil {
		accs, _ := d.sessions.Accounts(ctx, ids)
		for id, a := range accs {
			out[id] = store.Sailor{Name: a.Name, Kind: a.Kind}
		}
	}
	return out, nil
}

// asked sends a request to the play listener with a session's cookie,
// and returns its status and body.
func asked(t *testing.T, s *server, cookie, method, path string, body any) (int, string) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = strings.NewReader(string(b))
	}
	req, err := http.NewRequestWithContext(t.Context(), method, "http://127.0.0.1:8080"+path, r)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Cookie", auth.CookieName+"="+cookie)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// TestWatchingFromThePlayRoutes: the list of sailors to watch, the
// setting, and the watch over the game connection, through keel serve. A
// human appears on the list only once they allow spectators; the owner's
// machine sailor is first on their own list; a sailor told how many watch
// their boat; turning spectators off ends the watch within a second; the
// owner, sailing, watches their machine sailor, leaving the water, and
// sails again from the start.
func TestWatchingFromThePlayRoutes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}
		ann, annID := db.sessions.Add("Ann", "human")
		bob, _ := db.sessions.Add("Bob", "human")
		cid, _ := db.sessions.Add("Cid", "human")
		s := again(t, map[string]string{"KEEL_WORLD_SEED": "1"}, db)
		var mary store.AccountID
		token := db.machineFor("Iron Mary", annID, &mary)
		if text, refused := callTool(t, agentSession(t, s, token), "observe", nil); refused || !strings.Contains(text, "At sea") {
			t.Fatalf("observe: %v %q", refused, text)
		}
		_, bobIn, _ := connect(t, s, bob)
		time.Sleep(3 * time.Second)

		list := func(cookie string) string {
			t.Helper()
			status, body := asked(t, s, cookie, "GET", "/api/watch?q=", nil)
			if status != 200 {
				t.Fatalf("the list: %d %s", status, body)
			}
			return body
		}
		if got := list(cid); !strings.Contains(got, `"name":"Iron Mary","machine":true,"mine":false`) || strings.Contains(got, "Bob") {
			t.Fatalf("Cid's list before Bob allows: %s", got)
		}
		if status, body := asked(t, s, bob, "POST", "/api/me/spectators", map[string]string{"allow": "sometimes"}); status != 400 {
			t.Fatalf("not a choice: %d %s", status, body)
		}
		if status, body := asked(t, s, bob, "POST", "/api/me/spectators", map[string]string{"allow": "voyage"}); status != 200 ||
			!strings.Contains(body, `"spectators":"voyage"`) || !strings.Contains(body, `"atSea":true`) {
			t.Fatalf("this voyage: %d %s", status, body)
		}
		time.Sleep(3 * time.Second)
		if got := list(cid); !strings.Contains(got, `"name":"Bob"`) {
			t.Fatalf("Cid's list once Bob allows: %s", got)
		}
		if got := list(ann); !strings.HasPrefix(got, `{"sailors":[{"name":"Iron Mary","machine":true,"mine":true`) {
			t.Fatalf("Ann's list: %s", got)
		}
		if status, _ := asked(t, s, cid+"x", "GET", "/api/watch", nil); status != 401 {
			t.Fatalf("no session: %d", status)
		}

		// Cid watches Bob; Bob is told; Bob turns spectators off.
		ws := dialWatch(t, s, cid, "bob")
		defer ws.CloseNow()
		cidIn := client.Read(ws)
		awaitMessage(t, cidIn, func(m *pb.ServerMessage) bool { return m.GetWelcome().GetWatching().GetSailor() == "Bob" })
		awaitMessage(t, bobIn, func(m *pb.ServerMessage) bool { return m.GetWatchers().GetCount() == 1 })
		if status, _ := asked(t, s, bob, "POST", "/api/me/spectators", map[string]string{"allow": "no"}); status != 200 {
			t.Fatal("spectators off")
		}
		at := time.Now()
		awaitMessage(t, cidIn, func(m *pb.ServerMessage) bool {
			return m.GetWatchEnded().GetWhy() == pb.WatchEnd_WATCH_END_OFF
		})
		if d := time.Since(at); d > time.Second {
			t.Fatalf("the watch ended %v after", d)
		}

		// Ann, sailing, watches Iron Mary: her boat leaves the water; she
		// sails again, a new boat.
		annWS, annIn, w := connect(t, s, ann)
		defer annWS.CloseNow()
		first := w.GetBoat()
		time.Sleep(time.Second)
		if err := client.Send(t.Context(), annWS, client.Watch("Iron Mary")); err != nil {
			t.Fatal(err)
		}
		awaitMessage(t, annIn, func(m *pb.ServerMessage) bool { return m.GetWelcome().GetWatching().GetMine() })
		time.Sleep(time.Second)
		if _, body := asked(t, s, ann, "GET", "/api/me", nil); strings.Contains(body, `"atSea":true`) {
			t.Fatalf("Ann's boat is still in the water: %s", body)
		}
		if err := client.Send(t.Context(), annWS, client.Sail()); err != nil {
			t.Fatal(err)
		}
		var again *pb.Welcome
		awaitMessage(t, annIn, func(m *pb.ServerMessage) bool {
			again = m.GetWelcome()
			return again != nil
		})
		if again.GetWatching() != nil || again.GetBoat() == first || again.GetRejoined() {
			t.Fatalf("sailing again: %v", again)
		}
		s.stop(t)
	})
}

// dialWatch opens the game connection to watch a sailor.
func dialWatch(t *testing.T, s *server, cookie, sailor string) *websocket.Conn {
	t.Helper()
	h := http.Header{}
	h.Set("Cookie", auth.CookieName+"="+cookie)
	ws, _, err := websocket.Dial(t.Context(), "ws://127.0.0.1:8080/ws", &websocket.DialOptions{HTTPClient: s.client, HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Send(t.Context(), ws, client.HelloWatch(sailor)); err != nil {
		t.Fatal(err)
	}
	return ws
}

// awaitMessage reads until a message ok says so comes, for at most ten
// seconds.
func awaitMessage(t *testing.T, in *client.Inbox, ok func(*pb.ServerMessage) bool) {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case r, open := <-in.C:
			if !open {
				t.Fatalf("the connection ended: %v", in.Err())
			}
			if r.Message != nil && ok(r.Message) {
				return
			}
		case <-timeout:
			t.Fatal("no such message")
		}
	}
}

// TestTheLampOfTheOwnMachineSailor: an owner watching their machine
// sailor through keel serve is told its agent is at the helm while it
// calls, and through a wait; quiet a minute after its last call; and
// nothing more once the boat has left the water for its silence.
func TestTheLampOfTheOwnMachineSailor(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}
		ann, annID := db.sessions.Add("Ann", "human")
		s := again(t, map[string]string{"KEEL_WORLD_SEED": "1", "KEEL_AI_SILENCE": "90s"}, db)
		var mary store.AccountID
		cs := agentSession(t, s, db.machineFor("Iron Mary", annID, &mary))
		if text, refused := callTool(t, cs, "observe", nil); refused || !strings.Contains(text, "At sea") {
			t.Fatalf("observe: %v %q", refused, text)
		}
		ws := dialWatch(t, s, ann, "Iron Mary")
		defer ws.CloseNow()
		in := client.Read(ws)
		awaitMessage(t, in, func(m *pb.ServerMessage) bool { return m.GetWelcome().GetWatching().GetMine() })
		// A wait under way.
		done := make(chan struct{})
		go func() {
			defer close(done)
			if _, err := cs.CallTool(t.Context(), &mcp.CallToolParams{Name: "observe", Arguments: map[string]any{"wait": 25, "wake_on": []string{"chat"}}}); err != nil {
				t.Errorf("the wait: %v", err)
			}
		}()
		var lamps []pb.Lamp
		var ended *pb.WatchEnded
		// Reads for d, pinging as a client does, until ok says so.
		watch := func(d time.Duration, ok func() bool) bool {
			t.Helper()
			for end := time.Now().Add(d); time.Now().Before(end); {
				if err := client.Send(t.Context(), ws, &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTimeUs: 1}}}); err != nil {
					t.Fatal(err)
				}
				for wait := time.After(2 * time.Second); ; {
					select {
					case r := <-in.C:
						if l := r.Message.GetAgentLamp(); l != nil {
							lamps = append(lamps, l.GetState())
						}
						if e := r.Message.GetWatchEnded(); e != nil {
							ended = e
						}
						continue
					case <-wait:
					}
					break
				}
				if ok != nil && ok() {
					return true
				}
			}
			return ok == nil
		}
		last := func() pb.Lamp {
			if len(lamps) == 0 {
				return pb.Lamp_LAMP_UNSPECIFIED
			}
			return lamps[len(lamps)-1]
		}
		if !watch(10*time.Second, func() bool { return last() == pb.Lamp_LAMP_AT_HELM }) {
			t.Fatalf("calling: %v", lamps)
		}
		<-done
		// No call since the wait began: quiet a minute after it.
		if !watch(90*time.Second, func() bool { return last() == pb.Lamp_LAMP_QUIET }) {
			t.Fatalf("silent: %v", lamps)
		}
		if !watch(3*time.Minute, func() bool { return ended != nil }) || ended.GetWhy() != pb.WatchEnd_WATCH_END_LEFT {
			t.Fatalf("the boat gone: %v", ended)
		}
		n := len(lamps)
		watch(5*time.Second, nil)
		if len(lamps) != n || !slices.Equal(lamps, []pb.Lamp{pb.Lamp_LAMP_AT_HELM, pb.Lamp_LAMP_QUIET}) {
			t.Fatalf("told %v", lamps)
		}
		s.stop(t)
	})
}
