// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"math"
	"os"
	"testing"
)

// box is a wall-sided box hull: beam b, from depth below the waterline to
// height above it, length l in sections a tenth of a metre apart.
func box(b, depth, height, l float64) *model {
	m := &model{step: 0.1}
	half := []float64{0, -depth, b / 2, -depth, b / 2, height, 0, height}
	for z := 0.05; z < l; z += 0.1 {
		m.sections = append(m.sections, section{z: z, poly: whole(half)})
	}
	return m
}

// A box's lever is the wall-sided formula's until its deck edge or its
// bilge comes to the water: GZ = sin φ (GM + ½ BM tan² φ).
func TestABoxsLeverIsTheWallSidedFormulas(t *testing.T) {
	const b, draught, zg = 2.0, 0.5, 0.2
	m := box(b, draught, 1, 4)
	volume := b * draught * 4
	if h := m.waterline(0, volume); math.Abs(h) > 1e-6 {
		t.Fatalf("upright she floats at %g m, not on her waterline", h)
	}
	bm := b * b / (12 * draught)
	gm := -draught/2 + bm - zg
	for _, deg := range []float64{1, 5, 10, 15, 20, 25} {
		phi := deg * math.Pi / 180
		want := math.Sin(phi) * (gm + 0.5*bm*math.Tan(phi)*math.Tan(phi))
		got := m.buoyancy(phi, volume) - zg*math.Sin(phi)
		if math.Abs(got-want) > 1e-6 {
			t.Errorf("at %g°: GZ %.6f m, the formula's %.6f", deg, got, want)
		}
	}
	// Upside down she floats again at a lever of 0.
	if got := m.buoyancy(math.Pi, volume) - zg*math.Sin(math.Pi); math.Abs(got) > 1e-6 {
		t.Errorf("at 180°: GZ %.6f m", got)
	}
}

// A small volume counts while it is under the water, and not once it is
// out of it.
func TestAppendagesCountWhileUnderTheWater(t *testing.T) {
	m := box(2, 0.5, 1, 4)
	m.elements = [][4]float64{{0, -1.5, 2, 0.1}}
	if v, _ := m.immersed(0, 0); math.Abs(v-4.1) > 1e-9 {
		t.Errorf("upright, %g m³ under the water, not 4.1", v)
	}
	// Upside down, the 1 m of her above the old waterline is under it, and
	// the volume below her is out of the water.
	if v, _ := m.immersed(math.Pi, 0); math.Abs(v-8) > 1e-9 {
		t.Errorf("upside down, %g m³ under the water, not 8", v)
	}
}

// Every boat whose model carries the sections has the lever and centre of
// gravity in the catalog that the model gives.
func TestTheCatalogsLeverIsTheModels(t *testing.T) {
	if err := os.Chdir("../.."); err != nil {
		t.Fatal(err)
	}
	if err := run("yacht", true); err != nil {
		t.Error(err)
	}
}
