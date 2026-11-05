// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import "testing"

// TestLookOf: a machine sailor's look in words as the game writes any
// look's, its choices left out where the catalog has none of that id.
func TestLookOf(t *testing.T) {
	looks := MachineLooks{
		Versions: []LookOption{{ID: "female", Name: "female"}},
		Finishes: []LookOption{{ID: "brass", Name: "brass", Colour: "#d9a957"}},
		Colours:  []LookOption{{ID: "madder-red", Name: "madder red", Colour: "#9b2226"}},
	}
	l := looks.LookOf("female", "brass", "madder-red")
	if l.Words != "Machine, female, brass, madder red" || l.SRGB != "#9b2226" || l.Version != "female" || l.Finish != "brass" || l.Colour != "madder-red" {
		t.Errorf("look: %+v", l)
	}
	if w := looks.LookOf("female", "tin", "madder-red").Words; w != "Machine, female, madder red" {
		t.Errorf("a finish the catalog has not: %q", w)
	}
}
