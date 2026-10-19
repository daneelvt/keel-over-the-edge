// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"io"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestStatus: the status needs no session, is kept 30 s by caches, and
// may be read by the website's pages alone; before there is one, 503.
func TestStatus(t *testing.T) {
	st, _ := storetest.Store(t, store.Options{})
	var now atomic.Pointer[Status]
	srv := newTestServer(t, st, func(c *Config) {
		c.Status, c.Website = now.Load, "https://keelovertheedge.com"
	})
	get := func(origin string) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", srv.URL+"/api/status", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, string(b)
	}
	if res, _ := get(""); res.StatusCode != http.StatusServiceUnavailable || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("before a status: %d %q", res.StatusCode, res.Header.Get("Cache-Control"))
	}
	now.Store(&Status{AtSea: 37, Queued: 0, World: 14, EndsAt: "2026-11-01T23:00:00Z", Closing: true})
	res, body := get("https://keelovertheedge.com")
	if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "public, max-age=30" ||
		res.Header.Get("Content-Type") != "application/json" || res.Header.Get("Set-Cookie") != "" {
		t.Fatalf("the status: %d %v", res.StatusCode, res.Header)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "https://keelovertheedge.com" || res.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Errorf("CORS: %v", res.Header)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if got["atSea"] != 37.0 || got["world"] != 14.0 || got["endsAt"] != "2026-11-01T23:00:00Z" || got["closing"] != true || got["queued"] != 0.0 {
		t.Errorf("the status: %s", body)
	}
	// Another origin's page gets the same answer, which names the website
	// alone: a browser keeps it from that page.
	if res, _ := get("https://evil.example"); res.Header.Get("Access-Control-Allow-Origin") != "https://keelovertheedge.com" {
		t.Errorf("another origin: %v", res.Header)
	}
}
