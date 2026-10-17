// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

func edgeKit(t *testing.T) (*physics.Prepared, *physics.Waves, *catalog.Catalog) {
	t.Helper()
	if testing.Short() {
		t.Skip("sails the boat for minutes at many places")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	waves, kinds := cat.Prepare()
	return &kinds[0], waves, cat
}

// The lip can be clawed off in a breeze: from 8 knots up a Jolly boat gains
// from the lip itself in flat water, onto the lip and off it; in light air
// off it there is a line it cannot come back from, at most 450 m, as the
// flat water's measurements with the falls' draft at 4 knots have it.
func TestLineOfNoReturnInFlatWater(t *testing.T) {
	b, _, cat := edgeKit(t)
	prepared := cat.PrepareWeather()
	for _, k := range []float64{8, 12, 18} {
		w := steadyWorld(prepared, k)
		for _, onto := range []bool{true, false} {
			if line := w.lineOfNoReturn(b, onto); line != 1 {
				t.Errorf("%.0f knots, onto the lip %v: a line of no return at %v m", k, onto, line)
			}
		}
	}
	w := steadyWorld(prepared, 4)
	line := w.lineOfNoReturn(b, false)
	t.Logf("4 knots off the lip: the line of no return %v m", line)
	if !(line >= 100 && line <= 450) {
		t.Errorf("4 knots off the lip: the line of no return %v m", line)
	}
}

// With a spell's gusts and shifts, and the sea its wind raises over open
// water, a Jolly boat in a trade spell still gains from the lip itself.
func TestLineOfNoReturnInATrade(t *testing.T) {
	b, waves, cat := edgeKit(t)
	cases, err := edgeCases(b, waves, cat, 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Logf("%s, %.1f knots at the lip: onto %v m (flat %v), off %v m (flat %v), %.2f knots made good from 1 m onto",
			c.name, c.lipKnots, c.onto, c.flatOnto, c.off, c.flatOff, c.gainedOnto/knot)
		if c.name == "trade 1" && (c.onto != 1 || c.off != 1) {
			t.Errorf("%s: lines of no return onto %v m, off %v m", c.name, c.onto, c.off)
		}
		// The weather's line lies within 150 m of the flat water's.
		for _, pair := range [][2]float64{{c.onto, c.flatOnto}, {c.off, c.flatOff}} {
			if !math.IsInf(pair[0], 1) && !math.IsInf(pair[1], 1) && math.Abs(pair[0]-pair[1]) > 150 {
				t.Errorf("%s: the line %v m in the weather, %v m in flat water", c.name, pair[0], pair[1])
			}
		}
	}
}

// Capsized 150 m inside the lip in a breeze blowing onto it, a sailor who
// rights the boat, bears away for speed and hardens up is making ground
// within a minute, and does not go over.
func TestCapsizeNearTheLip(t *testing.T) {
	b, _, cat := edgeKit(t)
	prepared := cat.PrepareWeather()
	for _, k := range []float64{10, 16} {
		r := capsize(b, prepared, k, 150)
		t.Logf("%.0f knots: sailing after %.0f s, lost %.0f m, making ground after %.0f s, %.0f m inside after five minutes",
			k, r.sailing, r.lostToIt, r.leastAt, r.after)
		if r.over || r.leastAt > 60 || r.after < 150 {
			t.Errorf("%.0f knots: %+v", k, r)
		}
	}
}
