// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/registry"
)

const (
	thePage = `<!doctype html><html><head><script type="module" src="/assets/index-abc123.js"></script><link rel="stylesheet" href="/assets/index-def456.css"></head><body></body></html>`
	commit  = "0123456789abcdef0123456789abcdef01234567"
)

// edge stands for Cloudflare in front of the game: HSTS on every answer,
// the asset cached after its first fetch, PUT blocked, other hosts
// refused, and Traefik's limit of 100 at once per address, keyed on
// CF-Connecting-IP, which a good edge writes itself.
type edge struct {
	// page is what the game's page is served as.
	page string
	// passForged lets a client's CF-Connecting-IP through, as an edge must
	// not.
	passForged bool
	// hsts is the header, unless empty.
	hsts string

	mu     sync.Mutex
	cached bool
	counts map[string]int
}

func (e *edge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if e.hsts != "" {
		w.Header().Set("Strict-Transport-Security", e.hsts)
	}
	if !strings.HasPrefix(r.Host, "127.0.0.1") {
		http.Error(w, "unknown host", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodPut {
		http.Error(w, "blocked", http.StatusForbidden)
		return
	}
	key := "the client's address"
	if e.passForged && r.Header.Get("CF-Connecting-IP") != "" {
		key = r.Header.Get("CF-Connecting-IP")
	}
	e.mu.Lock()
	switch {
	case r.URL.Path == "/v2/daneelvt/keel-manifests/manifests/prod":
		e.mu.Unlock()
		body, _ := json.Marshal(map[string]any{"schemaVersion": 2, "annotations": map[string]string{"org.opencontainers.image.revision": "main@sha1:" + commit}})
		w.Write(body)
		return
	case r.URL.Path == "/api/version":
		e.counts[key]++
		over := e.counts[key] > 100
		e.mu.Unlock()
		if over {
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}
		io.WriteString(w, `{"build":"`+commit[:12]+`","catalog":"c"}`)
		return
	case strings.HasPrefix(r.URL.Path, "/assets/"):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		if e.cached {
			w.Header().Set("Cf-Cache-Status", "HIT")
		} else {
			w.Header().Set("Cf-Cache-Status", "MISS")
		}
		e.cached = true
		e.mu.Unlock()
		io.WriteString(w, "asset")
		return
	case r.URL.Path == "/ws":
		e.mu.Unlock()
		http.Error(w, "session", http.StatusUnauthorized)
		return
	case r.URL.Path == "/":
		e.mu.Unlock()
		w.Header().Set("Cf-Cache-Status", "DYNAMIC")
		io.WriteString(w, e.page)
		return
	}
	e.mu.Unlock()
	http.NotFound(w, r)
}

func testChecker(t *testing.T, e *edge) (*checker, *bytes.Buffer) {
	t.Helper()
	e.counts = map[string]int{}
	srv := httptest.NewServer(e)
	t.Cleanup(srv.Close)
	var out bytes.Buffer
	return &checker{
		base: srv.URL, hc: srv.Client(), out: &out,
		reg: &registry.Registry{Base: srv.URL, HC: srv.Client()},
		pause: func(time.Duration) {
			e.mu.Lock()
			e.counts = map[string]int{}
			e.mu.Unlock()
		},
	}, &out
}

func TestEveryCheckPasses(t *testing.T) {
	c, out := testChecker(t, &edge{page: thePage, hsts: "max-age=86400; includeSubDomains"})
	page := filepath.Join(t.TempDir(), "index.html")
	os.WriteFile(page, []byte(thePage), 0o644)
	c.page = page
	if failed := c.run(context.Background()); failed != 0 {
		t.Fatalf("%d failed:\n%s", failed, out)
	}
}

func TestChecksFail(t *testing.T) {
	for name, tc := range map[string]struct {
		e    *edge
		page string
		want string
	}{
		"no HSTS":                {&edge{page: thePage}, "", "no HSTS"},
		"HSTS preloaded":         {&edge{page: thePage, hsts: "max-age=86400; includeSubDomains; preload"}, "", "no preload"},
		"HSTS for an hour":       {&edge{page: thePage, hsts: "max-age=3600; includeSubDomains"}, "", "a max-age of a day or more"},
		"a script injected":      {&edge{page: strings.Replace(thePage, "</body>", `<script src="/cdn-cgi/scripts/email-decode.min.js"></script></body>`, 1), hsts: "max-age=86400; includeSubDomains"}, "", `holds "/cdn-cgi/"`},
		"another origin":         {&edge{page: strings.Replace(thePage, "/assets/index-def456.css", "https://example.org/x.css", 1), hsts: "max-age=86400; includeSubDomains"}, "", "from another origin"},
		"not the build's page":   {&edge{page: thePage, hsts: "max-age=86400; includeSubDomains"}, "<!doctype html><html></html>", "is not"},
		"a forged header passed": {&edge{page: thePage, hsts: "max-age=86400; includeSubDomains", passForged: true}, "", "Cloudflare passed the forged header through"},
	} {
		t.Run(name, func(t *testing.T) {
			c, out := testChecker(t, tc.e)
			if tc.page != "" {
				page := filepath.Join(t.TempDir(), "index.html")
				os.WriteFile(page, []byte(tc.page), 0o644)
				c.page = page
			}
			if failed := c.run(context.Background()); failed == 0 || !strings.Contains(out.String(), tc.want) {
				t.Errorf("%d failed, want %q:\n%s", failed, tc.want, out)
			}
		})
	}
}
