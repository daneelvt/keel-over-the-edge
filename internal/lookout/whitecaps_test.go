// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"encoding/json"
	"os"
	"testing"
)

const whitecapsFile = "testdata/whitecaps.json"

// TestWhitecapsFile holds Whitecaps to testdata/whitecaps.json, which the
// page's foamAt is held to too: from a calm to a gale by half knots.
func TestWhitecapsFile(t *testing.T) {
	type point struct {
		Knots     float64 `json:"knots"`
		Whitecaps float64 `json:"whitecaps"`
	}
	var got []point
	for k := 0.0; k <= 45; k += 0.5 {
		got = append(got, point{k, Whitecaps(k)})
	}
	if *update {
		data, err := json.MarshalIndent(got, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(whitecapsFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(whitecapsFile)
	if err != nil {
		t.Fatal(err)
	}
	var want []point
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) != len(got) {
		t.Fatalf("%d points, the file %d: rewrite it with -update", len(got), len(want))
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("%v knots: %v, the file %v", got[i].Knots, got[i].Whitecaps, want[i].Whitecaps)
		}
	}
	// Nothing in a breeze under force 3's beginning; whole in a gale.
	if Whitecaps(6) != 0 || Whitecaps(40) != 1 || !(Whitecaps(16) > 0.08 && Whitecaps(16) < 0.7) {
		t.Errorf("6 knots %v, 16 %v, 40 %v", Whitecaps(6), Whitecaps(16), Whitecaps(40))
	}
}
