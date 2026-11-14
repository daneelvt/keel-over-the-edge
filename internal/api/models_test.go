// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestModelsServed: an island's model is served at its address, public and
// kept a year, and nowhere else: not with another mac, a chunk's mac, or
// another world's.
func TestModelsServed(t *testing.T) {
	payloads := [][]byte{[]byte("island zero"), []byte("island one")}
	models := NewModels(testChunkWorld, testChunkKey, payloads)
	chunks := NewChunks(testChunkWorld, testChunkKey, testPayloads())
	s := newTestServer(t, unaskedStore{t: t}, func(c *Config) { c.Models, c.Chunks = models, chunks })
	get := func(path string) (int, []byte, http.Header) {
		t.Helper()
		res, err := s.Client().Get(s.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res.StatusCode, body, res.Header
	}
	for n, p := range models.Paths() {
		code, body, h := get(p)
		if code != 200 || !bytes.Equal(body, payloads[n]) || h.Get("Cache-Control") != chunkCache {
			t.Errorf("model %d: %d %q %q", n, code, body, h.Get("Cache-Control"))
		}
	}
	p := models.Paths()[1]
	mac := p[strings.LastIndexByte(p, '.')-22 : strings.LastIndexByte(p, '.')]
	chunkMac := chunks.Paths()[1][strings.LastIndexByte(chunks.Paths()[1], '.')-22 : strings.LastIndexByte(chunks.Paths()[1], '.')]
	wrong := []string{
		strings.Replace(p, mac, strings.Repeat("A", 22), 1),
		strings.Replace(p, mac, chunkMac, 1),
		strings.Replace(p, "/i/1.", "/i/0.", 1),
		strings.Replace(p, "/w/01020304", "/w/01020305", 1),
	}
	for _, w := range wrong {
		if code, _, h := get(w); code != 404 || h.Get("Cache-Control") == chunkCache {
			t.Errorf("%s: %d", w, code)
		}
	}
}
