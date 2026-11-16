// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEdgeCompressesAsCloudflare(t *testing.T) {
	big := strings.Repeat("keel over the edge ", 100)
	keel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		types := map[string]string{
			"/assets/main.js":   "text/javascript; charset=utf-8",
			"/assets/boat.glb":  "model/gltf-binary",
			"/assets/stars.bin": "application/octet-stream",
			"/w/1/c/2.bin":      "application/octet-stream",
			"/assets/look.avif": "image/avif",
			"/api/me":           "application/json",
		}
		w.Header().Set("Content-Type", types[r.URL.Path])
		if r.URL.Path == "/api/me" {
			io.WriteString(w, `{}`)
			return
		}
		http.ServeContent(w, r, "", time.Time{}, strings.NewReader(big))
	}))
	defer keel.Close()
	front := httptest.NewServer(edge(strings.TrimPrefix(keel.URL, "http://"), true))
	defer front.Close()
	before := httptest.NewServer(edge(strings.TrimPrefix(keel.URL, "http://"), false))
	defer before.Close()

	getFrom := func(srv *httptest.Server, path, accept, rng string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		if accept != "" {
			req.Header.Set("Accept-Encoding", accept)
		}
		if rng != "" {
			req.Header.Set("Range", rng)
		}
		res, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { res.Body.Close() })
		return res
	}
	get := func(path, accept, rng string) *http.Response {
		t.Helper()
		return getFrom(front, path, accept, rng)
	}
	for _, c := range []struct {
		path string
		want bool
	}{
		{"/assets/main.js", true},
		{"/assets/boat.glb", true},
		{"/assets/stars.bin", true},
		// The rule is for the page's assets; the land's chunks pass as they are.
		{"/w/1/c/2.bin", false},
		{"/assets/look.avif", false},
		// Too small to compress.
		{"/api/me", false},
	} {
		res := get(c.path, "gzip, br, zstd", "")
		got := res.Header.Get("Content-Encoding") == "gzip"
		if got != c.want {
			t.Errorf("%s: gzipped %v, want %v", c.path, got, c.want)
			continue
		}
		if !got {
			continue
		}
		z, err := gzip.NewReader(res.Body)
		if err != nil {
			t.Fatalf("%s: %v", c.path, err)
		}
		body, _ := io.ReadAll(z)
		if string(body) != big {
			t.Errorf("%s: the body changed", c.path)
		}
		if !strings.Contains(res.Header.Get("Vary"), "Accept-Encoding") {
			t.Errorf("%s: no Vary: Accept-Encoding", c.path)
		}
	}
	if res := get("/assets/main.js", "", ""); res.Header.Get("Content-Encoding") != "" {
		t.Error("compressed for a browser that accepts no gzip")
	}
	// Without the rule, the models as they were; the scripts compressed still.
	if res := getFrom(before, "/assets/boat.glb", "gzip", ""); res.Header.Get("Content-Encoding") != "" {
		t.Error("a model compressed without the rule")
	}
	if res := getFrom(before, "/assets/main.js", "gzip", ""); res.Header.Get("Content-Encoding") != "gzip" {
		t.Error("a script not compressed without the rule")
	}
	res := get("/assets/boat.glb", "gzip", "bytes=0-9")
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusPartialContent || res.Header.Get("Content-Encoding") != "" || !bytes.Equal(body, []byte(big[:10])) {
		t.Errorf("a range: %d %q %q", res.StatusCode, res.Header.Get("Content-Encoding"), body)
	}
}
