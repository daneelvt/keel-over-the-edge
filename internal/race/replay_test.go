// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"encoding/binary"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A track as a replay sends it: whole metres, the first sample where it
// was and each after its change, rounded where it was so that no error
// gathers along it.
func TestTrackOf(t *testing.T) {
	var b []byte
	b = binary.AppendUvarint(b, committee.TrackVersion)
	b = binary.AppendVarint(b, 600)
	b = binary.AppendUvarint(b, 60)
	// Decimetres: (10.4, −3.6), then +0.4 m east three times.
	for _, d := range [][4]int64{{104, -36, 0, 30}, {4, 0, 0, 0}, {4, 0, 0, 0}, {4, 0, 0, 0}} {
		for _, v := range d {
			b = binary.AppendVarint(b, v)
		}
	}
	tr := TrackOf(b)
	if tr == nil || tr.First != 600 || tr.Every != 60 {
		t.Fatalf("the track: %+v", tr)
	}
	// 10.4 → 10, 10.8 → 11, 11.2 → 11, 11.6 → 12.
	if want := []int32{10, -4, 1, 0, 0, 0, 1, 0}; !slices.Equal(tr.P, want) {
		t.Errorf("the samples %v, want %v", tr.P, want)
	}
	if TrackOf(nil) != nil || TrackOf([]byte{9}) != nil {
		t.Error("a track read from nothing")
	}
}

// A trial's runs: the home ones by time, then the rest; the best of each
// sailor's drawn unless others are asked for, at most a set of colours.
func TestTrialRuns(t *testing.T) {
	a, b, c := store.AccountID{1}, store.AccountID{2}, store.AccountID{3}
	run := func(n int, who store.AccountID, how string, secs float64) store.RaceRun {
		return store.RaceRun{Run: n, RaceResult: store.RaceResult{Account: who, How: how, Elapsed: secs}}
	}
	rs := trialRuns([]store.RaceRun{
		run(1, a, store.HowFinished, 300), run(2, b, store.HowRetired, -1), run(3, a, store.HowFinished, 250),
		run(4, c, store.HowFinished, 280), run(5, b, store.HowFinished, 400),
	}, a)
	var order []int
	for _, r := range rs {
		order = append(order, r.Run)
	}
	if !slices.Equal(order, []int{3, 4, 1, 5, 2}) {
		t.Fatalf("the runs in order: %v", order)
	}
	drawn := drawnRuns(KindTrial, rs, nil)
	if len(drawn) != 3 || !drawn[3] || !drawn[4] || !drawn[5] {
		t.Errorf("the best of each: %v", drawn)
	}
	if drawn := drawnRuns(KindTrial, rs, []int{1, 2, 99}); len(drawn) != 2 || !drawn[1] || !drawn[2] {
		t.Errorf("the runs asked for: %v", drawn)
	}
	if drawn := drawnRuns(KindRace, []store.RaceRun{run(0, a, store.HowFinished, 1)}, nil); !drawn[0] {
		t.Errorf("a race's run: %v", drawn)
	}
}
