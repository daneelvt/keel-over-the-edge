// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/client"
	pb "github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/registry"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/smoke"
)

type checker struct {
	base, page string
	hold       time.Duration
	hc         *http.Client
	out        io.Writer
	reg        *registry.Registry
	// pause waits for a rate limiter's bucket to fill again.
	pause func(time.Duration)

	// body is the page, once fetched.
	body []byte
}

type check struct {
	name string
	run  func(ctx context.Context) error
}

// run runs every check, in order, and says how many failed.
func (c *checker) run(ctx context.Context) int {
	checks := []check{
		{"the page answers, with HSTS, and is not cached at the edge", c.pageServed},
		{"nothing injected into the page", c.notInjected},
		{"an asset is cached at the edge", c.assetCached},
		{"/api/version names the build production follows", c.version},
		{"HEAD answers", c.head},
		{"a PUT is blocked at the edge", c.putBlocked},
		{"/ws refuses a request without a session", c.wsWithoutSession},
		{"another host is not served", c.otherHost},
		{"one address is limited, and cannot forge CF-Connecting-IP", c.limited},
		{"a game connection from another origin is refused, and one from the game's stays open", c.gameConnection},
	}
	failed := 0
	for _, k := range checks {
		start := time.Now()
		if err := k.run(ctx); err != nil {
			failed++
			fmt.Fprintf(c.out, "online: FAIL %s: %v\n", k.name, err)
			continue
		}
		fmt.Fprintf(c.out, "online: ok   %s (%v)\n", k.name, time.Since(start).Round(time.Millisecond))
	}
	return failed
}

func (c *checker) do(ctx context.Context, method, path string, header http.Header) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, nil)
	if err != nil {
		return nil, nil, err
	}
	for k, v := range header {
		req.Header[k] = v
	}
	if h := header.Get("Host"); h != "" {
		req.Host = h
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	return res, body, err
}

// hstsDay is the least max-age HSTS may have: a day, while the way in
// settles; six months after.
const hstsDay = 86400

var maxAge = regexp.MustCompile(`(?i)max-age=(\d+)`)

