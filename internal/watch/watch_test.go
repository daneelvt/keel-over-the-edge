// SPDX-License-Identifier: AGPL-3.0-only

package watch

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// TestAllowed is the rule, for every kind of target and viewer. The
// viewer's own machine sailor may be watched whenever it is in the water,
// unseen or not.
func TestAllowed(t *testing.T) {
	viewer := store.AccountID{1}
	other := store.AccountID{2}
	human := Target{ID: store.AccountID{3}, Kind: store.Human, Name: "Ann"}
	machine := Target{ID: store.AccountID{4}, Kind: store.AI, Owner: other, Name: "Iron Mary"}
	mine := machine
	mine.Owner = viewer
	stopped := machine
	stopped.Stopped = true
	self := Target{ID: viewer, Kind: store.Human}
	at := Boat{InWater: true}
	unseen := Boat{InWater: true, Unseen: true}
	voyage := Boat{InWater: true, Voyage: true}
	voyageUnseen := Boat{InWater: true, Voyage: true, Unseen: true}
	stoppedHuman := human
	stoppedHuman.Stopped = true
	for _, tc := range []struct {
		name string
		t    Target
		b    Boat
		want Verdict
	}{
		{"a machine sailor at sea", machine, at, Yes},
		{"a machine sailor not at sea", machine, Boat{}, NotAtSea},
		{"a machine sailor unseen", machine, unseen, Cannot},
		{"a machine sailor stopped", stopped, at, NotAtSea},
		{"a human allowing for the voyage", human, voyage, Yes},
		{"a human not allowing", human, at, Cannot},
		{"a human not at sea", human, Boat{}, Cannot},
		{"a human allowing, unseen", human, voyageUnseen, Cannot},
		{"a human allowing, stopped", stoppedHuman, voyage, Cannot},
		{"the own boat", self, at, Own},
		{"the own boat, not at sea", self, Boat{}, Own},
		{"the own machine sailor", mine, at, Yes},
		{"the own machine sailor, unseen", mine, unseen, Yes},
		{"the own machine sailor, not at sea", mine, Boat{}, NotAtSea},
	} {
		if got := Allowed(tc.t, tc.b, viewer); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
}
