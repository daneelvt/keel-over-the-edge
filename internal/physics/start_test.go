// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

// A boat's start sheet is good from rest for a sailor who touches
// nothing: started at rest at each angle off the wind it names, its helm
// centred, the boat makes at least 85% of what the best sheet makes 20 s
// after, in 3, 5 and 8 knots. Untouched, its weather helm rounds it up
// toward a close reach, so the best is tighter than the reach's own.
func TestStartSheet(t *testing.T) {
	data, err := os.ReadFile("../catalog/catalog.gen.json")
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		Boats []struct {
			StartSheet [][2]float64 `json:"startSheet"`
		} `json:"boats"`
	}
	if err := json.Unmarshal(data, &c); err != nil {
		t.Fatal(err)
	}
	if len(c.Boats) == 0 || len(c.Boats[0].StartSheet) == 0 {
		t.Fatal("the Jolly boat has no start sheet")
	}
	for _, e := range c.Boats[0].StartSheet {
		for _, knots := range []float64{3, 5, 8} {
			got := startFromRest(t, knots, e[0], e[1])
			most, bestSheet := 0.0, 0.0
			for sheet := 0.0; sheet <= 1+1e-9; sheet += 0.05 {
				if v := startFromRest(t, knots, e[0], sheet); v > most {
					most, bestSheet = v, sheet
				}
			}
			t.Logf("%.0f° off %.0f knots: the start sheet %.2f makes %.2f knots at 20 s, the best, %.2f, %.2f", e[0], knots, e[1], got, bestSheet, most)
			if got < 0.85*most {
				t.Errorf("%.0f° off %.0f knots: the start sheet %.2f makes %.2f knots at 20 s, under 85%% of the best's %.2f (%.2f)",
					e[0], knots, e[1], got, most, bestSheet)
			}
		}
	}
}

// startFromRest is the speed through the water, knots, of the Jolly boat
// 20 s after it starts at rest, off degrees off a wind of knots, its sheet
// at sheet and its helm centred.
func startFromRest(t *testing.T, knots, off, sheet float64) float64 {
	m := newSim(t, knots*knot, off, sheet)
	m.s.Surge = 0
	m.steer, m.c.Helm = false, 0
	m.run(20, nil)
	return math.Sqrt(m.s.Surge*m.s.Surge+m.s.Sway*m.s.Sway) / knot
}

// The sail says what it wants of its sheet as a sailor would, the course
// held: luffing with the sheet let out to half on a close reach, from rest
// or under way, and nothing once it is trimmed; stalled hauled in hard on
// a reach; nothing let fly on a run, where no easing helps, nor lying head
// to wind at rest.
func TestSailState(t *testing.T) {
	for _, c := range []struct {
		knots, off, sheet float64
		rest              bool
		want              float64
	}{
		{3, 66, 0.5, true, SailLuffing},
		{3, 66, 0.5, false, SailLuffing},
		{10, 60, 0.5, false, SailLuffing},
		{3, 66, 0.1, false, SailDrawing},
		{10, 90, 0.25, false, SailDrawing},
		{10, 130, 0.6, false, SailDrawing},
		{10, 130, 0, false, SailStalled},
		{6, 110, 0, false, SailStalled},
		{10, 175, 1, false, SailDrawing},
		{3, 5, 0.5, true, SailDrawing},
	} {
		m := newSim(t, c.knots*knot, c.off, c.sheet)
		if c.rest {
			m.s.Surge = 0
		}
		counts := map[float64]int{}
		m.run(20, func() {
			if m.time > 10 {
				counts[m.o.Sail]++
			}
		})
		if counts[c.want] < 240 {
			t.Errorf("%.0f knots %.0f° off, the sheet at %.2f (from rest %v): the sail says %v over the last 10 s, not %v mostly",
				c.knots, c.off, c.sheet, c.rest, counts, c.want)
		}
	}
}
