// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// seaOfHs is open water under the lightest wind, in whole knots, whose sea
// is at least hs high.
func seaOfHs(t testing.TB, hs float64) *ocean {
	t.Helper()
	for knots := 5.0; knots <= 60; knots++ {
		if sea := openSea(t, knots, 0, 6); sea.Window.Hs[0] >= hs {
			return sea
		}
	}
	t.Fatalf("no wind raises a sea of %g m", hs)
	return nil
}

func TestDepthFactor(t *testing.T) {
	w := testWaves(t)
	if w.breaking != 0.5 {
		t.Fatalf("breaking %v, want the catalog's 0.5", w.breaking)
	}
	const hs = 1.5
	for _, c := range []struct {
		depth float64 // m; negative is land
		want  float64
	}{
		{40, 1}, {4, 1}, {3, 1}, {2.9, 2.9 * 0.5 / hs}, {1, 1 * 0.5 / hs}, {0.5, 0.5 * 0.5 / hs}, {0, 0}, {-0.3, 0}, {-30, 0},
	} {
		g := testGround(func(x, y float64) float64 { return -c.depth })
		got := DepthFactor(w, g, 12.3, -45.6, hs)
		if math.Abs(got-c.want) > 1e-12 {
			t.Errorf("%g m of water under a sea of %g m: f = %v, want %v", c.depth, hs, got, c.want)
		}
		// Exactly 1, not nearly, wherever the depth carries the sea.
		if c.want == 1 && got != 1 {
			t.Errorf("%g m: f = %v, not exactly 1", c.depth, got)
		}
	}
	if f := DepthFactor(w, nil, 0, 0, hs); f != 1 {
		t.Errorf("no ground: f = %v", f)
	}
	// A chunk not held is deep water.
	if f := DepthFactor(w, testGround(func(x, y float64) float64 { return 2 }), 5000, 5000, hs); f != 1 {
		t.Errorf("a chunk not held: f = %v", f)
	}
	// No sea, nothing to cap.
	if f := DepthFactor(w, testGround(func(x, y float64) float64 { return 2 }), 0, 0, 0); f != 1 {
		t.Errorf("no sea: f = %v", f)
	}
}

// TestDeepGroundSeaUnchanged: the sea a hull reads over deep ground is the
// open sea's, bit for bit.
func TestDeepGroundSeaUnchanged(t *testing.T) {
	sea := openSea(t, 34, 0.4, 6)
	at := sea.at(7.4e8)
	deep := testGround(func(x, y float64) float64 { return -40 })
	for _, p := range [][2]float64{{0, 0}, {13.7, -250.1}, {-400, 77}} {
		if a, b := SeaSample(at, nil, p[0], p[1]), SeaSample(at, deep, p[0], p[1]); a != b {
			t.Errorf("at %v: %+v over deep ground, %+v in the open sea", p, b, a)
		}
		if a, b := WaveUnder(at, nil, 4, 1.4, p[0], p[1], 0.7), WaveUnder(at, deep, 4, 1.4, p[0], p[1], 0.7); a != b {
			t.Errorf("at %v: %+v over deep ground, %+v in the open sea", p, b, a)
		}
	}
	// And a step over it.
	b := jolly(t)
	s1 := State{Heading: math.Pi / 2, Surge: 3, SheetLimit: 0.6}
	s2 := s1
	c := Control{Sheet: 0.35}
	e := Env{WindSpeed: 7}
	var o1, o2 Out
	for i := range 300 {
		at := sea.at(7.4e8 + float64(i))
		Step(&s1, &c, &e, at, nil, b, &o1)
		Step(&s2, &c, &e, at, deep, b, &o2)
	}
	s2.GroundTimer = s1.GroundTimer
	if s1 != s2 {
		t.Errorf("after 300 steps over deep ground %+v, in the open sea %+v", s2, s1)
	}
}

