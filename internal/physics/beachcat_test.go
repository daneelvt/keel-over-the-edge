// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// Behaviour tests of a boat of two hulls whose rig pitches her, the beach
// cat: she lifts her windward hull close-hauled in a breeze and not in a
// light air, is fastest with it just clear, passes 12 knots on a beam
// reach; luffed in a gust with the sheet fixed she capsizes, and let fly
// she comes down; she tacks from full speed; capsized she lies on her side,
// her mast floating, and her sailor rights her on the line. Borne away in
// a gust on a broad reach with the sheet held, her bows bury and her
// sailor is thrown off over them; let fly, reefed or borne away to a run
// she is not, nor ever in 12 knots or upwind; and her sailor stands
// further aft as the wind rises.

// beachCat is the scenarios file's first boat of two hulls.
func beachCat(t testing.TB) *Prepared {
	t.Helper()
	for _, boat := range testBoats(t) {
		if boat.b.twin {
			return boat.b
		}
	}
	t.Fatal("no boat of two hulls")
	return nil
}

// meanHeel sails m for seconds and returns its mean heel, degrees.
func meanHeel(m *sim, seconds float64) float64 {
	return m.mean(seconds, func() float64 { return math.Abs(m.s.Heel) }) / deg
}

// Close-hauled with the sheet hauled in, the windward hull stays in the
// water in 6 knots and is more than half clear in 20, as the screen's "Hull
// flying" says, her sailor on the wire.
func TestBeachCatFliesAHull(t *testing.T) {
	b := beachCat(t)
	clear := (b.liftHeel + liftRange/2) / deg
	for _, c := range []struct {
		knots float64
		flies bool
	}{{6, false}, {20, true}} {
		m := newSimOf(t, b, c.knots*knot, 45, 0.02)
		m.run(60, nil)
		heel := meanHeel(m, 20)
		t.Logf("close-hauled in %g knots: heeled %.1f°, the sailor %.2f m out, the hull clear from %.0f°", c.knots, heel, math.Abs(m.s.Sailor), clear)
		if (heel >= clear) != c.flies || m.maxMode != Sailing {
			t.Errorf("close-hauled in %g knots: heeled %.1f°, the hull clear from %.0f°, sailor mode %v", c.knots, heel, clear, m.maxMode)
		}
	}
}

// reaching sails her on a beam reach in knots, under way at the sheet 0.3
// for half a minute and then at sheet for a minute, and returns her mean
// speed and heel over the last 20 s, m/s and degrees, and whether her
// sailor stayed aboard.
func reaching(t *testing.T, b *Prepared, knots, sheet float64) (speed, heel float64, aboard bool) {
	m := newSimOf(t, b, knots*knot, 90, 0.3)
	m.run(30, nil)
	m.c.Sheet = sheet
	m.run(40, nil)
	sum, n := 0.0, 0
	m.run(20, func() { heel += math.Abs(m.s.Heel); sum += m.speed(); n++ })
	return sum / float64(n), heel / float64(n) / deg, m.maxMode == Sailing
}

// On a beam reach in 14 knots she is fastest with her windward hull just
// clear of the water, faster than hauled in and pressed further; and she
// passes 12 knots.
func TestBeachCatFastestJustFlying(t *testing.T) {
	b := beachCat(t)
	clear := (b.liftHeel + liftRange/2) / deg
	bestSpeed, bestHeel, bestSheet := 0.0, 0.0, 0.0
	for sheet := 0.0; sheet <= 0.5; sheet += 0.025 {
		if v, heel, aboard := reaching(t, b, 14, sheet); aboard && v > bestSpeed {
			bestSpeed, bestHeel, bestSheet = v, heel, sheet
		}
	}
	t.Logf("a beam reach in 14 knots: fastest %.2f knots at the sheet %.3f, heeled %.1f°", bestSpeed/knot, bestSheet, bestHeel)
	if !(bestHeel >= clear-2 && bestHeel <= clear+4) {
		t.Errorf("a beam reach in 14 knots: fastest heeled %.1f°, not with the hull just clear (%.0f°)", bestHeel, clear)
	}
	if bestSpeed < 12*knot {
		t.Errorf("a beam reach in 14 knots: %.2f knots at her fastest", bestSpeed/knot)
	}
	pressed := max(0, bestSheet-0.075)
	v, heel, aboard := reaching(t, b, 14, pressed)
	t.Logf("hauled in to %.3f: %.2f knots, heeled %.1f°", pressed, v/knot, heel)
	if aboard && !(v < bestSpeed && heel > bestHeel) {
		t.Errorf("hauled in to %.3f: %.2f knots heeled %.1f°, against %.2f heeled %.1f°", pressed, v/knot, heel, bestSpeed/knot, bestHeel)
	}
}

