// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// TestModelsServed: an island's model is served at its address, public and
// kept a year, and nowhere else: not with another mac, a chunk's mac, or
// another world's.
func TestModelsServed(t *testing.T) {
	payloads := [][]byte{[]byte("island zero"), []byte("island one")}
	models := NewModels(testChunkWorld, testChunkKey, payloads)
	chunks := NewChunks(testChunkWorld, testChunkKey, testPayloads())
	s := newTestServer(t, unaskedStore{t}, func(c *Config) { c.Models, c.Chunks = models, chunks })
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

// newsStore is news in memory, the newest first.
type newsStore struct{ items []store.News }

func (n *newsStore) News(_ context.Context, before *[16]byte, limit int) ([]store.News, error) {
	var out []store.News
	on := before == nil
	for _, it := range n.items {
		if on && len(out) < limit {
			out = append(out, it)
		}
		if before != nil && it.ID == *before {
			on = true
		}
	}
	return out, nil
}

// TestNewsPaged: the news, a page at a time, the newest first, each page
// carrying where the next begins; open to all, and kept by the edge.
func TestNewsPaged(t *testing.T) {
	src := &newsStore{}
	for i := range 5 {
		src.items = append(src.items, store.News{ID: [16]byte{byte(10 - i)}, Column: "discoveries", Sailor: "Ann", Title: "Isle " + string(rune('A'+i)),
			Also: []store.Folded{{Subject: "place", Number: 3, Title: "a cove"}}, At: time.UnixMilli(int64(1000 - i))})
	}
	s := newTestServer(t, unaskedStore{t}, func(c *Config) { c.News, c.NewsPage = src, 2 })
	page := func(q string) newsPage {
		t.Helper()
		res, err := s.Client().Get(s.URL + "/api/news" + q)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "public, max-age=5" {
			t.Fatalf("news%s: %d %q", q, res.StatusCode, res.Header.Get("Cache-Control"))
		}
		var p newsPage
		if err := json.NewDecoder(res.Body).Decode(&p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	var titles []string
	q := ""
	for range 3 {
		p := page(q)
		for _, it := range p.Items {
			titles = append(titles, it.Title)
		}
		if !p.More {
			break
		}
		q = "?before=" + p.Items[len(p.Items)-1].ID
	}
	if strings.Join(titles, ",") != "Isle A,Isle B,Isle C,Isle D,Isle E" {
		t.Errorf("paged %v", titles)
	}
	if p := page(""); p.Items[0].Also[0].Title != "a cove" || p.Items[0].By != "Ann" || p.Items[0].ID != hex.EncodeToString(src.items[0].ID[:]) {
		t.Errorf("the first item %+v", p.Items[0])
	}
	res, err := s.Client().Get(s.URL + "/api/news?before=zz")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Errorf("before=zz: %d", res.StatusCode)
	}
}
