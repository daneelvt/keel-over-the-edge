// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"fmt"
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

// memWatching is who follows whom, in a memDB, and the codes of the
// accounts' links to watch, made as they are first asked for.
type memWatching struct {
	mu      sync.Mutex
	follows map[store.AccountID]map[store.AccountID]bool
	codes   map[store.AccountID]string
	fleets  map[store.AccountID]string
	made    int
}

// codeOf is an account's sailor's code, or with fleet its fleet's, made
// if it has none yet.
func (d *memDB) codeOf(id store.AccountID, fleet bool) string {
	d.watching.mu.Lock()
	defer d.watching.mu.Unlock()
	if d.watching.codes == nil {
		d.watching.codes, d.watching.fleets = map[store.AccountID]string{}, map[store.AccountID]string{}
	}
	m, prefix := d.watching.codes, "w"
	if fleet {
		m, prefix = d.watching.fleets, "f"
	}
	if c, ok := m[id]; ok {
		return c
	}
	d.watching.made++
	m[id] = fmt.Sprintf("%s%d", prefix, d.watching.made)
	return m[id]
}

// byCode is the account whose sailor's code, or with fleet whose fleet's,
// is code.
func (d *memDB) byCode(code string, fleet bool) (store.AccountID, bool) {
	d.watching.mu.Lock()
	defer d.watching.mu.Unlock()
	m := d.watching.codes
	if fleet {
		m = d.watching.fleets
	}
	for id, c := range m {
		if c == code {
			return id, true
		}
	}
	return store.AccountID{}, false
}

func (d *memDB) sailorOf(ctx context.Context, id store.AccountID) (store.Sailor, bool) {
	sl, ok := d.SailorsByID(ctx, []store.AccountID{id})
	s, found := sl[id]
	return s, ok == nil && found
}

func (d *memDB) LinkCodes(ctx context.Context, id store.AccountID) (store.LinkCodes, error) {
	s, ok := d.sailorOf(ctx, id)
	if !ok {
		return store.LinkCodes{}, store.ErrNotFound
	}
	c := store.LinkCodes{Sailor: s.Code}
	if s.Kind == store.Human {
		c.Fleet = d.codeOf(id, true)
	}
	return c, nil
}

func (d *memDB) LinkTarget(ctx context.Context, code string) (store.WatchTarget, error) {
	id, ok := d.byCode(code, false)
	if !ok {
		return store.WatchTarget{}, store.ErrNotFound
	}
	s, ok := d.sailorOf(ctx, id)
	if !ok {
		return store.WatchTarget{}, store.ErrNotFound
	}
	return d.WatchTarget(ctx, moderation.Key(s.Name))
}

func (d *memDB) FleetLinkOwner(_ context.Context, code string) (store.AccountID, error) {
	if id, ok := d.byCode(code, true); ok {
		return id, nil
	}
	return store.AccountID{}, store.ErrNotFound
}

func (d *memDB) NewWatchCode(ctx context.Context, owner, id store.AccountID) (string, error) {
	s, ok := d.sailorOf(ctx, id)
	if !ok || (id == owner) != (s.Kind == store.Human) || id != owner && s.Owner != owner {
		return "", store.ErrNotFound
	}
	d.watching.mu.Lock()
	delete(d.watching.codes, id)
	d.watching.mu.Unlock()
	return d.codeOf(id, false), nil
}

func (d *memDB) NewFleetCode(ctx context.Context, id store.AccountID) (string, error) {
	if s, ok := d.sailorOf(ctx, id); !ok || s.Kind != store.Human {
		return "", store.ErrNotFound
	}
	d.codeOf(id, true)
	d.watching.mu.Lock()
	delete(d.watching.fleets, id)
	d.watching.mu.Unlock()
	return d.codeOf(id, true), nil
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
	return store.WatchTarget{ID: t.ID, Kind: t.Kind, Name: t.Name, Stopped: d.isStopped(t.ID)}, nil
}

