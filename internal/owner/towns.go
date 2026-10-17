// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen/chart"
)

// The world's towns on the world page: each with its kind, its buildings
// counted by kind, its piers and its harbour, and where a teleport to its
// harbour puts a boat; each drawn alone at the lattice's resolution, its
// streets, quays and piers by their surfaces and its buildings as
// footprints facing their ways.

// townsList is towns.json: every town, and the kinds' names it counts by.
func townsList(cfg *Config) []byte {
	type townJSON struct {
		Number    int32          `json:"number"`
		Kind      string         `json:"kind"`
		Name      string         `json:"name"`
		Island    int32          `json:"island"`
		East      float64        `json:"east"`
		North     float64        `json:"north"`
		Buildings int            `json:"buildings"`
		Counts    map[string]int `json:"counts"`
		Piers     []float64      `json:"piers"`
		Streets   int            `json:"streets"`
		Moorings  int            `json:"moorings"`
		Harbour   *[2]float64    `json:"harbour"`
	}
	out := struct {
		Towns []townJSON `json:"towns"`
	}{Towns: []townJSON{}}
	b := cfg.Bundle
	if b != nil {
		for i := range b.Towns {
			t := &b.Towns[i]
			tj := townJSON{Number: t.Number, Kind: t.Kind, Name: t.Name, Island: t.Island, East: t.X, North: t.Y,
				Buildings: t.Buildings, Counts: map[string]int{}, Piers: []float64{}, Streets: t.Streets}
			for k, n := range t.Counts {
				if n > 0 && k < len(cfg.TownKinds) {
					tj.Counts[cfg.TownKinds[k]] = n
				}
			}
			for _, p := range t.Piers {
				tj.Piers = append(tj.Piers, p.Length)
			}
			if t.Kind == "main" {
				tj.Moorings = b.Start.Moorings
			}
			if x, y, ok := harbourPoint(cfg, t); ok {
				tj.Harbour = &[2]float64{round2(x), round2(y)}
			}
			out.Towns = append(out.Towns, tj)
		}
	}
	data, err := json.Marshal(out)
	if err != nil {
		panic(err) // plain data
	}
	return data
}

// harbourPoint is where a teleport to a town's harbour puts a boat: Port
// Royal's first mooring; else the middle of the first disc of its harbour
// in water deep enough, the nearest its quay first.
func harbourPoint(cfg *Config, t *worldgen.Town) (float64, float64, bool) {
	b := cfg.Bundle
	if t.Kind == "main" && b.Start.Moorings > 0 {
		p := b.Start.Places[0]
		return p[0], p[1], true
	}
	best, bx, by := math.Inf(1), 0.0, 0.0
	for _, d := range t.Harbour {
		e, _ := b.Ground.At(d.X, d.Y)
		if -e < cfg.Rules.Depth {
			continue
		}
		if dist := math.Hypot(d.X-t.X, d.Y-t.Y); dist < best {
			best, bx, by = dist, d.X, d.Y
		}
	}
	return bx, by, !math.IsInf(best, 1)
}

// town serves town n at the lattice's resolution: GET
// /owner/api/town/{n}.svg.
func (l *land) town(w http.ResponseWriter, r *http.Request) {
	name, ok := strings.CutSuffix(r.PathValue("file"), ".svg")
	n, err := strconv.Atoi(name)
	b := l.cfg.Bundle
	if !ok || err != nil || b == nil || n < 0 || n >= len(b.Towns) {
		http.Error(w, "no such town", http.StatusNotFound)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-cache")
	h.Set("ETag", l.etag)
	if r.Header.Get("If-None-Match") == l.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	svg, err := chart.Town(b, n, l.cfg.TownLook)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	h.Set("Content-Type", "image/svg+xml")
	_, _ = w.Write(svg)
}
