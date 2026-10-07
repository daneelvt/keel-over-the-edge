// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// Port and starboard are exact mirrors: a boat that sails better on one tack
// is a bug players would find. Every golden scenario is run as written and
// mirrored east for west, and the mirrored run must give the mirrored state
// at every step. The package's sine and arctangent are odd, and the model is
// written so that every term changes sign exactly, so the two agree to the
// bit; the test allows 10⁻¹² for a later change of summation order.

// mirror turns a state east for west: positions east, headings, turning,
// sideways motion, heel and everything to one side change sign.
func mirror(s State) State {
	s.X, s.Heading, s.Sway, s.YawRate = -s.X, -s.Heading, -s.Sway, -s.YawRate
	s.Heel, s.RollRate, s.Boom, s.BoomRate = -s.Heel, -s.RollRate, -s.Boom, -s.BoomRate
	s.Sailor, s.Rudder = -s.Sailor, -s.Rudder
	return s
}

// runScenarioStates runs a golden scenario with n substeps, mirrored or not,
// and returns the state after every step.
func runScenarioStates(t *testing.T, b *Prepared, sc scenario, n int32, mirrored bool, steps int) []State {
	t.Helper()
	var (
		s State
		c Control
		e Env
		o Out
	)
	for _, set := range []struct {
		record any
		values map[string]float64
	}{{&s, sc.State}, {&c, sc.Control}, {&e, sc.Env}} {
		if err := setFields(set.record, set.values); err != nil {
			t.Fatal(err)
		}
	}
	flip := func() {
		c.Helm, e.WindFrom = -c.Helm, -e.WindFrom
	}
	if mirrored {
		s = mirror(s)
		flip()
	}
	out := make([]State, 0, steps)
	next, steering, target := 0, false, 0.0
	for i := range steps {
		for ; next < len(sc.Changes) && sc.Changes[next].At == i; next++ {
			ch := sc.Changes[next]
			if mirrored {
				flip()
			}
			if err := setFields(&c, ch.Control); err != nil {
				t.Fatal(err)
			}
			if err := setFields(&e, ch.Env); err != nil {
				t.Fatal(err)
			}
			if mirrored {
				flip()
			}
			if _, ok := ch.Control["helm"]; ok {
				steering = false
			}
			if ch.Steer != nil {
				steering, target = true, *ch.Steer
				if mirrored {
					target = -target
				}
			}
		}
		if steering {
			c.Helm = steer(target, &s)
		}
		step(&s, &c, &e, b, &o, n)
		out = append(out, s)
	}
	return out
}

func TestMirrorSymmetry(t *testing.T) {
	var sf scenarioFile
	readJSON(t, scenariosFile, &sf)
	b := jolly(t)
	for _, sc := range sf.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			plain := runScenarioStates(t, b, sc, Substeps, false, sc.Steps)
			mirrored := runScenarioStates(t, b, sc, Substeps, true, sc.Steps)
			for i := range plain {
				p, m := plain[i], mirror(mirrored[i])
				for _, d := range []float64{
					p.X - m.X, p.Y - m.Y, math.Remainder(p.Heading-m.Heading, 2*math.Pi), p.Surge - m.Surge,
					p.Sway - m.Sway, p.YawRate - m.YawRate, math.Remainder(p.Heel-m.Heel, 2*math.Pi), p.RollRate - m.RollRate,
					p.Boom - m.Boom, p.BoomRate - m.BoomRate, p.Sailor - m.Sailor, p.Rudder - m.Rudder,
					p.SheetLimit - m.SheetLimit, p.SailorMode - m.SailorMode, p.SailorTimer - m.SailorTimer,
				} {
					if math.Abs(d) > 1e-12 {
						t.Fatalf("step %d: the mirrored run differs by %g:\n plain    %+v\n mirrored %+v", i, d, p, m)
					}
				}
			}
		})
	}
}