// asBrowser asks for the page as a browser does: Cloudflare adds what it
// adds to a page only for a client that accepts HTML.
var asBrowser = http.Header{"Accept": {"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}}

func (c *checker) pageServed(ctx context.Context) error {
	res, body, err := c.do(ctx, http.MethodGet, "/", asBrowser)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK || !bytes.Contains(body, []byte("<html")) {
		return fmt.Errorf("GET / answered %s", res.Status)
	}
	c.body = body
	hsts := res.Header.Get("Strict-Transport-Security")
	m := maxAge.FindStringSubmatch(hsts)
	if m == nil {
		return fmt.Errorf("no HSTS: Strict-Transport-Security is %q", hsts)
	}
	if age, _ := strconv.Atoi(m[1]); age < hstsDay || !strings.Contains(strings.ToLower(hsts), "includesubdomains") || strings.Contains(strings.ToLower(hsts), "preload") {
		return fmt.Errorf("Strict-Transport-Security is %q: want a max-age of a day or more, includeSubDomains, no preload", hsts)
	}
	if s := res.Header.Get("Cf-Cache-Status"); strings.EqualFold(s, "HIT") {
		return errors.New("the page came from Cloudflare's cache")
	}
	return nil
}

// The page's own references: a script's src or a stylesheet's href.
var refs = regexp.MustCompile(`(?i)<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"`)

func (c *checker) notInjected(context.Context) error {
	if c.body == nil {
		return errors.New("no page to read")
	}
	lower := bytes.ToLower(c.body)
	for _, mark := range []string{"/cdn-cgi/", "cloudflare", "__cf", "data-cf"} {
		if bytes.Contains(lower, []byte(mark)) {
			return fmt.Errorf("the page holds %q, which the game never writes", mark)
		}
	}
	for _, m := range refs.FindAllSubmatch(c.body, -1) {
		if ref := string(m[1]); !strings.HasPrefix(ref, "/") || strings.HasPrefix(ref, "//") {
			return fmt.Errorf("the page loads %s, from another origin", ref)
		}
	}
	if c.page == "" {
		return nil
	}
	want, err := os.ReadFile(c.page)
	if err != nil {
		return err
	}
	if !bytes.Equal(c.body, want) {
		return fmt.Errorf("the page (%d bytes) is not %s (%d bytes)", len(c.body), c.page, len(want))
	}
	return nil
}

var assetRef = regexp.MustCompile(`"(/assets/[^"]+)"`)

func (c *checker) assetCached(ctx context.Context) error {
	m := assetRef.FindSubmatch(c.body)
	if m == nil {
		return errors.New("the page names no asset")
	}
	path := string(m[1])
	var statuses []string
	for range 3 {
		res, _, err := c.do(ctx, http.MethodGet, path, nil)
		if err != nil {
			return err
		}
		if res.StatusCode != http.StatusOK {
			return fmt.Errorf("%s answered %s", path, res.Status)
		}
		if cc := res.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
			return fmt.Errorf("%s's Cache-Control is %q, not immutable", path, cc)
		}
		s := res.Header.Get("Cf-Cache-Status")
		statuses = append(statuses, s)
		if strings.EqualFold(s, "HIT") {
			return nil
		}
	}
	return fmt.Errorf("%s was never served from Cloudflare's cache: %v", path, statuses)
}

func (c *checker) version(ctx context.Context) error {
	res, body, err := c.do(ctx, http.MethodGet, "/api/version", nil)
	if err != nil {
		return err
	}
	var v struct{ Build string }
	if err := json.Unmarshal(body, &v); err != nil || res.StatusCode != http.StatusOK {
		return fmt.Errorf("/api/version answered %s: %v", res.Status, err)
	}
	_, repo, _ := strings.Cut(manifests.ManifestsRepo, "/")
	a, found, err := c.reg.Resolve(ctx, repo, manifests.ProdTag)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("%s:%s is not there", manifests.ManifestsRepo, manifests.ProdTag)
	}
	_, commit, _ := strings.Cut(a.Annotations["org.opencontainers.image.revision"], "@sha1:")
	if len(commit) < 12 || v.Build != commit[:12] {
		return fmt.Errorf("the game runs %q, production follows %q", v.Build, commit)
	}
	return nil
}

func (c *checker) head(ctx context.Context) error {
	res, _, err := c.do(ctx, http.MethodHead, "/", nil)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HEAD / answered %s", res.Status)
	}
	return nil
}

// putBlocked: the game would answer a PUT 405; Cloudflare's rule answers
// 403 first.
func (c *checker) putBlocked(ctx context.Context) error {
	res, _, err := c.do(ctx, http.MethodPut, "/", nil)
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusForbidden {
		return fmt.Errorf("PUT / answered %s, not Cloudflare's 403", res.Status)
	}
	return nil
}

func (c *checker) wsWithoutSession(ctx context.Context) error {
	res, _, err := c.do(ctx, http.MethodGet, "/ws", http.Header{
		"Origin": {c.base}, "Connection": {"Upgrade"}, "Upgrade": {"websocket"},
		"Sec-Websocket-Version": {"13"}, "Sec-Websocket-Key": {"dGhlIHNhbXBsZSBub25jZQ=="},
	})
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusUnauthorized {
		return fmt.Errorf("/ws without a session answered %s, want 401", res.Status)
	}
	return nil
}

func (c *checker) otherHost(ctx context.Context) error {
	u, err := url.Parse(c.base)
	if err != nil {
		return err
	}
	host := "zz-online-check." + strings.TrimPrefix(u.Hostname(), "play.")
	res, _, err := c.do(ctx, http.MethodGet, "/api/version", http.Header{"Host": {host}})
	if err != nil {
		return nil // refused outright
	}
	if res.StatusCode < 400 {
		return fmt.Errorf("a request for %s answered %s", host, res.Status)
	}
	return nil
}

// burst is more requests than Traefik lets one address make at once: its
// bucket holds 100, filling at 50 a second.
const burst = 160

