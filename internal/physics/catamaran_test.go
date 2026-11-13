// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// Behaviour tests of a cruising catamaran, two heavy hulls whose sailor
// never falls in: close-hauled at her fastest sheet she barely heels; held
// at a fixed helm in a squall with her sheet held at full sail she flies
// her windward hull and heels far, and eased she comes back, her sailor
// aboard throughout; her autopilot tacks her from full speed in a moderate
// and a fresh wind, and in light air either tacks her or, her way gone in
// the wind's eye, says the tack stalled and pays her off on her old tack.

// catamaran is the scenarios file's first boat of two hulls whose sailor
// never falls in.
func catamaran(t testing.TB) *Prepared {
	t.Helper()
	for _, boat := range testBoats(t) {
		if boat.b.twin && boat.b.fallOutHeel >= math.Pi {
			return boat.b
		}
	}
	t.Fatal("no boat of two hulls whose sailor never falls in")
	return nil
}

// Close-hauled at 52° with her sheet a little eased, near her fastest, she
// heels under 5° in 8, 12 and 16 knots ("4 degrees", Cruising World, of a
// 40-foot cruising catamaran), making about 6 knots in 12.
func TestCatamaranBarelyHeels(t *testing.T) {
	b := catamaran(t)
	for _, knots := range []float64{8, 12, 16} {
		m := newSimOf(t, b, knots*knot, 52, 0.1)
		m.run(120, nil)
		heel := meanHeel(m, 30)
		v := m.mean(10, m.speed) / knot
		t.Logf("%g knots, 52°, the sheet at 0.1: heel %.1f°, %.2f knots", knots, heel, v)
		if heel > 5 {
			t.Errorf("%g knots close-hauled: heel %.1f°, not under 5°", knots, heel)
		}
		if knots == 12 && (v < 5.5 || v > 7) {
			t.Errorf("12 knots close-hauled: %.2f knots, not about 6", v)
		}
	}
}

// Held close-hauled at a fixed helm in 12 knots, then struck by a squall
// of 40 knots with her sheet held at full sail, she lifts her windward
// hull clear ("hull flying") and heels past where her lever is greatest;
// let fly in the squall she comes back under 8°. In 55 knots held she is
// laid far over, past 75°, and let fly she comes back too: her lever, held
// positive past its fall, never lets her turn over. Her sailor never
// leaves her.
func TestCatamaranFliesAHullInASquall(t *testing.T) {
	b := catamaran(t)
	for _, c := range []struct{ gust, past float64 }{{40, leverPeak(b) / deg}, {55, 75}} {
		m := newSimOf(t, b, 12*knot, 52, 0)
		m.run(120, nil)
		helm := m.c.Helm
		m.steer, m.c.Helm = false, helm
		m.maxHeel = 0
		m.e.WindSpeed = c.gust * knot
		flying := 0.0
		m.run(20, func() { flying = max(flying, m.o.HullFlying) })
		heeled := m.maxHeel
		m.c.Sheet = 1
		m.run(30, nil)
		after := meanHeel(m, 5)
		t.Logf("a %g-knot squall, the sheet held: heeled %.0f°, the hull flying %v; let fly: %.1f°", c.gust, heeled, flying == 1, after)
		if flying != 1 || heeled < c.past {
			t.Errorf("a %g-knot squall with the sheet held: heeled %.0f°, the hull flying %v: not past %.0f°", c.gust, heeled, flying == 1, c.past)
		}
		if after > 8 {
			t.Errorf("let fly in a %g-knot squall she still heels %.1f°", c.gust, after)
		}
		if m.maxMode != Sailing {
			t.Errorf("a %g-knot squall: her sailor left her", c.gust)
		}
	}
}

// Her autopilot tacks her from close-hauled at full speed in 12 and 18
// knots of flat water, through about 100° (her certificate's beat angles,
// 48° to 52° either side), within 15 s, and she keeps way enough to sail
// on. In 6 knots she either tacks, slowly, within 20 s, or, as a cruising
// catamaran can in light air, stalls in the wind's eye: the autopilot says
// so and pays her off on her old tack, still sailing.
func TestCatamaranTacks(t *testing.T) {
	b := catamaran(t)
	for _, knots := range []float64{6, 12, 18} {
		m := newSimOf(t, b, knots*knot, -52, 0.1)
		m.steer = false
		m.c.Pilot, m.c.Target = PilotWind, pilotTarget(52)
		m.run(120, nil)
		within, least, _, furthest, capsized := turnFor(m, 52, WayTack, 40)
		stalled := m.s.PilotWay == WayTackStalled
		t.Logf("tacked from 52° in %g knots: within 5° after %.1f s, keeping %.0f%% of the speed, out to %.0f° off the wind, stalled %v", knots, within, 100*least, furthest, stalled)
		if capsized || furthest > 80 {
			t.Errorf("tacked from 52° in %g knots: out to %.0f°, capsized %v", knots, furthest, capsized)
		}
		if knots == 6 && stalled {
			if a := math.Abs(m.angle()) / deg; math.Abs(a-52) > 15 {
				t.Errorf("a tack stalled in 6 knots: %.0f° off the wind, not paid off on her old tack", a)
			}
			continue
		}
		limit := 15.0
		if knots == 6 {
			limit = 20
		}
		if within > limit || least < 0.3 {
			t.Errorf("tacked from 52° in %g knots: within 5° after %.1f s, keeping %.0f%%", knots, within, 100*least)
		}
	}
}
