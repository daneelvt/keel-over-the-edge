// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"encoding/json"
	"math"
	"os"
	"strconv"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// flushCase is a boat's flush from a ground as testdata/flushes.json holds
// it for the page's twin (client/src/life/flush.ts) to be held to: the
// ground, the ground's reach, the boat's id (a decimal string, as a uint64
// may not fit a JavaScript number), the flushes' slot, the bow and the
// tick, and the flush, if any.
type flushCase struct {
	Ground bus.LifeEncounter  `json:"ground"`
	Reach  float64            `json:"reach"`
	Boat   string             `json:"boat"`
	Slot   int64              `json:"slot"`
	Bow    Pose               `json:"bow"`
	Now    int64              `json:"now"`
	Flush  *bus.LifeEncounter `json:"flush,omitempty"`
}

type flushesFile struct {
	Comment string      `json:"comment"`
	Cases   []flushCase `json:"cases"`
}

// TestFlushGolden holds Flush and Patch to testdata/flushes.json, on
// every machine.
func TestFlushGolden(t *testing.T) {
	s := testSchedule(t, 42)
	k := &s.kinds[flusher(t, s)]
	var grounds []bus.LifeEncounter
	for _, e := range slots(s, 60000, 400, steady{wind: 6}) {
		if int(e.Kind) == k.Index && len(grounds) < 3 {
			grounds = append(grounds, e)
		}
	}
	if len(grounds) == 0 {
		t.Fatal("no ground of fish in 400 slots")
	}
	boats := []uint64{1, 7, 1<<40 | 7, 1<<63 | 5, math.MaxUint64}
	var cases []flushCase
	ok := 0
	for gi, g := range grounds {
		for bi, b := range boats {
			for n := range int64(4) {
				slot := FlushSlot(s.p, g.Start) + n + int64(bi)*13
				now := slot * s.p.FlushEvery
				h := float64(gi*5+bi)*1.3 - 2
				bow := Pose{X: g.East + float64(bi)*40 - 90, Y: g.North - float64(gi)*55 + 30, Heading: h}
				c := flushCase{Ground: g, Reach: Patch(k, g.Seed), Boat: strconv.FormatUint(b, 10), Slot: slot, Bow: bow, Now: now}
				if e, yes := Flush(s.p, k, &g, b, slot, bow, now); yes {
					c.Flush = &e
					ok++
				}
				cases = append(cases, c)
			}
		}
	}
	if ok == 0 || ok == len(cases) {
		t.Fatalf("%d of %d cases flush", ok, len(cases))
	}
	file := flushesFile{
		Comment: "Fish flushed from grounds by boats: written by go test ./internal/life -run Golden -update, read by client/src/life/flush.test.ts.",
		Cases:   cases,
	}
	const path = "testdata/flushes.json"
	if *update {
		b, err := json.MarshalIndent(file, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var want flushesFile
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want.Cases) != len(cases) {
		t.Fatalf("%d cases, the file %d", len(cases), len(want.Cases))
	}
	for i := range cases {
		a, b := cases[i], want.Cases[i]
		if a.Reach != b.Reach || (a.Flush == nil) != (b.Flush == nil) || a.Flush != nil && *a.Flush != *b.Flush {
			t.Errorf("case %d: %+v, the file %+v", i, a.Flush, b.Flush)
		}
	}
}
