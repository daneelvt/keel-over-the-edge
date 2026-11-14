// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

// openGrid is a way grid of open water everywhere, blocked within r of
// each centre given and beyond the disk.
func openGrid(r float64, centres ...[2]float64) *wayGrid {
	side := int32(2 * coarseHalf / coarseCell)
	w := &wayGrid{side: side, high: make([]int16, side*side), dist: make([]float64, side*side), blocked: make([]bool, side*side)}
	for i := range w.high {
		w.high[i] = -300
		w.dist[i] = math.Inf(1)
		x, y := w.centre(int32(i))
		for _, c := range centres {
			if d := hypot(x-c[0], y-c[1]); d < r {
				w.high[i], w.dist[i] = 20, 0
			}
		}
		w.blocked[i] = w.dist[i] == 0 || hypot(x, y) > 7000
	}
	// The distance from the land, near enough for the tests: to the
	// nearest centre, less r.
	for i := range w.dist {
		x, y := w.centre(int32(i))
		for _, c := range centres {
			w.dist[i] = min(w.dist[i], max(hypot(x-c[0], y-c[1])-r, 0))
		}
	}
	return w
}

// diagonalRays are the rays an island at (x, y) of radius r is judged by:
// out past its land toward the four corners.
func diagonalRays(x, y, r float64) []cutRay {
	var out []cutRay
	for _, b := range []float64{math.Pi / 4, 3 * math.Pi / 4, 5 * math.Pi / 4, 7 * math.Pi / 4} {
		s, c := sincos(b)
		out = append(out, cutRay{x: x + float64(r*s), y: y + float64(r*c), s: s, c: c})
	}
	return out
}

// The shortest way from a point back to it, crossing an island's cut once
// clockwise, goes round the island leaving it to starboard: every one of
// its rays crossed once clockwise, in turn; the other way round, every one
// anticlockwise. The way keeps clear of the land, and is the same each
// time it is found.
func TestWayRoundsAnIsland(t *testing.T) {
	w := openGrid(300, [2]float64{0, 0})
	for _, want := range []int8{1, -1} {
		cut := cutRay{x: 0, y: 0, s: 0, c: 1, want: want} // due north
		way := w.way(0, -1200, 0, -1200, []cutRay{cut}, [4]float64{-3000, -3000, 3000, 3000})
		if len(way) < 3 {
			t.Fatalf("want %d: no way round: %v", want, way)
		}
		if again := w.way(0, -1200, 0, -1200, []cutRay{cut}, [4]float64{-3000, -3000, 3000, 3000}); !slices.Equal(way, again) {
			t.Errorf("want %d: a second search found another way", want)
		}
		if l := wayLength(way); l < float64(2*math.Pi*300) || l > 6000 {
			t.Errorf("want %d: a way of %.0f m round an island 600 m across", want, l)
		}
		for i := 1; i < len(way); i++ {
			if !w.clearLine(way[i-1], way[i]) {
				t.Errorf("want %d: the way's leg %d crosses land", want, i)
			}
		}
		var alongs []float64
		rays := diagonalRays(0, 0, 200)
		for k := range rays {
			net, along := crossings(&rays[k], way)
			if net != int32(want) {
				t.Errorf("want %d: the ray toward %d crossed %d times on the whole", want, 45+90*k, net)
			}
			alongs = append(alongs, along)
		}
		// Clockwise from the south, the rays toward the south-west, the
		// north-west, the north-east and the south-east, in that order.
		order := []int{2, 3, 0, 1}
		if want < 0 {
			order = []int{1, 0, 3, 2}
		}
		for i := 1; i < len(order); i++ {
			if !(alongs[order[i]] > alongs[order[i-1]]) {
				t.Errorf("want %d: the rays crossed at %v m along, not in turn", want, alongs)
			}
		}
	}
}

