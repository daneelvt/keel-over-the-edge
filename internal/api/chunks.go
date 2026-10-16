// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/obs"
)

// The world's chunks are served at capability URLs (W3C TAG, Good Practices
// for Capability URLs, 2014): an address no one can guess, which the game
// connection hands a player only once their boat comes within sight of the
// chunk, so that the chart stays blank until it is sailed. The address is
//
//	/w/<world id>/c/<n>.<mac>.bin
//
// the world's id as the Welcome names it, n the chunk's number, and mac the
// first 128 bits of HMAC-SHA-256 (RFC 2104), under the world's chunk key, of
// the world's 16 bytes then the chunk's number as two bytes, little-endian,
// in unpadded base64url: 22 characters. RFC 2104 (5) asks a truncated HMAC
// to keep at least half the hash and 80 bits; 128 keeps both. Every player
// is handed the same address for a chunk, so the edge's cache holds it once:
// the response is public and kept for a year, and an address that is not a
// chunk's is 404, never cached. A world's addresses die with its key.

// ChunkMacSize is how many bytes of the HMAC an address carries.
const ChunkMacSize = 16

// chunkCount is how many chunks a world has.
const chunkCount = 256

// chunkCache is how a chunk is cached: by anyone, for a year, never asked
// again.
const chunkCache = "public, max-age=31536000, immutable"

// chunkMac is chunk n's mac under key, for the world with the id given.
func chunkMac(key []byte, world [16]byte, n int) [ChunkMacSize]byte {
	m := hmac.New(sha256.New, key)
	m.Write(world[:])
	m.Write(binary.LittleEndian.AppendUint16(nil, uint16(n)))
	var out [ChunkMacSize]byte
	copy(out[:], m.Sum(nil))
	return out
}

// worldString writes a world's id as the Welcome names it.
func worldString(w [16]byte) string {
	var b [36]byte
	hex.Encode(b[0:8], w[0:4])
	b[8] = '-'
	hex.Encode(b[9:13], w[4:6])
	b[13] = '-'
	hex.Encode(b[14:18], w[6:8])
	b[18] = '-'
	hex.Encode(b[19:23], w[8:10])
	b[23] = '-'
	hex.Encode(b[24:], w[10:])
	return string(b[:])
}

// ChunkPath is the address chunk n of the world with the id given is served
// at, signed with the world's chunk key.
func ChunkPath(key []byte, world [16]byte, n int) string {
	mac := chunkMac(key, world, n)
	return "/w/" + worldString(world) + "/c/" + strconv.Itoa(n) + "." + base64.RawURLEncoding.EncodeToString(mac[:]) + ".bin"
}

// Chunks are a world's chunks as served: each one's payload, as the bundle
// stores it, and its address.
type Chunks struct {
	world    string
	key      []byte
	id       [16]byte
	payloads [][]byte
	paths    []string
}

// NewChunks serves the payloads, by number, of the world with the id given,
// at addresses signed with its chunk key. It keeps the payloads, which it
// never changes, and a copy of the key.
func NewChunks(world [16]byte, key []byte, payloads [][]byte) *Chunks {
	c := &Chunks{world: worldString(world), key: bytes.Clone(key), id: world, payloads: payloads, paths: make([]string, len(payloads))}
	for n := range payloads {
		c.paths[n] = ChunkPath(key, world, n)
	}
	return c
}

// Paths are every chunk's address, by number: what the game connection
// hands out.
func (c *Chunks) Paths() []string { return c.paths }

// Size is the bytes of the payloads held.
func (c *Chunks) Size() int {
	n := 0
	for _, p := range c.payloads {
		n += len(p)
	}
	return n
}

// chunkRoute is the chunks' route, which needs no session; chunksRoute
// answers every other address under /w/ with a 404 that is not cached.
const (
	chunkRoute  = "GET /w/{world}/c/{file}"
	chunksRoute = "GET /w/"
)

// serve answers GET and HEAD of a chunk's address: its payload if the
// address is one this server hands out, byte for byte with ranges as
// http.ServeContent gives them; and 404, not to be cached, for any other.
// It reads nothing but what it holds.
func (c *Chunks) serve(m *obs.Metrics) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		n, ok := c.find(r.PathValue("world"), r.PathValue("file"))
		if !ok {
			m.ChunkRequests.WithLabelValues("refused").Inc()
			writeError(w, http.StatusNotFound, "not-found")
			return
		}
		m.ChunkRequests.WithLabelValues("ok").Inc()
		p := c.payloads[n]
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Cache-Control", chunkCache)
		h.Set("ETag", `"`+c.paths[n][strings.LastIndexByte(c.paths[n], '/')+1:]+`"`)
		cw := &countingWriter{ResponseWriter: w}
		http.ServeContent(cw, r, "", time.Time{}, bytes.NewReader(p))
		m.ChunkBytes.Add(float64(cw.n))
	}
}

// find is the chunk an address names, if its mac is the one its key gives:
// n.mac.bin, n written as Itoa writes it, mac 22 characters of base64url.
func (c *Chunks) find(world, file string) (int, bool) {
	if world != c.world {
		return 0, false
	}
	rest, ok := strings.CutSuffix(file, ".bin")
	if !ok {
		return 0, false
	}
	num, mac, ok := strings.Cut(rest, ".")
	if !ok || len(num) == 0 || len(num) > 3 || len(mac) != base64.RawURLEncoding.EncodedLen(ChunkMacSize) {
		return 0, false
	}
	n, err := strconv.Atoi(num)
	if err != nil || n < 0 || n >= len(c.payloads) || n >= chunkCount || strconv.Itoa(n) != num {
		return 0, false
	}
	got, err := base64.RawURLEncoding.Strict().DecodeString(mac)
	if err != nil || len(got) != ChunkMacSize {
		return 0, false
	}
	want := chunkMac(c.key, c.id, n)
	if !hmac.Equal(got, want[:]) {
		return 0, false
	}
	return n, true
}

// countingWriter counts the body's bytes written.
type countingWriter struct {
	http.ResponseWriter
	n int
}

func (w *countingWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	w.n += n
	return n, err
}

// robots keeps search engines off the chunks' addresses: they are
// capabilities, and no use to anyone not sailing.
const robots = "User-agent: *\nDisallow: /w/\n"

func serveRobots(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Cache-Control", "public, max-age=86400")
	h.Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write([]byte(robots))
}
