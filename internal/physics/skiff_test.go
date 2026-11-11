// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"fmt"
	"math"
	"testing"
)

// Behaviour tests of a boat with a downwind sail, the skiff: she planes on a
// reach; her crew sets the gennaker bearing away and takes it in coming
// up, holds it between, and keeps it in at the reef that keeps none of it;
// it pays on a broad reach, crosses in a gybe, and comes in when her
// sailor falls in; let fly in a gust she comes up; and the wind dying at
// once under her sailor on the trapeze takes her over to windward.

// skiff is the scenarios file's first boat with a downwind sail.
func skiff(t testing.TB) *Prepared {
	t.Helper()
	for _, boat := range testBoats(t) {
		if boat.b.kite {
			return boat.b
		}
	}
	t.Fatal("no boat with a downwind sail")
	return nil
}

// fastest sails b at heading degrees off a wind of knots 10 m up for a
// minute at each sheet and returns the fastest mean speed of the last 20 s,
// m/s, at reef reef.
func fastest(t *testing.T, b *Prepared, knots, heading, reef float64, sheets ...float64) float64 {
	top := 0.0
	for _, sheet := range sheets {
		m := newSimOf(t, b, knots*knot, heading, sheet)
		m.c.Reef, m.s.Reef = reef, reef
		m.run(60, nil)
		v := m.mean(20, m.speed)
		if m.maxMode == Sailing {
			top = max(top, v)
		}
	}
	return top
}

// She planes on a beam reach in 14 knots: faster than a Froude number of
// 0.6 on her waterline, past the hump of her resistance at about 0.45, as
// a 29er does there.
func TestSkiffPlanes(t *testing.T) {
	b := skiff(t)
	v := fastest(t, b, 14, 90, 0, 0.15, 0.2, 0.25, 0.3, 0.35)
	lwl := 2 * b.halfLength
	fn := v / math.Sqrt(gravity*lwl)
	t.Logf("a beam reach in 14 knots: %.2f knots, a Froude number of %.2f", v/knot, fn)
	if fn < 0.6 {
		t.Errorf("a beam reach in 14 knots: %.2f knots, a Froude number of %.2f: not planing", v/knot, fn)
	}
}

// On a broad reach in 10 knots she is faster with the gennaker set than
// with it kept in by the reef, the main and jib as full.
func TestSkiffGennakerPays(t *testing.T) {
	b := skiff(t)
	sheets := []float64{0.3, 0.4, 0.5, 0.6, 0.7, 0.8}
	set := fastest(t, b, 10, 120, 0, sheets...)
	in := fastest(t, b, 10, 120, 1, sheets...)
	t.Logf("120° in 10 knots: %.2f knots with the gennaker set, %.2f kept in", set/knot, in/knot)
	if !(set > 1.1*in) {
		t.Errorf("120° in 10 knots: %.2f knots with the gennaker set, %.2f kept in: it does not pay", set/knot, in/knot)
	}
}

// The crew sets it past setAngle and takes it in forward of dropAngle,
// each in its own time, and between the two angles leaves it as it is.
func TestSkiffCrewSetsAndTakesIn(t *testing.T) {
	b := skiff(t)
	set, drop := b.setAngle/deg, b.dropAngle/deg
	mid := (set + drop) / 2
	m := newSimOf(t, b, 10*knot, drop-10, 0.3)
	m.run(30, nil)
	check := func(when string, hoist float64) {
		t.Helper()
		if m.s.Hoist != hoist || m.s.HoistTarget != hoist {
			t.Errorf("%s: hoisted %.2f, the crew's aim %v, not %v", when, m.s.Hoist, m.s.HoistTarget, hoist)
		}
	}
	check(fmt.Sprintf("at %.0f°", drop-10), 0)
	m.hold(mid)
	m.run(30, nil)
	check(fmt.Sprintf("coming off to %.0f°, in the band", mid), 0)
	m.hold(set + 10)
	m.c.Sheet = 0.5
	took := math.NaN()
	m.run(30, func() {
		if math.IsNaN(took) && m.s.Hoist == 1 {
			took = m.time
		}
	})
	check(fmt.Sprintf("bearing away to %.0f°", set+10), 1)
	m.hold(mid)
	m.run(30, nil)
	check(fmt.Sprintf("coming up to %.0f°, in the band", mid), 1)
	m.hold(drop - 10)
	m.c.Sheet = 0.3
	m.run(30, nil)
	check(fmt.Sprintf("coming up to %.0f°", drop-10), 0)
	// Kept in at the reef that keeps none of it.
	m.c.Reef = 1
	m.hold(set + 20)
	m.run(30, nil)
	check(fmt.Sprintf("at %.0f° at reef 1", set+20), 0)
	m.c.Reef = 0
	m.run(30, nil)
	check(fmt.Sprintf("at %.0f° the reef shaken out", set+20), 1)
	if math.IsNaN(took) {
		t.Errorf("never set")
	}
}

