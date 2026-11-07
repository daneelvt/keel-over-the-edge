// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// Behaviour tests of the boats after the first, each fact with its source:
// the keelboat sails as its original's certificate rates it, is knocked
// down and comes back, meets the bottom on its keel, and every boat reefs
// to heel less.

// keelboat is the scenarios file's keelboat: the first boat with a fixed
// keel.
func keelboat(t testing.TB) *Prepared {
	t.Helper()
	for _, boat := range testBoats(t) {
		if boat.b.fixed {
			return boat.b
		}
	}
	t.Fatal("no boat with a fixed keel")
	return nil
}

// Upwind she makes what the J/22's ORC certificate (2021) rates her, under
// main and jib, in 8 and 10 knots 10 m up, where one sailor carries her
// as the rated crew does: close-hauled at 40° her speed made good to
// windward within 10% of the rated beat VMG at the better of 40° and 45°,
// and at 52° her speed within 10% of the rating.
func TestKeelboatUpwind(t *testing.T) {
	b := keelboat(t)
	for _, c := range []struct {
		knots, vmg, at52 float64
	}{{8, 3.44, 5.21}, {10, 3.87, 5.62}} {
		v := 0.0
		for _, a := range []float64{40, 45} {
			m := newSimOf(t, b, c.knots*knot, a, 0)
			m.run(60, nil)
			v = max(v, m.mean(30, m.speed)*math.Cos(a*deg)/knot)
		}
		m := newSimOf(t, b, c.knots*knot, 52, 0.02)
		m.run(60, nil)
		s := m.mean(30, m.speed) / knot
		t.Logf("%g knots: VMG %.2f knots against %.2f rated, %.2f knots at 52° against %.2f", c.knots, v, c.vmg, s, c.at52)
		if math.Abs(v/c.vmg-1) > 0.1 || math.Abs(s/c.at52-1) > 0.1 {
			t.Errorf("%g knots: VMG %.2f knots against %.2f rated, %.2f at 52° against %.2f: not within 10%%", c.knots, v, c.vmg, s, c.at52)
		}
		if m.maxMode != Sailing {
			t.Errorf("%g knots: the sailor left the boat", c.knots)
		}
	}
}

// A boat whose sailor never falls out is knocked down, not capsized: hit
// on a reach in 12 knots by a 40-knot gust of 20 s with her sheet hauled
// in, she goes far over; her sheet let fly 4 s in, her keel and her sails
// bring her back under 30° within 60 s of the gust's coming, and she stays
// there; her sailor never leaves her, and the helm and sheet work
// throughout.
func TestKnockdownRecovers(t *testing.T) {
	ran := 0
	for _, boat := range testBoats(t) {
		if boat.b.fallOutHeel < math.Pi {
			continue
		}
		ran++
		m := newSimOf(t, boat.b, 12*knot, 80, 0.3)
		m.run(60, nil)
		m.maxHeel = 0
		m.e.WindSpeed = 40 * knot
		m.c.Sheet = 0
		m.run(4, nil)
		deepest := m.maxHeel
		m.c.Sheet = 1
		limit := m.s.SheetLimit
		m.run(16, nil)
		m.e.WindSpeed = 12 * knot
		m.run(30, nil)
		// The last 10 s of the minute.
		most := 0.0
		m.run(10, func() { most = max(most, math.Abs(m.s.Heel)) })
		t.Logf("%s: knocked down to %.0f°, at most %.1f° over the last 10 s of the minute", boat.id, deepest, most/deg)
		if deepest < 45 {
			t.Errorf("%s: a 40-knot gust sheeted in heeled her only to %.0f°", boat.id, deepest)
		}
		if most > 30*deg {
			t.Errorf("%s: a minute after the gust came she heels %.1f°, not under 30°", boat.id, most/deg)
		}
		if m.maxMode != Sailing {
			t.Errorf("%s: the sailor left the boat", boat.id)
		}
		if !(m.s.SheetLimit > limit) {
			t.Errorf("%s: let fly, the sheet did not run: %.1f° from %.1f°", boat.id, m.s.SheetLimit/deg, limit/deg)
		}
		// The helm still turns her rudder.
		m.steer, m.c.Helm = false, 1
		m.run(1, nil)
		if !(m.s.Rudder > 0.9*m.b.rudderMax) {
			t.Errorf("%s: after the knockdown the rudder is at %.1f°, not following the helm", boat.id, m.s.Rudder/deg)
		}
	}
	if ran == 0 {
		t.Fatal("no boat whose sailor never falls out")
	}
}

