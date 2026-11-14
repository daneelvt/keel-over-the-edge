// SPDX-License-Identifier: AGPL-3.0-only

package committee

import "github.com/daneelvt/keel-over-the-edge/internal/bus"

// Crossings, on a boat's way from one tick to the next: a straight segment,
// exact and cheap.

// rayCross is how the segment from (ax, ay) to (bx, by) crosses ray ch: +1
// clockwise about its start, −1 anticlockwise, 0 not at all.
func rayCross(ch *bus.RaceCheck, ax, ay, bx, by float64) int8 {
	// How far a point lies to the anticlockwise side of the ray's line:
	// positive before a clockwise sweep about its start reaches the ray.
	across := func(px, py float64) float64 { return float64(ch.S*(py-ch.Y)) - float64(ch.C*(px-ch.X)) }
	pa, pb := across(ax, ay), across(bx, by)
	if (pa >= 0) == (pb >= 0) {
		return 0
	}
	t := pa / (pa - pb)
	x, y := ax+float64(t*(bx-ax)), ay+float64(t*(by-ay))
	if !(float64(ch.S*(x-ch.X))+float64(ch.C*(y-ch.Y)) > 0) {
		return 0
	}
	if pa >= 0 {
		return 1
	}
	return -1
}

// lineCross is how the segment from (ax, ay) to (bx, by) crosses line ch,
// between its ends: +1 from its left to its right, looking from its first
// end to its second, −1 the other way, 0 not at all.
func lineCross(ch *bus.RaceCheck, ax, ay, bx, by float64) int8 {
	dx, dy := ch.X2-ch.X, ch.Y2-ch.Y
	side := func(px, py float64) float64 { return float64(dx*(py-ch.Y)) - float64(dy*(px-ch.X)) }
	sa, sb := side(ax, ay), side(bx, by)
	if (sa > 0) == (sb > 0) {
		return 0
	}
	t := sa / (sa - sb)
	x, y := ax+float64(t*(bx-ax)), ay+float64(t*(by-ay))
	l2 := float64(dx*dx) + float64(dy*dy)
	u := (float64(dx*(x-ch.X)) + float64(dy*(y-ch.Y))) / l2
	if !(u >= 0 && u <= 1) {
		return 0
	}
	if sa > 0 {
		return 1
	}
	return -1
}
