// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"fmt"
	"math"
	"testing"
)

// Behaviour tests of boats meeting: facts about bumps and dirty air, each
// checked within tolerances, as the boat's own behaviour tests are.

// fleetSail is boats sailing together in a steady wind, each step each
// boat in the shadow of the others' wakes from the step before, then every
// pair's contact resolved together, then the wakes made for the next: the
// simulation's tick, for a handful of boats.
type fleetSail struct {
	b      *Prepared
	e      *EncounterPrepared
	env    Env
	s      []State
	c      []Control
	wake   []Wake
	steer  []float64 // a heading to hold, or NaN to hold the helm
	h      Hulls
	o      Out
	ts     []Touching
	deep   float64 // the deepest the hulls have been inside each other, m
	bumps  int     // steps on which a pair first touched after being apart
	apart  []int   // per pair, steps since they last touched
	shadow []bool  // per boat: whether a wake reached it this step
}

func newFleetSail(t *testing.T, env Env, s []State, c []Control) *fleetSail {
	f := &fleetSail{b: jolly(t), e: testEncounters(t), env: env, s: s, c: c}
	f.wake = make([]Wake, len(s))
	f.steer = make([]float64, len(s))
	f.shadow = make([]bool, len(s))
	for i := range f.steer {
		f.steer[i] = math.NaN()
	}
	f.apart = make([]int, len(s)*len(s))
	for i := range f.apart {
		f.apart[i] = 1 << 20
	}
	f.settle()
	return f
}

func (f *fleetSail) settle() {
	for i := range f.s {
		f.wake[i] = WakeOf(&f.s[i], &f.env, f.b, f.e)
	}
}

func (f *fleetSail) step() {
	n := len(f.s)
	for i := range f.s {
		var src Sources
		for j := range f.s {
			if j != i {
				src.Consider(&f.wake[j], int32(j), f.s[i].X, f.s[i].Y, f.e)
			}
		}
		f.shadow[i] = src.Len() > 0
		e := f.env
		ShadowAt(&e, f.s[i].X, f.s[i].Y, &src, f.e)
		if !math.IsNaN(f.steer[i]) {
			f.c[i].Helm = steer(f.steer[i], &f.s[i])
		}
		Step(&f.s[i], &f.c[i], &e, nil, f.b, &f.o)
	}
	f.ts = f.ts[:0]
	for i := range n {
		for j := i + 1; j < n; j++ {
			t := Touching{A: &f.s[i], B: &f.s[j], PA: f.b, PB: f.b}
			k := i*n + j
			if f.h.Touch(t.A, t.B, f.b, f.b, &t.C) {
				f.deep = max(f.deep, t.C.Depth)
				if f.apart[k] > int(f.e.apart) {
					f.bumps++
				}
				f.apart[k] = 0
				f.ts = append(f.ts, t)
			} else {
				f.apart[k]++
			}
		}
	}
	Resolve(f.ts, f.e)
	f.settle()
}

// Boats bump: two Jolly boats sailing into each other at every 30° of
// crossing angle touch, part, are both turned by it, and never pass
// through each other.
func TestBoatsBump(t *testing.T) {
	for angle := 30; angle <= 180; angle += 30 {
		th := float64(angle) * degree
		// They meet at (0, 8): the first heading north from the origin, the
		// second toward the same point at angle to it, as far off.
		meet := 8.0
		a := State{Heading: 0, Surge: 2.5}
		b := State{X: -meet * math.Sin(th), Y: meet - meet*math.Cos(th), Heading: th, Surge: 2.5}
		// A calm: they coast into each other.
		f := newFleetSail(t, Env{}, []State{a, b}, []Control{{}, {}})
		turned := false
		for range 240 {
			before := f.bumps
			f.step()
			if before == 0 && f.bumps > 0 {
				turned = f.s[0].YawRate != 0 && f.s[1].YawRate != 0
			}
		}
		if f.bumps == 0 {
			t.Errorf("crossing at %d°: no bump", angle)
			continue
		}
		if !turned {
			t.Errorf("crossing at %d°: the bump turned neither or one", angle)
		}
		if f.deep > 0.1 {
			t.Errorf("crossing at %d°: the hulls were %.3f m inside each other", angle, f.deep)
		}
		var c Contact
		if f.h.Touch(&f.s[0], &f.s[1], f.b, f.b, &c) && c.Depth > 2*f.e.slop {
			t.Errorf("crossing at %d°: still %.3f m inside each other after 8 s", angle, c.Depth)
		}
	}
}