// Sailed by the autopilot on a steady heading, in the band, through the
// shifts of a settled and a trade spell for ten minutes, the crew sets and
// takes in the gennaker no more than once: the mean wind's shifts turn the
// angle off the wind, and the band keeps the crew from following each.
func TestSkiffGennakerThroughTheShifts(t *testing.T) {
	b := skiff(t)
	p := testWeather(t)
	for _, c := range []struct {
		regime string
		n      uint32
	}{{"settled", 2}, {"trade", 1}, {"trade", 2}} {
		s := spellOfRegime(t, p, c.regime, c.n, 0, 0, 0)
		angle := (b.setAngle + b.dropAngle) / 2 / deg
		m := onPilot(t, b, weatherOf(p, s), angle, 0.55, PilotHeading)
		m.s.Hoist, m.s.HoistTarget = 1, 1
		changes, was := 0, m.s.HoistTarget
		lo, hi := math.Inf(1), math.Inf(-1)
		m.run(600, func() {
			if m.s.HoistTarget != was {
				changes++
				was = m.s.HoistTarget
			}
			lo, hi = min(lo, math.Abs(m.angle())/deg), max(hi, math.Abs(m.angle())/deg)
		})
		t.Logf("%s %d on a steady heading from %.1f°: the crew's aim changed %d times in ten minutes, the boat %.1f° to %.1f° off the mean wind", c.regime, c.n, angle, changes, lo, hi)
		if changes > 2 || m.maxMode != Sailing {
			t.Errorf("%s %d: the crew's aim changed %d times in ten minutes, sailor mode at most %v", c.regime, c.n, changes, m.maxMode)
		}
	}
}

// It crosses with the boat in a gybe, and stays set.
func TestSkiffGennakerGybes(t *testing.T) {
	b := skiff(t)
	m := newSimOf(t, b, 10*knot, 150, 0.7)
	m.run(30, nil)
	before := m.s.Kite
	m.hold(-150)
	least := 1.0
	m.run(30, func() { least = min(least, m.s.Hoist) })
	t.Logf("the clew at %.0f° before, %.0f° after; hoisted at least %.2f", before/deg, m.s.Kite/deg, least)
	if !(before*m.s.Kite < 0 && least == 1 && m.maxMode == Sailing) {
		t.Errorf("the clew at %.0f° before, %.0f° after; hoisted at least %.2f, sailor mode %v", before/deg, m.s.Kite/deg, least, m.maxMode)
	}
}

// When her sailor falls in, the crew takes it in.
func TestSkiffGennakerComesInCapsized(t *testing.T) {
	b := skiff(t)
	m := newSimOf(t, b, 16*knot, 120, 0.5)
	m.run(30, nil)
	if m.s.Hoist != 1 {
		t.Fatalf("at 120° in 16 knots the gennaker is hoisted %.2f", m.s.Hoist)
	}
	m.c.Sheet = 0
	m.hold(70)
	fell := math.NaN()
	m.run(60, func() {
		if math.IsNaN(fell) && m.s.SailorMode == InWater {
			fell = m.time
		}
	})
	if math.IsNaN(fell) {
		t.Fatal("hauled in and luffed to 70° in 16 knots she never capsized")
	}
	t.Logf("she capsized at %.1f s; the gennaker's aim %v, hoisted %.2f", fell, m.s.HoistTarget, m.s.Hoist)
	if m.s.HoistTarget != 0 {
		t.Errorf("capsized, the crew's aim is %v", m.s.HoistTarget)
	}
}

// Let fly in a gust under the gennaker, she comes up and stays upright.
func TestSkiffLetFlyInAGust(t *testing.T) {
	b := skiff(t)
	m := newSimOf(t, b, 10*knot, 130, 0.6)
	m.run(30, nil)
	m.e.WindSpeed = 24 * knot
	m.c.Sheet = 1
	m.run(5, nil)
	most := 0.0
	m.run(25, func() { most = max(most, math.Abs(m.s.Heel)) })
	t.Logf("a 24-knot gust, let fly: at most %.1f° from 5 s on", most/deg)
	if most > 30*deg || m.maxMode != Sailing {
		t.Errorf("a 24-knot gust, let fly: %.1f°, sailor mode %v", most/deg, m.maxMode)
	}
}

// Close-hauled with her sailor out on the trapeze, the wind dying at once
// takes her over to windward: the trapeze comes in slower than the boat
// rolls. Its lull to a breath lays her over, and she comes up.
func TestSkiffCapsizesToWindward(t *testing.T) {
	b := skiff(t)
	m := newSimOf(t, b, 16*knot, 45, 0.1)
	m.run(30, nil)
	out := m.s.Sailor
	m.e.WindSpeed = 0
	windward := 0.0
	m.run(20, func() { windward = max(windward, float64(sign(out)*m.s.Heel)) })
	t.Logf("on the wire %.2f m out, the wind gone: over to windward %.0f°, sailor mode %v", out, windward/deg, m.maxMode)
	if m.maxMode == Sailing || windward < b.fallOutHeel {
		t.Errorf("on the wire %.2f m out, the wind gone: over to windward only %.0f°", out, windward/deg)
	}
}
