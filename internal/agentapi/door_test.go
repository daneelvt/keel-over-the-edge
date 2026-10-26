// SPDX-License-Identifier: AGPL-3.0-only

package agentapi_test

import (
	"context"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/agentapi"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

func poolQuery(t *testing.T, h *harness, sql string, dest ...any) error {
	t.Helper()
	return storetest.PoolOn(t, h.db).QueryRow(context.Background(), sql).Scan(dest...)
}

// lookAlike is tok with one character changed.
func lookAlike(tok string) string {
	c := "0"
	if tok[20] == '0' {
		c = "1"
	}
	return tok[:20] + c + tok[21:]
}

func uuid(id [16]byte) string {
	s := hex.EncodeToString(id[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}

// TestDoor: the MCP address refuses what is not the game's token for it,
// each refusal a 401 with its words and the resource's metadata, or a 403
// for a Host or Origin it does not accept; a grant revoked on the account
// page is refused at once; the lifetime shortened under a live token ends
// it; handbook names the machine sailor for an app's token and a
// connection token alike.
func TestDoor(t *testing.T) {
	h := newHarness(t)
	game := h.browser()
	game.sailor("Ann Bonny")
	b := h.browser()
	b.keys = game.keys
	a := h.register("https://app.example/cb")
	access, _ := h.grant(b, a, makeAnn)
	metadata := `resource_metadata="` + strings.TrimSuffix(h.resource, "/mcp") + `/.well-known/oauth-protected-resource/mcp"`

	code, challenge, body := h.mcpCall("")
	if code != 401 || strings.Contains(challenge, "error=") || !strings.Contains(challenge, metadata) || !strings.Contains(challenge, `scope="sail"`) ||
		!strings.Contains(body, "Sign in") {
		t.Fatalf("no token: %d %q %q", code, challenge, body)
	}
	at, _ := oauth.NewToken(oauth.KindAccess)
	rt, _ := oauth.NewToken(oauth.KindRefresh)
	for name, tok := range map[string]string{
		"malformed": "keelote_at_short", "a look-alike": lookAlike(access), "unknown": at, "a refresh token": rt,
	} {
		code, challenge, body := h.mcpCall(tok)
		if code != 401 || !strings.Contains(challenge, `error="invalid_token"`) || !strings.Contains(challenge, "error_description=") ||
			!strings.Contains(challenge, metadata) || !strings.Contains(body, "not a token of Keel Over the Edge") {
			t.Errorf("%s: %d %q %q", name, code, challenge, body)
		}
	}
	if code, _, body := h.mcpCall(access); code != 200 || !strings.Contains(body, "You sail as «Iron Mary», «Ann Bonny»'s machine sailor") {
		t.Fatalf("accepted: %d %s", code, body)
	}

	// The Host must be the MCP address's, and an Origin https or this
	// computer's.
	call := func(host, origin string) int {
		req, _ := http.NewRequest("POST", h.resource, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		req.Host = host
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Mcp-Protocol-Version", "2025-06-18")
		req.Header.Set("Authorization", "Bearer "+access)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	u, _ := url.Parse(h.resource)
	for _, c := range []struct {
		host, origin string
		want         int
	}{
		{u.Host, "", 200}, {u.Host, "https://claude.ai", 200}, {u.Host, "http://localhost:6274", 200}, {u.Host, "http://127.0.0.1:6274", 200},
		{"evil.example", "", 403}, {"localhost", "", 403}, {u.Host, "http://evil.example", 403}, {u.Host, "null", 403},
	} {
		if got := call(c.host, c.origin); got != c.want {
			t.Errorf("Host %q, Origin %q: %d, want %d", c.host, c.origin, got, c.want)
		}
	}
	// A preflight, and the methods a stateless server does not take.
	req, _ := http.NewRequest("OPTIONS", h.resource, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 204 || res.Header.Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(res.Header.Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Errorf("preflight: %d %v", res.StatusCode, res.Header)
	}
	req, _ = http.NewRequest("GET", h.resource, nil)
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Accept", "text/event-stream")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 405 {
		t.Errorf("GET: %d", res.StatusCode)
	}
	if res, err := http.Get(u.Scheme + "://" + u.Host + "/other"); err != nil || res.StatusCode != 404 {
		t.Errorf("another path: %v %v", res, err)
	}

	// Revoked on the account page: refused at once, though cached.
	_, page, _ := game.do("GET", "/api/machines", "")
	grant := between(page, `"apps":[{"id":"`, `"`)
	if status, body := game.post("/api/machines/revoke", `{"grant":"`+grant+`"}`); status != 200 {
		t.Fatalf("revoke: %d %s", status, body)
	}
	if code, challenge, _ := h.mcpCall(access); code != 401 || !strings.Contains(challenge, "revoked on the account page") {
		t.Fatalf("revoked: %d %q", code, challenge)
	}

	// The lifetime shortened under a live token ends it.
	access, _ = h.grant(b, a, `{"machine":"`+machineOf(t, h)+`"}`)
	if code, _, _ := h.mcpCall(access); code != 200 {
		t.Fatal("a new approval")
	}
	h.later(2 * time.Minute)
	h.lifetime.Set(time.Minute)
	if code, challenge, _ := h.mcpCall(access); code != 401 || !strings.Contains(challenge, "ended on") {
		t.Fatalf("the lifetime shortened: %d %q", code, challenge)
	}
	h.lifetime.Set(oauth.DefaultLifetime)
	// An access token past its hour is refused, its grant alive.
	h.later(oauth.AccessFor)
	if code, challenge, _ := h.mcpCall(access); code != 401 || !strings.Contains(challenge, "expired") {
		t.Fatalf("an hour on: %d %q", code, challenge)
	}
	// A connection token: handbook names the machine sailor.
	token := game.connectionToken()
	if code, _, body := h.mcpCall(token); code != 200 || !strings.Contains(body, "Iron Mary") {
		t.Fatalf("the connection token: %d %s", code, body)
	}
	// An app that sends no Content-Type is answered: its body is JSON.
	if code, _, body := h.mcpCallAs(token, ""); code != 200 || !strings.Contains(body, "Iron Mary") {
		t.Fatalf("no Content-Type: %d %s", code, body)
	}
	// Deleting the machine sailor ends every token of it at once.
	if status, body := game.post("/api/machines/delete", `{"machine":"`+machineOf(t, h)+`","name":"iron mary"}`); status != 200 {
		t.Fatalf("delete: %d %s", status, body)
	}
	if code, _, _ := h.mcpCall(token); code != 401 {
		t.Fatalf("after the deletion: %d", code)
	}
	for _, r := range []string{"accepted", "missing", "malformed", "unknown", "revoked", "ended", "expired", "host", "origin"} {
		if testutil.ToFloat64(h.metrics.DoorRequests.WithLabelValues(r)) == 0 {
			t.Errorf("%s not counted", r)
		}
	}
}

func between(s, from, to string) string {
	i := strings.Index(s, from)
	if i < 0 {
		return ""
	}
	s = s[i+len(from):]
	if j := strings.Index(s, to); j >= 0 {
		return s[:j]
	}
	return s
}

// TestUsage: a grant's last use is written at the first use and then at
// most once an hour, off the requests.
func TestUsage(t *testing.T) {
	rec := &usageStore{n: map[[16]byte]int{}}
	u := agentapi.NewUsage(rec, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { u.Run(ctx); close(done) }()
	g := [16]byte{1}
	for range 50 {
		u.Used(g)
	}
	u.Used([16]byte{2})
	time.Sleep(200 * time.Millisecond)
	cancel()
	<-done
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.n[g] != 1 || rec.n[[16]byte{2}] != 1 {
		t.Fatalf("writes: %v", rec.n)
	}
}

type usageStore struct {
	mu sync.Mutex
	n  map[[16]byte]int
}

func (u *usageStore) GrantUsed(_ context.Context, g [16]byte, _ time.Time) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.n[g]++
	return nil
}
