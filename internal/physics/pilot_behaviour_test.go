// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// The autopilot sailing the Jolly boat in the catalog's spells: what a
// sailor who hands over the tiller gets. The boat starts at mid-disk with
// the wind from the north and its sheet where a sailor would set it for the
// angle and the wind; the autopilot never touches the sheet.

// boatFields is how many of State's fields are the boat's, before the
// autopilot's.
const boatFields = 19

// pilotTarget is an angle off the wind, or a heading, in degrees, as the
// control carries it.
func pilotTarget(degrees float64) float64 {
	return math.Mod(math.Round(degrees*degreeSteps)+TurnSteps, TurnSteps)
}

// onPilot puts the Jolly boat at mid-disk in w, at angle degrees off its
// mean wind (positive with the wind over starboard), with the sheet at
// sheet and its boom out to leeward, and the autopilot on in mode holding
// that angle, or the heading it makes.
func onPilot(t testing.TB, b *Prepared, w *Weather, angle, sheet float64, mode float64) *sim {
	t.Helper()
	m := &sim{t: t, b: b}
	m.under(w)
	m.s.X, m.s.Y = 0, 2.1*nm
	WeatherAt(w, &m.wt, m.tick)
	m.e = WindAt(&m.wt, m.s.X, m.s.Y)
	m.s.Heading = wrapAngle(m.e.MeanFrom - angle*deg)
	m.s.Surge = 2
	m.s.SheetLimit = b.boomIn + sheet*(b.boomOut-b.boomIn)
	m.s.Boom = -math.Copysign(m.s.SheetLimit, angle)
	m.c.Sheet = sheet
	m.c.Pilot = mode
	m.c.Target = pilotTarget(angle)
	if mode == PilotHeading {
		m.c.Target = pilotTarget(m.s.Heading / deg)
	}
	return m
}

// angle is the boat's angle off the mean wind, rad.
func (m *sim) angle() float64 { return wrapAngle(m.e.MeanFrom - m.s.Heading) }

// pilotRun is what a sail on the autopilot measured after its first minute.
type pilotRun struct {
	rms, most float64 // off the angle held, rad
	capsizes  int
	speed     float64 // mean, m/s
	// Each step's heading, the mean wind's direction and the gust's veer:
	// the wind's direction less the mean's.
	heading, mean, veer []float64
}

// holdAngle sails m for seconds, measuring how far it holds angle degrees
// off the mean wind.
func holdAngle(m *sim, seconds, angle float64) pilotRun {
	var r pilotRun
	sum, n := 0.0, 0
	was := m.s.SailorMode
	m.run(seconds, func() {
		if m.s.SailorMode != Sailing && was == Sailing {
			r.capsizes++
		}
		was = m.s.SailorMode
		if m.time < 60 {
			return
		}
		off := wrapAngle(m.angle() - angle*deg)
		sum += off * off
		n++
		r.most = max(r.most, math.Abs(off))
		r.speed += m.speed()
		r.heading = append(r.heading, m.s.Heading)
		r.mean = append(r.mean, m.e.MeanFrom)
		r.veer = append(r.veer, wrapAngle(m.e.WindFrom-m.e.MeanFrom))
	})
	r.rms = math.Sqrt(sum / float64(n))
	r.speed /= float64(n)
	return r
}

// unwrap makes a series of angles continuous.
func unwrap(a []float64) []float64 {
	out := make([]float64, len(a))
	for i, x := range a {
		out[i] = x
		if i > 0 {
			out[i] = out[i-1] + wrapAngle(x-a[i-1])
		}
	}
	return out
}

// slope is the least-squares slope of b on a.
func slope(a, b []float64) float64 {
	var ma, mb float64
	for i := range a {
		ma += a[i]
		mb += b[i]
	}
	ma /= float64(len(a))
	mb /= float64(len(b))
	var cov, va float64
	for i := range a {
		cov += (a[i] - ma) * (b[i] - mb)
		va += (a[i] - ma) * (a[i] - ma)
	}
	return cov / va
}

