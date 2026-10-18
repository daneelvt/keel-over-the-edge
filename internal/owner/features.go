// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"encoding/json"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// The islands' features on the world page: every feature with its kind,
// its island, where it is and how high, and where a boat sees it from,
// where a teleport puts the owner's boat; and every kind with the colour
// its marks are drawn in.

// FeatureKind is a kind of feature as the page lists and marks it.
type FeatureKind struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Site string `json:"site"`
	Mark string `json:"mark"`
}

// featuresList is features.json: the kinds of feature, and every feature.
func featuresList(cfg *Config) []byte {
	type featureJSON struct {
		Number   int32       `json:"number"`
		Kind     string      `json:"kind"`
		Island   int32       `json:"island"`
		East     float64     `json:"east"`
		North    float64     `json:"north"`
		Height   float64     `json:"height"`
		Size     float64     `json:"size"`
		Seen     bool        `json:"seen"`
		Approach *[2]float64 `json:"approach"`
	}
	out := struct {
		Kinds    []FeatureKind `json:"kinds"`
		Features []featureJSON `json:"features"`
	}{Kinds: cfg.FeatureKinds, Features: []featureJSON{}}
	if out.Kinds == nil {
		out.Kinds = []FeatureKind{}
	}
	if b := cfg.Bundle; b != nil {
		for _, f := range b.Features {
			j := featureJSON{Number: f.Number, Kind: f.Kind, Island: f.Island, East: round2(f.X), North: round2(f.Y),
				Height: f.Height, Size: f.Size, Seen: f.Seen}
			// Where it is seen from, or failing that the nearest deep water.
			if f.Seen {
				j.Approach = &[2]float64{round2(f.SightX), round2(f.SightY)}
			} else if x, y, ok := placeApproach(b.Ground, f.X, f.Y, cfg.Rules.Approach); ok {
				j.Approach = &[2]float64{round2(x), round2(y)}
			}
			out.Features = append(out.Features, j)
		}
	}
	body, err := json.Marshal(&out)
	if err != nil {
		panic(err)
	}
	return body
}

// islandFlora is what grows on island is: the plants of each surface that
// covers a hundredth of its land or more, by the catalog's names.
func islandFlora(cfg *Config, b *worldgen.Bundle, is *worldgen.Island) []string {
	out := []string{}
	if len(cfg.SurfacePlants) == 0 {
		return out
	}
	counts := make([]int, len(cfg.SurfacePlants))
	land := 0
	for cc := is.Box[0]; cc < is.Box[0]+is.Box[2]; cc++ {
		for jj := is.Box[1]; jj < is.Box[1]+is.Box[3]; jj++ {
			n, i, ok := physics.ChunkOf(cc, jj)
			if !ok || b.Ground.Chunks[n] == nil || b.Ground.Chunks[n].Elevation[i] <= 0 {
				continue
			}
			x, y := physics.CellCentre(cc, jj)
			// Its own land: about its centre, not a neighbour's in its box.
			if dx, dy := x-is.X, y-is.Y; dx*dx+dy*dy > is.Across*is.Across {
				continue
			}
			if s := int(b.Ground.Chunks[n].Surface[i]); s < len(counts) {
				counts[s]++
				land++
			}
		}
	}
	for s, n := range counts {
		if land == 0 || n*100 < land {
			continue
		}
		for _, p := range cfg.SurfacePlants[s] {
			if !slices.Contains(out, p) {
				out = append(out, p)
			}
		}
	}
	return out
}