// A fixed keel meets the bottom: the keelboat run onto a sloping beach
// stops where the water is her draught, her keel never pushed up, and once
// still she is pushed off into water her draught and a metre deep, deeper
// than the ground's own push-off depth.
func TestKeelAground(t *testing.T) {
	b := keelboat(t)
	g := testGround(beach)
	if want := Draught(b) + 1; PushDepth(b, g.Prepared) != want || !(want > testGroundParams.PushDepth) {
		t.Fatalf("her push-off depth is %.2f m, not her draught and a metre, %.2f m", PushDepth(b, g.Prepared), want)
	}
	// A beam reach east, wind from the north, 12 knots.
	s := State{X: -40, Heading: math.Pi / 2, Surge: 2.5, SheetLimit: 0.6}
	c := Control{Sheet: 0.4}
	e := Env{WindSpeed: 6.2, WindFrom: 0, MeanFrom: 0}
	var o Out
	stoppedAt, pushed := math.NaN(), false
	var after State
	for range 120 * StepsPerSecond {
		if !pushed {
			c.Helm = steer(math.Pi/2, &s)
		}
		Step(&s, &c, &e, nil, g, b, &o)
		if math.IsNaN(stoppedAt) && o.Aground == OnBottom && o.SpeedOverGround < 0.1 {
			stoppedAt = s.X
			c.Sheet = 1
		}
		if o.PushedOff != 0 && !pushed {
			pushed, after = true, s
		}
	}
	// The slope is 4 m deep at x = 50, rising a metre in 25: she stops
	// where her keel has ploughed no more than 0.3 m into it.
	depth := 4 - (stoppedAt-50)/25
	t.Logf("draught %.2f m: stopped at x = %.1f in %.2f m of water; pushed off to x = %.1f", Draught(b), stoppedAt, depth, after.X)
	if math.IsNaN(stoppedAt) || depth > Draught(b) || depth < Draught(b)-0.3 {
		t.Fatalf("she stopped at x = %.1f in %.2f m of water, not where her keel meets the bottom", stoppedAt, depth)
	}
	if !pushed {
		t.Fatal("she was never pushed off")
	}
	if depth, _ := g.At(after.X, after.Y); -depth < Draught(b)+1 {
		t.Errorf("pushed off into %.2f m of water, less than her draught and a metre", -depth)
	}
}

// Every boat reefs: in 24 knots at 50° off the wind with the sheet in
// near hard, past where her sailor can hold her up at full sail, a reef
// heels her less and two less still, and she sails no slower for them;
// the crew takes them in at her reef time, the sail's share of its luff
// going down to the reef's.
func TestReefingHeelsLess(t *testing.T) {
	for _, boat := range testBoats(t) {
		heel := func(reef float64) (float64, *sim) {
			m := newSimOf(t, boat.b, 24*knot, 50, 0.1)
			m.c.Reef = reef
			m.run(90, nil)
			return m.mean(30, func() float64 { return math.Abs(m.s.Heel) }) / deg, m
		}
		full, m0 := heel(0)
		one, _ := heel(1)
		two, m := heel(2)
		t.Logf("%s, 24 knots at 50°: heel %.1f° at full sail, %.1f° with a reef, %.1f° with two, %.2f and %.2f knots; the luff's share %.3f",
			boat.id, full, one, two, m0.speed()/knot, m.speed()/knot, m.o.ReefShare)
		if !(two < one && one < full) {
			t.Errorf("%s: heel %.1f°, %.1f°, %.1f° with no reef, one and two: not less as she reefs", boat.id, full, one, two)
		}
		if m.maxMode != Sailing || m.speed() < 0.95*m0.speed() {
			t.Errorf("%s: with two reefs in 24 knots, sailor mode %v, %.2f knots against %.2f at full sail", boat.id, m.maxMode, m.speed()/knot, m0.speed()/knot)
		}
		if m.s.Reef != 2 || m.o.ReefShare != boat.b.reefs[2] {
			t.Errorf("%s: reefed to %v, the luff's share %v, not 2 and %v", boat.id, m.s.Reef, m.o.ReefShare, boat.b.reefs[2])
		}
		// From full sail, a reef takes her reef time.
		m = newSimOf(t, boat.b, 24*knot, 50, 0.1)
		m.c.Reef = 1
		took := math.NaN()
		m.run(2/boat.b.reefRate, func() {
			if math.IsNaN(took) && m.s.Reef == 1 {
				took = m.time
			}
		})
		if math.Abs(took*boat.b.reefRate-1) > 0.01 {
			t.Errorf("%s: a reef took %.1f s, not %.1f s", boat.id, took, 1/boat.b.reefRate)
		}
	}
}
