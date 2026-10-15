// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// The boat in the wind of a spell: what a sailor meets.

// helmsman steers as someone at the tiller does toward a heading that may
// change: the helm follows how far off course the boat was seen to be a
// third of a second ago, and moves no faster than a hand does.
type helmsman struct {
	seen [10]float64
	n    int
	helm float64
}

func (h *helmsman) steer(target float64, s *State) float64 {
	h.seen[h.n%len(h.seen)] = s.Heading
	h.n++
	was := h.seen[0]
	if h.n >= len(h.seen) {
		was = h.seen[h.n%len(h.seen)]
	}
	want := max(-1, min(1, math.Remainder(target-was, 2*math.Pi)))
	h.helm += max(-2*Dt, min(2*Dt, want-h.helm))
	return h.helm
}

// follows is how well b follows a: their greatest correlation with b up to
// five seconds behind, and how far behind, in seconds.
func follows(a, b []float64) (c, behind float64) {
	c = -1
	for lag := 0; lag <= 5*StepsPerSecond; lag++ {
		if x := correlation(a[:len(a)-lag], b[lag:]); x > c {
			c, behind = x, float64(lag)*Dt
		}
	}
	return c, behind
}

// reach puts a boat on a beam reach at mid-disk in a spell whose wind comes
// from the north, and sails it for ten minutes, after half a minute to
// settle, keeping the wind at the boat and what of returns after each step.
func reach(t *testing.T, b *Prepared, w *Weather, sheet float64, of func(m *sim) float64) (wind, kept []float64) {
	t.Helper()
	m := &sim{t: t, b: b}
	m.under(w)
	m.s.X, m.s.Y, m.s.Heading, m.s.Surge = 0, 2.1*nm, 90*deg, 2
	m.c.Sheet = sheet
	m.s.SheetLimit = b.boomIn + sheet*(b.boomOut-b.boomIn)
	m.s.Boom = m.s.SheetLimit
	var h helmsman
	for i := range 630 * StepsPerSecond {
		m.c.Helm = h.steer(90*deg, &m.s)
		m.step()
		if m.s.SailorMode != Sailing {
			t.Fatalf("the boat capsized after %.0f s on a reach in %.1f knots", m.time, m.e.WindSpeed/knot)
		}
		if i >= 30*StepsPerSecond {
			wind, kept = append(wind, m.e.WindSpeed), append(kept, of(m))
		}
	}
	return wind, kept
}

// Heel follows a gust. A boat whose sailor sits still heels with the wind
// at the boat: on a reach in a settled spell, its shifts stilled so that
// the boat keeps its angle to the wind, heel and wind rise and fall
// together over ten minutes, the heel behind by under two seconds. A
// sailor who hikes keeps the boat flat instead, and it is the hiking that
// follows the gusts: in a trade spell, shifts and all.
func TestHeelFollowsTheGusts(t *testing.T) {
	p := testWeather(t)
	var sf scenarioFile
	readJSON(t, scenariosFile, &sf)
	var params Params
	if err := setParams(&params, sf.Params); err != nil {
		t.Fatal(err)
	}
	params.HikeReach, params.LeeReach = 0, 0
	var still Prepared
	Prepare(&params, testWaves(t), &still)
	for _, n := range []uint32{2, 4} {
		s := spellOfRegime(t, p, "settled", n, 0, 0, 0)
		s.Shift, s.Across = [2]float64{}, 0
		wind, heel := reach(t, &still, weatherOf(p, s), 0.3, func(m *sim) float64 { return m.s.Heel })
		c, behind := follows(wind, heel)
		t.Logf("a sailor sitting still, a settled spell of %.1f knots: the heel follows the wind %.2f s behind, with a correlation of %.2f", s.Speed*SeaSpeedStep/knot, behind, c)
		if c < 0.9 || behind >= 2 {
			t.Errorf("settled spell %d: the heel follows the wind %.2f s behind with a correlation of %.2f", n, behind, c)
		}
	}
	for _, n := range []uint32{1, 2, 3} {
		s := spellOfRegime(t, p, "trade", n, 0, 0, 0)
		steepest := 0.0
		wind, hiked := reach(t, jolly(t), weatherOf(p, s), 0.3, func(m *sim) float64 {
			steepest = max(steepest, math.Abs(m.s.Heel))
			return -m.s.Sailor
		})
		c, behind := follows(wind, hiked)
		t.Logf("a sailor hiking, a trade spell of %.1f knots: the hiking follows the wind %.2f s behind, with a correlation of %.2f; the boat heels %.1f° at most", s.Speed*SeaSpeedStep/knot, behind, c, steepest/deg)
		if c < 0.85 || behind >= 2 || steepest > 10*deg {
			t.Errorf("trade spell %d: the hiking follows the wind %.2f s behind with a correlation of %.2f, and the boat heels %.1f°", n, behind, c, steepest/deg)
		}
	}
}

