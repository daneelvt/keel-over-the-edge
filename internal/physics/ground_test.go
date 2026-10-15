// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// The ground's tests sail the Jolly boat over made terrain about the
// world's centre: four chunks round it, each hexagon's elevation from a
// function of its centre.

// testGroundParams are the catalog's starting values for grounding.
var testGroundParams = GroundParams{
	Friction:     [GroundSurfaces]float64{0.4, 0.5, 0.5, 0.5, 0.6, 0.45, 0.5, 0.5},
	StillSpeed:   0.2,
	StillTime:    5,
	PushDepth:    1,
	PushReach:    40,
	Restitution:  0.3,
	LandFriction: 0.2,
}

// testGround is ground whose elevation at each hexagon's centre is
// elevation(x, y), in m, over the four chunks about the centre.
func testGround(elevation func(x, y float64) float64) *Ground {
	g := &Ground{Prepared: new(GroundPrepared)}
	PrepareGround(&testGroundParams, g.Prepared)
	for _, n := range []int32{7*ChunkSide + 7, 7*ChunkSide + 8, 8*ChunkSide + 7, 8*ChunkSide + 8} {
		ch := new(GroundChunk)
		c0, j0 := ChunkCorner(n)
		for i := range int32(ChunkHexes) {
			x, y := CellCentre(c0+i/ChunkRows, j0+i%ChunkRows)
			e := math.Round(elevation(x, y) * 10)
			ch.Elevation[i] = int16(max(min(e, 800), DeepWater))
		}
		g.Chunks[n] = ch
	}
	return g
}

// sailOver steps a boat n times in a steady wind over g, calling each with the
// step's number, the state and Out after it.
func sailOver(t testing.TB, g *Ground, s *State, c *Control, e *Env, n int, each func(i int, s *State, o *Out)) {
	t.Helper()
	b := jolly(t)
	var o Out
	for i := range n {
		Step(s, c, e, nil, g, b, &o)
		if each != nil {
			each(i, s, &o)
		}
	}
}

func TestDeepGroundIsOpenSea(t *testing.T) {
	deep := testGround(func(x, y float64) float64 { return -40 })
	b := jolly(t)
	s1 := State{Heading: 1, Surge: 2, SheetLimit: 0.5}
	s2 := s1
	c := Control{Helm: 0.2, Sheet: 0.4}
	e := Env{WindSpeed: 7, WindFrom: 0.3}
	var o1, o2 Out
	for i := range 3000 {
		Step(&s1, &c, &e, nil, nil, b, &o1)
		Step(&s2, &c, &e, nil, deep, b, &o2)
		if s1 != s2 || o1 != o2 {
			t.Fatalf("step %d: deep ground sails differently from none:\n%+v\n%+v", i, s1, s2)
		}
	}
}

// beach is a sandy slope rising east: 4 m deep to x = 50, rising a metre in
// 25, dry from x = 150.
func beach(x, y float64) float64 { return math.Max(-4, -4+(x-50)/25) }

func TestBeach(t *testing.T) {
	g := testGround(beach)
	// A beam reach east, wind from the north, 12 knots.
	s := State{X: -40, Heading: math.Pi / 2, Surge: 2.5, SheetLimit: 0.6}
	c := Control{Sheet: 0.45}
	e := Env{WindSpeed: 6.2, WindFrom: 0, MeanFrom: 0}
	var deepLeeway, shallowLeeway, fastest float64
	// Once steady in deep water, then where the board is cut short.
	stoppedAt := math.Inf(1)
	cut := false
	sailOver(t, g, &s, &c, &e, 3000, func(i int, s *State, o *Out) {
		c.Helm = steer(math.Pi/2, s)
		switch {
		case s.X > 0 && s.X < 50:
			deepLeeway = max(deepLeeway, math.Abs(o.Leeway))
			fastest = max(fastest, o.SpeedOverGround)
		case o.Depth < 0.6 && o.Depth > 0.2:
			cut = true
			shallowLeeway = max(shallowLeeway, math.Abs(o.Leeway))
		}
		if o.SpeedOverGround < 0.05 && o.Aground != Afloat && math.IsInf(stoppedAt, 1) {
			stoppedAt = s.X
		}
	})
	if !cut {
		t.Fatal("the boat never sailed where the board was cut short")
	}
	if !(shallowLeeway > deepLeeway) {
		t.Errorf("with its board cut short the boat makes %.3f rad of leeway, no more than %.3f in deep water", shallowLeeway, deepLeeway)
	}
	if math.IsInf(stoppedAt, 1) {
		t.Fatal("the boat never stopped on the beach")
	}
	if stoppedAt > 152 {
		t.Errorf("it stopped at x = %.1f, past the beach's dry edge at 150", stoppedAt)
	}
	t.Logf("fastest %.2f m/s, leeway %.3f deep and %.3f shallow, stopped at x = %.1f", fastest, deepLeeway, shallowLeeway, stoppedAt)
}