// TestShallowsHeave: a boat lying in half a metre of water in a gale's sea
// heaves a sixth of what it would in deep water, and no more than 0.25 m.
func TestShallowsHeave(t *testing.T) {
	sea := seaOfHs(t, 1.5)
	b := jolly(t)
	heave := func(g *Ground) float64 {
		s := State{SheetLimit: 1.4}
		c := Control{Sheet: 1}
		e := Env{WindSpeed: 3}
		var o Out
		most := 0.0
		for i := range 1800 {
			Step(&s, &c, &e, sea.at(7.4e8+float64(i)), g, b, &o)
			// Held in place, so that it lies in the same water.
			s.X, s.Y, s.Surge, s.Sway = 0, 0, 0, 0
			if i > 300 {
				most = math.Max(most, math.Abs(s.Heave))
			}
		}
		return most
	}
	deep, shallow := heave(nil), heave(testGround(func(x, y float64) float64 { return -0.5 }))
	t.Logf("a sea of Hs %.2f m: heaves up to %.3f m in deep water, %.3f m in 0.5 m of it", sea.Window.Hs[0], deep, shallow)
	if shallow > 0.25 {
		t.Errorf("heaves %.3f m in half a metre of water, more than 0.25 m", shallow)
	}
	if !(shallow < deep/3) {
		t.Errorf("heaves %.3f m in the shallows, %.3f m in deep water", shallow, deep)
	}
}

// TestShoal sails the golden scenario shoal natively: a boat running before
// a fresh breeze's sea onto a beach, where the depth caps the waves under it
// from all of them to almost none.
func TestShoal(t *testing.T) {
	var sf scenarioFile
	readJSON(t, scenariosFile, &sf)
	var sc *scenario
	for i := range sf.Scenarios {
		if sf.Scenarios[i].Name == "shoal" {
			sc = &sf.Scenarios[i]
		}
	}
	if sc == nil {
		t.Fatal("no scenario shoal")
	}
	w := testWaves(t)
	sea, err := scenarioOcean(w, sc.Sea)
	if err != nil {
		t.Fatal(err)
	}
	g := testGround(beach)
	b := jolly(t)
	var s State
	var c Control
	var e Env
	if err := setFields(&s, sc.State); err != nil {
		t.Fatal(err)
	}
	if err := setFields(&c, sc.Control); err != nil {
		t.Fatal(err)
	}
	if err := setFields(&e, sc.Env); err != nil {
		t.Fatal(err)
	}
	var o Out
	first, least := -1.0, 1.0
	aground := false
	for i := range sc.Steps {
		at := sea.at(sc.Sea.Tick + float64(i))
		f := DepthFactor(w, g, s.X, s.Y, at.hsAt(s.X, s.Y))
		if first < 0 {
			first = f
		}
		least = math.Min(least, f)
		c.Helm = steer(math.Pi/2, &s)
		Step(&s, &c, &e, at, g, b, &o)
		aground = aground || o.Aground != Afloat
	}
	t.Logf("f from %.3f to %.3f; ended at x = %.1f", first, least, s.X)
	if first != 1 || !(least < 0.3) || !aground {
		t.Errorf("f from %v to %v, aground %v: want from 1 to under 0.3, aground", first, least, aground)
	}
}

func TestStepInShallowSeaAllocatesNothing(t *testing.T) {
	sea := seaOfHs(t, 1)
	at := sea.at(7.4e8)
	g := testGround(beach)
	b := jolly(t)
	s := State{X: 130, Heading: math.Pi / 2, Surge: 1, SheetLimit: 0.6}
	c := Control{Sheet: 0.35}
	e := Env{WindSpeed: 7}
	var o Out
	if n := testing.AllocsPerRun(100, func() { Step(&s, &c, &e, at, g, b, &o) }); n != 0 {
		t.Errorf("a step in a shallow sea allocates %v times", n)
	}
}

// BenchmarkStepShallowSea times a step in a fresh breeze's sea over deep
// ground and in the shallows, where the depth caps it.
func BenchmarkStepShallowSea(bm *testing.B) {
	b := jolly(bm)
	sea := openSea(bm, 20, 0, 6)
	at := sea.at(7.4e8)
	for _, c := range []struct {
		name string
		g    *Ground
		x    float64
	}{
		{"open", nil, 0},
		{"deep", testGround(func(x, y float64) float64 { return -40 }), 0},
		{"shallows", testGround(beach), 130},
	} {
		bm.Run(c.name, func(bm *testing.B) {
			ctl := Control{Sheet: 0.35}
			e := Env{WindSpeed: 7}
			var o Out
			for bm.Loop() {
				s := State{X: c.x, Heading: math.Pi / 2, Surge: 1, SheetLimit: 0.6}
				Step(&s, &ctl, &e, at, c.g, b, &o)
			}
		})
	}
}
