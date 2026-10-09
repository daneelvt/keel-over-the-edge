// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// Restarts against the test database, on real sockets in real time: two
// keel serves, one after the other or both at once, on one database.

// realGuest makes a guest through the server's POST /guest and returns its
// session's cookie.
func realGuest(t *testing.T, s *realServer, name string) string {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"name": name, "look": string(cat.Sailors[0].ID)})
	req, err := http.NewRequest(http.MethodPost, s.net.url(t, "127.0.0.1:8080")+"/guest", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	for _, c := range res.Cookies() {
		if c.Name == auth.CookieName {
			return c.Value
		}
	}
	t.Fatalf("POST /guest answered %s with no session", res.Status)
	return ""
}

// sailing is a game connection whose snapshots are kept as they come.
type sailing struct {
	ws      *websocket.Conn
	welcome *pb.Welcome
	mu      sync.Mutex
	snaps   []timed
	done    chan error
}

type timed struct {
	at time.Time
	sn *protocol.Snapshot
}

func realConnect(t *testing.T, s *realServer, cookie string) *sailing {
	t.Helper()
	h := http.Header{}
	h.Set("Cookie", auth.CookieName+"="+cookie)
	u := strings.Replace(s.net.url(t, "127.0.0.1:8080"), "http", "ws", 1) + "/ws"
	ws, _, err := websocket.Dial(t.Context(), u, &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	if err := client.Send(t.Context(), ws, client.Hello()); err != nil {
		t.Fatal(err)
	}
	c := &sailing{ws: ws, done: make(chan error, 1)}
	in := client.Read(ws)
	for r := range in.C {
		if w := r.Message.GetWelcome(); w != nil {
			c.welcome = w
			break
		}
	}
	if c.welcome == nil {
		t.Fatalf("no welcome: %v", in.Err())
	}
	go func() {
		for r := range in.C {
			if r.Snapshot != nil {
				c.mu.Lock()
				c.snaps = append(c.snaps, timed{time.Now(), r.Snapshot})
				c.mu.Unlock()
			}
		}
		c.done <- in.Err()
	}()
	return c
}

// last is the newest snapshot, waiting for one if need be.
func (c *sailing) last(t *testing.T) timed {
	t.Helper()
	for start := time.Now(); time.Since(start) < 5*time.Second; time.Sleep(10 * time.Millisecond) {
		c.mu.Lock()
		n := len(c.snaps)
		var l timed
		if n > 0 {
			l = c.snaps[n-1]
		}
		c.mu.Unlock()
		if n > 0 {
			return l
		}
	}
	t.Fatal("no snapshot")
	return timed{}
}

func distance(a, b *protocol.Snapshot) float64 {
	return math.Hypot(a.State.X-b.State.X, a.State.Y-b.State.Y)
}

// TestTwoServersOneLease: a second keel serve on the same database waits
// for the lease, not ready and saying who holds it, and takes over within
// a second of the first's stop, with the epoch one higher.
func TestTwoServersOneLease(t *testing.T) {
	u := storetest.URL(t)
	first := startReal(t, u)
	first.waitReady(t)
	second := startReal(t, u)
	time.Sleep(1500 * time.Millisecond)
	if code, body := second.get(t, "127.0.0.1:9090", "/readyz"); code != 503 || !strings.Contains(body, "waiting for the simulation lease (held by ") {
		t.Fatalf("/readyz %d %q while the first holds the lease", code, body)
	}
	if _, metrics := first.get(t, "127.0.0.1:9090", "/metrics"); !strings.Contains(metrics, "keel_sim_lease_epoch 1") {
		t.Fatal("the first's epoch is not 1")
	}
	first.stop(t)
	stopped := time.Now()
	second.waitReady(t)
	if d := time.Since(stopped); d > 2*time.Second {
		t.Fatalf("the second was ready %v after the first stopped", d)
	}
	if _, metrics := second.get(t, "127.0.0.1:9090", "/metrics"); !strings.Contains(metrics, "keel_sim_lease_epoch 2") ||
		!strings.Contains(metrics, `keel_sim_restores_total{result="restored"} 1`) {
		t.Fatal("the second's epoch is not 2, or it restored nothing")
	}
	second.stop(t)
}

// TestRestartRejoinsTheBoat: a client sails; keel serve is stopped and a
// new one started on the same database; the client, connecting again, is
// welcomed back to its own boat, within a metre of where it was.
func TestRestartRejoinsTheBoat(t *testing.T) {
	u := storetest.URL(t)
	vars := map[string]string{"KEEL_DEV_COMMANDS": "1"}
	first := startRealWith(t, u, vars)
	first.waitReady(t)
	cookie := realGuest(t, first, "Ann")
	c := realConnect(t, first, cookie)
	start := c.last(t)
	if err := client.Send(t.Context(), c.ws, &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{Helm: 512, Sheet: 400}}}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(4 * time.Second)
	// The wind dies; the boat slows, and how fast it still drifts is
	// measured.
	res, err := http.Post(first.net.url(t, "127.0.0.1:9090")+"/debug/wind?knots=0&from=0", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	time.Sleep(6 * time.Second)
	a := c.last(t)
	time.Sleep(time.Second)
	b := c.last(t)
	drift := distance(a.sn, b.sn) / b.at.Sub(a.at).Seconds()

	first.stop(t)
	if err := <-c.done; websocket.CloseStatus(err) != websocket.StatusServiceRestart {
		t.Fatalf("closed with %v", err)
	}
	before := c.last(t)
	second := startRealWith(t, u, vars)
	second.waitReady(t)
	c2 := realConnect(t, second, cookie)
	if !c2.welcome.GetRejoined() || c2.welcome.GetBoat() != c.welcome.GetBoat() {
		t.Fatalf("welcomed to boat %d (rejoined %v), had %d", c2.welcome.GetBoat(), c2.welcome.GetRejoined(), c.welcome.GetBoat())
	}
	after := c2.last(t)
	if d := distance(start.sn, before.sn); d < 3 {
		t.Fatalf("the boat sailed only %.1f m", d)
	}
	bound := 1 + drift*after.at.Sub(before.at).Seconds()
	if d := distance(before.sn, after.sn); d > bound {
		t.Fatalf("the boat is %.2f m from where it was (drifting %.2f m/s, bound %.2f m)", d, drift, bound)
	}
	t.Logf("paused %v; the boat %.2f m from where it was, drifting %.3f m/s", after.at.Sub(before.at).Round(time.Millisecond),
		distance(before.sn, after.sn), drift)
	second.stop(t)
}
