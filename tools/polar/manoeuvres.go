// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// manoeuvre is how a tack or gybe went.
type manoeuvre struct {
	Before  float64 // speed before, knots
	Least   float64 // least speed, knots
	Regain  float64 // s from the start until the speed is back to 90% of before
	Lost    float64 // m lost to windward (to leeward, for a gybe) against sailing on
	Crossed bool    // the boom crossed
	OK      bool    // the boat stayed upright
}

// settled returns a boat sailing steadily at twa (degrees) on port tack with
// the best sheet there.
func settled(k *kind, windKnots, twa float64) (*boat, helmsman) {
	pt := best(k, windKnots, twa, 0)
	h := k.helmsmanOf(twa)
	bt := newBoat(k, k.wind10(windKnots), h.target, pt.Sheet, 0)
	for range int(k.settleAt(k.wind10(windKnots)) * physics.StepsPerSecond) {
		bt.c.Helm = h.helm(&bt.s)
		bt.step()
	}
	return bt, h
}

// turn sails a boat settled at from (degrees) round to the same angle on the
// other tack, through the wind for a tack or through dead downwind for a
// gybe, and measures the manoeuvre over the following 30 s against the VMG
// it had.
func turn(k *kind, windKnots, from float64) manoeuvre {
	bt, h := settled(k, windKnots, from)
	// Speed and progress toward the wind before the turn.
	var m manoeuvre
	y0 := bt.s.Y
	const before = 5.0
	for range int(before * physics.StepsPerSecond) {
		bt.c.Helm = h.helm(&bt.s)
		bt.step()
		m.Before += math.Hypot(bt.s.Surge, bt.s.Sway)
	}
	m.Before /= before * physics.StepsPerSecond
	vmg := (bt.s.Y - y0) / before

	h.target = -from * deg
	side := math.Signbit(bt.s.Boom)
	m.Least = math.Inf(1)
	y0, t0 := bt.s.Y, bt.time
	const after = 30.0
	for range int(after * physics.StepsPerSecond) {
		bt.c.Helm = h.helm(&bt.s)
		bt.step()
		v := math.Hypot(bt.s.Surge, bt.s.Sway)
		m.Least = min(m.Least, v)
		if m.Regain == 0 && v < 0.9*m.Before {
			m.Regain = -1
		}
		if m.Regain < 0 && v >= 0.9*m.Before {
			m.Regain = bt.time - t0
		}
		if math.Signbit(bt.s.Boom) != side {
			m.Crossed = true
		}
	}
	m.Lost = vmg*after - (bt.s.Y - y0)
	if from > 90 {
		m.Lost = -m.Lost
	}
	m.Before /= knot
	m.Least /= knot
	m.OK = !bt.capsized
	return m
}

// byTheLee bears away slowly from a run until the boom gybes by itself, and
// returns how far by the lee the boat was then, in degrees; NaN if it never
// gybed.
func byTheLee(k *kind, windKnots float64) float64 {
	bt, h := settled(k, windKnots, 170)
	const rate = 1 * deg // per second
	side := math.Signbit(bt.s.Boom)
	for range int(60 * physics.StepsPerSecond) {
		h.target += rate / physics.StepsPerSecond
		bt.c.Helm = h.helm(&bt.s)
		bt.step()
		if math.Signbit(bt.s.Boom) != side {
			// With the wind from the north, a heading past 180° is how far
			// by the lee.
			return math.Mod(bt.s.Heading/deg+360, 360) - 180
		}
	}
	return math.NaN()
}

func runManoeuvres(k *kind) error {
	fmt.Printf("%s, winds %s\n", k.name, k.heightWords())
	fmt.Println("wind  manoeuvre  before  least  least/before  regain 90%  lost      boom crossed")
	// A tack from close-hauled: 45°, or a boat's close-hauled angle if she
	// cannot sail so close.
	tackFrom := max(45, k.p.CloseHauled)
	for _, w := range []float64{6, 12, 18} {
		for _, mv := range []struct {
			name string
			from float64
		}{{"tack", tackFrom}, {"gybe", 150}} {
			m := turn(k, w, mv.from)
			status := ""
			if !m.OK {
				status = "  capsized"
			}
			fmt.Printf("%4g  %-9s  %5.2f  %5.2f  %11.0f%%  %8.1f s  %5.1f m  %v%s\n",
				w, mv.name, m.Before, m.Least, 100*m.Least/m.Before, m.Regain, m.Lost, m.Crossed, status)
		}
	}
	for _, w := range []float64{6, 12, 18} {
		fmt.Printf("%4g  an accidental gybe comes %.1f° by the lee\n", w, byTheLee(k, w))
	}
	if k.square {
		return shipManoeuvres(k)
	}
	return nil
}

// A ship's tacks and wears by her own autopilot and her crew, from
// close-hauled on one tack to close-hauled on the other: her tack in
// 12 knots of flat water from her full speed, and from shipSlow, which
// must stall; her wear, which must turn within shipLengths of her
// lengths of where it began.
const (
	shipSlow    = 2.5 // knots
	shipLengths = 4
	shipSettle  = 240.0 // s on the autopilot before the order
	shipAfter   = 300.0 // s after it
)