// It holds an angle through the shifts and ignores the gusts. Over ten
// minutes in the catalog's spells 1 and 2 of each regime, at angles from
// close-hauled to a run, with a sheet set for the angle and the wind, the
// boat stays upright and within 1° rms and 3° at most of its angle to the
// mean wind, its heading follows the mean wind's shifts (a correlation
// above 0.95), and it turns with the gusts' veer by under a fifth of it:
// what it steers by is the mean wind. Steered by the gusty wind instead, it
// would turn with all of the veer, 3–5° rms. What turning is left is the
// boat's own: close-hauled in a breeze, a gust heels her and she rounds up.
func TestPilotHoldsAnAngleThroughTheShifts(t *testing.T) {
	p := testWeather(t)
	b := jolly(t)
	type point struct{ angle, sheet float64 }
	light := []point{{45, 0.02}, {90, 0.23}, {150, 0.75}}
	// Close-hauled in a trade spell's upper winds, a sheet hauled in hard
	// capsizes the boat: it is eased a little.
	trade2 := []point{{45, 0.1}, {90, 0.23}, {150, 0.75}}
	breeze := []point{{45, 0.15}, {90, 0.4}, {130, 0.6}, {170, 0.75}}
	for _, c := range []struct {
		regime string
		n      uint32
		points []point
	}{
		{"settled", 1, light}, {"settled", 2, light}, {"trade", 1, light}, {"trade", 2, trade2},
		{"unsettled", 1, breeze}, {"unsettled", 2, breeze}, {"stormy", 1, breeze}, {"stormy", 2, breeze},
	} {
		s := spellOfRegime(t, p, c.regime, c.n, 0, 0, 0)
		for _, pt := range c.points {
			m := onPilot(t, b, weatherOf(p, s), pt.angle, pt.sheet, PilotWind)
			r := holdAngle(m, 600, pt.angle)
			follows := correlation(unwrap(r.heading), unwrap(r.mean))
			resid := make([]float64, len(r.heading))
			for i := range resid {
				resid[i] = wrapAngle(r.heading[i] - r.mean[i])
			}
			gusts := slope(r.veer, resid)
			t.Logf("%s %d, %.1f knots, %3.0f° with the sheet at %.2f: %.2f° rms, %.2f° at most off the angle, %.1f knots; the heading follows the mean wind with a correlation of %.3f and turns %.4f° a degree of the gusts' veer",
				c.regime, c.n, s.Speed*SeaSpeedStep/knot, pt.angle, pt.sheet, r.rms/deg, r.most/deg, r.speed/knot, follows, gusts)
			if r.capsizes > 0 || r.rms > 1*deg || r.most > 3*deg || follows < 0.95 || math.Abs(gusts) > 0.2 {
				t.Errorf("%s %d at %.0f°: %d capsizes, %.2f° rms, %.2f° at most, the mean wind followed with a correlation of %.3f, %.4f° a degree of veer",
					c.regime, c.n, pt.angle, r.capsizes, r.rms/deg, r.most/deg, follows, gusts)
			}
		}
	}
}

// turn orders m's autopilot, holding angle degrees, to tack or gybe onto
// the mirrored angle, and sails 30 s. It returns how long the boat took to
// come within 5° of the new angle, the least share of its speed it kept,
// the least and greatest angle off the wind it passed, in degrees, and
// whether it capsized.
func turn(m *sim, angle, way float64) (within, least, nearest, furthest float64, capsized bool) {
	start, t0 := m.speed(), m.time
	m.c.Target = pilotTarget(-angle)
	m.c.Order = math.Mod(m.c.Order+1, PilotOrders)
	m.c.Way = way
	least, within, nearest = 1, math.Inf(1), 180
	m.run(30, func() {
		a := m.angle()
		least = min(least, m.speed()/start)
		nearest = min(nearest, math.Abs(a)/deg)
		furthest = max(furthest, math.Abs(a)/deg)
		if math.IsInf(within, 1) && math.Abs(wrapAngle(a+angle*deg)) < 5*deg {
			within = m.time - t0
		}
		capsized = capsized || m.s.SailorMode != Sailing
	})
	return within, least, nearest, furthest, capsized
}

