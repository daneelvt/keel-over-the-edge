// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// flockCase is a group's record, a boat's pose and the places of its
// middle at ticks, as testdata/flocks.json holds them for the page's twin
// (client/src/life/flock.ts) to be held to.
type flockCase struct {
	Record bus.LifeEncounter `json:"record"`
	Pose   *Pose             `json:"pose,omitempty"`
	At     []flockAt         `json:"at"`
}

type flockAt struct {
	Tick  float64 `json:"tick"`
	Alive bool    `json:"alive"`
	X     float64 `json:"x,omitempty"`
	Y     float64 `json:"y,omitempty"`
	Z     float64 `json:"z,omitempty"`
}

type flocksFile struct {
	Comment string      `json:"comment"`
	Cases   []flockCase `json:"cases"`
}

// TestFlocks holds FlockAt to testdata/flocks.json, and checks that each
// group comes in from its range and goes out to it.
func TestFlocks(t *testing.T) {
	s := testSchedule(t, 42)
	enc := slots(s, 60000, 400, steady{wind: 6})
	seen := map[uint16]int{}
	var cases []flockCase
	for _, e := range enc {
		if seen[e.Kind] >= 2 {
			continue
		}
		seen[e.Kind]++
		cases = append(cases, flockCase{Record: e})
	}
	// One with a boat, in a frame of its own.
	k := follower(t, s)
	w := NewWorld(s, 4)
	f := sailing(900_000, harbourAt[0], harbourAt[1], 3)
	sail(w, f, 30*15)
	w.Raise(f, k, f.State[0].X+100, f.State[0].Y+50)
	bound := f.Life[len(f.Life)-1]
	st := &f.State[0]
	cases = append(cases, flockCase{Record: bound, Pose: &Pose{X: st.X, Y: st.Y, Heading: st.Heading}})
	// One riding a bow, at the boat itself.
	w.Raise(f, rider(t, s), f.State[0].X+100, f.State[0].Y-80)
	ride := *raised(f)
	if ride.Boat == 0 {
		t.Fatal("the pod took no boat")
	}
	cases = append(cases, flockCase{Record: ride, Pose: &Pose{X: st.X, Y: st.Y, Heading: st.Heading}})
	// Of each path, one that drifts and one that comes with another.
	var drift, over bool
	for _, c := range cases {
		drift = drift || s.kinds[c.Record.Kind].PathOf(&c.Record) == PathDrift
		over = over || c.Record.Over != 0
	}
	if !drift || !over {
		t.Fatalf("the cases hold one that drifts %v, one that comes with another %v", drift, over)
	}

	for i := range cases {
		c := &cases[i]
		e := &c.Record
		kind := &s.kinds[e.Kind]
		life := float64(e.End - e.Start)
		for _, share := range []float64{-0.01, 0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999, 1} {
			tick := float64(e.Start) + math.Floor(life*share)
			x, y, z, ok := FlockAt(e, kind, tick, c.Pose)
			c.At = append(c.At, flockAt{Tick: tick, Alive: ok, X: x, Y: y, Z: z})
		}
		// In from its range and out to it.
		ref := [2]float64{e.East, e.North}
		if c.Pose != nil {
			ref = [2]float64{c.Pose.X, c.Pose.Y}
		}
		// A kind that comes from nowhere far (a drifting boil, a ground of
		// fish) is under the water or nothing until it is near.
		far := math.Min(600, 0.9*kind.Range)
		if kind.PathOf(e) == PathDrift || !(far > 0) {
			continue
		}
		for _, tick := range []float64{float64(e.Start), float64(e.End - 1)} {
			x, y, _, _ := FlockAt(e, kind, tick, c.Pose)
			if d := math.Hypot(x-ref[0], y-ref[1]); d < far {
				t.Errorf("%s at tick %.0f of %d–%d is %.0f m from where it is met", kind.Name, tick, e.Start, e.End, d)
			}
		}
	}
	file := flocksFile{
		Comment: "Groups of the sea's life and where each one's middle is at ticks: written by go test ./internal/life -run Flocks -update, read by client/src/life/flock.test.ts.",
		Cases:   cases,
	}
	const path = "testdata/flocks.json"
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
	var want flocksFile
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want.Cases) != len(cases) {
		t.Fatalf("%d cases, the file %d", len(cases), len(want.Cases))
	}
	for i := range cases {
		for j, a := range cases[i].At {
			b := want.Cases[i].At[j]
			if a.Alive != b.Alive || math.Abs(a.X-b.X) > 1e-6 || math.Abs(a.Y-b.Y) > 1e-6 || math.Abs(a.Z-b.Z) > 1e-6 {
				t.Errorf("case %d at %.0f: %+v, the file %+v", i, a.Tick, a, b)
			}
		}
	}
	_ = physics.StepsPerSecond
}
