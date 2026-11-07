// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// Behaviour tests of a ship under square sails, each fact with its
// source: she makes ground to windward braced up sharp, tacks with way and
// stalls without it, wears within four of her lengths, and her crew swings
// her yards through square as a ship's crew does (Willis 2003).

// tallShip is the scenarios file's first boat with square sails.
func tallShip(t testing.TB) *Prepared {
	t.Helper()
	for _, boat := range testBoats(t) {
		if boat.b.square {
			return boat.b
		}
	}
	t.Fatal("no boat with square sails")
	return nil
}

// shipPilot hands m's helm to the autopilot, holding the angle off the
// wind m was put at, degrees, with the wind over port.
func shipPilot(m *sim, angle float64) {
	m.steer = false
	m.c.Pilot = PilotWind
	m.c.Target = pilotTarget(-angle)
}

// shipAt is the ship on her autopilot close-hauled in knots of steady
// wind from the north, braced up sharp, after she has settled for four
// minutes.
func shipAt(t *testing.T, b *Prepared, knots float64) *sim {
	angle := b.closeHauled / deg
	m := newSimOf(t, b, knots*knot, angle, 0)
	m.s.Surge = 3
	shipPilot(m, angle)
	m.run(240, nil)
	return m
}

// Braced up sharp in 12 knots she makes ground to windward close-hauled,
// at least 0.9 knots of it, her square sails drawing, with 6° to 12° of
// leeway (Willis 2003: a point of leeway, 6° to 12° measured).
func TestShipMakesGroundToWindward(t *testing.T) {
	b := tallShip(t)
	m := shipAt(t, b, 12)
	y := m.s.Y
	drawing, leeway, n := 0, 0.0, 0
	m.run(120, func() {
		if m.o.Sail == SailDrawing && m.o.AfterFootFlow != FlowAback && m.o.ForeFootFlow != FlowAback {
			drawing++
		}
		leeway += math.Abs(m.o.Leeway)
		n++
	})
	made := (m.s.Y - y) / 120
	leeway /= float64(n)
	t.Logf("close-hauled %.0f° off 12 knots, braced up sharp: %.2f knots to windward at %.2f knots, %.1f° of leeway, drawing %d of %d steps",
		b.closeHauled/deg, made/knot, m.speed()/knot, leeway/deg, drawing, n)
	if made < 0.9*knot || drawing < n*9/10 || leeway < 6*deg || leeway > 12*deg {
		t.Errorf("close-hauled: %.2f knots to windward, drawing %d of %d steps, %.1f° of leeway", made/knot, drawing, n, leeway/deg)
	}
}

// shipTurn orders m's autopilot to turn by way to the same angle off the
// wind on the other side, and sails secs, recording what the turn did.
type shipTurn struct {
	within, stalled float64 // s from the order, +Inf for never
	far             float64 // m from where the turn began at the furthest, until within 5°
	// The angle off the wind, degrees, positive on the old side and on
	// past the bow or the stern, at which each group of yards first left
	// its old side's angle, and the seconds at which each swung through
	// square.
	afterLeft, foreLeft     float64
	afterSquare, foreSquare float64
	// ends is the angle off the wind at the end, degrees, positive on the
	// old side.
	ends float64
}

func shipTurnOf(m *sim, way, secs float64) shipTurn {
	angle := wrapAngle(m.e.MeanFrom - m.s.Heading)
	from := math.Abs(angle)
	side := sign(angle)
	m.c.Target = pilotTarget(-side * from / deg)
	m.c.Order, m.c.Way = math.Mod(m.c.Order+1, PilotOrders), way
	inf := math.Inf(1)
	r := shipTurn{within: inf, stalled: inf, afterLeft: inf, foreLeft: inf, afterSquare: inf, foreSquare: inf}
	x0, y0, t0 := m.s.X, m.s.Y, m.time
	after, fore := m.s.Yards, m.s.ForeYards
	// How far the ship has turned from her old side, degrees: through the
	// bow for a tack, through the stern for a wear.
	turned := func() float64 {
		a := float64(side*wrapAngle(m.e.MeanFrom-m.s.Heading)) / deg
		if way == WayGybe && a < 0 {
			a += 360
		}
		return a
	}
	m.run(secs, func() {
		if m.o.PilotStalled != 0 && math.IsInf(r.stalled, 1) {
			r.stalled = m.time - t0
		}
		if math.IsInf(r.within, 1) {
			r.far = max(r.far, math.Hypot(m.s.X-x0, m.s.Y-y0))
			if math.Abs(wrapAngle(m.e.MeanFrom-m.s.Heading)+float64(side*from)) < 5*deg {
				r.within = m.time - t0
			}
		}
		if math.IsInf(r.afterLeft, 1) && math.Abs(m.s.Yards-after) > degree {
			r.afterLeft = turned()
		}
		if math.IsInf(r.foreLeft, 1) && math.Abs(m.s.ForeYards-fore) > degree {
			r.foreLeft = turned()
		}
		if math.IsInf(r.afterSquare, 1) && sign(m.s.Yards) != sign(after) {
			r.afterSquare = m.time - t0
		}
		if math.IsInf(r.foreSquare, 1) && sign(m.s.ForeYards) != sign(fore) {
			r.foreSquare = m.time - t0
		}
	})
	r.ends = float64(side*wrapAngle(m.e.MeanFrom-m.s.Heading)) / deg
	return r
}

