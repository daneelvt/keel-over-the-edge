// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/helmsman"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// A machine sailor at sea through keel's own agents' listener: an agent
// with a connection token, on the MCP SDK's client, goes to sea, steers,
// waits, and falls silent.

// machineTokens are the connection tokens a memDB knows, by their hashes.
type machineTokens struct {
	mu     sync.Mutex
	tokens map[[32]byte]store.TokenGrant
}

// machine makes a machine sailor's connection token on db, and returns it
// and the machine sailor's account.
func (d *memDB) machine(name, owner string, priority bool) (string, store.AccountID) {
	token, hash := oauth.NewToken(oauth.KindConnection)
	var id store.AccountID
	copy(id[:], hash[:16])
	id[6], id[8] = 0x70|id[6]&0x0f, 0x80|id[8]&0x3f
	d.tokens.mu.Lock()
	defer d.tokens.mu.Unlock()
	if d.tokens.tokens == nil {
		d.tokens.tokens = map[[32]byte]store.TokenGrant{}
	}
	d.tokens.tokens[hash] = store.TokenGrant{
		Kind: store.TokenConnection, GrantKind: store.GrantConnection, Grant: [16]byte(hash[16:]), Approved: time.Now(),
		Account: id, Name: name, OwnerName: owner, Priority: priority,
	}
	return token, id
}

func (d *memDB) TokenGrant(_ context.Context, hash [32]byte) (store.TokenGrant, error) {
	d.tokens.mu.Lock()
	defer d.tokens.mu.Unlock()
	if t, ok := d.tokens.tokens[hash]; ok {
		return t, nil
	}
	return store.TokenGrant{}, store.ErrNotFound
}

// agentsHost is the MCP address's host the tests' servers have: the play
// origin's, by default.
const agentsHost = "play.example.com"

// toAgents sends a request to the agents' listener on the memory net,
// with the MCP address's host, and a token.
type toAgents struct {
	next  http.RoundTripper
	token string
}

func (t toAgents) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.URL.Scheme, r.URL.Host, r.Host = "http", "127.0.0.1:8081", agentsHost
	r.Header.Set("Authorization", "Bearer "+t.token)
	return t.next.RoundTrip(r)
}

