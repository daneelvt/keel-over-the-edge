// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// homeCourse is an island course from a port at (0, −1600): straight
// north 1,000 m to an island at (0, 0), round it to starboard, and home.
func homeCourse() Course {
	way := [][2]float64{{0, -1000}, {0, -300}, {300, -300}, {300, 300}, {-300, 300}, {-300, -300}, {0, -300}, {0, -1000}}
	c := Course{Number: 7, Way: way, Length: 3800, Home: true, Loop: true,
		Start: Site{X: 0, Y: -1000, Room: 160}, Finish: Site{X: 0, Y: -1000, Room: 160}}
	for i, b := range []float64{math.Pi / 4, 3 * math.Pi / 4, 5 * math.Pi / 4, 7 * math.Pi / 4} {
		c.Rays = append(c.Rays, Ray{X: 0, Y: 0, Bearing: b, Crossings: 1, Along: float64(900 + 600*i), Mark: 1})
	}
	return c
}

// TestAnIslandStartMovedOffTheWind: a race on a course whose way leaves
// straight up the wind is moved to a start near the port, a straight leg
// off the wind joining the way; the moves are tried in their order; how a
// move's first leg lies is worked out as the course moved to it would
// have it; a course that cannot be moved, or a trial, is laid as made,
// a race marked upwind.
func TestAnIslandStartMovedOffTheWind(t *testing.T) {
	c := homeCourse()
	open := func(x, y float64) bool { return math.Hypot(x, y) > 250 }
	s := &Stage{Courses: []Course{c}, Kinds: stage(t).Kinds}
	s.MoveStarts(Port{X: 0, Y: -1600, Within: 1852}, 60, open)
	mc := &s.Courses[0]
	if len(mc.Moves) == 0 || len(mc.BackMoves) == 0 {
		t.Fatalf("%d moves, %d back", len(mc.Moves), len(mc.BackMoves))
	}
	along := alongs(mc.Way)
	for w := range 16 {
		from := wrap(float64(w) * math.Pi / 8)
		for _, m := range mc.Moves {
			if moveUpwind(mc, along, m, from) != upwindStart(moved(mc, m), from) {
				t.Fatalf("a move to %+v in a wind from %.2f: worked out unlike the course moved", m, from)
			}
		}
	}
	// A wind straight down the way out, from the north.
	from := 0.0
	if !upwindStart(mc, from) {
		t.Fatal("the course as made does not start upwind")
	}
	laid := s.Lay(bus.NewFrame(4), &bus.RaceCall{Island: true, Course: 7}, 6, from, 4)
	if laid.Upwind || laid.Way[0] == mc.Way[0] {
		t.Errorf("laid upwind %v, from %v", laid.Upwind, laid.Way[0])
	}
	if off := offWind(from, laid.Way[0], laid.Way[1]); off < 70*math.Pi/180 {
		t.Errorf("the moved start's first leg %.0f° off the wind", off*180/math.Pi)
	}
	if d := math.Hypot(laid.Way[0][0], laid.Way[0][1]+1600); d > 1852 {
		t.Errorf("moved %.0f m from the port", d)
	}
	trial := s.Lay(bus.NewFrame(4), &bus.RaceCall{Island: true, Course: 7, Trial: true}, 6, from, 4)
	if trial.Upwind || trial.Way[0] != mc.Way[0] {
		t.Error("a trial's run moved")
	}
	// With nowhere to move to, laid as made, marked upwind.
	none := homeCourse()
	s = &Stage{Courses: []Course{none}, Kinds: s.Kinds}
	laid = s.Lay(bus.NewFrame(4), &bus.RaceCall{Island: true, Course: 7}, 6, from, 4)
	if !laid.Upwind || laid.Way[0] != none.Way[0] || !s.StartsUpwind(7, from) || s.StartsUpwind(7, math.Pi/2) {
		t.Errorf("unmoved: upwind %v from %v", laid.Upwind, laid.Way[0])
	}
}