// steadyOf is spell 1 of a regime with no shifts and no gusts.
func steadyOf(t *testing.T, p *WeatherPrepared, regime string) Spell {
	s := spellOfRegime(t, p, regime, 1, 0, 0, 0)
	s.Shift, s.Gust, s.Across, s.Drift = [2]float64{}, 1000, 0, 0
	return s
}

// It tacks and gybes. In a trade spell's steady wind, a tack from 45° ends
// within 5° of 45° on the other tack in under 6 s, keeping over 60% of the
// speed, and a gybe from 150° in under 6 s keeping over 75%; in a stormy
// spell a gybe at a third of the helm does not capsize. A tack never comes
// near dead downwind, a gybe never near head to wind.
func TestPilotTacksAndGybes(t *testing.T) {
	p := testWeather(t)
	b := jolly(t)
	for _, c := range []struct {
		regime        string
		angle, sheet  float64
		way           float64
		within, least float64
	}{
		{"trade", 45, 0.02, WayTack, 6, 0.6},
		{"trade", -45, 0.02, WayTack, 6, 0.6},
		{"trade", 150, 0.75, WayGybe, 6, 0.75},
		{"trade", -150, 0.75, WayGybe, 6, 0.75},
		{"stormy", 150, 0.75, WayGybe, 6, 0.75},
		{"stormy", 170, 0.75, WayGybe, 6, 0.75},
		// From a run, a tack is turned all the way round through the wind.
		{"trade", 160, 0.75, WayTack, 30, 0},
	} {
		s := steadyOf(t, p, c.regime)
		m := onPilot(t, b, weatherOf(p, s), c.angle, c.sheet, PilotWind)
		m.run(60, nil)
		within, least, nearest, furthest, capsized := turn(m, c.angle, c.way)
		t.Logf("%s, %.1f knots: from %.0f°, way %v: within 5° after %.1f s, keeping %.0f%% of the speed, between %.0f° and %.0f° off the wind",
			c.regime, s.Speed*SeaSpeedStep/knot, c.angle, c.way, within, 100*least, nearest, furthest)
		if within > c.within || least < c.least || capsized {
			t.Errorf("%s from %.0f°, way %v: within 5° after %.1f s, keeping %.0f%%, capsized %v", c.regime, c.angle, c.way, within, 100*least, capsized)
		}
		if c.way == WayTack && furthest > 175 || c.way == WayGybe && nearest < 90 {
			t.Errorf("%s from %.0f°, way %v: the other way round, between %.0f° and %.0f° off the wind", c.regime, c.angle, c.way, nearest, furthest)
		}
	}
}

