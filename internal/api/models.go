// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/obs"
)

// Each charted island's model for the chart is served as a chunk is, at a
// capability URL handed out with the island's charting and no sooner:
//
//	/w/<world id>/i/<n>.<mac>.bin
//
// n the island's model's number, mac the first 128 bits of HMAC-SHA-256
// under the world's chunk key of the world's 16 bytes, the letter i, then
// n as two bytes, little-endian: never a chunk's mac, which has no letter.
// The payload is the island's model, gzipped; public, kept for a year.

// modelRoute is the islands' models' route, which needs no session.
const modelRoute = "GET /w/{world}/i/{file}"

// modelMac is model n's mac under key, for the world with the id given.
func modelMac(key []byte, world [16]byte, n int) [ChunkMacSize]byte {
	m := hmac.New(sha256.New, key)
	m.Write(world[:])
	m.Write([]byte{'i'})
	m.Write(binary.LittleEndian.AppendUint16(nil, uint16(n)))
	var out [ChunkMacSize]byte
	copy(out[:], m.Sum(nil))
	return out
}

// ModelPath is the address model n of the world with the id given is
// served at.
func ModelPath(key []byte, world [16]byte, n int) string {
	mac := modelMac(key, world, n)
	return "/w/" + worldString(world) + "/i/" + strconv.Itoa(n) + "." + base64.RawURLEncoding.EncodeToString(mac[:]) + ".bin"
}

// Models are a world's islands' models as served.
type Models struct {
	world    string
	key      []byte
	id       [16]byte
	payloads [][]byte
	paths    []string
}

// NewModels serves the payloads, by number, of the world with the id given.
func NewModels(world [16]byte, key []byte, payloads [][]byte) *Models {
	m := &Models{world: worldString(world), key: bytes.Clone(key), id: world, payloads: payloads, paths: make([]string, len(payloads))}
	for n := range payloads {
		m.paths[n] = ModelPath(key, world, n)
	}
	return m
}

// Paths are every model's address, by number.
func (m *Models) Paths() []string { return m.paths }

// Size is the bytes of the payloads held.
func (m *Models) Size() int {
	n := 0
	for _, p := range m.payloads {
		n += len(p)
	}
	return n
}

// serve answers GET and HEAD of a model's address, and 404 for any other.
func (m *Models) serve(metrics *obs.Metrics) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		n, ok := m.find(r.PathValue("world"), r.PathValue("file"))
		if !ok {
			metrics.ChunkRequests.WithLabelValues("refused").Inc()
			writeError(w, http.StatusNotFound, "not-found")
			return
		}
		metrics.ChunkRequests.WithLabelValues("ok").Inc()
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Cache-Control", chunkCache)
		h.Set("ETag", `"`+m.paths[n][strings.LastIndexByte(m.paths[n], '/')+1:]+`"`)
		cw := &countingWriter{ResponseWriter: w}
		http.ServeContent(cw, r, "", time.Time{}, bytes.NewReader(m.payloads[n]))
		metrics.ChunkBytes.Add(float64(cw.n))
	}
}

// find is the model an address names, if its mac is the one its key gives.
func (m *Models) find(world, file string) (int, bool) {
	if world != m.world {
		return 0, false
	}
	rest, ok := strings.CutSuffix(file, ".bin")
	if !ok {
		return 0, false
	}
	num, mac, ok := strings.Cut(rest, ".")
	if !ok || len(num) == 0 || len(num) > 4 || len(mac) != base64.RawURLEncoding.EncodedLen(ChunkMacSize) {
		return 0, false
	}
	n, err := strconv.Atoi(num)
	if err != nil || n < 0 || n > math.MaxUint16 || n >= len(m.payloads) || strconv.Itoa(n) != num {
		return 0, false
	}
	got, err := base64.RawURLEncoding.Strict().DecodeString(mac)
	if err != nil || len(got) != ChunkMacSize {
		return 0, false
	}
	want := modelMac(m.key, m.id, n)
	return n, hmac.Equal(got, want[:])
}