// A way never passes land: none is found to a point walled off, and one
// between two islands goes between them only when the gap is clear.
func TestWayKeepsOffTheLand(t *testing.T) {
	w := openGrid(300, [2]float64{0, 0})
	// A point inside the island.
	if way := w.way(0, -1200, 0, 0, nil, [4]float64{-3000, -3000, 3000, 3000}); way != nil {
		t.Errorf("a way onto the land: %v", way)
	}
	// Two islands touching: a way from south to north goes round them.
	w = openGrid(300, [2]float64{-280, 0}, [2]float64{280, 0})
	way := w.way(0, -1500, 0, 1500, nil, [4]float64{-3000, -3000, 3000, 3000})
	if len(way) < 3 {
		t.Fatalf("no way round two islands: %v", way)
	}
	for i := 1; i < len(way); i++ {
		if !w.clearLine(way[i-1], way[i]) {
			t.Errorf("the way's leg %d crosses land", i)
		}
	}
	if wayLength(way) < 3200 {
		t.Errorf("a way of %.0f m between islands that touch", wayLength(way))
	}
}

// A ray is crossed clockwise about its start, or anticlockwise, or on the
// whole not at all by a way that crosses and comes back.
func TestCrossings(t *testing.T) {
	r := cutRay{x: 0, y: 100, s: 0, c: 1} // from (0, 100) due north
	for _, c := range []struct {
		way  [][2]float64
		want int32
	}{
		{[][2]float64{{-50, 500}, {50, 500}}, 1},             // west to east, north of the start: clockwise
		{[][2]float64{{50, 500}, {-50, 500}}, -1},            // the other way
		{[][2]float64{{-50, 50}, {50, 50}}, 0},               // south of its start
		{[][2]float64{{-50, 500}, {50, 500}, {-50, 600}}, 0}, // there and back
		{[][2]float64{{-50, 500}, {50, 500}, {50, 900}}, 1},  // once, then along it
		{[][2]float64{{-50, 200}, {50, 300}, {-50, 400}, {50, 500}}, 1},
	} {
		if got, _ := crossings(&r, c.way); got != c.want {
			t.Errorf("%v crosses %d times, want %d", c.way, got, c.want)
		}
	}
}

// A single straight leg is a beat in few of the sixteen winds; a way
// round an island in most. A boat sails the same way faster in more
// wind.
func TestLegTimes(t *testing.T) {
	cat := testCatalog(t)
	p := cat.Polar(0)
	if p == nil {
		t.Fatal("no polar for the first boat")
	}
	straight := [][2]float64{{0, 0}, {0, 3000}}
	_, beats := legTimes(p, 6, straight, 200)
	if beats > 6 {
		t.Errorf("a straight leg beats in %d winds of 16", beats)
	}
	loop := [][2]float64{{0, 0}, {1000, 1000}, {0, 2000}, {-1000, 1000}, {0, 0}}
	slow, beats := legTimes(p, 3, loop, 200)
	if beats < 12 {
		t.Errorf("a loop beats in %d winds of 16", beats)
	}
	if fast, _ := legTimes(p, 7, loop, 200); !(fast < slow) || !(fast > 0) {
		t.Errorf("the loop takes %.0f s in 3 m/s and %.0f s in 7", slow, fast)
	}
}

// A channel is as wide as the water between its shores, and a way along
// one shore with open water on its other side as wide as all the water a
// boat needs.
func TestNarrows(t *testing.T) {
	// Two islands 400 m apart, their coasts 400 − 2 × 150 = 100 m apart.
	w := openGrid(150, [2]float64{-200, 0}, [2]float64{200, 0})
	if got := w.width(0, 0, 0, 500); got < 64 || got > 140 {
		t.Errorf("the channel is %.0f m across, about 100 m", got)
	}
	if got := w.width(0, 1000, 0, 500); got != 500 {
		t.Errorf("open water is %.0f m across, want all 500 m", got)
	}
	if got := w.width(-200, 400, math.Pi/2, 500); got != 500 {
		t.Errorf("by one shore, %.0f m across, want all 500 m", got)
	}
}

