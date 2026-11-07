// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

// Each town's gulls wheel over its square, else its quay, else its quay's
// edge, the building of the lowest own number; a few of them, within the
// catalog's wheel of it.
func TestGullTowns(t *testing.T) {
	cat := testCatalog(t)
	kinds := cat.World.Towns.Buildings
	kindOf := func(stands catalog.Stands, prop bool) int {
		for i, k := range kinds {
			if k.Stands == stands && (k.Prop != nil && *k.Prop) == prop {
				return i
			}
		}
		return -1
	}
	square, quay, edge := kindOf(catalog.StandsSquare, false), kindOf(catalog.StandsQuay, false), kindOf(catalog.StandsEdge, true)
	street := kindOf(catalog.StandsStreet, false)
	if square < 0 || edge < 0 || street < 0 {
		t.Fatal("the catalog's buildings lack a square's, a quay's edge's or a street's")
	}
	b := []GullBuilding{
		{Kind: street, East: 1, North: 1, Seed: 0, Town: 0},
		{Kind: edge, East: 5, North: 5, Seed: 0, Town: 0},
		{Kind: square, East: 30, North: 40, Seed: 9, Town: 0, Level: 2},
		{Kind: square, East: 20, North: 40, Seed: 3, Town: 0, Level: 1.5},
		{Kind: edge, East: 900, North: 0, Seed: 7, Town: 4},
		{Kind: edge, East: 800, North: 0, Seed: 7, Town: 4},
		{Kind: street, East: -500, North: 0, Seed: 1, Town: 2},
		{Kind: square, East: 0, North: 0, Seed: 1, Town: -1},
	}
	if quay >= 0 {
		b = append(b, GullBuilding{Kind: quay, East: 7, North: 7, Seed: 0, Town: 0})
	}
	got := GullTowns(b, kinds)
	if len(got) != 2 || got[0].Town != 0 || got[0].East != 20 || got[0].Level != 1.5 || got[1].Town != 4 || got[1].East != 800 {
		t.Fatalf("the towns' gulls: %+v", got)
	}
	r := &cat.Life.Towns
	for _, town := range got {
		n := GullCount(&town, r)
		if n < r.Count[0] || n > r.Count[1] {
			t.Errorf("%d gulls over town %d", n, town.Town)
		}
		for k := range n {
			for _, at := range []float64{0, 1000.5, 123456.75} {
				g := GullAt(&town, r, k, at)
				d := math.Hypot(g.East-town.East, g.North-town.North)
				if d < 0.6*r.Wheel[0]-1e-9 || d > r.Wheel[1]+1e-9 || g.Up < town.Level+r.Height[0]-3 || g.Up > town.Level+r.Height[1]+3 {
					t.Errorf("gull %d of town %d at %v s: %+v", k, town.Town, at, g)
				}
			}
		}
	}
}