// agentSession is an MCP session with keel's agents' listener, as the
// machine sailor of token.
func agentSession(t *testing.T, s *server, token string) *mcp.ClientSession {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "keel-test-agent", Version: "1"}, nil)
	hc := &http.Client{Transport: toAgents{next: s.client.Transport, token: token}}
	cs, err := c.Connect(t.Context(), &mcp.StreamableClientTransport{Endpoint: "http://" + agentsHost + "/mcp", HTTPClient: hc, DisableStandaloneSSE: true}, nil)
	if err != nil {
		t.Fatalf("connecting: %v\n%s", err, s.logs.String())
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

// callTool calls a tool and returns its text and whether it was refused.
func callTool(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) (string, bool) {
	t.Helper()
	res, err := cs.CallTool(t.Context(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String(), res.IsError
}

func TestAMachineSailorSails(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		vars := map[string]string{"KEEL_DEV_COMMANDS": "1", "KEEL_WORLD_SEED": "1", "KEEL_AI_SILENCE": "20s"}
		s, _ := gameServer(t, vars, db)
		res, err := s.client.Post(internalURL+"/debug/wind?knots=12&from=0", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		time.Sleep(2500 * time.Millisecond)
		token, _ := db.machine("Iron Mary", "Ann Bonny", false)
		cs := agentSession(t, s, token)

		// The list of tools is the twelve, in their order.
		tl, err := cs.ListTools(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, tool := range tl.Tools {
			names = append(names, tool.Name)
		}
		if got := strings.Join(names, " "); got != "observe steer trim chart pencil forecast news say race boat bottle handbook" {
			t.Fatalf("the tools: %s", got)
		}

		// Reading the chart does not go to sea; the first call is primed.
		text, refused := callTool(t, cs, "chart", nil)
		if refused || !strings.Contains(text, "never pauses") || !strings.Contains(text, "not at sea") {
			t.Fatalf("chart: %v %q", refused, text)
		}
		// observe goes to sea.
		text, refused = callTool(t, cs, "observe", nil)
		if refused || !strings.Contains(text, "At sea: you are in the water") || !strings.Contains(text, "Boat: sailing") {
			t.Fatalf("observe: %v %q", refused, text)
		}
		// A beam reach on the side it starts on, the boom out: the boat
		// sails. (A boat starts heading east, the wind from the north over
		// its port side.)
		text, refused = callTool(t, cs, "steer", map[string]any{"wind_angle": 90, "side": "same", "boom": 40})
		if refused || !strings.Contains(text, "holding wind 90° port") || !strings.Contains(text, "boom out to 40°") {
			t.Fatalf("steer: %v %q", refused, text)
		}
		text, _ = callTool(t, cs, "steer", map[string]any{"wind_angle": 90, "side": "port", "boom": 40})
		if !strings.Contains(text, "already") {
			t.Fatalf("the same order again: %q", text)
		}
		time.Sleep(15 * time.Second)
		text, refused = callTool(t, cs, "observe", map[string]any{"detail": "full"})
		if refused || !strings.Contains(text, "Wind:") || !strings.Contains(text, "Where:") || !strings.Contains(text, "port tack") {
			t.Fatalf("a full report: %v %q", refused, text)
		}
		t.Logf("a full report:\n%s", text)
		var rep struct {
			Boat struct {
				Speed float64 `json:"speedKnots"`
			} `json:"boat"`
			Seq int64 `json:"seq"`
		}
		text, _ = callTool(t, cs, "observe", map[string]any{"format": "json"})
		if err := json.Unmarshal([]byte(text), &rep); err != nil || rep.Boat.Speed < 2 {
			t.Fatalf("the boat does not sail: %v %q", err, text)
		}

		// A tack, retried at once: the boat turns once.
		text, refused = callTool(t, cs, "steer", map[string]any{"wind_angle": 45, "side": "starboard", "boom": 18})
		if refused || !strings.Contains(text, "tacking to wind 45° starboard") {
			t.Fatalf("a tack: %v %q", refused, text)
		}
		text, refused = callTool(t, cs, "steer", map[string]any{"wind_angle": 45, "side": "starboard", "boom": 18})
		if refused || !strings.Contains(text, "already tacking to wind 45° starboard") {
			t.Fatalf("the tack again: %v %q", refused, text)
		}
		// Inside the dial's bound, refused with what to send.
		if text, refused = callTool(t, cs, "steer", map[string]any{"wind_angle": 20}); !refused || !strings.Contains(text, "Try wind_angle") {
			t.Fatalf("too close to the wind: %v %q", refused, text)
		}
		// A wait for the tack to finish.
		text, refused = callTool(t, cs, "observe", map[string]any{"wait": 20, "wake_on": []string{"pilot"}})
		if refused || !strings.Contains(text, "woke: pilot") && !strings.Contains(text, "waited 20 s") {
			t.Fatalf("a wait: %v %q", refused, text)
		}
		if !strings.Contains(text, "Pilot: wind 45° starboard") {
			t.Fatalf("after the tack: %q", text)
		}

		// Silence: the boat's grace begins after 20 s without a call, and
		// it leaves the water a minute later; the next call sails again,
		// told why.
		time.Sleep(90 * time.Second)
		text, refused = callTool(t, cs, "observe", nil)
		if refused || !strings.Contains(text, "left the water after 20 seconds without a call") || !strings.Contains(text, "At sea") {
			t.Fatalf("after the silence: %v %q", refused, text)
		}
		s.stop(t)
	})
}

// session calls an MCP session's tools, for the helmsman.
type session struct{ cs *mcp.ClientSession }

func (s session) Call(ctx context.Context, tool string, args map[string]any) (string, bool, error) {
	res, err := s.cs.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		return "", false, err
	}
	var b strings.Builder
	for _, c := range res.Content {
		if t, ok := c.(*mcp.TextContent); ok {
			b.WriteString(t.Text)
		}
	}
	return b.String(), res.IsError, nil
}

// TestTheHelmsmanSails: a program with no model, given only a charted
// place's name, sails there from the start by the chart's bearings, in
// seed 1's world.
func TestTheHelmsmanSails(t *testing.T) {
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	// A world of its own: a server that sails a bundle changes it.
	world, err := worldgen.Generate(1, cat)
	if err != nil {
		t.Fatal(err)
	}
	cw := chart.Build(world, cat)
	// A place on another island, a passage away from the start.
	target := ""
	best, toward := math.Inf(1), 0.0
	for _, s := range cw.Subjects {
		d := math.Sqrt(s.X*s.X + s.Y*s.Y)
		if s.Kind == sight.Place && s.Name != "" && d > 900 && d < best {
			target, best, toward = s.Name, d, math.Mod(math.Atan2(s.X, s.Y)*180/math.Pi+360, 360)
		}
	}
	if target == "" {
		t.Fatal("no place to sail to")
	}
	// Off the wind, and beating to it into a wind from its way. (With the
	// wind from the other beam, the south, the start's basin lies in the
	// land's lee, and a boat with no way on cannot get out of it.)
	for _, from := range []float64{math.Mod(toward+270, 360), toward} {
		t.Run(fmt.Sprintf("the wind from %03.0f", from), func(t *testing.T) { helmsmanSails(t, world, target, best, from) })
	}
}

func helmsmanSails(t *testing.T, world *worldgen.Bundle, target string, best, from float64) {
	synctest.Test(t, func(t *testing.T) {
		d := &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}
		gen := func(uint64) (*worldgen.Bundle, error) { return world, nil }
		s := startServer(t, map[string]string{"KEEL_DEV_COMMANDS": "1"}, newMemNet(), d.with(serveOptions{generate: gen}))
		// Seed 1's chart and sight table take their time to build: keel
		// listens once they are.
		var res *http.Response
		var err error
		for range 120 {
			time.Sleep(time.Second)
			if res, err = s.client.Post(fmt.Sprintf("%s/debug/wind?knots=12&from=%.0f", internalURL, from), "", nil); err == nil {
				break
			}
		}
		if err != nil {
			select {
			case e := <-s.done:
				t.Fatalf("keel stopped: %v", e)
			default:
			}
			t.Fatalf("%v\n%s", err, s.logs.String())
		}
		res.Body.Close()
		for n := range 4 {
			res, err := s.client.Post(internalURL+"/owner/api/chart", "application/json", strings.NewReader(fmt.Sprintf(`{"number":%d}`, n)))
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				break
			}
		}
		time.Sleep(5 * time.Second)
		token, _ := d.machine("Iron Mary", "Ann Bonny", false)
		cs := agentSession(t, s, token)
		r, err := helmsman.Sail(t.Context(), session{cs}, target, 200, 300, t.Logf)
		if err != nil {
			t.Fatal(err)
		}
		if !r.Arrived {
			t.Fatalf("the helmsman did not reach %s, %.0f m away from the centre: %.0f m off after %d looks and %d tacks", target, best, r.Distance, r.Looks, r.Tacks)
		}
		t.Logf("reached %s, %.0f m from the centre, in %d looks and %d tacks", target, best, r.Looks, r.Tacks)
		s.stop(t)
	})
}

