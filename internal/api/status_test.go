// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// passToken is an Access that lets through a request with the token
// "signed", and no other.
type passToken struct{}

func (passToken) Check(r *http.Request) error {
	if r.Header.Get("Cf-Access-Jwt-Assertion") != "signed" {
		return errors.New("not signed")
	}
	return nil
}

// TestStatus: the status answers only a request Access signed, never
// kept by a cache, gzipped to a caller that takes it, with no cookie and
// no CORS; 503 before there is one; and without Access, or without a
// status, it is not served at all.
func TestStatus(t *testing.T) {
	st, _ := storetest.Store(t, store.Options{})
	var body atomic.Pointer[[]byte]
	now := func(context.Context) ([]byte, []byte, error) {
		b := body.Load()
		if b == nil {
			return nil, nil, nil
		}
		var z bytes.Buffer
		zw := gzip.NewWriter(&z)
		_, _ = zw.Write(*b)
		_ = zw.Close()
		return *b, z.Bytes(), nil
	}
	srv := newTestServer(t, st, func(c *Config) { c.Status, c.Access = now, passToken{} })
	get := func(srv *testServer, token, encoding string) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", srv.URL+"/api/status", nil)
		req.Header.Set("Origin", "https://keelovertheedge.com")
		if token != "" {
			req.Header.Set("Cf-Access-Jwt-Assertion", token)
		}
		// Asked for by hand, the transport leaves the answer as it came.
		req.Header.Set("Accept-Encoding", encoding)
		res, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, string(b)
	}
	if res, _ := get(srv, "signed", ""); res.StatusCode != http.StatusServiceUnavailable || !strings.Contains(res.Header.Get("Cache-Control"), "no-store") {
		t.Fatalf("before a status: %d %q", res.StatusCode, res.Header.Get("Cache-Control"))
	}
	b := []byte(`{"atSea":37,"world":14}`)
	body.Store(&b)
	for _, token := range []string{"", "forged"} {
		res, got := get(srv, token, "")
		if res.StatusCode != http.StatusForbidden || got == string(b) || res.Header.Get("Cache-Control") != "no-store" {
			t.Errorf("token %q: %d %s", token, res.StatusCode, got)
		}
	}
	res, got := get(srv, "signed", "identity")
	if res.StatusCode != 200 || got != string(b) || res.Header.Get("Cache-Control") != "private, no-store" ||
		res.Header.Get("Content-Type") != "application/json" || res.Header.Get("Set-Cookie") != "" || res.Header.Get("Content-Encoding") != "" {
		t.Fatalf("the status: %d %v %s", res.StatusCode, res.Header, got)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("CORS: %v", res.Header)
	}
	res, got = get(srv, "signed", "br, gzip;q=0.8")
	if res.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("gzip asked for: %v", res.Header)
	}
	zr, err := gzip.NewReader(bytes.NewReader([]byte(got)))
	if err != nil {
		t.Fatal(err)
	}
	if plain, _ := io.ReadAll(zr); string(plain) != string(b) {
		t.Errorf("gzipped: %s", plain)
	}
	if res, _ := get(srv, "signed", "gzip;q=0"); res.Header.Get("Content-Encoding") != "" {
		t.Errorf("gzip refused: %v", res.Header)
	}
	// Fails closed: no Access, or no status, and there is no route.
	for name, change := range map[string]func(*Config){
		"no Access": func(c *Config) { c.Status = now },
		"no status": func(c *Config) { c.Access = passToken{} },
	} {
		srv := newTestServer(t, st, change)
		if res, _ := get(srv, "signed", ""); res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %d", name, res.StatusCode)
		}
	}
}
