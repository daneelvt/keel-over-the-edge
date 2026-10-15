// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// pilotAt asks the autopilot of b, once, for a boat heading heading (rad)
// with its boom to the side boom gives, in a mean wind from wind, holding
// target (degrees, as the control carries it) in mode by way.
func pilotAt(b *Prepared, heading, boom, wind float64, mode, target, way float64) (State, Out) {
	s := State{Heading: heading, Boom: boom, PilotWay: way}
	c := Control{Pilot: mode, Target: pilotTarget(target)}
	e := Env{MeanFrom: wind}
	var o Out
	b.pilot(&s, &c, &e, &o)
	return s, o
}

// The angle off the wind is the wind's direction less the heading, positive
// with the wind over starboard: a boat holding the angle it is at is on
// course, to within the control's step, and steers for its own heading.
func TestPilotAngleOffTheWind(t *testing.T) {
	b := jolly(t)
	step := 2 * math.Pi / TurnSteps
	for _, wind := range []float64{0, 1.3, -2.9, math.Pi} {
		for a := -175.0; a <= 180; a += 5 {
			heading := wrapAngle(wind - a*deg)
			boom := -math.Copysign(0.3, a)
			for _, mode := range []float64{PilotWind, PilotHeading} {
				target := a
				if mode == PilotHeading {
					target = math.Mod(heading/deg+360, 360)
				}
				_, o := pilotAt(b, heading, boom, wind, mode, target, WayHold)
				if math.Abs(o.PilotOff) > step || math.Abs(wrapAngle(o.PilotHeading-heading)) > step {
					t.Errorf("wind %.2f, %.0f° off it, mode %v: %v off course, steering for %v not %v", wind, a, mode, o.PilotOff, o.PilotHeading, heading)
				}
			}
		}
	}
}

// crosses reports whether the turn from angle a by d (both rad; the angle
// falls as the bow turns to starboard) passes through point p, modulo a
// whole turn, strictly between its ends.
func crosses(a, d, p float64) bool {
	lo, hi := min(a, a+d), max(a, a+d)
	k := math.Ceil((lo - p) / (2 * math.Pi))
	x := p + k*2*math.Pi
	if x == lo {
		x += 2 * math.Pi
	}
	return x < hi
}

// The ways from every 15° to every 15°: a tack turns through head to wind
// and never dead downwind, a gybe through dead downwind and never head to
// wind, each to the target; holding never turns through dead downwind, and
// turns to the target, or holds its angle on the boat's own tack when both
// are aft of the beam on opposite tacks.
func TestPilotWays(t *testing.T) {
	b := jolly(t)
	const wind = 0.4
	for from := -165.0; from <= 165; from += 15 {
		for to := -165.0; to <= 165; to += 15 {
			if from == to || from == 0 || to == 0 {
				continue
			}
			boom := -math.Copysign(0.3, from)
			for _, way := range []float64{WayHold, WayTack, WayGybe} {
				_, o := pilotAt(b, wrapAngle(wind-from*deg), boom, wind, PilotWind, to, way)
				// The turn's end: the angle falls by the angle off course.
				d := -o.PilotOff
				end := from*deg + d
				want := to * deg
				opposite := math.Signbit(from) != math.Signbit(to)
				if way == WayHold && opposite && math.Abs(from) >= 90 && math.Abs(to) >= 90 {
					want = -want
				}
				if math.Abs(wrapAngle(end-want)) > 1e-3 {
					t.Errorf("from %.0f° to %.0f°, way %v: the turn ends at %.1f°, not %.1f°", from, to, way, end/deg, want/deg)
				}
				down, up := crosses(from*deg, d, math.Pi), crosses(from*deg, d, 0)
				switch {
				case way != WayGybe && down:
					t.Errorf("from %.0f° to %.0f°, way %v: through dead downwind", from, to, way)
				case way == WayGybe && up:
					t.Errorf("from %.0f° to %.0f°, a gybe: through head to wind", from, to)
				case way == WayTack && opposite && !up:
					t.Errorf("from %.0f° to %.0f°, a tack: not through head to wind", from, to)
				case way == WayGybe && opposite && !down:
					t.Errorf("from %.0f° to %.0f°, a gybe: not through dead downwind", from, to)
				}
			}
		}
	}
}