// TestAMachineSailorAcrossARestart: a machine sailor's boat is restored
// in its grace as keel starts again, and its agent's next call takes it
// back, the boat where it was, its grace ended.
func TestAMachineSailorAcrossARestart(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		vars := map[string]string{"KEEL_DEV_COMMANDS": "1", "KEEL_WORLD_SEED": "1", "KEEL_BELL": "1s"}
		s, _ := gameServer(t, vars, db)
		token, _ := db.machine("Iron Mary", "Ann Bonny", false)
		cs := agentSession(t, s, token)
		callTool(t, cs, "observe", nil)
		callTool(t, cs, "steer", map[string]any{"wind_angle": 90, "side": "same", "boom": 40})
		time.Sleep(10 * time.Second)
		cs.Close()
		s.stop(t)
		s = again(t, vars, db)
		cs = agentSession(t, s, token)
		text, refused := callTool(t, cs, "observe", map[string]any{"wait": 50, "wake_on": []string{"heel"}, "heel_over": 60})
		if refused || strings.Contains(text, "At sea: you are in the water") || !strings.Contains(text, "waited 50 s") {
			t.Fatalf("after the restart: %v %q", refused, text)
		}
		text, _ = callTool(t, cs, "observe", map[string]any{"wait": 30, "wake_on": []string{"heel"}, "heel_over": 60})
		if strings.Contains(text, "left the water") {
			t.Fatalf("the restored boat left the water: %q", text)
		}
		s.stop(t)
	})
}
