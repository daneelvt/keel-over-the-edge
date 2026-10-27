// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// lineAt is a squall line of a kind at (east, north) m, moving toward
// heading degrees, half its depth size m and its length m, at full
// strength.
func lineAt(kind int32, east, north, heading, size, length, peakKnots, depth float64) System {
	s := systemAt(kind, east, north, heading, size, peakKnots, depth)
	s.Length = length
	return s
}

// Across a line its wind is a dome's at its middle, all along its length;
// past its ends it falls off as a dome's does from its centre; its
// pressure the same.
func TestLineIsADomeAlongItsLength(t *testing.T) {
	p, kinds := testSystems(t)
	// Beyond the inner waters, where nothing weakens it, moving north: its
	// length runs east and west.
	const size, length, oy = 0.15 * nm, 2.5 * nm, 3.35 * nm
	line := lineAt(kinds["squall-line"], 0, oy, 0, size, length, 15, 3)
	dome := systemAt(kinds["squall-line"], 0, oy, 0, size, 15, 3)
	wl, wd := withSystem(p, worldTick, line, still(0)), withSystem(p, worldTick, dome, still(0))
	var tl, td WeatherTick
	WeatherAt(wl, &tl, worldTick)
	WeatherAt(wd, &td, worldTick)
	same := func(got, want WindPoint) bool {
		return math.Abs(got.MeanSpeed-want.MeanSpeed) < 1e-5 && (want.MeanSpeed < 1e-3 || math.Abs(turnDeg(got.MeanFrom/degree, want.MeanFrom/degree)) < 1e-3)
	}
	for _, a := range []float64{-0.3 * nm, -0.1 * nm, 0, 0.05 * nm, 0.12 * nm, 0.3 * nm} {
		want := windAt(wd, 0, oy+a, worldTick)
		for _, c := range []float64{-1.2 * nm, -0.5 * nm, 0, 0.7 * nm, 1.24 * nm} {
			if got := windAt(wl, c, oy+a, worldTick); !same(got, want) {
				t.Errorf("at %.2f NM ahead, %.2f NM along: %.3f m/s from %.1f°, the dome's middle %.3f from %.1f°", a/nm, c/nm, got.MeanSpeed, got.MeanFrom/degree, want.MeanSpeed, want.MeanFrom/degree)
			}
			if d := PressureAt(&tl, c, oy+a) - PressureAt(&td, 0, oy+a); math.Abs(d) > 1e-9 {
				t.Errorf("at %.2f NM ahead, %.2f NM along: its pressure %.4f hPa off the dome's", a/nm, c/nm, d)
			}
		}
		for _, past := range []float64{0.05 * nm, 0.2 * nm, 0.5 * nm} {
			for _, end := range []float64{-1, 1} {
				got := windAt(wl, end*(length/2+past), oy+a, worldTick)
				if want := windAt(wd, end*past, oy+a, worldTick); !same(got, want) {
					t.Errorf("%.2f NM past its end, %.2f NM ahead: %.3f m/s, the dome's %.3f", past/nm, a/nm, got.MeanSpeed, want.MeanSpeed)
				}
			}
		}
	}
	// Far past its ends, nothing.
	if w := windAt(wl, length/2+nm, oy, worldTick); w.MeanSpeed > 1e-9 {
		t.Errorf("a mile past its end, %.4f m/s", w.MeanSpeed)
	}
}

// Buys Ballot's law about a line: its wind blows out of its high, turned
// clockwise, so with one's back to it the higher pressure is on the right,
// all along its length.
func TestLineBuysBallot(t *testing.T) {
	p, kinds := testSystems(t)
	line := lineAt(kinds["squall-line"], 500, -300, 40, 0.15*nm, 2.4*nm, 15, 3)
	w := withSystem(p, worldTick, line, still(0))
	var at WeatherTick
	WeatherAt(w, &at, worldTick)
	seen := 0
	for x := -2 * nm; x <= 2*nm; x += 0.05 * nm {
		for y := -2 * nm; y <= 2*nm; y += 0.05 * nm {
			wp := windAt(w, x, y, worldTick)
			if wp.MeanSpeed < 0.5 {
				continue
			}
			seen++
			// The pressure's rise to the right of the way the wind blows.
			sin, cos := SinCos(wp.MeanFrom + math.Pi)
			rx, ry := cos, -sin
			if d := PressureAt(&at, x+5*rx, y+5*ry) - PressureAt(&at, x-5*rx, y-5*ry); !(d > 0) {
				t.Fatalf("at (%.0f, %.0f) the pressure falls to the right of the wind by %.5f hPa", x, y, -d)
			}
		}
	}
	if seen < 100 {
		t.Fatalf("only %d points where the line blows", seen)
	}
}