// cliff is a wall of land rising sheer east of x = 60, the water 10 m deep
// to it, with an inlet 8 m wide cut into it from x = 40: a cove whose head
// a boat running into it is held against.
func cliff(x, y float64) float64 {
	if x > 60 || x > 40 && math.Abs(y) > 4 {
		return 20
	}
	return -10
}

// deepest is how deep the boat's hull is into any land about it.
func deepest(s *State, g *Ground, b *Prepared) float64 {
	sinH, cosH := SinCos(s.Heading)
	q0, r0 := HexAt(s.X, s.Y)
	worst := 0.0
	for dq := int32(-3); dq <= 3; dq++ {
		for dr := int32(-3); dr <= 3; dr++ {
			if e, _ := g.cellAt(q0+dq, r0+dr); e <= 0 {
				continue
			}
			hx, hy := HexCentre(q0+dq, r0+dr)
			if _, _, d, _, _, ok := landTouch(&b.outline, sinH, cosH, hx-s.X, hy-s.Y); ok {
				worst = max(worst, d)
			}
		}
	}
	return worst
}

func TestCliff(t *testing.T) {
	g := testGround(cliff)
	b := jolly(t)
	// A run straight into the cove's head, the wind behind it.
	s := State{X: 30, Heading: math.Pi / 2, Surge: 2, SheetLimit: 1.4}
	c := Control{Sheet: 1}
	e := Env{WindSpeed: 5, WindFrom: -math.Pi / 2, MeanFrom: -math.Pi / 2}
	touched := -1
	worst := 0.0
	sailOver(t, g, &s, &c, &e, 30*40, func(i int, s *State, o *Out) {
		c.Helm = steer(math.Pi/2, s)
		if o.Aground == AgainstLand && touched < 0 {
			touched = i
		}
		worst = max(worst, deepest(s, g, b))
	})
	if touched < 0 {
		t.Fatal("the boat never touched the cliff")
	}
	if worst > 0.02 {
		t.Errorf("the hull was %.3f m into the land after a step", worst)
	}
	if s.X > 60 {
		t.Errorf("the boat is at x = %.2f, inside the cliff", s.X)
	}
	t.Logf("touched at step %d, the deepest into the land %.4f m", touched, worst)
}

func TestOffALeeShore(t *testing.T) {
	g := testGround(beach)
	b := jolly(t)
	// Aground on the beach, the wind onshore from the west, 10 knots.
	s := State{X: 148, Heading: math.Pi / 2, SheetLimit: 1.4}
	c := Control{Sheet: 1}
	e := Env{WindSpeed: 5.1, WindFrom: -math.Pi / 2, MeanFrom: -math.Pi / 2}
	pushed := -1
	var at, after State
	sailOver(t, g, &s, &c, &e, 30*60, func(i int, s *State, o *Out) {
		if pushed < 0 {
			at = *s
		}
		if o.PushedOff != 0 && pushed < 0 {
			pushed, after = i, *s
		}
		if pushed >= 0 {
			// Off on the heading it was pushed off on.
			c.Sheet = 0.2
			c.Helm = steer(after.Heading, s)
		}
	})
	if pushed < 0 {
		t.Fatal("the boat was never pushed off the beach")
	}
	still := math.Floor(testGroundParams.StillTime*StepsPerSecond + 0.5)
	if float64(pushed+1) < still {
		t.Errorf("pushed off at step %d, sooner than %v steps aground and still", pushed, still)
	}
	if e, _ := g.At(after.X, after.Y); e > -testGroundParams.PushDepth {
		t.Errorf("pushed off into %.1f m of water", -e)
	}
	if d := math.Hypot(after.X-at.X, after.Y-at.Y); d > testGroundParams.PushReach {
		t.Errorf("pushed off %.1f m, further than %v", d, testGroundParams.PushReach)
	}
	if off := math.Abs(wrapAngle(after.Heading - e.WindFrom)); math.Abs(off-(b.closeHauled+10*degree)) > 1e-9 || after.Surge != 0 || after.Sway != 0 {
		t.Errorf("pushed off to %+v, not at rest a little off close-hauled", after)
	}
	if s.X > 100 {
		t.Errorf("a minute after being pushed off the boat is at x = %.1f, still off the beach", s.X)
	}
	t.Logf("pushed off at step %d to (%.1f, %.1f); at (%.1f, %.1f) a minute later", pushed, after.X, after.Y, s.X, s.Y)
}

func TestGroundAllocatesNothing(t *testing.T) {
	g := testGround(cliff)
	b := jolly(t)
	s := State{X: 55, Heading: math.Pi / 2, Surge: 2, SheetLimit: 0.5}
	c := Control{Sheet: 0.4}
	e := Env{WindSpeed: 7, WindFrom: -2.6}
	var o Out
	if n := testing.AllocsPerRun(1000, func() { Step(&s, &c, &e, nil, g, b, &o) }); n != 0 {
		t.Errorf("a step against land allocates %v times", n)
	}
}
