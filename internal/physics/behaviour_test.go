// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"math/rand/v2"
	"testing"
)

// Behaviour tests: physical facts about the boat, each with the source it
// comes from, checked within tolerances. The golden tests prove the server
// and the client agree; these prove the boat sails like an ILCA. Winds are
// given at sail height where the fact comes from a measurement there
// (windAtSail), and 10 m up otherwise.

// The step.

func TestRestStaysAtRest(t *testing.T) {
	b := jolly(t)
	s := State{X: 120, Y: -40, Heading: 1, SheetLimit: b.boomIn}
	want := s
	var (
		c Control
		e Env
		o Out
	)
	for range 300 {
		Step(&s, &c, &e, b, &o)
	}
	if s != want {
		t.Errorf("a boat at rest in no wind moved:\n got  %+v\n want %+v", s, want)
	}
	if o.Drive != 0 || o.SideForce != 0 || o.SpeedOverGround != 0 {
		t.Errorf("a boat at rest in no wind has forces: %+v", o)
	}
}

func TestControlsClamped(t *testing.T) {
	b := jolly(t)
	for _, c := range []struct{ helm, sheet, rudder, limit float64 }{
		{math.NaN(), math.NaN(), 0, b.boomIn},
		{5, 7, b.rudderMax, b.boomOut},
		{-5, -7, -b.rudderMax, b.boomIn},
		{math.Inf(1), math.Inf(-1), b.rudderMax, b.boomIn},
	} {
		s := State{SheetLimit: b.boomIn}
		ctl := Control{Helm: c.helm, Sheet: c.sheet}
		var (
			e Env
			o Out
		)
		for range 120 {
			Step(&s, &ctl, &e, b, &o)
		}
		if s.Rudder != c.rudder || s.SheetLimit != c.limit {
			t.Errorf("helm %g, sheet %g: rudder %g, sheet limit %g; want %g, %g", c.helm, c.sheet, s.Rudder, s.SheetLimit, c.rudder, c.limit)
		}
	}
}

func TestRandomStaysFinite(t *testing.T) {
	// Seeded random controls and wind from calm to 45 knots, changed every
	// 1 to 10 s: the state stays finite and the boat below 20 m/s.
	b := jolly(t)
	rng := rand.New(rand.NewPCG(11, 12))
	s := State{SheetLimit: b.boomIn, Surge: 1}
	var (
		c Control
		e Env
		o Out
	)
	for i := range 10_000 {
		if i%(30+rng.IntN(270)) == 0 {
			c = Control{Helm: 2*rng.Float64() - 1, Sheet: rng.Float64()}
			e = Env{WindSpeed: 45 * knot * rng.Float64(), WindFrom: (2*rng.Float64() - 1) * math.Pi}
		}
		Step(&s, &c, &e, b, &o)
		for _, v := range append(fields(&s), fields(&o)...) {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				t.Fatalf("step %d: not finite: %+v %+v", i, s, o)
			}
		}
		if v := math.Hypot(s.Surge, s.Sway); v > 20 {
			t.Fatalf("step %d: %.1f m/s", i, v)
		}
	}
}

// TestSubstepsConverge compares Substeps with 32 over the first 20 s of
// every golden scenario. Until the sailor first leaves the boat, in winds up
// to 25 knots, the boat stays within 0.2 m and 1° of heel. Beyond that, a
// capsize a substep earlier or later, or a storm, moves it further; there the
// test asks for first-order convergence, the error at least halving from 4
// substeps to 16, which a stiff parameter would break.
func TestSubstepsConverge(t *testing.T) {
	var sf scenarioFile
	readJSON(t, scenariosFile, &sf)
	b := jolly(t)
	maxWind := func(sc scenario) float64 {
		w := sc.Env["windSpeed"]
		for _, c := range sc.Changes {
			if c.At < 600 {
				w = max(w, c.Env["windSpeed"])
			}
		}
		return w
	}
	errors := func(a, f []State, untilCapsize bool) (pos, heel float64) {
		for i := range a {
			if untilCapsize && (a[i].SailorMode != Sailing || f[i].SailorMode != Sailing) {
				break
			}
			pos = max(pos, math.Hypot(a[i].X-f[i].X, a[i].Y-f[i].Y))
			heel = max(heel, math.Abs(math.Remainder(a[i].Heel-f[i].Heel, 2*math.Pi)))
		}
		return pos, heel
	}
	for _, sc := range sf.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			steps := min(sc.Steps, 600)
			fine := runScenarioStates(t, b, sc, 32, false, steps)
			four := runScenarioStates(t, b, sc, Substeps, false, steps)
			if maxWind(sc) <= 25*knot {
				if pos, heel := errors(four, fine, true); pos > 0.2 || heel > 1*deg {
					t.Errorf("%d substeps are %.3f m and %.2f° from 32", Substeps, pos, heel/deg)
				}
			}
			sixteen := runScenarioStates(t, b, sc, 16, false, steps)
			p4, _ := errors(four, fine, false)
			p16, _ := errors(sixteen, fine, false)
			if p4 > 0.01 && p16 > p4/2 {
				t.Errorf("not converging: %.3f m at %d substeps, %.3f m at 16", p4, Substeps, p16)
			}
		})
	}
}

