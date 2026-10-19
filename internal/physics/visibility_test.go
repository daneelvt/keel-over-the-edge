// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

// visibilityFile holds the visual range at radii across the disk, which the
// page's rule is held to (client/src/edge/mist.test.ts).
const visibilityFile = "testdata/visibility.json"

type visibilityGolden struct {
	Comment    string     `json:"comment"`
	Visibility Visibility `json:"visibility"`
	Radii      []float64  `json:"radii"`
	Ranges     []float64  `json:"ranges"`
}

// testVisibility is the catalog's band: from 4.2 nautical miles to the lip,
// a lip of 300 m in clear air of 4.5 nautical miles.
var testVisibility = Visibility{Band: 4.2 * 1852, Lip: 8334, Clear: 4.5 * 1852, Range: 300}

// TestVisualRangeAt: the clear air's inside the band, the lip's at the lip
// and beyond, falling across the band.
func TestVisualRangeAt(t *testing.T) {
	v := &testVisibility
	if got := VisualRangeAt(v, 0); math.Abs(got-v.Clear) > 1e-9 {
		t.Errorf("at the centre %v, want the clear air's %v", got, v.Clear)
	}
	if got := VisualRangeAt(v, v.Band); math.Abs(got-v.Clear) > 1e-9 {
		t.Errorf("at the band's inner edge %v, want the clear air's %v", got, v.Clear)
	}
	for _, r := range []float64{v.Lip, v.Lip + 400} {
		if got := VisualRangeAt(v, r); math.Abs(got-300) > 1e-9 {
			t.Errorf("at %v m %v, want the lip's 300 m", r, got)
		}
	}
	last := math.Inf(1)
	for r := v.Band; r <= v.Lip; r += 10 {
		got := VisualRangeAt(v, r)
		if got > last {
			t.Fatalf("at %v m %v, more than %v nearer the centre", r, got, last)
		}
		last = got
	}
	if n := testing.AllocsPerRun(100, func() { VisualRangeAt(v, 8000) }); n != 0 {
		t.Errorf("%v allocations", n)
	}
}

// TestVisibilityGolden holds the rule to testdata/visibility.json at 200
// radii, which the page's test reads:
//
//	go test ./internal/physics -run VisibilityGolden -update
func TestVisibilityGolden(t *testing.T) {
	g := visibilityGolden{
		Comment:    "Written by go test ./internal/physics -run VisibilityGolden -update: the mist band's visual range, m, at each radius, m.",
		Visibility: testVisibility,
	}
	for i := range 200 {
		r := float64(i) * 45
		g.Radii = append(g.Radii, r)
		g.Ranges = append(g.Ranges, VisualRangeAt(&g.Visibility, r))
	}
	if *update {
		b, err := json.MarshalIndent(g, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(visibilityFile, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(visibilityFile)
	if err != nil {
		t.Fatal(err)
	}
	var want visibilityGolden
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want.Ranges) != len(g.Ranges) || want.Visibility != g.Visibility {
		t.Fatalf("%s is for other radii: write it again with -update", visibilityFile)
	}
	for i := range g.Ranges {
		if math.Abs(want.Ranges[i]-g.Ranges[i]) > 0.01 {
			t.Errorf("at %v m %v, the file has %v", g.Radii[i], g.Ranges[i], want.Ranges[i])
		}
	}
}