// By the lee: up to byTheLee past dead downwind, with its boom still out on
// its side, the boat is on its tack and steers back up the short way; past
// it, the boat has gybed, and holds its angle on its new tack. A heading a
// little by the lee is sailed by the lee.
func TestPilotByTheLee(t *testing.T) {
	b := jolly(t)
	const wind = 0
	// On starboard, the boom to port, holding 165°.
	for _, c := range []struct {
		lee, steer float64 // degrees by the lee; the angle it steers for
	}{{5, 165}, {10, 165}, {14, 165}, {16, -165}, {25, -165}} {
		heading := wrapAngle(wind - (180+c.lee)*deg)
		_, o := pilotAt(b, heading, -0.8, wind, PilotWind, 165, WayHold)
		if got := wrapAngle(wind-o.PilotHeading) / deg; math.Abs(got-c.steer) > 0.01 {
			t.Errorf("%.0f° by the lee: steers for %.1f° off the wind, not %.0f°", c.lee, got, c.steer)
		}
		if crosses(-(180+c.lee)*deg, -o.PilotOff, 0) {
			t.Errorf("%.0f° by the lee: turns through head to wind", c.lee)
		}
	}
	// A heading 10° by the lee of a boat on starboard.
	heading := wrapAngle(wind - 150*deg)
	target := math.Mod((wind-190*deg)/deg+720, 360)
	_, o := pilotAt(b, heading, -0.8, wind, PilotHeading, target, WayHold)
	if math.Abs(wrapAngle(o.PilotHeading-(wind-190*deg))) > 1e-3 || o.PilotOff > 0 {
		t.Errorf("a heading 10° by the lee from 150°: steers for %.1f°, %.1f° off course", o.PilotHeading/deg, o.PilotOff/deg)
	}
}

// pilotStep steps the boat once on a beam reach in a steady wind with c.
func pilotStep(b *Prepared, s *State, c *Control) Out {
	e := Env{WindSpeed: 5, WindFrom: 0, MeanFrom: 0}
	var o Out
	Step(s, c, &e, nil, b, &o)
	return o
}

// An order is taken once per count, and its way holds until the boat is on
// its target's side within onCourse of it; the autopilot switched off
// forgets its way and standing helm, and follows the count, so switching
// it on again is no order.
func TestPilotOrders(t *testing.T) {
	b := jolly(t)
	s := State{Heading: -90 * deg, Surge: 2, SheetLimit: 0.6, Boom: -0.6}
	c := Control{Pilot: PilotWind, Target: pilotTarget(-90), Order: 1, Way: WayTack, Sheet: 0.3}
	pilotStep(b, &s, &c)
	if s.PilotWay != WayTack || s.PilotOrder != 1 {
		t.Fatalf("a new order: way %v, order %v", s.PilotWay, s.PilotOrder)
	}
	// The way is the boat's now: changing the control's way without a new
	// count changes nothing.
	c.Way = WayGybe
	pilotStep(b, &s, &c)
	if s.PilotWay != WayTack {
		t.Fatalf("the same count again: way %v", s.PilotWay)
	}
	// Placed on the target's side, a degree off it: the turn is over.
	s.Heading, s.Boom = 89*deg, 0.6
	pilotStep(b, &s, &c)
	if s.PilotWay != WayHold {
		t.Errorf("on course on the target's side: way %v", s.PilotWay)
	}
	// The same count does not tack again.
	s.Heading = 120 * deg
	pilotStep(b, &s, &c)
	if s.PilotWay != WayHold {
		t.Errorf("the same count after the turn: way %v", s.PilotWay)
	}
	s.PilotTrim = 0.1
	c.Pilot, c.Order = PilotOff, 3
	o := pilotStep(b, &s, &c)
	if s.PilotTrim != 0 || s.PilotWay != WayHold || s.PilotOrder != 3 || o.PilotOff != 0 {
		t.Errorf("switched off: trim %v, way %v, order %v, off %v", s.PilotTrim, s.PilotWay, s.PilotOrder, o.PilotOff)
	}
	c.Pilot, c.Way = PilotWind, WayGybe
	pilotStep(b, &s, &c)
	if s.PilotWay != WayHold {
		t.Errorf("switched on with the count it was left at: way %v", s.PilotWay)
	}
	// Out of range, the count is clamped to a whole number of its range.
	c.Order = math.NaN()
	pilotStep(b, &s, &c)
	if s.PilotOrder != 0 {
		t.Errorf("an order count of NaN is taken as %v", s.PilotOrder)
	}
}

