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

// twinBox is two wall-sided box hulls of beam b, their centrelines s
// apart, from depth below the waterline to height above it, length l in
// sections a tenth of a metre apart, joined by nothing: each section's
// starboard half runs out along the deck's height to the hull and round it.
func twinBox(s, b, depth, height, l float64) *model {
	m := &model{step: 0.1}
	in, out := s/2-b/2, s/2+b/2
	half := []float64{0, height, in, height, in, -depth, out, -depth, out, height, in, height, 0, height}
	for z := 0.05; z < l; z += 0.1 {
		m.sections = append(m.sections, section{z: z, poly: whole(half)})
	}
	return m
}

// Two boxes' lever, once the windward one is clear of the water, is the
// lee one's alone, carrying the whole weight half the spacing out: GZ =
// s/2 cos φ + sin φ (BM (1 + ½ tan² φ) − KG), the wall-sided formula about
// the lee box's centreline at twice the draught (KG above the boxes' upright
// waterline, which is the lee box's own centreline at half its new draught).
func TestTwoBoxesLeverIsTheFormulas(t *testing.T) {
	const s, b, draught, zg = 4.0, 1.0, 0.5, 0.6
	m := twinBox(s, b, draught, 1.5, 4)
	volume := 2 * b * draught * 4
	if h := m.waterline(0, volume); math.Abs(h) > 1e-6 {
		t.Fatalf("upright she floats at %g m, not on her waterline", h)
	}
	lift := clearHeel(m, volume)
	bm := b * b / (12 * 2 * draught)
	for _, deg := range []float64{25, 30, 35, 40} {
		phi := deg * math.Pi / 180
		if deg < lift {
			t.Fatalf("at %g° her windward box is not yet clear (clear at %.1f°)", deg, lift)
		}
		want := s/2*math.Cos(phi) + math.Sin(phi)*(bm*(1+0.5*math.Tan(phi)*math.Tan(phi))-zg)
		got := m.buoyancy(phi, volume) - zg*math.Sin(phi)
		if math.Abs(got-want) > 1e-6 {
			t.Errorf("at %g°: GZ %.6f m, the formula's %.6f", deg, got, want)
		}
	}
	// Upright the lever is nothing, and the windward box's volume all
	// of half.
	if got := m.buoyancy(0, volume); math.Abs(got) > 1e-9 {
		t.Errorf("upright: GZ %.6f m", got)
	}
	if v := m.immersedPort(0, 0); math.Abs(v-volume/2) > 1e-9 {
		t.Errorf("upright her port box has %g m³ under the water, not %g", v, volume/2)
	}
}

// Past its greatest, a lever held at a share falls only to that share of
// its greatest, and stays there from where it first falls so far.
func TestAHeldLeverNeverFallsPastItsShare(t *testing.T) {
	lever := []float64{0, 1, 2, 1.5, 0.8, 0.1, -0.3, -0.2, 0.05}
	got := hold(lever, 0.1)
	want := []float64{0, 1, 2, 1.5, 0.8, 0.2, 0.2, 0.2, 0.2}
	for i := range want {
		if math.Abs(got[i]-want[i]) > 1e-12 {
			t.Fatalf("held: %v, not %v", got, want)
		}
	}
	if got := hold(lever, 0); math.Abs(got[6]-lever[6]) > 0 {
		t.Errorf("unheld, the lever changed: %v", got)
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
	for _, id := range []string{"yacht", "catamaran"} {
		if err := run(id, true); err != nil {
			t.Errorf("%s: %v", id, err)
		}
	}
}