// Luffed hard in a gust with the sheet hauled in she capsizes onto her
// side; let fly in the same gust she comes down.
func TestBeachCatCapsizesLuffed(t *testing.T) {
	b := beachCat(t)
	gust := func(sheet float64) *sim {
		m := newSimOf(t, b, 14*knot, 90, 0.3)
		m.run(40, nil)
		m.e.WindSpeed = 24 * knot
		m.c.Sheet = sheet
		m.hold(60)
		m.run(20, nil)
		return m
	}
	fixed := gust(0)
	t.Logf("luffed to 60° in a 24-knot gust, hauled in: the most heel %.0f°, sailor mode %v", fixed.maxHeel, fixed.maxMode)
	if fixed.maxMode == Sailing || fixed.maxHeel < 80 {
		t.Errorf("luffed to 60° in a 24-knot gust, hauled in: the most heel %.0f°, not over on her side", fixed.maxHeel)
	}
	free := gust(1)
	t.Logf("the same, let fly: the most heel %.0f°, sailor mode %v", free.maxHeel, free.maxMode)
	if free.maxMode != Sailing || free.maxHeel > 30 {
		t.Errorf("luffed in a 24-knot gust and let fly: the most heel %.0f°, sailor mode %v", free.maxHeel, free.maxMode)
	}
}

// Capsized, she lies on her side, her mast floating, and does not turn
// over; her sailor swims to the lower hull and rights her on the line, and
// climbs back aboard.
func TestBeachCatLiesOnHerSideAndRights(t *testing.T) {
	b := beachCat(t)
	m := newSimOf(t, b, 14*knot, 90, 0.3)
	m.run(40, nil)
	m.e.WindSpeed = 24 * knot
	m.c.Sheet = 0
	m.hold(60)
	fell := math.NaN()
	most, onSide := 0.0, 0.0
	righted := math.NaN()
	m.run(240, func() {
		if math.IsNaN(fell) && m.s.SailorMode == InWater {
			fell = m.time
			m.e.WindSpeed = 12 * knot
		}
		heel := math.Abs(m.s.Heel)
		most = max(most, heel)
		if m.s.SailorMode == InWater {
			onSide = max(onSide, heel)
		}
		if !math.IsNaN(fell) && math.IsNaN(righted) && m.s.SailorMode == Sailing {
			righted = m.time
		}
	})
	t.Logf("capsized at %.1f s, heeled at most %.0f°, back sailing at %.1f s", fell, most/deg, righted)
	if math.IsNaN(fell) {
		t.Fatal("never capsized")
	}
	if most > 120*deg || onSide < 70*deg {
		t.Errorf("capsized: at most %.0f°, on her side %.0f°: she should lie on her side, not turn over", most/deg, onSide/deg)
	}
	if math.IsNaN(righted) || righted-fell > 120 {
		t.Errorf("capsized at %.1f s: back sailing at %.1f s", fell, righted)
	}
}

// Her autopilot tacks her from full speed in 12 knots of flat water.
func TestBeachCatTacks(t *testing.T) {
	b := beachCat(t)
	m := newSimOf(t, b, 12*knot, -45, 0.05)
	m.steer = false
	m.c.Pilot, m.c.Target = PilotWind, pilotTarget(45)
	m.run(60, nil)
	within, least, _, _, capsized := turnFor(m, 45, WayTack, 30)
	t.Logf("tacked from 45° in 12 knots: within 5° after %.1f s, keeping %.0f%% of the speed", within, 100*least)
	if within > 10 || least < 0.3 || capsized {
		t.Errorf("tacked from 45° in 12 knots: within 5° after %.1f s, keeping %.0f%%, capsized %v", within, 100*least, capsized)
	}
}

