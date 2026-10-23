// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// unaskedStore is a store that fails the test if anything asks it for a
// session.
type unaskedStore struct {
	noAccounts
	t *testing.T
}

func (s unaskedStore) Session(context.Context, [32]byte) (store.Session, error) {
	s.t.Error("the store was asked for a session")
	return store.Session{}, store.ErrNotFound
}

func (s unaskedStore) Touch(context.Context, [32]byte) error {
	s.t.Error("the store was asked to touch a session")
	return nil
}

var (
	testChunkKey = func() []byte {
		k := make([]byte, 32)
		for i := range k {
			k[i] = byte(i)
		}
		return k
	}()
	testChunkWorld = [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
)

// TestChunkPath: an address worked by hand (Python's hmac, of the world's
// bytes and the chunk's number as two bytes little-endian, truncated to 16
// bytes, in unpadded base64url).
func TestChunkPath(t *testing.T) {
	for n, mac := range map[int]string{0: "-EkbUC-Y0mBP_V0G4elQyw", 205: "j25LcdiAYGp3Y3RFfJ4Bkg", 255: "p9Jy17ZHH2Lzf2cGAbgCuA"} {
		want := fmt.Sprintf("/w/01020304-0506-0708-090a-0b0c0d0e0f10/c/%d.%s.bin", n, mac)
		if got := ChunkPath(testChunkKey, testChunkWorld, n); got != want {
			t.Errorf("chunk %d: %s, want %s", n, got, want)
		}
	}
	other := bytes.Clone(testChunkKey)
	other[0] ^= 1
	if ChunkPath(other, testChunkWorld, 205) == ChunkPath(testChunkKey, testChunkWorld, 205) {
		t.Error("another key gives the same address")
	}
	w := testChunkWorld
	w[15]++
	a, b := ChunkPath(testChunkKey, w, 205), ChunkPath(testChunkKey, testChunkWorld, 205)
	if a[strings.LastIndexByte(a, '/'):] == b[strings.LastIndexByte(b, '/'):] {
		t.Error("another world gives the same mac")
	}
}

func testPayloads() [][]byte {
	out := make([][]byte, chunkCount)
	for n := range out {
		out[n] = bytes.Repeat([]byte{byte(n), byte(n >> 3), 0x1f}, 50+n*7)
	}
	return out
}

func TestChunksServed(t *testing.T) {
	payloads := testPayloads()
	chunks := NewChunks(testChunkWorld, testChunkKey, payloads)
	s := newTestServer(t, unaskedStore{t: t}, func(c *Config) { c.Chunks = chunks })
	client := s.Client()
	jar := &cookieCount{}
	get := func(method, path string, header http.Header) (*http.Response, []byte) {
		t.Helper()
		req, err := http.NewRequest(method, s.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		for k, v := range header {
			req.Header[k] = v
		}
		// A session cookie, as a player's browser sends: the route must not
		// read it.
		req.AddCookie(&http.Cookie{Name: "keel_session", Value: strings.Repeat("A", 43)})
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		jar.n += len(res.Header.Values("Set-Cookie"))
		return res, body
	}
	for _, n := range []int{0, 7, 205, 255} {
		res, body := get("GET", chunks.Paths()[n], nil)
		if res.StatusCode != 200 || !bytes.Equal(body, payloads[n]) {
			t.Fatalf("chunk %d: %d, %d bytes", n, res.StatusCode, len(body))
		}
		for k, v := range map[string]string{
			"Content-Type":           "application/octet-stream",
			"Cache-Control":          "public, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
		} {
			if got := res.Header.Get(k); got != v {
				t.Errorf("chunk %d: %s %q, want %q", n, k, got, v)
			}
		}
	}
	// HEAD, and a range.
	res, body := get("HEAD", chunks.Paths()[3], nil)
	if res.StatusCode != 200 || len(body) != 0 || res.ContentLength != int64(len(payloads[3])) {
		t.Errorf("HEAD: %d, %d bytes, length %d", res.StatusCode, len(body), res.ContentLength)
	}
	res, body = get("GET", chunks.Paths()[9], http.Header{"Range": {"bytes=10-19"}})
	if res.StatusCode != 206 || !bytes.Equal(body, payloads[9][10:20]) {
		t.Errorf("a range: %d, %x", res.StatusCode, body)
	}
	// Again with its ETag: not modified.
	res, _ = get("GET", chunks.Paths()[9], http.Header{"If-None-Match": {res.Header.Get("ETag")}})
	if res.StatusCode != 304 {
		t.Errorf("If-None-Match: %d", res.StatusCode)
	}

	good := chunks.Paths()[205]
	base, file := good[:strings.LastIndexByte(good, '/')+1], good[strings.LastIndexByte(good, '/')+1:]
	mac := strings.TrimSuffix(strings.TrimPrefix(file, "205."), ".bin")
	raw, _ := base64.RawURLEncoding.DecodeString(mac)
	flipped := bytes.Clone(raw)
	flipped[15] ^= 1
	otherWorld := testChunkWorld
	otherWorld[0] = 0xff
	refused := map[string]string{
		"another world":            ChunkPath(testChunkKey, otherWorld, 205),
		"another world's id here":  strings.Replace(good, "01020304", "01020305", 1),
		"chunk 256":                base + "256." + mac + ".bin",
		"chunk 1000":               base + "1000." + mac + ".bin",
		"chunk -1":                 base + "-1." + mac + ".bin",
		"chunk 0205":               base + "0205." + mac + ".bin",
		"another chunk's mac":      base + "204." + mac + ".bin",
		"a mac one bit wrong":      base + "205." + base64.RawURLEncoding.EncodeToString(flipped) + ".bin",
		"a mac too short":          base + "205." + mac[:21] + ".bin",
		"a mac too long":           base + "205." + mac + "A.bin",
		"a mac with padding":       base + "205." + mac + "==.bin",
		"a mac's spare bits set":   base + "205." + mac[:21] + string(spareBits(mac[21])) + ".bin",
		"no extension":             base + "205." + mac,
		"another extension":        base + "205." + mac + ".gz",
		"no mac":                   base + "205.bin",
		"another shape":            "/w/" + strings.Split(good, "/")[2] + "/x/205." + mac + ".bin",
		"deeper":                   good + "/more",
		"a key's own path":         "/w/" + strings.Split(good, "/")[2] + "/c/",
		"the world's bare address": "/w/" + strings.Split(good, "/")[2],
	}
	for name, path := range refused {
		res, _ := get("GET", path, nil)
		if res.StatusCode != 404 {
			t.Errorf("%s (%s): %d, want 404", name, path, res.StatusCode)
			continue
		}
		if cc := res.Header.Get("Cache-Control"); cc != "no-store" {
			t.Errorf("%s: Cache-Control %q on a 404", name, cc)
		}
	}
	if jar.n != 0 {
		t.Errorf("%d responses set a cookie", jar.n)
	}
	if got := testutil.ToFloat64(s.metrics.ChunkRequests.WithLabelValues("ok")); got != 7 {
		t.Errorf("%v chunks counted served", got)
	}
	if got := testutil.ToFloat64(s.metrics.ChunkRequests.WithLabelValues("refused")); got < 15 {
		t.Errorf("%v refusals counted", got)
	}
	// The access log names the route, never the address.
	logs := s.logs.String()
	if !strings.Contains(logs, `"route":"GET /w/{world}/c/{file}"`) {
		t.Errorf("the access log lacks the chunks' route:\n%s", logs)
	}
	if strings.Contains(logs, mac) || strings.Contains(logs, "/w/0102") {
		t.Errorf("the access log holds an address:\n%s", logs)
	}
}

// spareBits is a base64url character of the same 2 leading bits as c with
// its 4 spare bits set: decoding it loosely would give c's bytes.
func spareBits(c byte) byte {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	i := strings.IndexByte(alphabet, c)
	return alphabet[i|0x0f]
}

type cookieCount struct{ n int }

func TestRobots(t *testing.T) {
	s := newTestServer(t, unaskedStore{t: t}, nil)
	res, err := s.Client().Get(s.URL + "/robots.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !strings.Contains(string(body), "Disallow: /w/") {
		t.Errorf("robots.txt: %d %q", res.StatusCode, body)
	}
}
