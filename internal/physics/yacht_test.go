// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// Behaviour tests of a heavy cruising keelboat with two rudders on one
// hull, the yacht: close-hauled at her fastest sheet she heels moderately;
// held in a gust with her sheet fixed she rounds up, heeled past 30°, and
// eased she comes back; her autopilot tacks her from full speed in light,
// moderate and fresh winds; and heeled, her windward rudder leaves the
// water while her lee one still steers her.

// yacht is the scenarios file's first boat with two rudders on one hull.
func yacht(t testing.TB) *Prepared {
	t.Helper()
	for _, boat := range testBoats(t) {
		if boat.b.twinRudders {
			return boat.b
		}
	}
	t.Fatal("no boat with two rudders on one hull")
	return nil
}

// Close-hauled at 45° in 12 knots with her sheet hauled in, her fastest,
// she heels 8° to 20° (a 40-footer is kept under 20° to 25°: Cruising
// World), making 6 to 8 knots.
func TestYachtHeelsCloseHauled(t *testing.T) {
	b := yacht(t)
	for _, knots := range []float64{8, 12, 16} {
		m := newSimOf(t, b, knots*knot, 45, 0)
		m.run(120, nil)
		heel := meanHeel(m, 30)
		v := m.mean(10, m.speed) / knot
		t.Logf("%g knots, 45°, hauled in: heel %.1f°, %.2f knots", knots, heel, v)
		if knots == 12 && (heel < 8 || heel > 20 || v < 6 || v > 8) {
			t.Errorf("12 knots, 45°, hauled in: heel %.1f°, %.2f knots: not 8° to 20° at 6 to 8 knots", heel, v)
		}
	}
}

// Held close-hauled at a fixed helm in 12 knots, then struck by a 35-knot
// gust with her sheet held, she heels past 30° and rounds up toward the
// wind; let fly she comes back under 20°. Her sailor never leaves her.
func TestYachtRoundsUpInAGust(t *testing.T) {
	b := yacht(t)
	m := newSimOf(t, b, 12*knot, 50, 0)
	m.run(120, nil)
	helm := m.c.Helm
	m.steer, m.c.Helm = false, helm
	before := m.angle()
	m.maxHeel = 0
	m.e.WindSpeed = 35 * knot
	m.run(15, nil)
	heeled, up := m.maxHeel, math.Abs(before)-math.Abs(m.angle())
	m.c.Sheet = 1
	m.run(20, nil)
	after := meanHeel(m, 5)
	t.Logf("a 35-knot gust, the sheet held: heeled %.0f°, rounded up %.0f°; let fly: %.1f°", heeled, up/deg, after)
	if heeled < 30 || up < 10*deg {
		t.Errorf("a 35-knot gust with the sheet held: heeled %.0f°, rounded up %.0f°: not past 30° and up", heeled, up/deg)
	}
	if after > 20 {
		t.Errorf("let fly in the gust she still heels %.1f°", after)
	}
	if m.maxMode != Sailing {
		t.Error("her sailor left her")
	}
}

// Her autopilot tacks her from close-hauled at full speed in 6, 12 and 18
// knots of flat water, through about 90° (the certificate's beat angles,
// 40° to 46° either side), and she keeps way enough to sail on.
func TestYachtTacks(t *testing.T) {
	b := yacht(t)
	for _, knots := range []float64{6, 12, 18} {
		m := newSimOf(t, b, knots*knot, -45, 0)
		m.steer = false
		m.c.Pilot, m.c.Target = PilotWind, pilotTarget(45)
		m.run(120, nil)
		within, least, _, furthest, capsized := turnFor(m, 45, WayTack, 40)
		t.Logf("tacked from 45° in %g knots: within 5° after %.1f s, keeping %.0f%% of the speed, out to %.0f° off the wind", knots, within, 100*least, furthest)
		if within > 15 || least < 0.3 || capsized || furthest > 75 {
			t.Errorf("tacked from 45° in %g knots: within 5° after %.1f s, keeping %.0f%%, out to %.0f°, capsized %v", knots, within, 100*least, furthest, capsized)
		}
	}
}

// Heeled, her windward rudder's root leaves the water first and then its
// tip: upright her two rudders lift twice what one would; between, less;
// past its tip's heel only her lee rudder steers, lifting what one would,
// and still turns her.
func TestYachtsWindwardRudderDries(t *testing.T) {
	b := yacht(t)
	one := *b
	one.twinRudders = false
	// The rudders' lift at 10° of rudder, sailing at 6 knots with the
	// boat held at a heel.
	lift := func(p *Prepared, heel float64) (float64, float64) {
		m := newSimOf(t, p, 0, 0, 0.5)
		m.steer = false
		m.s.Surge = 6 * knot
		m.c.Helm = 10 * deg / p.rudderMax
		m.s.Rudder = 10 * deg
		m.s.Heel = heel * deg
		m.s.RollRate = 0
		m.step()
		return math.Abs(m.o.RudderLift), m.s.YawRate
	}
	clear := (b.rudderLift + 1/b.invRudderRange) / deg
	halfway := (b.rudderLift + 0.5/b.invRudderRange) / deg
	for _, c := range []struct {
		heel, share float64
	}{{2, 2}, {halfway, 1.5}, {clear + 3, 1}} {
		two, turn := lift(b, c.heel)
		single, _ := lift(&one, c.heel)
		t.Logf("heeled %.0f°: the rudders' lift at 10° %.0f N, one rudder's %.0f N: %.2f of it", c.heel, two, single, two/single)
		if math.Abs(two/single-c.share) > 0.05 {
			t.Errorf("heeled %.0f°: the rudders lift %.2f of one rudder, not %.2f", c.heel, two/single, c.share)
		}
		if turn == 0 {
			t.Errorf("heeled %.0f°: the helm does not turn her", c.heel)
		}
	}
}