func (d *memDB) WatchTargetByID(ctx context.Context, id store.AccountID) (store.WatchTarget, error) {
	d.tokens.mu.Lock()
	for _, g := range d.tokens.tokens {
		if g.Account == id {
			d.tokens.mu.Unlock()
			return d.WatchTarget(ctx, moderation.Key(g.Name))
		}
	}
	d.tokens.mu.Unlock()
	if d.sessions == nil {
		return store.WatchTarget{}, store.ErrNotFound
	}
	t, err := d.sessions.TargetByID(ctx, id)
	if err != nil {
		return store.WatchTarget{}, err
	}
	return store.WatchTarget{ID: t.ID, Kind: t.Kind, Name: t.Name, Stopped: d.isStopped(t.ID), Born: t.Born}, nil
}

func (d *memDB) Follows(ctx context.Context, follower store.AccountID) ([]store.Followed, error) {
	d.watching.mu.Lock()
	var ids []store.AccountID
	for id := range d.watching.follows[follower] {
		ids = append(ids, id)
	}
	d.watching.mu.Unlock()
	sailors, err := d.SailorsByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	var out []store.Followed
	for _, id := range ids {
		if sl, ok := sailors[id]; ok {
			out = append(out, store.Followed{ID: id, Sailor: sl})
		}
	}
	return out, nil
}

func (d *memDB) Follow(_ context.Context, follower, followed store.AccountID) error {
	d.watching.mu.Lock()
	defer d.watching.mu.Unlock()
	if d.watching.follows == nil {
		d.watching.follows = map[store.AccountID]map[store.AccountID]bool{}
	}
	if d.watching.follows[follower] == nil {
		d.watching.follows[follower] = map[store.AccountID]bool{}
	}
	d.watching.follows[follower][followed] = true
	return nil
}