// A line's rain falls along its length, its towers stand along it, and its
// lightning strikes along it.
func TestLineRainCloudsAndLightning(t *testing.T) {
	p, kinds := testSystems(t)
	const length = 2.4 * nm
	line := lineAt(kinds["squall-line"], 0, 0, 90, 0.15*nm, length, 15, 3)
	w := withSystem(p, worldTick, line, still(0))
	var at WeatherTick
	WeatherAt(w, &at, worldTick)
	for _, c := range []float64{-1.1 * nm, 0, 0.8 * nm} {
		if r := RainAt(&at, 0, c); r < 30 {
			t.Errorf("%.1f NM along, %.1f mm an hour", c/nm, r)
		}
	}
	if r := RainAt(&at, 0, length/2+0.6*nm); r > 0.05 {
		t.Errorf("past its end, %.2f mm an hour", r)
	}
	clouds := make([]Cloud, MaxClouds)
	n := HeapedClouds(&at, clouds)
	if n < 3 || n > lineTowers {
		t.Fatalf("%d towers", n)
	}
	for _, c := range clouds[:n] {
		if math.Abs(c.East) > 1 || math.Abs(c.North) > length/2 {
			t.Errorf("a tower at (%.0f, %.0f), off its line", c.East, c.North)
		}
	}
	lo, hi := 0.0, 0.0
	for slot := 0.0; slot < 4000; slot++ {
		var fl [MaxFlashes]Flash
		for i := range Flashes(&at, slot, fl[:]) {
			if math.Abs(fl[i].East) > 0.2*nm || math.Abs(fl[i].North) > length/2+0.1*nm {
				t.Fatalf("a flash at (%.0f, %.0f), off its line", fl[i].East, fl[i].North)
			}
			lo, hi = min(lo, fl[i].North), max(hi, fl[i].North)
		}
	}
	if hi-lo < length/2 {
		t.Errorf("its flashes span %.2f NM of its %.1f", (hi-lo)/nm, length/nm)
	}
}

// A boat crossing a warm front meets its rain first, ahead of its line,
// and a veer at the line with no surge of the gusts behind it; a cold
// front's rain is behind its line, and its gusts surge.
func TestWarmFront(t *testing.T) {
	p, _ := testSystems(t)
	old := spellOfRegime(t, p, "trade", 1, 225, 0, 8*hourOfTicks)
	old.Pressure = 101500
	cold := frontSpell(t, p, worldTick)
	warm := cold
	warm.Warm = 1
	for _, f := range []struct {
		name  string
		s     Spell
		ahead bool
	}{{"cold", cold, false}, {"warm", warm, true}} {
		w := weatherOf(p, old, f.s)
		var at WeatherTick
		WeatherAt(w, &at, worldTick)
		lx, ly := at.line*at.fe, at.line*at.fn
		rain := func(s float64) float64 { return RainAt(&at, lx+s*at.fe, ly+s*at.fn) }
		if got := rain(0.6*nm) > 2; got != f.ahead {
			t.Errorf("%s front: rain 0.6 NM ahead %.1f mm an hour", f.name, rain(0.6*nm))
		}
		if got := rain(-0.2*nm) > 2; got == f.ahead {
			t.Errorf("%s front: rain 0.2 NM behind %.1f mm an hour", f.name, rain(-0.2*nm))
		}
		behind := windAt(w, lx-0.3*nm*at.fe, ly-0.3*nm*at.fn, worldTick)
		ahead := windAt(w, lx+0.3*nm*at.fe, ly+0.3*nm*at.fn, worldTick)
		if v := turnDeg(ahead.MeanFrom/degree, behind.MeanFrom/degree); v < 15 {
			t.Errorf("%s front: the wind veers %.0f° across the line", f.name, v)
		}
		far := windAt(w, lx-1.5*nm*at.fe, ly-1.5*nm*at.fn, worldTick)
		if surge := behind.Excess - far.Excess; f.ahead && surge > 1e-9 || !f.ahead && !(surge > 0.05) {
			t.Errorf("%s front: the gusts behind the line surge by %.3f", f.name, surge)
		}
	}
}