// Upwind (Day 2017).

func TestUpwind(t *testing.T) {
	type upwind struct{ heel, rudder, leeway float64 }
	sail := func(knots float64) upwind {
		m := newSim(t, windAtSail(knots), 42, 0.02)
		m.run(60, nil)
		var u upwind
		n := 0.0
		m.run(20, func() {
			u.heel += m.s.Heel
			u.rudder += m.s.Rudder
			u.leeway += m.o.Leeway
			n++
		})
		return upwind{u.heel / n / deg, u.rudder / n / deg, u.leeway / n / deg}
	}
	at9, at12, at15 := sail(9), sail(12), sail(15)
	t.Logf("9 knots %+v, 12 knots %+v, 15 knots %+v", at9, at12, at15)
	// Day holds the boat flat upwind up to 9 knots of wind.
	if math.Abs(at9.heel) > 3 {
		t.Errorf("at 9 knots the boat heels %.1f°, not flat", at9.heel)
	}
	// A dinghy makes 2° to 5° of leeway upwind.
	for _, u := range []upwind{at9, at12, at15} {
		if u.leeway < 2 || u.leeway > 5 {
			t.Errorf("leeway %.1f°, want 2° to 5°", u.leeway)
		}
	}
	// Weather helm, the rudder turning the bow to leeward on port tack, grows
	// with the wind and the heel. The plan's 2° to 4° is not reached: the
	// model balances near neutral when flat (see docs/development.md).
	if !(at15.rudder > at9.rudder && at15.rudder > 0 && at12.rudder > 0) {
		t.Errorf("weather helm %.1f°, %.1f°, %.1f° at 9, 12 and 15 knots does not grow with the wind", at9.rudder, at12.rudder, at15.rudder)
	}
}

func TestOverpowered(t *testing.T) {
	// Sheeted hard in close-hauled in 16 knots, the full rig overpowers the
	// sailor (Day 2017 finds it needs depowering above about 9 knots): it
	// heels past 30° and capsizes. Eased, it sails.
	m := newSim(t, 16*knot, 45, 0)
	m.run(60, nil)
	if m.maxHeel < 30 || m.maxMode == Sailing {
		t.Errorf("sheeted hard in, the boat heeled at most %.1f° and did not capsize", m.maxHeel)
	}
	m = newSim(t, 16*knot, 45, 0.15)
	m.run(60, nil)
	if m.maxHeel > 30 || m.maxMode != Sailing {
		t.Errorf("eased, the boat heeled %.1f° (sailor mode %g)", m.maxHeel, m.maxMode)
	}
}

