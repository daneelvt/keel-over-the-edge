// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A chunk of a format before the lee's byte reads as one whose lee is open
// water, its wind's shelter as it was.
func TestOlderChunkHasNoLee(t *testing.T) {
	n, g, s := madeChunk()
	payload, err := encodeChunk(n, chunkFileWorld, g, s, nil, 3, 4)
	if err != nil {
		t.Fatal(err)
	}
	_, read, _, err := DecodeChunkOf(payload, n, chunkFileWorld, 4)
	if err != nil {
		t.Fatal(err)
	}
	leeHeld := false
	for i := 0; i < len(read.Values); i += physics.ShelterStride {
		if read.Values[i] != s.Values[i] || read.Values[i+1] != s.Values[i+1] {
			t.Fatalf("byte %d: the wind's shelter %d, %d read as %d, %d", i, s.Values[i], s.Values[i+1], read.Values[i], read.Values[i+1])
		}
		if read.Values[i+2] != physics.ShelterLeeOpen {
			t.Fatalf("byte %d: an older chunk's lee reads as %d", i+2, read.Values[i+2])
		}
		leeHeld = leeHeld || s.Values[i+2] != physics.ShelterLeeOpen
	}
	if !leeHeld {
		t.Fatal("the made chunk holds no lee to lose")
	}
	// And this format keeps it.
	payload, err = EncodeChunk(n, chunkFileWorld, g, s)
	if err != nil {
		t.Fatal(err)
	}
	if _, read, err = DecodeChunk(payload, n, chunkFileWorld); err != nil || read.Values != s.Values {
		t.Fatalf("a chunk of this format does not read back its shelter: %v", err)
	}
}

// Port Royal's basin, in seed 1's world: by the area's own fetch and the
// lee's, its moorings' waves are under a quarter of the open sea's from at
// least 13 of the 16 directions a fresh breeze may blow from, and under a
// third from any: the basin's fetch is under 300 m from 14 at its centre,
// and a mooring by the narrows sees out through them.
func TestBasinIsCalm(t *testing.T) {
	_, b := wholeWorld(t)
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	waves, _ := cat.Prepare()
	if b.Start.Moorings == 0 {
		t.Fatal("seed 1 has no moorings")
	}
	for _, m := range [][2]float64{b.Start.Places[0], b.Start.Places[b.Start.Moorings/2], b.Start.Places[b.Start.Moorings-1]} {
		calm := 0
		var factors []float64
		for k := range physics.ShelterDirections {
			from := float64(k) * 2 * math.Pi / physics.ShelterDirections
			win := physics.SeaWindow{Col: physics.SeaAreaOf(m[0]) - 2, Row: physics.SeaAreaOf(m[1]) - 2, Size: 5,
				Inputs: make([]physics.SeaInput, 25), Amp: make([]float64, 25*physics.SeaComponents),
				Hs: make([]float64, 25), Peak: make([]float64, 25), Parts: make([]physics.SeaParts, 25)}
			for i := range int32(25) {
				c := min(max(win.Col+i%5, 0), physics.SeaAreas-1)
				r := min(max(win.Row+i/5, 0), physics.SeaAreas-1)
				physics.SeaArea(waves, &win, i, waves.LandSea(20*1852.0/3600, from, &b.Fetch[r*physics.SeaAreas+c]))
			}
			win.Seal()
			var tick physics.SeaTick
			sea := physics.Sea{Waves: waves, Window: &win, Tick: &tick, Lee: b.Shelter}
			open := physics.SeaWindow{Size: 1, Inputs: make([]physics.SeaInput, 1), Amp: make([]float64, physics.SeaComponents),
				Hs: make([]float64, 1), Peak: make([]float64, 1), Parts: make([]physics.SeaParts, 1)}
			physics.SeaArea(waves, &open, 0, waves.OpenSea(20*1852.0/3600, from))
			f := physics.SeaSample(&sea, nil, m[0], m[1]).Hs / open.Hs[0]
			factors = append(factors, math.Round(f*100)/100)
			if f < 0.25 {
				calm++
			}
			if f > 0.35 {
				t.Errorf("a mooring at (%.0f, %.0f) keeps %.2f of the open sea's waves from %.0f°", m[0], m[1], f, from*180/math.Pi)
			}
		}
		if calm < 13 {
			t.Errorf("a mooring at (%.0f, %.0f) is calmed under a quarter from %d of 16 directions: %v", m[0], m[1], calm, factors)
		}
		t.Logf("a mooring at (%.0f, %.0f): %v", m[0], m[1], factors)
	}
}