func (d *memDB) Unfollow(_ context.Context, follower, followed store.AccountID) error {
	d.watching.mu.Lock()
	defer d.watching.mu.Unlock()
	delete(d.watching.follows[follower], followed)
	return nil
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
	for id, s := range out {
		s.Code = d.codeOf(id, false)
		out[id] = s
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
		for _, path := range []string{"/api/watch", "/api/watch/sailor?name=Bob"} {
			if status, _ := asked(t, s, cid+"x", "GET", path, nil); status != 401 {
				t.Fatalf("%s with no session: %d", path, status)
			}
		}
		if status, body := asked(t, s, bob, "POST", "/api/me/spectators", map[string]string{"allow": "always"}); status != 400 || !strings.Contains(body, `"allow"`) {
			t.Fatalf("always: %d %s", status, body)
		}

		// The facts: Cid, with no boat, sees where the boats are; Bob, at
		// sea, does not, but for the sky, the wind and the speed.
		page := func(cookie, query string) watchPage {
			t.Helper()
			status, body := asked(t, s, cookie, "GET", "/api/watch?"+query, nil)
			var p watchPage
			if err := json.Unmarshal([]byte(body), &p); status != 200 || err != nil {
				t.Fatalf("the list %q: %d %s", query, status, body)
			}
			return p
		}
		cidPage := page(cid, "sort=edge")
		if cidPage.AtSea != 2 || cidPage.Withheld || len(cidPage.Sailors) != 2 {
			t.Fatalf("Cid's page: %+v", cidPage)
		}
		for _, it := range cidPage.Sailors {
			if it.EdgeNM == nil || it.Sky == "" || it.State != "sailing" || it.Kind == "" {
				t.Fatalf("Cid's row of %s: %+v", it.Name, it)
			}
		}
		bobPage := page(bob, "sort=edge")
		if !bobPage.Withheld || len(bobPage.Sailors) != 1 || bobPage.Sailors[0].EdgeNM != nil || bobPage.Sailors[0].Sky == "" {
			t.Fatalf("Bob's page: %+v", bobPage)
		}
		if p := page(cid, "names=iron%20mary,Nobody,Bob"); len(p.Sailors) != 2 {
			t.Fatalf("by names: %+v", p)
		}
		card := func(cookie, name string) (int, map[string]any) {
			t.Helper()
			status, body := asked(t, s, cookie, "GET", "/api/watch/sailor?name="+name, nil)
			var c map[string]any
			_ = json.Unmarshal([]byte(body), &c)
			return status, c
		}
		if status, c := card(cid, "Iron%20Mary"); status != 200 || c["weather"] == nil || c["where"] == nil || c["agent"] != nil {
			t.Fatalf("Cid's card of Iron Mary: %d %v", status, c)
		}
		if status, c := card(bob, "Iron%20Mary"); status != 200 || c["weather"] == nil || c["where"] != nil {
			t.Fatalf("Bob's card of Iron Mary, at sea: %d %v", status, c)
		}
		if status, c := card(ann, "Iron%20Mary"); status != 200 || c["agent"] == nil || c["where"] == nil {
			t.Fatalf("Ann's card of her own: %d %v", status, c)
		}
		if status, c := card(cid, "Nobody"); status != 404 || c["error"] != "cannot" {
			t.Fatalf("a card of nobody: %d %v", status, c)
		}

		// Cid follows Iron Mary and Bob: first after nobody's own.
		for _, name := range []string{"Iron Mary", "bob"} {
			if status, body := asked(t, s, cid, "POST", "/api/watch/follow", map[string]any{"name": name, "on": true}); status != 200 {
				t.Fatalf("following %s: %d %s", name, status, body)
			}
		}
		if p := page(cid, "who=following&sort=name"); len(p.Sailors) != 2 || !p.Sailors[0].Followed || p.Sailors[0].Name != "Bob" {
			t.Fatalf("Cid's follows: %+v", p)
		}
		if status, body := asked(t, s, cid, "POST", "/api/watch/follow", map[string]any{"name": "Ann", "on": true}); status != 404 || !strings.Contains(body, `"cannot"`) {
			t.Fatalf("following one who cannot be watched: %d %s", status, body)
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
		// Bob, no longer allowing, is followed but cannot be watched.
		time.Sleep(3 * time.Second)
		if p := page(cid, "who=following&sort=name"); len(p.Sailors) != 2 || p.Sailors[0].Name != "Iron Mary" || p.Sailors[1].Gone != "cannot" {
			t.Fatalf("Cid's follows once Bob stops allowing: %+v", p)
		}
		if status, body := asked(t, s, cid, "POST", "/api/watch/follow", map[string]any{"name": "Bob", "on": false}); status != 200 || body != `{"following":1}`+"\n" {
			t.Fatalf("unfollowing Bob: %d %q", status, body)
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

// TestLinksToWatch: the codes of a human's own links on GET /api/me; a
// sailor's link found, refused alike for a human not allowing, and a
// machine sailor's; a fleet's link finds its machine sailors and never
// names their human, nor puts the human's own boat among them; the list's
// fleet filter; following by a link whatever the sailor's state; a
// machine sailor's card carries its code and a human's does not; a link
// made anew stops the old one; and none of it without a session.
func TestLinksToWatch(t *testing.T) {
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
		annWS, _, _ := connect(t, s, ann)
		defer annWS.CloseNow()
		bobWS, _, _ := connect(t, s, bob)
		defer bobWS.CloseNow()
		time.Sleep(3 * time.Second)

		codes := func(cookie string) (string, string) {
			t.Helper()
			status, body := asked(t, s, cookie, "GET", "/api/me", nil)
			var m struct {
				WatchCode string `json:"watchCode"`
				FleetCode string `json:"fleetCode"`
			}
			if err := json.Unmarshal([]byte(body), &m); status != 200 || err != nil || m.WatchCode == "" || m.FleetCode == "" {
				t.Fatalf("the codes: %d %s", status, body)
			}
			return m.WatchCode, m.FleetCode
		}
		annCode, annFleet := codes(ann)
		bobCode, _ := codes(bob)
		_, c := func() (int, map[string]any) {
			status, body := asked(t, s, cid, "GET", "/api/watch/sailor?name=Iron%20Mary", nil)
			var c map[string]any
			_ = json.Unmarshal([]byte(body), &c)
			return status, c
		}()
		maryCode, _ := c["code"].(string)
		if maryCode == "" {
			t.Fatalf("Iron Mary's card: %v", c)
		}
		link := func(cookie, query string, want int, has ...string) string {
			t.Helper()
			status, body := asked(t, s, cookie, "GET", "/api/watch/link?"+query, nil)
			if status != want {
				t.Fatalf("%s: %d %s", query, status, body)
			}
			for _, h := range has {
				if !strings.Contains(body, h) {
					t.Fatalf("%s: %s, want %s", query, body, h)
				}
			}
			return body
		}
		link(cid, "w="+bobCode, 404, `"error":"cannot"`, `"name":"Bob"`)
		link(cid, "w="+annCode, 404, `"error":"cannot"`, `"name":"Ann"`)
		link(cid, "w="+maryCode, 200, `{"name":"Iron Mary","machine":true}`)
		link(ann, "w="+annCode, 404, `"error":"own"`)
		link(cid, "w=nobody", 404, `{"error":"no-link"}`)
		link(cid, "", 400, `"link"`)
		if body := link(cid, "f="+annFleet, 200, `{"sailors":[{"name":"Iron Mary","machine":true,"mine":false`); strings.Contains(body, "Ann") {
			t.Fatalf("the fleet names its human: %s", body)
		}
		if status, _ := asked(t, s, cid+"x", "GET", "/api/watch/link?w="+maryCode, nil); status != 401 {
			t.Fatalf("with no session: %d", status)
		}
		if status, body := asked(t, s, cid, "GET", "/api/watch?fleet="+annFleet, nil); status != 200 || !strings.Contains(body, "Iron Mary") || strings.Contains(body, "Bob") {
			t.Fatalf("the fleet's list: %d %s", status, body)
		}
		if status, body := asked(t, s, cid, "GET", "/api/watch?fleet=nobody", nil); status != 404 || !strings.Contains(body, "no-link") {
			t.Fatalf("no fleet: %d %s", status, body)
		}

		// Cid follows Bob by his link while Bob does not allow: the same
		// answer as for one who does.
		if status, body := asked(t, s, cid, "POST", "/api/watch/follow", map[string]any{"code": bobCode, "on": true}); status != 200 || body != `{"following":1}`+"\n" {
			t.Fatalf("following Bob by his link: %d %s", status, body)
		}
		if status, body := asked(t, s, cid, "POST", "/api/watch/follow", map[string]any{"code": maryCode, "on": true}); status != 200 || body != `{"following":2}`+"\n" {
			t.Fatalf("following Iron Mary by her link: %d %s", status, body)
		}
		if status, _ := asked(t, s, bob, "POST", "/api/me/spectators", map[string]string{"allow": "voyage"}); status != 200 {
			t.Fatal("Bob allows")
		}
		time.Sleep(3 * time.Second)
		link(cid, "w="+bobCode, 200, `{"name":"Bob","machine":false}`)
		if status, body := asked(t, s, cid, "GET", "/api/watch/sailor?name=Bob", nil); status != 200 || strings.Contains(body, `"code"`) {
			t.Fatalf("Bob's card: %d %s", status, body)
		}

		// Made anew, the old links find nothing.
		for _, which := range []map[string]string{{"which": "me"}, {"which": "fleet"}, {"which": "machine", "machine": mary.String()}} {
			if status, body := asked(t, s, ann, "POST", "/api/me/link/new", which); status != 200 || !strings.Contains(body, `"code"`) {
				t.Fatalf("%v anew: %d %s", which, status, body)
			}
		}
		link(cid, "w="+annCode, 404, "no-link")
		link(cid, "f="+annFleet, 404, "no-link")
		link(cid, "w="+maryCode, 404, "no-link")
		if status, _ := asked(t, s, bob, "POST", "/api/me/link/new", map[string]string{"which": "machine", "machine": mary.String()}); status != 404 {
			t.Fatalf("another's machine sailor: %d", status)
		}
		if status, _ := asked(t, s, bob, "POST", "/api/me/link/new", map[string]string{"which": "all"}); status != 400 {
			t.Fatalf("none of the links: %d", status)
		}
		s.stop(t)
	})
}

// watchPage is a page of the list, as the test reads it.
type watchPage struct {
	Sailors []struct {
		Name     string   `json:"name"`
		Kind     string   `json:"kind"`
		Sky      string   `json:"sky"`
		State    string   `json:"state"`
		Followed bool     `json:"followed"`
		EdgeNM   *float64 `json:"edgeNM"`
		Gone     string   `json:"gone"`
	} `json:"sailors"`
	AtSea    int  `json:"atSea"`
	Withheld bool `json:"withheld"`
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
