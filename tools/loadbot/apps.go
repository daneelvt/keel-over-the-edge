// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/auth/softkey"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

// The AI apps' load: with -apps, instead of sailing, one sailor approves an
// app that registered itself that many times, each through the approval
// page with its passkey, for a machine sailor made on the first; then the
// last approval's refresh token is rotated -refreshes times, and the MCP
// address called with each access token issued. It reports each route's
// times as this side saw them; keel's access log has the server's.

// appsJar keeps every cookie, Secure ones too over plain http, as a
// browser on localhost does.
type appsJar struct {
	mu sync.Mutex
	by map[string]*http.Cookie
}

func (j *appsJar) SetCookies(_ *url.URL, cs []*http.Cookie) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, c := range cs {
		if c.MaxAge < 0 {
			delete(j.by, c.Name)
			continue
		}
		j.by[c.Name] = &http.Cookie{Name: c.Name, Value: c.Value}
	}
}

func (j *appsJar) Cookies(*url.URL) []*http.Cookie {
	j.mu.Lock()
	defer j.mu.Unlock()
	var out []*http.Cookie
	for _, c := range j.by {
		out = append(out, c)
	}
	return out
}

type appsRun struct {
	base string
	c    *http.Client
	took map[string][]time.Duration
}

func (a *appsRun) call(ctx context.Context, route, method, path, contentType string, body []byte, want int) ([]byte, http.Header, error) {
	req, err := http.NewRequestWithContext(ctx, method, a.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	start := time.Now()
	res, err := a.c.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	a.took[route] = append(a.took[route], time.Since(start))
	if res.StatusCode != want {
		return nil, nil, fmt.Errorf("%s %s: %s %s", method, path, res.Status, out)
	}
	return out, res.Header, nil
}

func (a *appsRun) json(ctx context.Context, route, path string, v any, want int) ([]byte, error) {
	var body []byte
	if v != nil {
		body, _ = json.Marshal(v)
	}
	out, _, err := a.call(ctx, route, http.MethodPost, path, "application/json", body, want)
	return out, err
}

// runApps runs the AI apps' load against the game at base.
func runApps(ctx context.Context, hc *http.Client, base, mcp string, approvals, refreshes int) error {
	jar := &appsJar{by: map[string]*http.Cookie{}}
	c := *hc
	c.Jar = jar
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	a := &appsRun{base: strings.TrimSuffix(base, "/"), c: &c, took: map[string][]time.Duration{}}
	cat, err := catalog.Load()
	if err != nil {
		return err
	}
	stamp := time.Now().UnixNano() % 1_000_000
	opts, err := a.json(ctx, "account", "/account/begin", map[string]string{"name": fmt.Sprintf("Loadbot A %06d", stamp), "look": string(cat.Sailors[0].ID)}, 200)
	if err != nil {
		return err
	}
	key, answer, err := softkey.Create(opts, a.base)
	if err != nil {
		return err
	}
	if _, _, err := a.call(ctx, "account", http.MethodPost, "/account/finish", "application/json", answer, 201); err != nil {
		return err
	}
	redirect := "http://127.0.0.1/callback"
	reg, err := a.json(ctx, "register", "/oauth/register", map[string]any{"client_name": "Loadbot", "redirect_uris": []string{redirect}}, 201)
	if err != nil {
		return err
	}
	var client struct {
		ClientID string `json:"client_id"`
	}
	_ = json.Unmarshal(reg, &client)
	m := &cat.Machine
	makeIt := map[string]any{"make": map[string]string{
		"name": fmt.Sprintf("Loadbot M %06d", stamp), "version": string(m.Versions[0].ID), "finish": string(m.Finishes[0].ID), "colour": string(m.Colours[0].ID),
	}}
	var refresh string
	// The approval page, as keel answers it: 200 when it serves the built
	// page, 303 to it when another server does.
	page := http.StatusOK
	if res, err := c.Get(a.base + "/oauth/authorize"); err == nil {
		res.Body.Close()
	}
	probe := url.Values{"client_id": {client.ClientID}, "redirect_uri": {"http://127.0.0.1:9/callback"}, "response_type": {"code"},
		"code_challenge": {strings.Repeat("A", 43)}, "code_challenge_method": {"S256"}}
	if res, err := c.Get(a.base + "/oauth/authorize?" + probe.Encode()); err == nil {
		page = res.StatusCode
		res.Body.Close()
	}
	verifier := strings.Repeat("v", 43)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	for i := range approvals {
		q := url.Values{"response_type": {"code"}, "client_id": {client.ClientID}, "redirect_uri": {"http://127.0.0.1:9/callback"},
			"state": {"s"}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}, "resource": {mcp}}
		// Without a built page, keel sends the browser on to it.
		if _, _, err := a.call(ctx, "authorize", http.MethodGet, "/oauth/authorize?"+q.Encode(), "", nil, page); err != nil {
			return err
		}
		opts, err := a.json(ctx, "approve/begin", "/oauth/approve/begin", nil, 200)
		if err != nil {
			return err
		}
		answer, err := key.Get(opts)
		if err != nil {
			return err
		}
		signed, _, err := a.call(ctx, "approve/finish", http.MethodPost, "/oauth/approve/finish", "application/json", answer, 200)
		if err != nil {
			return err
		}
		// The first approval makes the machine sailor; the rest approve
		// it, as the page lists it once signed in.
		var body any = makeIt
		if i > 0 {
			var p struct {
				SignedIn struct{ Machines []struct{ ID string } }
			}
			if err := json.Unmarshal(signed, &p); err != nil || len(p.SignedIn.Machines) == 0 {
				return fmt.Errorf("no machine sailor listed: %s", signed)
			}
			body = map[string]string{"machine": p.SignedIn.Machines[0].ID}
		}
		out, err := a.json(ctx, "approve", "/oauth/approve", body, 200)
		if err != nil {
			return err
		}
		var r struct{ Redirect string }
		_ = json.Unmarshal(out, &r)
		u, err := url.Parse(r.Redirect)
		if err != nil {
			return err
		}
		form := url.Values{"grant_type": {"authorization_code"}, "code": {u.Query().Get("code")}, "client_id": {client.ClientID},
			"redirect_uri": {"http://127.0.0.1:9/callback"}, "code_verifier": {verifier}, "resource": {mcp}}
		tok, _, err := a.call(ctx, "token (code)", http.MethodPost, "/oauth/token", "application/x-www-form-urlencoded", []byte(form.Encode()), 200)
		if err != nil {
			return err
		}
		var raw map[string]any
		_ = json.Unmarshal(tok, &raw)
		refresh, _ = raw["refresh_token"].(string)
	}
	mcpCall := func(token string) error {
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"handbook","arguments":{}}}`
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, mcp, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Mcp-Protocol-Version", "2025-06-18")
		req.Header.Set("Authorization", "Bearer "+token)
		start := time.Now()
		res, err := hc.Do(req)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		a.took["mcp handbook"] = append(a.took["mcp handbook"], time.Since(start))
		if res.StatusCode != 200 {
			return fmt.Errorf("the MCP address: %s", res.Status)
		}
		return nil
	}
	for range refreshes {
		form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {client.ClientID}}
		tok, _, err := a.call(ctx, "token (refresh)", http.MethodPost, "/oauth/token", "application/x-www-form-urlencoded", []byte(form.Encode()), 200)
		if err != nil {
			return err
		}
		var raw map[string]any
		_ = json.Unmarshal(tok, &raw)
		access, _ := raw["access_token"].(string)
		refresh, _ = raw["refresh_token"].(string)
		// Each new token's first call is cold; its second, warm.
		if err := mcpCall(access); err != nil {
			return err
		}
		if err := mcpCall(access); err != nil {
			return err
		}
	}
	form := url.Values{"token": {refresh}, "client_id": {client.ClientID}}
	if _, _, err := a.call(ctx, "revoke", http.MethodPost, "/oauth/revoke", "application/x-www-form-urlencoded", []byte(form.Encode()), 200); err != nil {
		return err
	}
	routes := make([]string, 0, len(a.took))
	for r := range a.took {
		routes = append(routes, r)
	}
	slices.Sort(routes)
	fmt.Printf("%-18s %6s %8s %8s %8s\n", "route", "n", "p50", "p99", "max")
	for _, r := range routes {
		d := a.took[r]
		slices.Sort(d)
		pick := func(p float64) time.Duration { return d[min(len(d)-1, int(p*float64(len(d))))] }
		fmt.Printf("%-18s %6d %8v %8v %8v\n", r, len(d), pick(0.5).Round(10*time.Microsecond), pick(0.99).Round(10*time.Microsecond), d[len(d)-1].Round(10*time.Microsecond))
	}
	return nil
}