// The standing helm grows only near the course, up to its limit, toward the
// wind as the error says; it is kept toward the wind, so its helm changes
// side with the tack; it does not grow while the sailor is out of the boat.
func TestPilotStandingHelm(t *testing.T) {
	b := jolly(t)
	const wind = 0
	grow := func(s *State, c *Control, n int) {
		e := Env{MeanFrom: wind}
		var o Out
		for range n {
			b.pilot(s, c, &e, &o)
		}
	}
	// 5° to windward of a 90° target on starboard: it must bear away, and
	// the standing helm grows away from the wind.
	s := State{Heading: wrapAngle(wind - 85*deg), Boom: -0.6}
	c := Control{Pilot: PilotWind, Target: pilotTarget(90)}
	grow(&s, &c, 1)
	if !(s.PilotTrim < 0) {
		t.Errorf("to windward of the course: the standing helm is %v", s.PilotTrim)
	}
	grow(&s, &c, 600*StepsPerSecond)
	if s.PilotTrim != -b.trimLimit {
		t.Errorf("held off course: the standing helm is %v, its limit %v", s.PilotTrim, b.trimLimit)
	}
	// The same standing helm on port turns the bow the other way.
	_, starboard := pilotAt(b, wrapAngle(wind-90*deg), -0.6, wind, PilotWind, 90, WayHold)
	ps := State{Heading: wrapAngle(wind + 90*deg), Boom: 0.6, PilotTrim: s.PilotTrim}
	pc := Control{Pilot: PilotWind, Target: pilotTarget(-90)}
	var po Out
	helm := b.pilot(&ps, &pc, &Env{MeanFrom: wind}, &po)
	ss := State{Heading: wrapAngle(wind - 90*deg), Boom: -0.6, PilotTrim: s.PilotTrim}
	helmS := b.pilot(&ss, &c, &Env{MeanFrom: wind}, &starboard)
	if math.Abs(helm+helmS) > 1e-9 || helm == 0 {
		t.Errorf("on course, the same standing helm: %v on port, %v on starboard", helm, helmS)
	}
	// Outside the band it is left alone, and while the sailor is out of
	// the boat too.
	for _, s := range []State{
		{Heading: wrapAngle(wind - 60*deg), Boom: -0.6, PilotTrim: 0.1},
		{Heading: wrapAngle(wind - 85*deg), Boom: -0.6, PilotTrim: 0.1, SailorMode: InWater},
	} {
		grow(&s, &c, 30)
		if s.PilotTrim != 0.1 {
			t.Errorf("heading %.0f°, sailor %v: the standing helm moved to %v", s.Heading/deg, s.SailorMode, s.PilotTrim)
		}
	}
}

// A step with the autopilot on allocates nothing, and with it off leaves the
// boat's physics as they were (the golden scenarios, unchanged since before
// the autopilot, hold that).
func TestPilotStepAllocatesNothing(t *testing.T) {
	b := jolly(t)
	s := State{Heading: 1, Surge: 2, SheetLimit: 0.5}
	c := Control{Sheet: 0.4, Pilot: PilotWind, Target: pilotTarget(60), Order: 1, Way: WayTack}
	e := Env{WindSpeed: 7, WindFrom: 2, MeanFrom: 2.1}
	var o Out
	if n := testing.AllocsPerRun(1000, func() { Step(&s, &c, &e, nil, b, &o) }); n != 0 {
		t.Errorf("a step on the autopilot allocates %v times", n)
	}
}

// BenchmarkStepPilot times a step on a beam reach on the autopilot, beside
// BenchmarkStep's by hand.
func BenchmarkStepPilot(bm *testing.B) {
	b := jolly(bm)
	s := State{Heading: math.Pi / 2, Surge: 3, SheetLimit: 0.6}
	c := Control{Sheet: 0.35, Pilot: PilotWind, Target: pilotTarget(-90)}
	e := Env{WindSpeed: 7, WindFrom: 0}
	var o Out
	for bm.Loop() {
		Step(&s, &c, &e, nil, b, &o)
	}
}
