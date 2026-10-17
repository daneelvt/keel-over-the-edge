// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// currentSpeed is the current's speed at r metres from the centre, along
// the bearing given, in knots, and its parts: round the disk and out.
func currentAt(w *WeatherPrepared, way, r, bearing float64, g *Ground) (east, north float64) {
	sin, cos := math.Sincos(bearing)
	return CurrentAt(w, way, r*sin, r*cos, g)
}

// The current is nothing in the refuge, and hits the catalog's points: the
// circulation's 0.2 knots at 1.4 NM and 0.5 from 3.5 NM, the drain's 0.6 at
// 4.2 NM and 2 at the lip.
func TestCurrentPoints(t *testing.T) {
	w := testWeather(t)
	for _, c := range []struct{ nm, round, out float64 }{
		{0, 0, 0}, {0.5, 0, 0}, {1, 0, 0}, {1.2, 0.1, 0}, {1.4, 0.2, 0}, {2.45, 0.35, 0}, {3.5, 0.5, 0},
		{3.85, 0.5, 0.3}, {4.2, 0.5, 0.6}, {4.35, 0.5, 1.3}, {4.5, 0.5, 2}, {5, 0.5, 2},
	} {
		for _, bearing := range []float64{0, 1, 2.5, -2} {
			e, n := currentAt(w, 1, c.nm*nm, bearing, nil)
			sin, cos := math.Sincos(bearing)
			out := (e*sin + n*cos) / knot
			round := (e*cos - n*sin) / knot
			if math.Abs(out-c.out) > 1e-9 || math.Abs(round-c.round) > 1e-9 {
				t.Errorf("%g NM at %g rad: %.6f knots round and %.6f out, want %g and %g", c.nm, bearing, round, out, c.round, c.out)
			}
		}
	}
	// Within the refuge it is exactly still, so a boat there steps as in
	// still water.
	for _, r := range []float64{0, 1, 500, 1852} {
		if e, n := currentAt(w, 1, r, 0.3, nil); e != 0 || n != 0 {
			t.Errorf("at %g m the current is (%v, %v)", r, e, n)
		}
	}
}

// It has no step at any of its points.
func TestCurrentContinuous(t *testing.T) {
	w := testWeather(t)
	for _, at := range []float64{1, 1.4, 3.5, 4.2, 4.5} {
		r := at * nm
		e0, n0 := currentAt(w, -1, r*(1-1e-12), 0.7, nil)
		e1, n1 := currentAt(w, -1, r*(1+1e-12), 0.7, nil)
		if d := math.Hypot(e1-e0, n1-n0); d > 1e-9 {
			t.Errorf("at %g NM the current steps by %g m/s", at, d)
		}
	}
}

// The circulation runs clockwise seen from above for a way of 1 and the
// other way for −1, and not at all for 0; the drain runs outward whichever.
func TestCurrentWay(t *testing.T) {
	w := testWeather(t)
	r := 2 * nm
	// Due north of the centre, clockwise is east.
	if e, n := CurrentAt(w, 1, 0, r, nil); !(e > 0.1) || n != 0 {
		t.Errorf("north of the centre clockwise: (%v, %v)", e, n)
	}
	if e, n := CurrentAt(w, -1, 0, r, nil); !(e < -0.1) || n != 0 {
		t.Errorf("north of the centre anticlockwise: (%v, %v)", e, n)
	}
	if e, n := CurrentAt(w, 0, 0, r, nil); e != 0 || n != 0 {
		t.Errorf("no circulation: (%v, %v)", e, n)
	}
	// East of the centre, beyond the drain's start, the drain is east too.
	if e, n := CurrentAt(w, 0, 4.4*nm, 0, nil); !(e > 0.7) || n != 0 {
		t.Errorf("east of the centre, the drain: (%v, %v)", e, n)
	}
}

// Over shallow ground the current falls in proportion to the depth:
// halved in 1.5 m of water, nothing over land, whole in 3 m and deeper.
func TestCurrentShallow(t *testing.T) {
	w := testWeather(t)
	x, y := 0.0, 4.4*nm
	n, i, _ := ChunkOf(HexCell(HexAt(x, y)))
	deep, _ := CurrentAt(w, 1, x, y, nil)
	for _, c := range []struct {
		depth, share float64
	}{{40, 1}, {3, 1}, {1.5, 0.5}, {0.6, 0.2}, {0, 0}, {-2, 0}} {
		g := &Ground{Prepared: new(GroundPrepared)}
		ch := new(GroundChunk)
		ch.Elevation[i] = int16(math.Round(-c.depth * 10))
		g.Chunks[n] = ch
		e, _ := CurrentAt(w, 1, x, y, g)
		if math.Abs(e-c.share*deep) > 1e-12 {
			t.Errorf("in %g m of water the current is %v, want %v of %v", c.depth, e, c.share, deep)
		}
	}
}

// A boat moving with the water, in air that moves with it, stays with it:
// nothing flows past hull, foils or sail.
func TestDriftHoldsTheCurrent(t *testing.T) {
	b := jolly(t)
	ce, cn := 1.0, 0.5
	s := State{Heading: 0.5, SheetLimit: 1.4, Boom: 1.4}
	s.Surge, s.Sway = currentInFrame(ce, cn, math.Sin(s.Heading), math.Cos(s.Heading))
	c := Control{Sheet: 1}
	e := Env{WindSpeed: math.Hypot(ce, cn), WindFrom: math.Atan2(-ce, -cn), CurrentEast: ce, CurrentNorth: cn}
	var o Out
	for i := range 10 * 60 * StepsPerSecond {
		x, y := s.X, s.Y
		Step(&s, &c, &e, nil, nil, b, &o)
		ve, vn := (s.X-x)/Dt, (s.Y-y)/Dt
		if d := math.Hypot(ve-ce, vn-cn); d > 0.01 {
			t.Fatalf("after %.1f s the boat moves at (%.4f, %.4f), %.4f m/s off the current", float64(i+1)*Dt, ve, vn, d)
		}
	}
}