// pilotTurn is how a turn the autopilot made went.
type pilotTurn struct {
	Before, Least float64 // knots
	Within        float64 // s from the order until within 5° of the new angle
	Far, Path     float64 // m from where it began at the furthest, and sailed, until then
	Stalled       float64 // s from the order until the autopilot gave the turn up; +Inf if never
	Ends          float64 // degrees off the wind at the end, negative on the new side
	EndSpeed      float64 // knots
}

// turnByPilot settles a ship on her autopilot at from degrees off the wind
// in windKnots, braced up sharp, then, from slow knots if that is not
// negative, orders the turn by way to the same angle on the other side.
func turnByPilot(k *kind, windKnots, from, way, slow float64) pilotTurn {
	bt := newBoat(k, k.wind10(windKnots), -from*deg, 0, 0)
	bt.c.Pilot = physics.PilotWind
	bt.c.Target = pilotSteps(from)
	for range int(shipSettle * physics.StepsPerSecond) {
		bt.step()
	}
	if slow >= 0 {
		bt.s.Surge, bt.s.Sway, bt.s.YawRate = slow*knot, 0, 0
	}
	r := pilotTurn{Before: math.Hypot(bt.s.Surge, bt.s.Sway) / knot, Least: math.Inf(1),
		Within: math.Inf(1), Stalled: math.Inf(1)}
	x0, y0, t0 := bt.s.X, bt.s.Y, bt.time
	bt.c.Target, bt.c.Order, bt.c.Way = pilotSteps(-from), 1, way
	px, py := x0, y0
	for range int(shipAfter * physics.StepsPerSecond) {
		bt.step()
		if bt.o.PilotStalled != 0 && math.IsInf(r.Stalled, 1) {
			r.Stalled = bt.time - t0
		}
		v := math.Hypot(bt.s.Surge, bt.s.Sway) / knot
		r.Least = min(r.Least, v)
		angle := math.Remainder(bt.e.MeanFrom-bt.s.Heading, 2*math.Pi)
		if math.IsInf(r.Within, 1) {
			r.Far = max(r.Far, math.Hypot(bt.s.X-x0, bt.s.Y-y0))
			r.Path += math.Hypot(bt.s.X-px, bt.s.Y-py)
			if math.Abs(angle+from*deg) < 5*deg {
				r.Within = bt.time - t0
			}
		}
		px, py = bt.s.X, bt.s.Y
		r.Ends, r.EndSpeed = angle/deg, v
	}
	return r
}

// pilotSteps is an angle off the wind, degrees, as the autopilot's target.
func pilotSteps(degrees float64) float64 {
	return math.Mod(math.Round(degrees*physics.TurnSteps/360)+physics.TurnSteps, physics.TurnSteps)
}

// shipManoeuvres prints the ship's tack with way, her tack from slow,
// and her wear, and fails if the tack with way does not come round, the
// slow one does not stall and pay off on her old side, or the wear takes
// more room than shipLengths of her.
func shipManoeuvres(k *kind) error {
	from := k.p.CloseHauled
	length := k.p.Transom + k.p.Stem
	fmt.Printf("her autopilot and crew, 12 knots, from %g° braced up sharp:\n", from)
	var failed []string
	tack := turnByPilot(k, 12, from, physics.WayTack, -1)
	fmt.Printf("  tack from %.2f knots: within 5° of %g° on the new tack after %.0f s, %.2f knots at the least; %.0f s on, %.1f° off the wind at %.2f knots\n",
		tack.Before, from, tack.Within, tack.Least, shipAfter, tack.Ends, tack.EndSpeed)
	if math.IsInf(tack.Within, 1) || !math.IsInf(tack.Stalled, 1) || tack.Ends > 0 {
		failed = append(failed, "the tack with way did not come round")
	}
	slow := turnByPilot(k, 12, from, physics.WayTack, shipSlow)
	fmt.Printf("  tack from %.2f knots: stalled after %.0f s; %.0f s on, %.1f° off the wind at %.2f knots\n",
		slow.Before, slow.Stalled, shipAfter, slow.Ends, slow.EndSpeed)
	if math.IsInf(slow.Stalled, 1) || slow.Ends < 0 {
		failed = append(failed, fmt.Sprintf("the tack from %g knots did not stall on her old tack", shipSlow))
	}
	wear := turnByPilot(k, 12, from, physics.WayGybe, -1)
	fmt.Printf("  wear from %.2f knots: within 5° of %g° on the new tack after %.0f s, %.0f m from where it began at the furthest (%g lengths, %.0f m), %.0f m sailed; %.0f s on, %.1f° off the wind at %.2f knots\n",
		wear.Before, from, wear.Within, wear.Far, float64(shipLengths), shipLengths*length, wear.Path, shipAfter, wear.Ends, wear.EndSpeed)
	if math.IsInf(wear.Within, 1) || wear.Far > shipLengths*length || wear.Ends > 0 {
		failed = append(failed, "the wear did not turn within her lengths")
	}
	if len(failed) > 0 {
		return errors.New(strings.Join(failed, "; "))
	}
	return nil
}
