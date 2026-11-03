// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// TestForget: an account deleted keeps its credits' places on the chart,
// read as a former sailor's; the chart published before is left as it was;
// a sailor of the server's own reads "a sailor".
func TestForget(t *testing.T) {
	b, cat := world1(t)
	m := NewModel(Build(b, cat), cat, nil)
	ann, mary := [16]byte{1}, [16]byte{2}
	m.Add([]store.Charting{
		{Subject: "island", Number: 0, Credited: true, Account: ann, Boat: 1, Sailor: "Ann Bonny", AccountKind: "human"},
		{Subject: "island", Number: 1, Credited: true, Account: mary, Boat: 2, Sailor: "Mary Read", AccountKind: "human"},
		{Subject: "island", Number: 2, Credited: true, Account: [16]byte{3}, Boat: 3},
		{Subject: "island", Number: 3},
	})
	before := m.Load()
	m.Forget(ann)
	after := m.Load()
	by := func(c *Chart) []string {
		out := make([]string, len(c.Entries))
		for i, e := range c.Entries {
			out[i] = e.By
		}
		return out
	}
	if got := by(after); len(got) != 4 || got[0] != "a former sailor" || got[1] != "Mary Read" || got[2] != "a sailor" || got[3] != "" {
		t.Fatalf("after: %q", got)
	}
	if got := by(before); got[0] != "Ann Bonny" || before.Rows[0].Sailor != "Ann Bonny" {
		t.Fatalf("the chart published before changed: %q", got)
	}
	if after.Rows[0].Sailor != "" || after.Rows[0].Account != ann {
		t.Fatalf("the row: %+v", after.Rows[0])
	}
	m.Forget([16]byte{9})
	if m.Load() != after {
		t.Fatal("published again for an account with no credits")
	}
}

// TestNewsNamesAChartedIsland: the news of a light charted names its
// island only once the island is charted; before, it is uncharted land.
func TestNewsNamesAChartedIsland(t *testing.T) {
	b, cat := world1(t)
	w := Build(b, cat)
	m := NewModel(w, cat, nil)
	light := int32(-1)
	for i, s := range w.Subjects {
		if s.Light >= 0 && s.Island >= 0 && w.Subjects[s.Island].Name != "" {
			light = int32(i)
			break
		}
	}
	if light < 0 {
		t.Fatal("no lighthouse on a named island")
	}
	island := &w.Subjects[w.Subjects[light].Island]
	news := func() string {
		return m.Charting(&bus.Charted{Subject: light, Slot: 0, Boat: 1, With: -1}).News.What
	}
	if got := news(); !strings.HasSuffix(got, " on uncharted land") || strings.Contains(got, island.Name) {
		t.Errorf("before its island is charted: %q", got)
	}
	m.Add([]store.Charting{{Subject: KindWord(island.Kind), Number: island.Number}})
	if got := news(); !strings.HasSuffix(got, " on "+island.Name) {
		t.Errorf("after its island is charted: %q, want it on %s", got, island.Name)
	}
}