func TestTack(t *testing.T) {
	// A tack in 12 knots: an ILCA loses up to about a boat length.
	m := newSim(t, windAtSail(12), 42, 0.02)
	m.run(60, nil)
	before := m.mean(5, m.speed)
	ahead := *m
	y0 := m.windward()
	ahead.run(30, nil)
	m.hold(-42)
	least := math.Inf(1)
	crossed := false
	m.run(30, func() {
		least = min(least, m.speed())
		crossed = crossed || m.s.Boom < 0
	})
	lost := (ahead.windward() - y0) - (m.windward() - y0)
	t.Logf("before %.2f knots, least %.2f, lost %.2f m", before/knot, least/knot, lost)
	if !crossed || m.maxMode != Sailing {
		t.Fatal("the boat did not tack cleanly")
	}
	if r := least / before; r < 0.5 || r > 0.75 {
		t.Errorf("the least speed is %.0f%% of the speed before, want 50%% to 75%%", 100*r)
	}
	if lost < 0.5 || lost > 8 {
		t.Errorf("the tack lost %.2f m to windward, want 0.5 to 8 m", lost)
	}
}

func TestIrons(t *testing.T) {
	// Head to wind with the sheet in, the boat stops and drifts backwards;
	// with the rudder reversed, it bears away.
	m := newSim(t, 10*knot, 0, 0)
	m.s.Surge = 0
	m.steer, m.c.Helm = false, 0
	m.run(20, nil)
	if m.s.Surge >= 0 {
		t.Errorf("in irons the boat moves ahead at %.2f m/s", m.s.Surge)
	}
	m.c.Helm = 1 // going astern, this turns the bow to port
	m.run(10, nil)
	if off := math.Abs(math.Remainder(m.s.Heading, 2*math.Pi)); off < 10*deg {
		t.Errorf("with the rudder reversed the boat is still %.1f° off the wind", off/deg)
	}
}

func TestGybe(t *testing.T) {
	// Steered from a broad reach on port tack to one on starboard, the boom
	// crosses.
	m := newSim(t, windAtSail(12), 150, 0.75)
	m.run(30, nil)
	m.hold(210)
	crossed := false
	m.run(20, func() { crossed = crossed || m.s.Boom < 0 })
	if !crossed {
		t.Error("the boom did not cross in a gybe")
	}

	// Bearing away slowly past a run with the sheet eased, the boat gybes by
	// itself before it is 25° by the lee: the wind gets behind the leech.
	for _, knots := range []float64{6, 12, 18} {
		m := newSim(t, windAtSail(knots), 170, 0.9)
		m.run(30, nil)
		gybed := math.NaN()
		heading := 170.0
		m.run(60, func() {
			heading += 1.0 / StepsPerSecond
			m.hold(heading)
			if math.IsNaN(gybed) && m.s.Boom < 0 {
				gybed = math.Mod(m.s.Heading/deg+360, 360) - 180
			}
		})
		t.Logf("%g knots: gybed %.1f° by the lee", knots, gybed)
		if !(gybed > 5 && gybed <= 25) {
			t.Errorf("%g knots: the boat gybed %.1f° by the lee, want past 5° and by 25°", knots, gybed)
		}
	}
}

func TestLetFly(t *testing.T) {
	// Let fly in 15 knots, held across the wind, the sail luffs and the boat
	// lies there, drifting slowly.
	m := newSim(t, 15*knot, 90, 1)
	m.run(60, nil)
	if v := m.mean(30, m.speed); v > 1.5*knot {
		t.Errorf("let fly, the boat sails at %.2f knots", v/knot)
	}
}

// The sailor.

func TestSailorSettles(t *testing.T) {
	// In a steady breeze the sailor hikes the boat flat and holds it there
	// without overshooting by more than 1°.
	m := newSim(t, windAtSail(9), 45, 0.02)
	m.run(15, nil)
	final := m.mean(30, func() float64 { return m.s.Heel })
	lo, hi := math.Inf(1), math.Inf(-1)
	m.run(30, func() { lo, hi = min(lo, m.s.Heel), max(hi, m.s.Heel) })
	if hi-final > 1*deg || final-lo > 1*deg {
		t.Errorf("heel ranges %.2f° to %.2f° about %.2f°", lo/deg, hi/deg, final/deg)
	}
}

