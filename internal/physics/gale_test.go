// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// galeRun is what ten minutes in a gale measured.
type galeRun struct {
	capsizes        int
	maxPitch, heave float64 // the most pitch, degrees; the heave's swing, 4σ, m
	pitchSD         float64 // degrees
	maxHeel         float64 // degrees, while sailing
	rms             float64 // off the angle held after the first minute, degrees
	speed           float64 // mean, knots
}

// sailGale sails the Jolly boat ten minutes in a steady wind of knots from
// the north, in sea, or in flat water if sea is nil: on the autopilot at
// angle degrees off the wind with the boom out boom degrees, or, at an
// angle of 0, at rest with the sail let fly and nothing steering.
func sailGale(t *testing.T, sea *ocean, knots, angle, boom float64) galeRun {
	t.Helper()
	b := jolly(t)
	m := &sim{t: t, b: b}
	if sea != nil {
		m.in(sea)
	}
	m.e = Env{WindSpeed: knots * knot}
	sheet := (boom - 4) / (95 - 4)
	m.c.Sheet = sheet
	m.s.SheetLimit = b.boomIn + sheet*(b.boomOut-b.boomIn)
	if angle == 0 {
		// Beam on to the wind and the sea, lying with the sail let fly.
		m.s.Heading = 90 * deg
	} else {
		m.s.Heading = wrapAngle(-angle * deg)
		m.s.Surge = 2
		m.c.Pilot = PilotWind
		m.c.Target = pilotTarget(angle)
	}
	m.s.Boom = math.Copysign(m.s.SheetLimit, math.Sin(m.s.Heading))
	var r galeRun
	var sum, n, heave, heave2, pitch, pitch2, ns float64
	was := m.s.SailorMode
	m.run(600, func() {
		for _, v := range append(fields(&m.s), fields(&m.o)...) {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				t.Fatalf("%g knots, %g° off: not finite at %.1f s: %+v", knots, angle, m.time, m.s)
			}
		}
		if m.s.SailorMode != Sailing && was == Sailing {
			r.capsizes++
		}
		was = m.s.SailorMode
		r.maxPitch = max(r.maxPitch, math.Abs(m.s.Pitch)/deg)
		heave += m.s.Heave
		heave2 += m.s.Heave * m.s.Heave
		pitch += m.s.Pitch
		pitch2 += m.s.Pitch * m.s.Pitch
		ns++
		if m.s.SailorMode == Sailing {
			r.maxHeel = max(r.maxHeel, math.Abs(m.s.Heel)/deg)
		}
		if angle == 0 || m.time < 60 {
			return
		}
		off := wrapAngle(wrapAngle(-m.s.Heading) - angle*deg)
		sum += off * off
		n++
		r.speed += m.speed()
	})
	r.heave = 4 * math.Sqrt(max(heave2/ns-(heave/ns)*(heave/ns), 0))
	r.pitchSD = math.Sqrt(max(pitch2/ns-(pitch/ns)*(pitch/ns), 0)) / deg
	if n > 0 {
		r.rms = math.Sqrt(sum/n) / deg
		r.speed /= n * knot
	}
	return r
}

// The Jolly boat in a gale's sea, the stretched sea of 34 knots over open
// water: ten minutes at rest, and on the autopilot close-hauled, on a beam
// reach and on a run with the handbook's trim for a breeze (on the run its
// 150° row: eased further, as its 170° row has it, she death-rolls in a
// gale in flat water too). The sea alone capsizes her no more than the
// same wind does in flat water; nothing stops being a number; she pitches
// within her hull's limits and the autopilot holds its angle.
func TestJollyBoatInAGalesSea(t *testing.T) {
	const knots = 34
	sea := openSea(t, knots, 0, 6)
	if hs := sea.Window.Hs[0]; hs < 1.8 {
		t.Fatalf("a gale's sea of %.2f m: not the stretched sea", hs)
	}
	for _, c := range []struct {
		name        string
		angle, boom float64
	}{
		{"at rest", 0, 95},
		{"close-hauled", 45, 18},
		{"beam reach", 90, 40},
		{"run", 160, 60},
	} {
		flat := sailGale(t, nil, knots, c.angle, c.boom)
		wavy := sailGale(t, sea, knots, c.angle, c.boom)
		t.Logf("%s: in the sea %d capsizes, pitch %.1f° σ (%.1f° most), heave %.2f m, heel %.0f° most, %.1f° rms off, %.1f knots; flat water %d capsizes, heel %.0f°, %.1f° rms, %.1f knots",
			c.name, wavy.capsizes, wavy.pitchSD, wavy.maxPitch, wavy.heave, wavy.maxHeel, wavy.rms, wavy.speed, flat.capsizes, flat.maxHeel, flat.rms, flat.speed)
		if wavy.capsizes > flat.capsizes {
			t.Errorf("%s: capsized %d times in the sea, %d in flat water", c.name, wavy.capsizes, flat.capsizes)
		}
		if wavy.maxPitch > 30 {
			t.Errorf("%s: pitched %.0f°", c.name, wavy.maxPitch)
		}
		if c.angle != 0 && wavy.capsizes == 0 && wavy.rms > 10 {
			t.Errorf("%s: %.1f° rms off the angle held", c.name, wavy.rms)
		}
	}
}