// She tacks in 12 knots of flat water from close-hauled at her full speed:
// she comes within 5° of close-hauled on the other tack within three
// minutes, and is sailing there three minutes after that. Her crew holds
// the after yards until her head is within hauls of the wind, then swings
// them through square to the new side, "mainsail haul", while the fore
// yards stay aback and push her head round until the wind is letGo on the
// new bow, "let go and haul" (Willis 2003). From 2.5 knots, without way
// to come through the wind, her tack stalls, the autopilot gives it up
// and she pays off on her old tack.
func TestShipTacks(t *testing.T) {
	b := tallShip(t)
	closeHauled := b.closeHauled / deg
	m := shipAt(t, b, 12)
	speed := m.speed()
	r := shipTurnOf(m, WayTack, 360)
	t.Logf("a tack from %.2f knots: within 5° after %.0f s; the after yards leave %.1f° off the wind and swing through square at %.0f s, the fore yards leave %.1f° on the new bow and swing through at %.0f s; ends %.1f° off the wind on the new tack at %.2f knots",
		speed/knot, r.within, r.afterLeft, r.afterSquare, -r.foreLeft, r.foreSquare, -r.ends, m.speed()/knot)
	if r.within > 180 || !math.IsInf(r.stalled, 1) || math.Abs(r.ends+closeHauled) > 10 || m.speed() < 2*knot {
		t.Errorf("a tack with way: within 5° after %.0f s, stalled at %.0f s, ends %.1f° off the wind on the new tack at %.2f knots", r.within, r.stalled, -r.ends, m.speed()/knot)
	}
	if !(r.afterSquare < r.foreSquare) || !(r.afterLeft > 0 && r.afterLeft < b.hauls/deg+0.5) || -r.foreLeft < b.letGo/deg-0.5 {
		t.Errorf("the yards: the after yards leave at %.1f° off the wind and swing at %.0f s, the fore yards leave at %.1f° on the new bow and swing at %.0f s",
			r.afterLeft, r.afterSquare, -r.foreLeft, r.foreSquare)
	}

	m = shipAt(t, b, 12)
	m.s.Surge, m.s.Sway, m.s.YawRate = 2.5*knot, 0, 0
	r = shipTurnOf(m, WayTack, 240)
	t.Logf("a tack from 2.5 knots: stalled after %.0f s; ends %.1f° off the wind on her old tack at %.2f knots, way %v", r.stalled, r.ends, m.speed()/knot, m.s.PilotWay)
	if r.stalled > 60 || m.s.PilotWay != WayTackStalled || math.Abs(r.ends-closeHauled) > 10 {
		t.Errorf("a tack from 2.5 knots: stalled after %.0f s, ends %.1f° off the wind on her old tack, way %v", r.stalled, r.ends, m.s.PilotWay)
	}
}

// She wears from close-hauled to close-hauled in 12 knots, turning
// through 226°, within four of her lengths of where she began, as the
// best ships did (Willis 2003); both groups of yards keep their side
// until the wind is letGo on her new quarter, and she is sailing on her
// new tack three minutes after.
func TestShipWears(t *testing.T) {
	b := tallShip(t)
	m := shipAt(t, b, 12)
	r := shipTurnOf(m, WayGybe, 360)
	t.Logf("a wear: within 5° after %.0f s, %.0f m from where she began at the furthest (four lengths %.0f m); the after yards leave %.1f° and the fore %.1f° past dead downwind, swinging through square at %.0f s and %.0f s; ends %.1f° off the wind on the new tack at %.2f knots",
		r.within, r.far, 4*b.length, r.afterLeft-180, r.foreLeft-180, r.afterSquare, r.foreSquare, -r.ends, m.speed()/knot)
	if math.IsInf(r.within, 1) || r.far > 4*b.length || math.Abs(r.ends+b.closeHauled/deg) > 10 || m.speed() < 2*knot {
		t.Errorf("a wear: within 5° after %.0f s, %.0f m at the furthest, ends %.1f° off the wind on the new tack at %.2f knots", r.within, r.far, -r.ends, m.speed()/knot)
	}
	for _, left := range []float64{r.afterLeft, r.foreLeft} {
		if left-180 < b.letGo/deg-0.5 {
			t.Errorf("a wear: yards left their side %.1f° past dead downwind, before the wind was %.0f° on her new quarter", left-180, b.letGo/deg)
		}
	}
}

// Laid on her beam ends in a 40-knot squall, her braces let go, she rights
// herself: her range of stability, 110°, is past the 90° large sailing
// vessels are held to, so that a squall never leaves her on her side.
// She is back under 30° within 60 s and stays there, her sailor at the
// wheel throughout.
func TestShipBeamEnds(t *testing.T) {
	b := tallShip(t)
	m := newSimOf(t, b, 40*knot, 80, 1)
	m.run(30, nil)
	m.s.Heel, m.s.RollRate = 90*deg, 0
	back, most := math.Inf(1), 0.0
	m.run(90, func() {
		if math.IsInf(back, 1) && math.Abs(m.s.Heel) < 30*deg {
			back = m.time - 30
		}
		if m.time > 90 {
			most = max(most, math.Abs(m.s.Heel)/deg)
		}
	})
	t.Logf("on her beam ends in 40 knots, her braces let go: under 30° after %.1f s, at most %.1f° over the last half minute", back, most)
	if back > 60 || most > 30 || m.maxMode != Sailing {
		t.Errorf("on her beam ends: under 30° after %.1f s, at most %.1f° over the last half minute, sailor mode %v", back, most, m.maxMode)
	}
}
