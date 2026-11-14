// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"path/filepath"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The catalog's polar table is the tool's: every boat sailed again at a
// point of the table makes the table's speed, so a change to a boat's
// physics that moves her polar fails here until the table is written
// again. go run ./tools/polar -check sails more points.
func TestTableHolds(t *testing.T) {
	if testing.Short() {
		t.Skip("sails every boat")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	f, err := readTable(filepath.Join("..", "..", tablePath))
	if err != nil {
		t.Fatal(err)
	}
	_, prepared := cat.Prepare()
	for i := range cat.Boats {
		b := &cat.Boats[i]
		params := catalog.PhysicsParams(b)
		k := newKind(string(b.ID), b.Name, &prepared[i], &params, 10, b.StartSheet)
		if err := checkTable(k, f, []float64{12}, []float64{90}); err != nil {
			t.Error(err)
		}
	}
}

// The table's rows are the winds, its columns the angles, and it reads
// back through the catalog as each boat's polar.
func TestTableShape(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	f, err := readTable(filepath.Join("..", "..", tablePath))
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Polars.Boats) != len(cat.Boats) {
		t.Fatalf("%d boats' polars for %d boats", len(f.Polars.Boats), len(cat.Boats))
	}
	for i, b := range f.Polars.Boats {
		if len(b.Speed) != len(f.Polars.Winds) || len(b.Up) != len(f.Polars.Winds) || len(b.Down) != len(f.Polars.Winds) {
			t.Errorf("%s: %d rows of speed, %d up, %d down for %d winds", b.Boat, len(b.Speed), len(b.Up), len(b.Down), len(f.Polars.Winds))
		}
		for _, r := range b.Speed {
			if len(r) != len(f.Polars.Angles) {
				t.Errorf("%s: a row of %d speeds for %d angles", b.Boat, len(r), len(f.Polars.Angles))
			}
		}
		p := cat.Polar(i)
		if p == nil {
			t.Fatalf("the catalog has no polar for %s", cat.Boats[i].ID)
		}
		// In 12 knots every boat makes way on a reach and beats to windward.
		tws := 12 * physics.Knot
		if v := p.Speed(tws, 1.5707963267948966); !(v > 0.5) {
			t.Errorf("%s: %v m/s on a reach in 12 knots", b.Boat, v)
		}
		if up, vmg := p.BestUp(tws); !(up > 0.5 && up < 1.3 && vmg > 0.2) {
			t.Errorf("%s: best up %v rad at %v m/s in 12 knots", b.Boat, up, vmg)
		}
	}
}
