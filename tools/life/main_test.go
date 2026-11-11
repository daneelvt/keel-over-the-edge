// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"io"
	"math"
	"math/rand/v2"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// steadyAir is a fixed weather: a breeze, no rain, and clear air.
type steadyAir struct{}

func (steadyAir) Weather(x, y float64) (wind, rain float64) { return 6, 0 }
func (steadyAir) Visibility(x, y float64) float64           { return math.Inf(1) }

// openSea is the catalog's life over open sea with the sun always up, a
// town and a colony to bring the harbours' and the colonies' kinds, in a
// steady weather.
func openSea(t *testing.T) *sea {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	p, kinds := life.Prepare(cat)
	const disk = 8334
	h := life.NewHabitat(p, nil, life.Places{Towns: [][2]float64{{0, -40}}, Colonies: [][2]float64{{2000, 2000}}}, disk)
	return &sea{
		sched: life.NewSchedule(&life.Config{Params: p, Kinds: kinds, Habitat: h, Seed: 5}),
		air:   func(int64) air { return steadyAir{} },
		chart: newChart(nil, disk),
		week:  7 * 24 * 3600 * physics.StepsPerSecond,
		seed:  5,
	}
}

// TestTallyOpenSea: routes sailed over open sea in daylight meet the sea's
// life, keep within the routes' reach, and count it.
func TestTallyOpenSea(t *testing.T) {
	s := openSea(t)
	o := options{Routes: 4, Hours: 3, Step: 5}
	got := s.tally(o)
	if got.routes != o.Routes {
		t.Fatalf("%d routes sailed, want %d", got.routes, o.Routes)
	}
	if h := got.hours[byDay][everywhere]; math.Abs(h-float64(o.Routes)*o.Hours) > 0.01 {
		t.Errorf("%.2f h sailed by day under a sun always up, want %g", h, float64(o.Routes)*o.Hours)
	}
	if got.groups[byDay][everywhere] == 0 {
		t.Error("twelve hours sailed and nothing came in sight")
	}
	if got.passing[byDay][everywhere] == 0 {
		t.Error("no bird passed")
	}
	if got.hours[byDay][outerWater] == 0 || got.hours[byDay][nearIslands] != 0 {
		t.Errorf("over open sea, %.2f h in the outer water and %.2f h near islands", got.hours[byDay][outerWater], got.hours[byDay][nearIslands])
	}
	if len(got.gaps) == 0 || len(got.empty) == 0 {
		t.Errorf("%d gaps and %d empty stretches", len(got.gaps), len(got.empty))
	}
	var b strings.Builder
	got.worlds = 1
	got.write(&b, o, true)
	for _, want := range []string{"Birds passing", "Birds working the water", "| Hours sailed |"} {
		if !strings.Contains(b.String(), want) {
			t.Errorf("the table has no %q:\n%s", want, b.String())
		}
	}
}

// TestRoutesKeepToOpenWater: a route turns away from the shallows and
// keeps within the routes' reach of the centre.
func TestRoutesKeepToOpenWater(t *testing.T) {
	s := openSea(t)
	rng := rand.New(rand.NewPCG(1, 2))
	x, y, h := 0.0, within-200, 0.0
	for range 20_000 {
		h = s.steer(x, y, h, rng)
		sin, cos := math.Sincos(h)
		x, y = x+speed*5*sin, y+speed*5*cos
		if r := math.Hypot(x, y); r > within {
			t.Fatalf("the route ran out to %.0f m from the centre", r)
		}
	}
}

// TestGaps: the gaps run from one group coming in sight to the next, the
// empty stretches while none is in sight, and the night cuts both.
func TestGaps(t *testing.T) {
	tl := newTally(nil)
	g := gapper{t: tl}
	step := int64(physics.StepsPerSecond * 60)
	// Minute by minute: a group at 0, nothing until 10, a group at 10 and
	// 11, nothing until night at 30, and a group at dawn, 40, alone until
	// the route ends at 81.
	for m := int64(0); m <= 80; m++ {
		day := m < 30 || m >= 40
		something := m == 0 || m == 10 || m == 11 || m == 40
		fresh := m == 0 || m == 10 || m == 11 || m == 40
		g.at(m*step, day, something, fresh, 60)
	}
	g.end(81 * step)
	if want := []float64{600, 60}; !equal(tl.gaps, want) {
		t.Errorf("gaps %v, want %v", tl.gaps, want)
	}
	if want := []float64{540, 1080, 2400}; !equal(tl.empty, want) {
		t.Errorf("empty stretches %v, want %v", tl.empty, want)
	}
	if want := []float64{2400}; !equal(tl.longest, want) {
		t.Errorf("the longest %v, want %v", tl.longest, want)
	}
}

// equal says whether two lists of seconds are the same.
func equal(a, b []float64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestTallyAWorld: a world of a seed is made, sailed and tallied.
func TestTallyAWorld(t *testing.T) {
	if testing.Short() {
		t.Skip("making a world takes seconds")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	got, err := tallyWorlds(cat, options{Seeds: 1, From: 1, Routes: 4, Hours: 6, Step: 10, Workers: 1}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if got.worlds != 1 || got.routes != 4 {
		t.Fatalf("%d worlds and %d routes", got.worlds, got.routes)
	}
	if got.hours[allHours][everywhere] < 23.9 || got.hours[byDay][everywhere] == 0 {
		t.Errorf("%.1f h sailed, %.1f by day", got.hours[allHours][everywhere], got.hours[byDay][everywhere])
	}
	if got.hours[byDay][nearIslands] == 0 {
		t.Error("no hour sailed near the islands")
	}
	if got.groups[byDay][everywhere] == 0 {
		t.Error("nothing came in sight")
	}
}