// Seed 1's courses: its racing areas within the bound of Port Royal and
// clear of the start's fan, with room; its island courses on ways that
// keep clear of land and shoal water, every ray crossed, each boat offered
// a course of the right length, at most the beacons it may need, each a
// place that marks a reef or bar, and the names all different.
func TestCoursesOfSeedOne(t *testing.T) {
	c, b := wholeWorld(t)
	cc := &c.courses
	if len(b.Areas) < 1 {
		t.Fatal("no racing area")
	}
	port := b.made.islands[0]
	g := newWayGrid(b.Ground, c, b.Towns, decimetres(-(cc.deepest + cc.Depth)), decimetres(-(cc.deepestInAreas + cc.Depth)))
	for _, a := range b.Areas {
		if d := hypot(a.X-port.x, a.Y-port.y) + a.Radius; d > float64(cc.Areas.Within*nauticalMile)+0.1 {
			t.Errorf("area %d reaches %.0f m from Port Royal", a.Number, d)
		}
		for _, p := range b.Start.Places[:b.Start.Fan] {
			if hypot(p[0]-a.X, p[1]-a.Y) < a.Radius {
				t.Errorf("area %d holds a place of the start's fan", a.Number)
			}
		}
		if !(a.Depth > cc.deepestInAreas) {
			t.Errorf("area %d is %.1f m deep at least", a.Number, a.Depth)
		}
	}
	if len(b.Courses) < 3 {
		t.Fatalf("%d island courses", len(b.Courses))
	}
	beacon := c.kinds[catalog.SiteBeacon]
	places := map[int32]*Place{}
	for i := range b.Places {
		// Every place has a number of its own, after the islands' and the
		// groups': the beacons too.
		p := &b.Places[i]
		if n := p.Number; places[n] != nil || int(n) < len(b.Islands)+len(b.Groups) {
			t.Errorf("place %d (%s) shares its number", n, p.Name)
		}
		places[p.Number] = p
	}
	names := map[string]bool{}
	for _, co := range b.Courses {
		if names[co.Name] {
			t.Errorf("two courses named %q", co.Name)
		}
		names[co.Name] = true
		for i := 1; i < len(co.Way); i++ {
			if !g.clearLine(co.Way[i-1], co.Way[i]) {
				t.Errorf("%s: leg %d crosses land or shoal water", co.Name, i)
			}
		}
		if len(co.Rays) == 0 {
			t.Errorf("%s: no rays", co.Name)
		}
		for _, r := range co.Rays {
			if r.Crossings == 0 {
				t.Errorf("%s: a ray its way never crosses", co.Name)
			}
		}
		if len(co.Beacons) > cc.Beacons {
			t.Errorf("%s: %d beacons", co.Name, len(co.Beacons))
		}
		for _, n := range co.Beacons {
			p := places[n]
			if p == nil || p.Kind != beacon || places[p.Details.Marks] == nil {
				t.Errorf("%s: beacon %d is not a place that marks one", co.Name, n)
			}
		}
		if len(co.Boats) == 0 {
			t.Errorf("%s: offered to no boat", co.Name)
		}
		for _, bt := range co.Boats {
			if m := bt.Expected / 60; m < cc.Minutes[0] || m > cc.Minutes[1] {
				t.Errorf("%s: %s expected in %.0f minutes", co.Name, bt.Boat, m)
			}
		}
		if len(co.Islands)+len(co.Places) == 0 {
			t.Errorf("%s: nothing to chart to open it", co.Name)
		}
	}
}

// The typical wind rises from the centre to the rim as the weather's does,
// and every boat has a polar to size courses by.
func TestCourseConfig(t *testing.T) {
	c := testConfig(t)
	cc := &c.courses
	if !(cc.windAt(0) < cc.windAt(4000)) || !(cc.windAt(0) > 2) {
		t.Errorf("the typical wind %v m/s at the centre, %v m/s 4 km out", cc.windAt(0), cc.windAt(4000))
	}
	for _, b := range cc.boats {
		if b.polar == nil || !(b.draught > 0) || !(b.length > 0) {
			t.Errorf("%s: polar %v, draught %v m, length %v m", b.id, b.polar != nil, b.draught, b.length)
		}
	}
	if !(cc.deepest >= cc.deepestInAreas) || !(cc.deepestInAreas > 0) {
		t.Errorf("the deepest boat %v m, in the areas %v m", cc.deepest, cc.deepestInAreas)
	}
}