// edgeRefusal is how Cloudflare answers a request that carries its own
// CF-Connecting-IP: 403, error 1000, before it reaches the tunnel.
const edgeRefusal = "error code: 1000"

// limited: a burst from one address meets Traefik's 429; and the same
// burst, each request forging a different CF-Connecting-IP, never escapes
// it: Cloudflare refuses each, or writes the header itself and the burst
// meets the 429 again. Only a forged burst answered with no refusal and no
// 429 fails: the header would have chosen the address counted.
func (c *checker) limited(ctx context.Context) error {
	for _, forge := range []bool{false, true} {
		c.pause(3 * time.Second) // the bucket full again
		codes := make([]int, burst)
		refused := make([]bool, burst)
		var wg sync.WaitGroup
		for i := range burst {
			wg.Go(func() {
				h := http.Header{}
				if forge {
					h.Set("CF-Connecting-IP", fmt.Sprintf("198.51.100.%d", i%250+1))
				}
				res, body, err := c.do(ctx, http.MethodGet, "/api/version", h)
				if err == nil {
					codes[i] = res.StatusCode
					refused[i] = res.StatusCode == http.StatusForbidden && strings.Contains(string(body), edgeRefusal)
				}
			})
		}
		wg.Wait()
		n, edge := map[int]int{}, 0
		for i, code := range codes {
			n[code]++
			if refused[i] {
				edge++
			}
		}
		switch {
		case !forge && n[http.StatusTooManyRequests] == 0:
			return fmt.Errorf("%d requests at once from one address met no 429: %v", burst, n)
		case forge && edge == burst:
			// Every forged header refused at the edge.
		case forge && n[http.StatusTooManyRequests] == 0:
			return fmt.Errorf("%d requests at once, each forging another CF-Connecting-IP, met neither Cloudflare's refusal nor a 429: %v", burst, n)
		}
	}
	c.pause(3 * time.Second)
	return nil
}

// pingEvery keeps the connection sending, as the page does: the game drops
// a connection that sends nothing for a minute.
const pingEvery = 10 * time.Second

func (c *checker) gameConnection(ctx context.Context) error {
	if c.hold == 0 {
		return nil
	}
	_, jar, err := smoke.GuestNamed(ctx, c.hc, c.base, fmt.Sprintf("Zz Online %06d", time.Now().UnixNano()%1_000_000))
	if err != nil {
		return err
	}
	// From another origin, with the session: refused.
	other := *c.hc
	other.Jar = jar
	other.Timeout = 0
	if ws, res, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(c.base, "https")+"/ws", &websocket.DialOptions{
		HTTPClient: &other, HTTPHeader: http.Header{"Origin": {"https://example.org"}},
	}); err == nil {
		ws.CloseNow()
		return errors.New("a game connection from https://example.org was accepted")
	} else if res != nil && res.StatusCode == http.StatusSwitchingProtocols {
		return fmt.Errorf("a game connection from https://example.org: %v", err)
	}
	ws, err := smoke.DialGame(ctx, c.hc, jar, c.base)
	if err != nil {
		return err
	}
	defer ws.CloseNow()
	ws.SetReadLimit(-1)
	if err := client.Send(ctx, ws, client.Hello()); err != nil {
		return err
	}
	read := make(chan error, 1)
	go func() {
		for {
			if _, _, err := ws.Read(ctx); err != nil {
				read <- err
				return
			}
		}
	}()
	end := time.After(c.hold)
	tick := time.NewTicker(pingEvery)
	defer tick.Stop()
	start := time.Now()
	for {
		select {
		case err := <-read:
			return fmt.Errorf("the game connection closed after %v: %w", time.Since(start).Round(time.Second), err)
		case <-tick.C:
			ping := &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTimeUs: time.Since(start).Microseconds()}}}
			if err := client.Send(ctx, ws, ping); err != nil {
				return fmt.Errorf("the game connection, after %v: %w", time.Since(start).Round(time.Second), err)
			}
		case <-end:
			return ws.Close(websocket.StatusNormalClosure, "")
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