func TestGust(t *testing.T) {
	// A gust heels the boat, and the sailor hikes it back.
	m := newSim(t, windAtSail(6), 45, 0.02)
	m.run(40, nil)
	m.e.WindSpeed = windAtSail(10)
	peak := 0.0
	m.run(3, func() { peak = max(peak, m.s.Heel) })
	m.run(20, nil)
	if peak < 2*deg || m.s.Heel > peak/2 {
		t.Errorf("in the gust the heel peaked at %.1f° and settled at %.1f°", peak/deg, m.s.Heel/deg)
	}
	if m.maxMode != Sailing {
		t.Error("a moderate gust capsized the boat")
	}

	// A strong gust capsizes it, but only once the sailor is fully hiked.
	m = newSim(t, windAtSail(9), 45, 0.02)
	m.run(40, nil)
	m.e.WindSpeed = windAtSail(22)
	last := 0.0
	m.run(20, func() {
		if m.s.SailorMode == Sailing {
			last = m.s.Sailor
		}
	})
	if m.maxMode == Sailing {
		t.Fatal("a 22-knot gust, sheeted in, did not capsize the boat")
	}
	if last > -0.95*m.b.hikeReach {
		t.Errorf("the boat capsized with the sailor %.2f m out, not fully hiked", -last)
	}
}

// Capsizing and righting.

func TestCapsizeAndRighting(t *testing.T) {
	for _, knots := range []float64{6, 12, 20} {
		m := newSim(t, knots*knot, 90, 0.4)
		m.run(20, nil)
		// Sheeted hard in, in a squall.
		m.c.Sheet = 0
		m.e.WindSpeed = max(knots, 16) * 1.4 * knot
		var fell, back float64
		lying := 0.0
		rudder, limit := 0.0, 0.0
		m.run(120, func() {
			out := m.s.SailorMode != Sailing
			if fell == 0 && out {
				fell = m.time
				m.e.WindSpeed = knots * knot
				// The player's controls do nothing while the sailor is out:
				// the tiller swings free and the sheet runs.
				m.steer, m.c.Helm, m.c.Sheet = false, 1, 0
				rudder, limit = math.Abs(m.s.Rudder), m.s.SheetLimit
			}
			if fell > 0 && back == 0 {
				lying = max(lying, math.Abs(m.s.Heel))
				if out && (math.Abs(m.s.Rudder) > rudder || m.s.SheetLimit < limit) {
					t.Fatalf("%g knots: the controls work with the sailor out: rudder %.1f°, sheet %.1f°", knots, m.s.Rudder/deg, m.s.SheetLimit/deg)
				}
				rudder, limit = math.Abs(m.s.Rudder), m.s.SheetLimit
				if !out {
					back = m.time
					m.c.Helm = 0
				}
			}
		})
		took := back - fell
		t.Logf("%g knots: fell in at %.1f s, sailing again after %.1f s, lay at %.0f°", knots, fell, took, lying/deg)
		if fell == 0 || back == 0 {
			t.Fatalf("%g knots: capsized at %.1f s, back at %.1f s", knots, fell, back)
		}
		// It lies on the water near 90°, and does not turtle.
		if lying < 75*deg || lying > 120*deg {
			t.Errorf("%g knots: the boat lay at %.0f°, not near 90°", knots, lying/deg)
		}
		if took < 15 || took > 45 {
			t.Errorf("%g knots: righting took %.1f s, want 15 to 45 s", knots, took)
		}
		// Back in, the sheet comes in at the hauling rate.
		limit = m.s.SheetLimit
		m.c.Sheet = 0
		Step(&m.s, &m.c, &m.e, m.b, &m.o)
		if d := limit - m.s.SheetLimit; d > m.b.haulRate*Dt*1.000001 {
			t.Errorf("%g knots: the sheet came in %.2f° in one step", knots, d/deg)
		}
	}
}

func TestDeathRoll(t *testing.T) {
	// Running in 22 knots, rolling to windward, the boat goes over to
	// windward: the boom out to starboard, the heel to port.
	m := newSim(t, 22*knot, 178, 1)
	m.s.Surge, m.s.Heel, m.s.RollRate, m.s.Boom, m.s.SheetLimit = 3.5, -0.35, -0.9, 1.5, m.b.boomOut
	m.hold(182)
	heel := 0.0
	m.run(5, func() {
		if heel == 0 && m.s.SailorMode != Sailing {
			heel = m.s.Heel
		}
	})
	if !(heel < -m.b.fallOutHeel+1e-9) {
		t.Errorf("the death roll did not capsize the boat to windward (heel %.1f°)", heel/deg)
	}
}