// A boat at rest is picked up by the current, and in still air settles to
// drift slower than the water by what the air holds it back.
func TestDriftFromRest(t *testing.T) {
	b := jolly(t)
	ce, cn := 1.0, 0.5
	for _, air := range []struct {
		name       string
		moving     bool
		within     float64 // of the current after five minutes, m/s
		slowerThan float64 // at least this much slower than the current, m/s
	}{{"in air that moves with the water", true, 0.05, -1}, {"in still air", false, 0.6, 0.1}} {
		s := State{Heading: 0.5, SheetLimit: 1.4}
		c := Control{Sheet: 1}
		e := Env{CurrentEast: ce, CurrentNorth: cn}
		if air.moving {
			e.WindSpeed, e.WindFrom = math.Hypot(ce, cn), math.Atan2(-ce, -cn)
		}
		var o Out
		var ve, vn float64
		reached := 0.0
		for i := range 5 * 60 * StepsPerSecond {
			x, y := s.X, s.Y
			Step(&s, &c, &e, nil, nil, b, &o)
			ve, vn = (s.X-x)/Dt, (s.Y-y)/Dt
			if reached == 0 && (ve*ce+vn*cn)/(ce*ce+cn*cn) > 0.5 {
				reached = float64(i+1) * Dt
			}
		}
		slip := math.Hypot(ve-ce, vn-cn)
		t.Logf("%s: half the current's speed after %.1f s; after five minutes (%.3f, %.3f) m/s, %.3f m/s off it", air.name, reached, ve, vn, slip)
		if !(reached > 0 && reached < 30) {
			t.Errorf("%s: the boat took %.1f s to reach half the current's speed", air.name, reached)
		}
		if !(slip < air.within) || !(slip > air.slowerThan) {
			t.Errorf("%s: after five minutes %.3f m/s off the current", air.name, slip)
		}
	}
}

// A current is a moving frame: a boat sailing in a current, in a wind over
// the ground, sails as one in still water would in the wind over the water,
// carried along. Only the order of the arithmetic differs.
func TestCurrentIsAMovingFrame(t *testing.T) {
	b := jolly(t)
	ce, cn := -0.6, 0.8
	wind, from := 6.0, 0.4
	sinF, cosF := math.Sincos(from)
	// The wind over the water: the air's velocity less the water's.
	we, wn := -wind*sinF-ce, -wind*cosF-cn
	still := Env{WindSpeed: math.Hypot(we, wn), WindFrom: math.Atan2(-we, -wn)}
	moving := Env{WindSpeed: wind, WindFrom: from, CurrentEast: ce, CurrentNorth: cn}
	a := State{Heading: 1.6, Surge: 2.5, SheetLimit: 0.6}
	m := a
	ahead, starboard := currentInFrame(ce, cn, math.Sin(a.Heading), math.Cos(a.Heading))
	m.Surge, m.Sway = m.Surge+ahead, m.Sway+starboard
	c := Control{Sheet: 0.35, Helm: 0.1}
	var oa, om Out
	for i := range 60 * StepsPerSecond {
		if i == 600 {
			c.Helm = -0.4
		}
		Step(&a, &c, &still, nil, nil, b, &oa)
		Step(&m, &c, &moving, nil, nil, b, &om)
	}
	tt := 60.0
	dx, dy := m.X-ce*tt-a.X, m.Y-cn*tt-a.Y
	if d := math.Hypot(dx, dy); d > 0.05 || math.Abs(wrapAngle(m.Heading-a.Heading)) > 1e-3 {
		t.Errorf("after a minute the boat in the current is %.4f m and %.5f rad from the one in still water, carried", d, m.Heading-a.Heading)
	}
	if math.Abs(om.SpeedThroughWater-oa.SpeedThroughWater) > 1e-3 {
		t.Errorf("through the water: %.4f m/s in the current, %.4f in still water", om.SpeedThroughWater, oa.SpeedThroughWater)
	}
}

func TestStepInACurrentAllocatesNothing(t *testing.T) {
	b := jolly(t)
	s := State{Heading: 1, Surge: 2, SheetLimit: 0.5}
	c := Control{Helm: 0.3, Sheet: 0.4}
	e := Env{WindSpeed: 7, WindFrom: 2, CurrentEast: 0.5, CurrentNorth: -0.3}
	w := testWeather(t)
	var o Out
	if n := testing.AllocsPerRun(1000, func() {
		e.CurrentEast, e.CurrentNorth = CurrentAt(w, 1, 8000, 100, nil)
		Step(&s, &c, &e, nil, nil, b, &o)
	}); n != 0 {
		t.Errorf("a step in a current allocates %v times", n)
	}
}

// BenchmarkStepInACurrent times BenchmarkStep's beam reach in the drain.
func BenchmarkStepInACurrent(bm *testing.B) {
	b := jolly(bm)
	s := State{Heading: math.Pi / 2, Surge: 3, SheetLimit: 0.6}
	c := Control{Sheet: 0.35}
	e := Env{WindSpeed: 7, WindFrom: 0, CurrentEast: 0.9, CurrentNorth: 0.1}
	var o Out
	for bm.Loop() {
		Step(&s, &c, &e, nil, nil, b, &o)
	}
}

func BenchmarkCurrentAt(bm *testing.B) {
	w := testWeather(bm)
	var e float64
	for bm.Loop() {
		de, _ := CurrentAt(w, 1, 6000, 5000, nil)
		e += de
	}
	_ = e
}
