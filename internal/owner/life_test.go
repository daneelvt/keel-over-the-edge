// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
)

// TestLifeNow: the page marks each group of the sea's life alive where its
// middle is, a group with a boat at that boat, and none it is not alive.
func TestLifeNow(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	p, kinds := life.Prepare(cat)
	s := life.NewSchedule(&life.Config{Params: p, Kinds: kinds, Habitat: life.NewHabitat(p, nil, life.Places{}, 8334), Seed: 1})
	b := &builder{cfg: &Config{SeaLife: s}, tick: 1000}
	b.life = []bus.LifeEncounter{
		{ID: 1, Kind: 0, Start: 0, End: 2000, East: 100, North: 200, Speed: 10, Count: 3, Slot: -1},
		{ID: 2, Kind: 0, Start: 0, End: 2000, East: 500, North: 500, Heading: 0, Speed: 10, Count: 2, Boat: 7, Slot: 0},
		{ID: 3, Kind: 0, Start: 1500, End: 2000, Slot: -1},
	}
	got := b.lifeNow()
	if len(got) != 2 || got[0].Count != 3 || got[0].Kind != kinds[0].Name || got[1].Boat != 7 {
		t.Fatalf("marked %+v", got)
	}
	if got[1].North > 500 || got[1].North < 400 {
		t.Errorf("a group with a boat heading north is at %v, not astern of it", got[1].North)
	}
	if (&builder{cfg: &Config{}}).lifeNow() == nil {
		t.Error("no life is an empty list, not null")
	}
}