// madeGood is how far a boat has made to windward of where it started, in
// a wind from from.
func madeGood(start, now *State, from float64) float64 {
	return (now.X-start.X)*math.Sin(from) + (now.Y-start.Y)*math.Cos(from)
}

// Dirty air costs a racer: of two Jolly boats beating in a steady breeze,
// the one starting a rig height or two behind the other on its wake's line
// makes good less to windward over two minutes than one in clear air
// beside them, by at least shadowCost; and once it tacks out of the wake
// it makes good as the boat in clear air does.
func TestDirtyAirCosts(t *testing.T) {
	for _, knots := range []float64{7, 12, 18} {
		t.Run(fmt.Sprint(knots, " knots"), func(t *testing.T) { dirtyAirCosts(t, knots) })
	}
}

func dirtyAirCosts(t *testing.T, knots float64) {
	env := Env{WindSpeed: knots * knot, WindFrom: 0}
	course := -45 * degree // starboard tack, close-hauled
	b := jolly(t)
	e := testEncounters(t)
	// Settle a boat on the beat first, alone.
	lone := newFleetSail(t, env, []State{{Heading: course, Surge: 2, SheetLimit: 0.1}}, []Control{{Sheet: 0.08}})
	lone.steer[0] = course
	for range 900 {
		lone.step()
	}
	settled := lone.s[0]
	settled.X, settled.Y = 0, 0
	// The leader, the follower on the leader's wake line 1.5 rig heights
	// behind, and a boat in clear air 200 m to leeward.
	leader := settled
	w := WakeOf(&leader, &env, b, e)
	follower := settled
	follower.X = w.X + 1.5*w.Height*w.East - (w.X - leader.X)
	follower.Y = w.Y + 1.5*w.Height*w.North - (w.Y - leader.Y)
	clear := settled
	clear.X, clear.Y = 140, -140
	f := newFleetSail(t, env, []State{leader, follower, clear}, []Control{{Sheet: 0.08}, {Sheet: 0.08}, {Sheet: 0.08}})
	for i := range f.steer {
		f.steer[i] = course
	}
	starts := append([]State(nil), f.s...)
	shadowed := 0
	for range 2 * 60 * StepsPerSecond {
		f.step()
		if f.shadow[1] {
			shadowed++
		}
	}
	behind := madeGood(&starts[1], &f.s[1], env.WindFrom)
	free := madeGood(&starts[2], &f.s[2], env.WindFrom)
	cost := 1 - behind/free
	t.Logf("in %v knots, over two minutes: in the wake %.1f m, in clear air %.1f m to windward: %.1f%% less; in the shadow %.0f s of 120",
		knots, behind, free, 100*cost, float64(shadowed)/StepsPerSecond)
	if cost < shadowCost {
		t.Errorf("dirty air cost %.1f%% of the way to windward, want at least %.0f%%", 100*cost, 100*shadowCost)
	}
	if f.s[2].Y-f.s[1].Y > 0 && cost < 0 {
		t.Error("the boat in dirty air made more to windward than the boat in clear air")
	}

	// Tacking out: the follower tacks onto port, out of the wake, and over
	// the next minute makes good as the boat in clear air does.
	f.steer[1] = -course
	f.steer[2] = -course
	for range 15 * StepsPerSecond {
		f.step()
	}
	starts = append(starts[:0], f.s...)
	for range 60 * StepsPerSecond {
		f.step()
	}
	out := madeGood(&starts[1], &f.s[1], env.WindFrom)
	clean := madeGood(&starts[2], &f.s[2], env.WindFrom)
	t.Logf("after tacking out: %.1f m against %.1f m in clear air", out, clean)
	if math.Abs(1-out/clean) > 0.03 {
		t.Errorf("tacked out of the wake: made good %.1f m, the boat in clear air %.1f m", out, clean)
	}
}

// shadowCost is the least share of the way to windward dirty air costs in
// TestDirtyAirCosts: below what the shadow's starting values give (3.6% to
// 6.7% from 18 down to 7 knots), the boat behind slowing out of the strongest
// of the wake within half a minute.
const shadowCost = 0.03
