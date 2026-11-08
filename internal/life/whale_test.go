// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// whaleCase is a group of whales and each of its first whales' events over
// its life, as testdata/whales.json holds them for the page's twin
// (client/src/life/whale.ts) to be held to.
type whaleCase struct {
	Record bus.LifeEncounter `json:"record"`
	Whales [][]whaleEvent    `json:"whales"`
}

type whaleEvent struct {
	Event int     `json:"event"`
	At    float64 `json:"at"`
}

type whalesFile struct {
	Comment string      `json:"comment"`
	Cases   []whaleCase `json:"cases"`
}

// whaleKinds are the indices of the kinds that are whales.
func whaleKinds(s *Schedule) []int {
	var out []int
	for i := range s.kinds {
		if s.kinds[i].Form == catalog.LifeFormWhale {
			out = append(out, i)
		}
	}
	return out
}

// TestWhales holds WhaleEvents to testdata/whales.json, and checks each
// whale's round: blows its kind's blowEvery apart within a bout, none
// before its group is met or after, a sperm whale's one bout ending in a
// dive with its flukes raised, and breaches and slaps now and then.
func TestWhales(t *testing.T) {
	s := testSchedule(t, 5)
	kinds := whaleKinds(s)
	if len(kinds) == 0 {
		t.Fatal("no whales in the catalog")
	}
	var cases []whaleCase
	breaches, slaps := 0, 0
	for _, ki := range kinds {
		k := &s.kinds[ki]
		for n := range 4 {
			seed := hash32(uint32(1000*ki + n))
			e := bus.LifeEncounter{Kind: uint16(ki), Seed: seed, Count: uint16(k.GroupHigh), Start: 900_000, Speed: float32Of(k.SpeedLow)}
			e.End = e.Start + lifeTicks(k.FreeLife(e.Speed, Stay(k, seed)))
			life := float64(e.End-e.Start) / physics.StepsPerSecond
			c := whaleCase{Record: e}
			for i := range min(int(e.Count), 3) {
				var evs []whaleEvent
				WhaleEvents(k, &e, i, 0, life, func(ev int, at float64) {
					evs = append(evs, whaleEvent{Event: ev, At: at})
				})
				var last float64 = -1
				for _, ev := range evs {
					if ev.At < 0 || ev.At >= life {
						t.Errorf("%s %d: an event at %.1f s of a life of %.1f", k.Name, i, ev.At, life)
					}
					switch ev.Event {
					case WhaleBlow:
						if gap := ev.At - last; last >= 0 && gap < k.Swim.BlowEvery[0]-1e-9 {
							t.Errorf("%s %d: blows %.1f s apart", k.Name, i, gap)
						}
						last = ev.At
					case WhaleFluke:
						last = -1
					case WhaleBreach:
						breaches++
					case WhaleSlap:
						slaps++
					}
				}
				if len(evs) == 0 && life > 600 {
					t.Errorf("%s %d: no blow in %.0f s", k.Name, i, life)
				}
				if k.Path == PathDrift {
					if len(evs) < 2 || evs[len(evs)-1].Event != WhaleFluke {
						t.Errorf("%s %d: its bout does not end fluking up: %v", k.Name, i, evs)
					}
				}
				c.Whales = append(c.Whales, evs)
			}
			cases = append(cases, c)
		}
	}
	if breaches == 0 || slaps == 0 {
		t.Errorf("%d breaches and %d slaps in every whale's life", breaches, slaps)
	}
	file := whalesFile{
		Comment: "Groups of whales and the events of each of the first whales' rounds, s into the group's life: written by go test ./internal/life -run Whales -update, read by client/src/life/whale.test.ts.",
		Cases:   cases,
	}
	const path = "testdata/whales.json"
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
	var want whalesFile
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want.Cases) != len(cases) {
		t.Fatalf("%d cases, the file %d", len(cases), len(want.Cases))
	}
	for i := range cases {
		for w := range cases[i].Whales {
			got, exp := cases[i].Whales[w], want.Cases[i].Whales[w]
			if len(got) != len(exp) {
				t.Errorf("case %d whale %d: %d events, the file %d", i, w, len(got), len(exp))
				continue
			}
			for j := range got {
				if got[j].Event != exp[j].Event || math.Abs(got[j].At-exp[j].At) > 1e-9 {
					t.Errorf("case %d whale %d event %d: %+v, the file %+v", i, w, j, got[j], exp[j])
				}
			}
		}
	}
}

// float32Of is a speed as the wire carries it.
func float32Of(v float64) float64 { return float64(float32(v)) }