// It never gybes unasked. A heading across dead downwind is reached through
// the wind; a boat pushed 10° by the lee steers back up without its boom
// crossing; one 20° by the lee has gybed, and holds its angle on its new
// tack rather than gybe back or turn all the way round.
func TestPilotNeverGybesUnasked(t *testing.T) {
	p := testWeather(t)
	b := jolly(t)
	s := steadyOf(t, p, "trade")

	m := onPilot(t, b, weatherOf(p, s), 90, 0.5, PilotHeading)
	m.run(30, nil)
	// The heading of 150° off the wind on port tack.
	m.c.Target = pilotTarget(math.Mod(m.e.MeanFrom/deg+150+360, 360))
	_, _, nearest, furthest, capsized := turn(m, -150, WayHold)
	m.c.Target = pilotTarget(math.Mod(m.e.MeanFrom/deg+150+360, 360))
	m.run(60, nil)
	t.Logf("from a beam reach to a heading 150° off the wind on the other tack: between %.0f° and %.0f° off the wind, ending at %.1f°", nearest, furthest, m.angle()/deg)
	if nearest > 10 || furthest > 155 || math.Abs(m.angle()/deg+150) > 3 || capsized {
		t.Errorf("a heading across dead downwind: between %.0f° and %.0f° off the wind, ending at %.1f°, capsized %v", nearest, furthest, m.angle()/deg, capsized)
	}

	for _, c := range []struct {
		lee, want float64
		crosses   bool
	}{{10, 165, false}, {20, -165, true}} {
		m := onPilot(t, b, weatherOf(p, s), 165, 0.75, PilotWind)
		m.run(30, nil)
		// Pushed by the lee, the boom still to port.
		m.s.Heading = wrapAngle(m.e.MeanFrom - (180+c.lee)*deg)
		m.s.YawRate = 0
		crossed, nearest := false, 180.0
		m.run(30, func() {
			crossed = crossed || m.s.Boom > 0
			nearest = min(nearest, math.Abs(m.angle())/deg)
		})
		t.Logf("%.0f° by the lee: ends at %.1f° off the wind, the boom crossed %v, %.0f° off the wind at the nearest", c.lee, m.angle()/deg, crossed, nearest)
		if math.Abs(m.angle()/deg-c.want) > 3 || crossed != c.crosses || nearest < 90 {
			t.Errorf("%.0f° by the lee: ends at %.1f° off the wind, not %.0f°; the boom crossed %v, %.0f° off the wind at the nearest", c.lee, m.angle()/deg, c.want, crossed, nearest)
		}
	}
}

// The physics are unchanged: close-hauled on the autopilot with the sheet
// hauled in, in an unsettled spell, the boat capsizes; and with the
// autopilot's helm fed in by hand instead, every step gives the same bits.
func TestPilotLeavesThePhysicsAlone(t *testing.T) {
	p := testWeather(t)
	b := jolly(t)
	s := spellOfRegime(t, p, "unsettled", 1, 0, 0, 0)
	m := onPilot(t, b, weatherOf(p, s), 45, 0.02, PilotWind)
	hand := onPilot(t, b, weatherOf(p, s), 45, 0.02, PilotOff)
	capsizes, was := 0, m.s.SailorMode
	for i := range 600 * StepsPerSecond {
		m.step()
		if m.s.SailorMode != Sailing && was == Sailing {
			capsizes++
		}
		was = m.s.SailorMode
		hand.c.Helm = m.o.PilotHelm
		hand.step()
		a, h := fields(&m.s)[:boatFields], fields(&hand.s)[:boatFields]
		for j := range a {
			if math.Float64bits(a[j]) != math.Float64bits(h[j]) {
				t.Fatalf("step %d: the state's field %d is %v on the autopilot and %v by hand", i, j, a[j], h[j])
			}
		}
	}
	t.Logf("close-hauled with the sheet hauled in, %.1f knots: %d capsizes in 10 minutes", s.Speed*SeaSpeedStep/knot, capsizes)
	if capsizes == 0 {
		t.Error("the boat on the autopilot with its sheet hauled in never capsized in an unsettled spell")
	}
}

// Heading mode upwind wanders in the shifts: holding a compass heading set
// 45° off a trade spell's wind, the angle to the wind swings with the
// shifts, as a sail does when the shift shows in it.
func TestPilotHeadingModeWandersUpwind(t *testing.T) {
	p := testWeather(t)
	s := spellOfRegime(t, p, "trade", 1, 0, 0, 0)
	m := onPilot(t, jolly(t), weatherOf(p, s), 45, 0.02, PilotHeading)
	r := holdAngle(m, 600, 45)
	t.Logf("a heading set 45° off a trade spell's wind: %.1f° rms and %.0f° at most off that angle, %d capsizes", r.rms/deg, r.most/deg, r.capsizes)
	if r.rms < 3*deg {
		t.Errorf("a heading upwind: the angle to the wind kept within %.1f° rms", r.rms/deg)
	}
}
