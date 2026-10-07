// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// Helpers for the behaviour tests: a boat that sails in a steady wind, with
// a heading-hold.

const (
	knot = 1852.0 / 3600 // m/s
	deg  = math.Pi / 180
)

// windAtSail returns the wind 10 m up that blows at knots at sail height,
// about 3 m, where the reference data's wind is taken.
func windAtSail(knots float64) float64 {
	return knots * knot * math.Log(10/seaRoughness) / math.Log(3/seaRoughness)
}

type sim struct {
	t      testing.TB
	b      *Prepared
	s      State
	c      Control
	e      Env
	o      Out
	time   float64
	steer  bool
	target float64
	// minMode is the lowest sailor mode seen; maxHeel the greatest heel to
	// either side, in degrees.
	maxMode float64
	maxHeel float64
}

// newSim puts the Jolly boat at heading (degrees) in a wind 10 m up of wind
// m/s from the north, with the sheet at sheet and a heading-hold on.
func newSim(t testing.TB, wind, heading, sheet float64) *sim {
	t.Helper()
	b := jolly(t)
	m := &sim{t: t, b: b}
	m.e.WindSpeed = wind
	m.s.Heading = heading * deg
	m.s.Surge = 2
	m.s.SheetLimit = b.boomIn + sheet*(b.boomOut-b.boomIn)
	// The boom starts out on its stop to leeward: on port tack, heading
	// east of north, to starboard.
	m.s.Boom = math.Copysign(m.s.SheetLimit, math.Sin(m.s.Heading))
	m.c.Sheet = sheet
	m.hold(heading)
	return m
}

// hold steers toward heading, degrees.
func (m *sim) hold(heading float64) {
	m.steer, m.target = true, math.Remainder(heading*deg, 2*math.Pi)
}

// run sails for seconds, calling each, if not nil, after every step.
func (m *sim) run(seconds float64, each func()) {
	for range int(math.Round(seconds * StepsPerSecond)) {
		if m.steer {
			m.c.Helm = steer(m.target, &m.s)
		}
		Step(&m.s, &m.c, &m.e, m.b, &m.o)
		m.time += Dt
		m.maxMode = max(m.maxMode, m.s.SailorMode)
		m.maxHeel = max(m.maxHeel, math.Abs(m.s.Heel)/deg)
		if each != nil {
			each()
		}
	}
}

// mean returns the mean of f over seconds of sailing.
func (m *sim) mean(seconds float64, f func() float64) float64 {
	sum, n := 0.0, 0
	m.run(seconds, func() { sum += f(); n++ })
	return sum / float64(n)
}

func (m *sim) speed() float64 { return math.Hypot(m.s.Surge, m.s.Sway) }

// windward returns the boat's progress toward the wind, from the north, m.
func (m *sim) windward() float64 { return m.s.Y }
