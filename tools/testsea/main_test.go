// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"math"
	"reflect"
	"testing"
)

// The spectrum's whole height against the JONSWAP fetch law,
// Hs = 1.6·10⁻³ √(gF/U²) U²/g (CERC Shore Protection Manual, 1984). The
// spectrum's own fits for α and the peak come out about 20% above it, so the
// check allows 25%.
func TestSpectrumMatchesFetchLaw(t *testing.T) {
	for _, s := range states {
		u := s.WindKnots * knot
		f := s.FetchNM * nauticalMi
		want := 1.6e-3 * math.Sqrt(gravity*f/(u*u)) * u * u / gravity
		got := float64(Build(s).HsFull)
		if math.Abs(got-want) > 0.25*want {
			t.Errorf("%s: Hs %.3f m, fetch law %.3f m", s.Name, got, want)
		}
	}
}

// The drawn components carry the band's energy: their significant height,
// 4√(Σa²/2), is within 10% of the spectrum's over the band.
func TestComponentsCarryTheBand(t *testing.T) {
	for _, s := range states {
		f := Build(s)
		sum := 0.0
		for _, c := range f.Components {
			sum += float64(c.A) * float64(c.A) / 2
		}
		got := 4 * math.Sqrt(sum)
		want := float64(f.HsBand)
		if math.Abs(got-want) > 0.1*want {
			t.Errorf("%s: components' Hs %.4f m, band's %.4f m", s.Name, got, want)
		}
		if len(f.Components) != components {
			t.Errorf("%s: %d components", s.Name, len(f.Components))
		}
	}
}

func TestComponentsAreWaves(t *testing.T) {
	for _, s := range states {
		f := Build(s)
		kmax := 2 * math.Pi / shortest
		for i, c := range f.Components {
			n := math.Hypot(float64(c.East), float64(c.North))
			if math.Abs(n-1) > 1e-8 {
				t.Errorf("%s %d: direction of length %v", s.Name, i, n)
			}
			if c.K <= 0 || float64(c.K) > kmax*(1+1e-8) {
				t.Errorf("%s %d: k %v outside the band", s.Name, i, c.K)
			}
			if c.Phase < 0 || float64(c.Phase) >= 2*math.Pi {
				t.Errorf("%s %d: phase %v", s.Name, i, c.Phase)
			}
		}
	}
}

func TestSeeded(t *testing.T) {
	if !reflect.DeepEqual(Build(states[3]), Build(states[3])) {
		t.Fatal("two builds of the same sea state differ")
	}
}