// beat sails a boat to windward of dir for seconds in w from (x, y),
// close-hauled on the wind it feels over the last few seconds, easing the
// sheet when it heels, and returns how far it made good to windward. It
// tacks on every header of more than 5° from dir, felt over twenty seconds,
// if headers; every five minutes if not.
func beat(t *testing.T, w *Weather, x, y, dir, seconds float64, headers bool) (made float64, tacks int) {
	t.Helper()
	const close = 45 * deg
	m := &sim{t: t, b: jolly(t)}
	m.under(w)
	m.s.X, m.s.Y, m.s.Heading, m.s.Surge = x, y, dir-close, 2
	m.c.Sheet = 0.1
	m.s.SheetLimit = m.b.boomIn + 0.1*(m.b.boomOut-m.b.boomIn)
	m.s.Boom = m.s.SheetLimit
	var h helmsman
	// On starboard tack the boat heads to the left of the wind.
	side := -1.0
	var felt, slow, last float64
	for i := range int(seconds * StepsPerSecond) {
		WeatherAt(m.wx, &m.wt, m.tick)
		off := wrapAngle(WindAt(&m.wt, m.s.X, m.s.Y, nil).WindFrom - dir)
		if i == 0 {
			felt, slow = off, off
		}
		felt += (off - felt) * Dt / 3
		slow += (off - slow) * Dt / 20
		now := float64(i) * Dt
		// A header: on starboard the wind backing, on port it veering.
		headed := side < 0 && slow < -5*deg || side > 0 && slow > 5*deg
		if headers && headed && now-last > 30 || !headers && now-last >= 300 {
			side, last = -side, now
			tacks++
		}
		m.c.Helm = h.steer(dir+felt+side*close, &m.s)
		m.c.Sheet = clamp(0.1+3*(math.Abs(m.s.Heel)-8*deg), 0.1, 0.7)
		m.step()
		if m.s.SailorMode != Sailing {
			t.Fatalf("the boat capsized beating, after %.0f s", m.time)
		}
	}
	return (m.s.X-x)*math.Sin(dir) + (m.s.Y-y)*math.Cos(dir), tacks
}

// shiftsGain is how much further to windward, as a share, a boat that tacks
// on the headers gets in twenty minutes than one that tacks every five, in
// each of the first spells of a regime, from the same place.
func shiftsGain(t *testing.T, p *WeatherPrepared, id string, spells int) (gains []float64) {
	t.Helper()
	for n := range spells {
		s := spellOfRegime(t, p, id, uint32(n+1), 0, 0, 0)
		s.Drift = 0
		w := weatherOf(p, s)
		played, _ := beat(t, w, 3000, -1500, 0, 1200, true)
		clock, _ := beat(t, w, 3000, -1500, 0, 1200, false)
		gains = append(gains, played/clock-1)
	}
	return gains
}

// Racers can play the shifts: of two Jolly boats beating for twenty minutes
// in a trade spell from the same place, steered as a person steers, the one
// that tacks on every header of more than 5° makes good more distance to
// windward than the one that tacks every five minutes: 2.5% more over six
// spells, and more in most of them. One spell is a few shifts, and a clock
// sometimes falls in step with them.
func TestPlayingTheShifts(t *testing.T) {
	p := testWeather(t)
	gains := shiftsGain(t, p, "trade", 6)
	sum, won := 0.0, 0
	for _, g := range gains {
		sum += g
		if g > 0 {
			won++
		}
	}
	mean := sum / float64(len(gains))
	t.Logf("tacking on the headers makes good %+.1f%% more to windward over six trade spells (%+.1f%% each)", 100*mean, scale(gains, 100))
	if mean < 0.025 || won < 4 {
		t.Errorf("tacking on the headers makes good %+.1f%% more over six trade spells, and more in %d of them", 100*mean, won)
	}
	if testing.Verbose() && !testing.Short() {
		for _, id := range []string{"settled", "unsettled"} {
			t.Logf("%s spells: %+.1f%% each", id, scale(shiftsGain(t, p, id, 6), 100))
		}
	}
}

func scale(v []float64, k float64) []float64 {
	out := make([]float64, len(v))
	for i := range v {
		out[i] = k * v[i]
	}
	return out
}

// A capsize in a gust is the physics': on a reach in a stormy spell's outer
// waters, with the sheet eased as far as the mean wind asks, the boat sails
// ten minutes in the mean wind alone, and in the same wind with its gusts
// it capsizes.
func TestCapsizeInAGust(t *testing.T) {
	p := testWeather(t)
	sail := func(w *Weather, gusts bool) (capsized, wind float64) {
		m := &sim{t: t, b: jolly(t)}
		m.tick = worldTick
		m.s.X, m.s.Y, m.s.Heading, m.s.Surge = 0, 3.5*nm, 90*deg, 2
		m.c.Sheet = 0.35
		m.s.SheetLimit = m.b.boomIn + 0.35*(m.b.boomOut-m.b.boomIn)
		m.s.Boom = m.s.SheetLimit
		var h helmsman
		var at WeatherTick
		for range 600 * StepsPerSecond {
			WeatherAt(w, &at, m.tick)
			m.e = WindAt(&at, m.s.X, m.s.Y, nil)
			if !gusts {
				m.e.WindSpeed, m.e.WindFrom = MeanWindAt(&at, m.s.X, m.s.Y)
			}
			m.c.Helm = h.steer(90*deg, &m.s)
			m.step()
			if m.s.SailorMode != Sailing {
				return m.time, m.e.WindSpeed
			}
		}
		return 0, 0
	}
	for _, n := range []uint32{1, 2} {
		s := spellOfRegime(t, p, "stormy", n, 0, 0, 0)
		w := weatherOf(p, s)
		if at, wind := sail(w, false); at != 0 {
			t.Errorf("stormy spell %d: in the mean wind alone the boat capsized after %.0f s, in %.1f knots", n, at, wind/knot)
		}
		at, wind := sail(w, true)
		if at == 0 {
			t.Errorf("stormy spell %d: the boat sailed ten minutes through the gusts", n)
			continue
		}
		mean := s.Speed * SeaSpeedStep * (p.speedCentre + p.speedSpan*smooth(3.5*nm/p.rim))
		t.Logf("stormy spell %d, %.1f knots at 3.5 NM: capsized after %.0f s in a gust of %.1f knots", n, mean/knot, at, wind/knot)
		if wind < 1.15*mean {
			t.Errorf("stormy spell %d: the boat capsized in %.1f knots, no gust over the mean %.1f", n, wind/knot, mean/knot)
		}
	}
}
