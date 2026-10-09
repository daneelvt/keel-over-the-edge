// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// builtPage writes a directory laid out as the client's build is.
func builtPage(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{
		"index.html":                   "<!doctype html><title>Keel Over the Edge</title>",
		"dev.html":                     "<!doctype html><title>dev</title>",
		"third-party-licences.txt":     "licences",
		".hidden":                      "secret",
		"assets/main-D6eWoT1T.js":      "console.log(1)",
		"assets/main-CfmwCcCx.css":     "body{}",
		"assets/physics-207F3rPv.wasm": "\x00asm\x01\x00\x00\x00",
		"assets/jolly-boat-DDy.glb":    "glTF",
		"assets/Alegreya-CUl.woff2":    "wOF2",
		"assets/IMFell-BCAx.ttf":       "\x00\x01\x00\x00",
		"assets/.hidden":               "secret",
		"assets/sub/deeper.js":         "no",
	} {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// downSessions is a database that cannot be asked about sessions.
type downSessions struct{ noGuests }

func (downSessions) Session(context.Context, [32]byte) (store.Session, error) {
	return store.Session{}, errors.New("the database is down")
}

func pageServer(t *testing.T) *testServer {
	t.Helper()
	return pageServerWith(t, noGuests{})
}

func pageServerWith(t *testing.T, db database) *testServer {
	t.Helper()
	page, err := OpenPage(builtPage(t))
	if err != nil {
		t.Fatal(err)
	}
	return newTestServer(t, db, func(c *Config) {
		c.Page = page
		c.Game = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	})
}

// raw sends a request line as written, so paths reach the server uncleaned.
func raw(t *testing.T, srv *testServer, method, path string) (*http.Response, string) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	req, err := http.NewRequest(method, srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.URL.Opaque = path
	if err := req.Write(conn); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res, string(body)
}

func TestPageServesItsFiles(t *testing.T) {
	srv := pageServer(t)
	cases := []struct {
		path, contentType, cache, body string
	}{
		{"/", "text/html; charset=utf-8", "no-cache", "<!doctype html><title>Keel Over the Edge</title>"},
		{"/index.html", "text/html; charset=utf-8", "no-cache", "<!doctype html><title>Keel Over the Edge</title>"},
		{"/dev.html", "text/html; charset=utf-8", "no-cache", "<!doctype html><title>dev</title>"},
		{"/third-party-licences.txt", "text/plain; charset=utf-8", "no-cache", "licences"},
		{"/assets/main-D6eWoT1T.js", "text/javascript; charset=utf-8", "public, max-age=31536000, immutable", "console.log(1)"},
		{"/assets/main-CfmwCcCx.css", "text/css; charset=utf-8", "public, max-age=31536000, immutable", "body{}"},
		{"/assets/physics-207F3rPv.wasm", "application/wasm", "public, max-age=31536000, immutable", "\x00asm\x01\x00\x00\x00"},
		{"/assets/jolly-boat-DDy.glb", "model/gltf-binary", "public, max-age=31536000, immutable", "glTF"},
		{"/assets/Alegreya-CUl.woff2", "font/woff2", "public, max-age=31536000, immutable", "wOF2"},
		{"/assets/IMFell-BCAx.ttf", "font/ttf", "public, max-age=31536000, immutable", "\x00\x01\x00\x00"},
	}
	for _, c := range cases {
		res, body := raw(t, srv, "GET", c.path)
		if res.StatusCode != http.StatusOK || body != c.body {
			t.Errorf("%s: %d %q", c.path, res.StatusCode, body)
			continue
		}
		h := res.Header
		if h.Get("Content-Type") != c.contentType || h.Get("Cache-Control") != c.cache || h.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: Content-Type %q, Cache-Control %q, X-Content-Type-Options %q", c.path, h.Get("Content-Type"), h.Get("Cache-Control"), h.Get("X-Content-Type-Options"))
		}
	}

	res, body := raw(t, srv, "HEAD", "/assets/physics-207F3rPv.wasm")
	if res.StatusCode != http.StatusOK || body != "" || res.ContentLength != 8 || res.Header.Get("Content-Type") != "application/wasm" {
		t.Errorf("HEAD: %d, %d bytes, %q", res.StatusCode, res.ContentLength, body)
	}
}

func TestPageServesNothingElse(t *testing.T) {
	srv := pageServer(t)
	for _, p := range []string{
		"/assets/", "/assets", "/../go.mod", "/assets/../index.html", "/assets/./main-D6eWoT1T.js", "/assets//main-D6eWoT1T.js",
		"/.hidden", "/assets/.hidden", "/missing", "/assets/missing.js", "/assets/sub", "/assets/sub/deeper.js",
		"/%2e%2e/go.mod", "/assets/..%2findex.html",
	} {
		res, _ := raw(t, srv, "GET", p)
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, res.StatusCode)
		}
		if res.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: no nosniff", p)
		}
	}
	for _, p := range []string{"/", "/assets/main-D6eWoT1T.js"} {
		if res, _ := raw(t, srv, "POST", p); res.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("POST %s: %d, want 405", p, res.StatusCode)
		}
	}
}

func TestPageLeavesTheOtherRoutes(t *testing.T) {
	srv := pageServer(t)
	if res, body := raw(t, srv, "GET", "/api/version"); res.StatusCode != http.StatusOK || !strings.Contains(body, `"build":"abc123"`) {
		t.Errorf("/api/version: %d %s", res.StatusCode, body)
	}
	if res, _ := raw(t, srv, "GET", "/api/me"); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("/api/me: %d", res.StatusCode)
	}
	if res, _ := raw(t, srv, "GET", "/ws"); res.StatusCode != http.StatusTeapot {
		t.Errorf("/ws: %d", res.StatusCode)
	}
	status, body, _ := post(t, nil, srv.URL+"/guest", "application/json", `{"name":"Al","look":"figure"}`)
	if status != 422 || body != `{"error":"short"}` {
		t.Errorf("/guest: %d %s", status, body)
	}
}

// TestPageNeedsNoSession: with the database down, a returning player's
// cookie stops the API, not the page.
func TestPageNeedsNoSession(t *testing.T) {
	srv := pageServerWith(t, downSessions{})
	cookie := &http.Cookie{Name: auth.CookieName, Value: strings.Repeat("A", 43)}
	for path, want := range map[string]int{"/": 200, "/assets/main-D6eWoT1T.js": 200, "/api/me": 503} {
		if status, _ := get(t, http.DefaultClient, srv.URL+path, cookie); status != want {
			t.Errorf("%s with a cookie and no database: %d, want %d", path, status, want)
		}
	}
}

func TestNoPageServesNoFiles(t *testing.T) {
	srv := newTestServer(t, noGuests{}, nil)
	for _, p := range []string{"/", "/index.html", "/assets/main-D6eWoT1T.js"} {
		if res, _ := raw(t, srv, "GET", p); res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %d", p, res.StatusCode)
		}
	}
}

func TestOpenPageNeedsAnIndex(t *testing.T) {
	dir := builtPage(t)
	if err := os.Remove(filepath.Join(dir, "index.html")); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenPage(dir); err == nil || !strings.Contains(err.Error(), "index.html") {
		t.Fatalf("no index.html: %v", err)
	}
	if _, err := OpenPage(filepath.Join(dir, "none")); err == nil {
		t.Fatal("a missing directory opened")
	}
	page, err := OpenPage(builtPage(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := page.files["assets/sub/deeper.js"]; ok || page.files[".hidden"].body != nil {
		t.Fatal("a nested or hidden file was read")
	}
}
