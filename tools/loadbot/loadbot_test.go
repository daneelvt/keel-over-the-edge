// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// testGuests makes guests in the test server's own store, counting them.
type testGuests struct {
	srv     *edgetest.Server
	mu      sync.Mutex
	made    int
	valid   map[string]bool
	refused bool
}

func (g *testGuests) Create(_ context.Context, name string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	// The name of guest 3 is refused once, as the server's filter might.
	if name == "Loadbot 3" && !g.refused {
		g.refused = true
		return "", errNameRefused
	}
	token, _ := g.srv.Sessions.Add(name, store.Human)
	g.made++
	g.valid[token] = true
	return token, nil
}

func (g *testGuests) Valid(_ context.Context, cookie string) (bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.valid[cookie], nil
}

// TestBots: 20 bots join the in-memory server, sail, see each other, are
// reported, and close cleanly; a second run uses the sessions the first
// saved and makes no guest; with lag, the connections go through the lag
// model.
func TestBots(t *testing.T) {
	sessions := filepath.Join(t.TempDir(), "sessions.json")
	synctest.Test(t, func(t *testing.T) {
		srv := edgetest.NewServer(t, edgetest.Config{Capacity: 64})
		guests := &testGuests{srv: srv, valid: map[string]bool{}}
		dial := func(ctx context.Context, cookie string, wrap func(net.Conn) net.Conn) (*websocket.Conn, error) {
			ws, _, err := srv.Dial(ctx, edgetest.DialOptions{Cookie: cookie, Wrap: wrap})
			return ws, err
		}
		var out strings.Builder
		cfg := Config{N: 20, Sail: 20 * time.Second, Ramp: 2 * time.Second, FrameEvery: time.Second / 30,
			Guests: guests, Sessions: sessions, Dial: dial, Out: &out}
		rep, err := Run(t.Context(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		t.Log(out.String())
		if rep.Made != 20 {
			t.Fatalf("%d guests made", rep.Made)
		}
		for _, p := range rep.Players {
			if p.RTT > 10*time.Millisecond {
				t.Fatalf("%s: a round trip of %v with no lag", p.Name, p.RTT)
			}
			s := p.Stats
			if s.Snapshots < 250 || s.FramesIn < 250*160 || s.MaxOthers != 19 || p.Errors != 0 || s.Corrections != 0 || s.Dropped != 0 {
				t.Fatalf("%s: %d snapshots, %d bytes in, at most %d others in view, %d errors, %d corrections, %d dropped",
					p.Name, s.Snapshots, s.FramesIn, s.MaxOthers, p.Errors, s.Corrections, s.Dropped)
			}
		}
		if !strings.Contains(out.String(), "bytes a player a second") {
			t.Fatalf("no report: %s", out.String())
		}

		// Again, through the lag model: the same guests, none made.
		cfg.Lag = &client.Lag{Delay: 100 * time.Millisecond, Loss: 0.02}
		cfg.Sail, cfg.Ramp, cfg.Out = 10*time.Second, 0, nil
		again, err := Run(t.Context(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		if again.Made != 0 || guests.made != 20 {
			t.Fatalf("the second run made %d guests", again.Made)
		}
		for _, p := range again.Players {
			// The round trip the clock measured is the model's.
			if p.Stats.Snapshots < 100 || p.Errors != 0 || p.RTT < 190*time.Millisecond || p.RTT > 260*time.Millisecond {
				t.Fatalf("%s through the lag: %d snapshots, %d errors, a round trip of %v", p.Name, p.Stats.Snapshots, p.Errors, p.RTT)
			}
		}
	})
}

// TestBotsAcrossARestart: the server restarts while the bots sail: each
// hears the bell, is closed with 1012, waits as the page does and comes
// back to its own boat, which sailed on in its grace from where it was;
// the report says so.
func TestBotsAcrossARestart(t *testing.T) {
	sessions := filepath.Join(t.TempDir(), "sessions.json")
	synctest.Test(t, func(t *testing.T) {
		srv := edgetest.NewServer(t, edgetest.Config{Capacity: 64})
		guests := &testGuests{srv: srv, valid: map[string]bool{}}
		dial := func(ctx context.Context, cookie string, wrap func(net.Conn) net.Conn) (*websocket.Conn, error) {
			ws, _, err := srv.Dial(ctx, edgetest.DialOptions{Cookie: cookie, Wrap: wrap})
			return ws, err
		}
		go func() {
			time.Sleep(8 * time.Second)
			srv.Restart(t, 2*time.Second)
		}()
		var out strings.Builder
		rep, err := Run(t.Context(), Config{N: 10, Sail: 20 * time.Second, FrameEvery: time.Second / 30,
			Guests: guests, Sessions: sessions, Dial: dial, Out: &out})
		if err != nil {
			t.Fatal(err)
		}
		t.Log(out.String())
		for _, p := range rep.Players {
			if len(p.Returns) != 1 || p.Stats.Bells != 1 || p.Closes[1012] != 1 {
				t.Fatalf("%s: returns %+v, %d bells, closes %v", p.Name, p.Returns, p.Stats.Bells, p.Closes)
			}
			b := p.Returns[0]
			// The pause: the server's 2 s, and the page's wait of 0.5 to 5 s
			// or, if it came first, another second's.
			if !b.Rejoined || b.Code != 1012 || b.Pause < 2*time.Second || b.Pause > 7*time.Second || b.Distance > 3*b.Pause.Seconds() {
				t.Fatalf("%s came back %+v", p.Name, b)
			}
		}
		if !strings.Contains(out.String(), "came back 10 times (10 bells heard): 10 to their own boat, 0 to a new one") ||
			!strings.Contains(out.String(), "the pause, s: median") {
			t.Fatalf("the report: %s", out.String())
		}
	})
}

func TestQuantile(t *testing.T) {
	before := parse(`
keel_x_bucket{le="0.001"} 10
keel_x_bucket{le="0.01"} 10
keel_x_bucket{le="+Inf"} 10
keel_x_sum 0.005
keel_x_count 10
`)
	after := parse(`
# HELP keel_x a histogram
keel_x_bucket{le="0.001"} 50
keel_x_bucket{le="0.01"} 109
keel_x_bucket{le="+Inf"} 110
keel_x_sum 0.205
keel_x_count 110
`)
	q, mean := quantile(before, after, "keel_x", 0.99)
	if q != 0.01 || mean != 0.002 {
		t.Fatalf("p99 %v, mean %v", q, mean)
	}
}
