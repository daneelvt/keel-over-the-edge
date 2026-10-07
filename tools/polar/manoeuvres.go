// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"math"

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
func settled(b *physics.Prepared, windKnots, twa float64) (*boat, helmsman) {
	pt := best(b, windKnots, twa)
	h := helmsman{target: twa * deg}
	bt := newBoat(b, wind10(windKnots), h.target, pt.Sheet)
	for range int(settle * physics.StepsPerSecond) {
		bt.c.Helm = h.helm(&bt.s)
		bt.step()
	}
	return bt, h
}

// turn sails a boat settled at from (degrees) round to the same angle on the
// other tack, through the wind for a tack or through dead downwind for a
// gybe, and measures the manoeuvre over the following 30 s against the VMG
// it had.
func turn(b *physics.Prepared, windKnots, from float64) manoeuvre {
	bt, h := settled(b, windKnots, from)
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
func byTheLee(b *physics.Prepared, windKnots float64) float64 {
	bt, h := settled(b, windKnots, 170)
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

func runManoeuvres(b *physics.Prepared) error {
	fmt.Println("wind  manoeuvre  before  least  least/before  regain 90%  lost      boom crossed")
	for _, w := range []float64{6, 12, 18} {
		for _, mv := range []struct {
			name string
			from float64
		}{{"tack", 45}, {"gybe", 150}} {
			m := turn(b, w, mv.from)
			status := ""
			if !m.OK {
				status = "  capsized"
			}
			fmt.Printf("%4g  %-9s  %5.2f  %5.2f  %11.0f%%  %8.1f s  %5.1f m  %v%s\n",
				w, mv.name, m.Before, m.Least, 100*m.Least/m.Before, m.Regain, m.Lost, m.Crossed, status)
		}
	}
	for _, w := range []float64{6, 12, 18} {
		fmt.Printf("%4g  an accidental gybe comes %.1f° by the lee\n", w, byTheLee(b, w))
	}
	return nil
}