// pitchpoleCase sails her at 135° in 20 knots at reef with the sheet that
// sails her fastest there, eased by ease, then meets a 30-knot gust and
// steers to heading; it reports whether her sailor was thrown off over
// the bow, and the most she pitched bow down, degrees.
func pitchpoleCase(t *testing.T, b *Prepared, knots, gust, from, to, ease, reef float64) (bool, float64) {
	t.Helper()
	sheet, top := 0.0, 0.0
	for s := 0.3; s <= 0.9; s += 0.05 {
		m := newSimOf(t, b, knots*knot, from, s)
		m.c.Reef, m.s.Reef = reef, reef
		m.run(40, nil)
		if v := m.mean(10, m.speed); m.maxMode == Sailing && v > top {
			sheet, top = s, v
		}
	}
	m := newSimOf(t, b, knots*knot, from, min(1, sheet+ease))
	m.c.Reef, m.s.Reef = reef, reef
	m.run(60, nil)
	m.e.WindSpeed = gust * knot
	m.hold(to)
	thrown, most := false, 0.0
	m.run(40, func() {
		most = max(most, -m.s.Pitch)
		if m.s.SailorMode == InWater && math.Abs(m.s.Heel) < b.fallOutHeel {
			thrown = true
		}
	})
	return thrown, most / deg
}

// Pitchpoling: borne away to 150° in a 30-knot gust from 20 knots on a
// broad reach, the sheet held at the reach's fastest, her bows bury and
// her sailor is thrown off over them; with the sheet let fly, at two
// reefs, or borne away to a run, she is not. In a 12-knot breeze's gusts
// she never is, nor close-hauled.
func TestBeachCatPitchpoles(t *testing.T) {
	b := beachCat(t)
	for _, c := range []struct {
		name             string
		knots, gust, to  float64
		from, ease, reef float64
		thrown           bool
	}{
		{"borne away to 150°, the sheet held", 20, 30, 150, 135, 0, 0, true},
		{"borne away to 150°, let fly", 20, 30, 150, 135, 1, 0, false},
		{"borne away to 150° at two reefs", 20, 30, 150, 135, 0, 2, false},
		{"borne away to 165°, the sheet held", 20, 30, 165, 135, 0, 0, false},
		{"borne away to 150° in 12 knots", 12, 18, 150, 135, 0, 0, false},
		{"borne away to 160° in 12 knots", 12, 18, 160, 135, 0, 0, false},
		{"close-hauled", 20, 30, 45, 45, 0, 0, false},
	} {
		thrown, most := pitchpoleCase(t, b, c.knots, c.gust, c.from, c.to, c.ease, c.reef)
		t.Logf("%s, a %g-knot gust in %g knots: pitched %.1f° bow down at most, thrown off %v", c.name, c.gust, c.knots, most, thrown)
		if thrown != c.thrown {
			t.Errorf("%s, a %g-knot gust in %g knots: pitched %.1f° bow down at most, thrown off %v", c.name, c.gust, c.knots, most, thrown)
		}
	}
}

// Her sailor stands further aft as the wind rises on a broad reach, and
// not at all in a light air; no other boat's sailor moves aft.
func TestBeachCatSailorStepsAft(t *testing.T) {
	b := beachCat(t)
	last := -1.0
	for _, knots := range []float64{4, 10, 16} {
		m := newSimOf(t, b, knots*knot, 135, 0.6)
		m.run(40, nil)
		aft := m.mean(10, func() float64 { return m.s.SailorAft })
		t.Logf("135° in %g knots: %.2f m aft", knots, aft)
		if !(aft > last) || aft > b.aftReach+1e-9 {
			t.Errorf("135° in %g knots: %.2f m aft, after %.2f", knots, aft, last)
		}
		last = aft
	}
	for _, boat := range testBoats(t) {
		if boat.b.rigPitch {
			continue
		}
		m := newSimOf(t, boat.b, 16*knot, 135, 0.6)
		m.run(20, func() {
			if m.s.SailorAft != 0 || m.o.BowsBurying != 0 || m.o.HullFlying != 0 {
				t.Fatalf("%s: the sailor %.2f m aft, bows burying %v, a hull flying %v", boat.id, m.s.SailorAft, m.o.BowsBurying, m.o.HullFlying)
			}
		})
	}
}
