// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// orcSail is one of the Offshore Racing Congress's VPP sails (2023, §5.2):
// the greatest lift coefficient it reaches trimmed at each apparent wind
// angle, its viscous drag, and its drag growing with lift squared.
type orcSail struct {
	name      string
	points    []struct{ awa, cl, cd float64 }
	quadratic float64
	// from and to are the angles between which drive is held to the
	// source; side the angles at which side force is too.
	from, to float64
	side     []float64
}

// orcMain is ORC's low-lift mainsail (Table 5.1). Day (2017) found it
// matches a Laser's sail in a wind tunnel: 1.30 to 1.36 at 28°, against
// ORC's 1.347.
var orcMain = orcSail{
	name: "ORC's mainsail",
	points: []struct{ awa, cl, cd float64 }{
		{7, 0.862, 0.026},
		{9, 1.052, 0.023},
		{12, 1.164, 0.023},
		{28, 1.347, 0.033},
		{60, 1.353, 0.113},
		{90, 1.267, 0.383},
		{120, 0.931, 0.969},
		{150, 0.388, 1.316},
		{180, -0.112, 1.345},
	},
	quadratic: 0.01379,
	from:      28,
	to:        180,
	side:      []float64{28, 60},
}

// orcJib is ORC's low-lift jib, of a forestay that cannot be adjusted
// while racing (Table 5.4). It is held to from 27° to 100°: from a broad
// reach aft ORC's jib stands across the wind as if poled out, where a jib
// sheeted to the rail, as the game's is, stands behind the main.
var orcJib = orcSail{
	name: "ORC's jib",
	points: []struct{ awa, cl, cd float64 }{
		{7, 0, 0.05},
		{15, 1.0, 0.032},
		{20, 1.375, 0.031},
		{27, 1.45, 0.037},
		{50, 1.45, 0.25},
		{60, 1.25, 0.35},
		{100, 0.40, 0.73},
		{150, 0, 0.95},
		{180, -0.10, 0.90},
	},
	quadratic: 0.016,
	from:      27,
	to:        100,
	side:      []float64{27, 50, 60},
}

// sailTolerance is how far a trimmed sail's drive may be from its source's
// at the angles it is held at, and its side force where that is held, as a
// fraction of the source's total force there.
const sailTolerance = 0.05

// coefficients is a sail of the boat's as the tool trims it: its
// coefficients at an angle of attack, its upper strip's twist with its
// foot at an angle off the centreline, and that angle's limits, degrees.
type coefficients struct {
	at      func(a float64) (cl, cd float64)
	twist   func(angle float64) float64
	in, out float64
}

// mainOf is the boat's main, unflattened.
func mainOf(k *kind) coefficients {
	return coefficients{
		at:    func(a float64) (float64, float64) { return physics.SailCoefficients(k.b, a, 1) },
		twist: func(d float64) float64 { return physics.SailTwist(k.b, d, 1) },
		in:    k.p.BoomIn, out: k.p.BoomOut,
	}
}

// headsailsOf is the boat's headsails, unflattened.
func headsailsOf(k *kind) coefficients {
	return coefficients{
		at:    func(a float64) (float64, float64) { return physics.HeadsailCoefficients(k.b, a, 1) },
		twist: func(d float64) float64 { return physics.HeadsailTwist(k.b, d) },
		in:    k.p.HeadsailIn, out: k.p.HeadsailOut,
	}
}

// trimmed returns the sail's coefficients at apparent wind angle awa
// (radians) with its foot set for the most drive within its limits: both
// strips, the head twisted beyond the foot.
func trimmed(c coefficients, awa float64) (cl, cd, angle float64) {
	bestDrive := math.Inf(-1)
	sinA, cosA := math.Sincos(awa)
	for d := c.in; d <= c.out+1e-9; d += 0.25 {
		var l, cc float64
		for _, twist := range []float64{0, c.twist(d * deg)} {
			a := awa - d*deg - twist
			sl, sc := c.at(math.Abs(a))
			if a < 0 {
				sl = -sl
			}
			l += sl / 2
			cc += sc / 2
		}
		if drive := l*sinA - cc*cosA; drive > bestDrive {
			bestDrive, cl, cd, angle = drive, l, cc, d
		}
	}
	return cl, cd, angle
}

// runSail prints each of the boat's sails trimmed against its source, as
// lift and drag and as drive and side force, and fails if drive or side
// force where they are held is further from the source's than
// sailTolerance. Induced drag is the whole rig's, as in the step: its area
// on its effective height.
func runSail(k *kind) error {
	induced := (k.p.SailArea + k.p.HeadsailArea) / (math.Pi * k.p.EffectiveHeight * k.p.EffectiveHeight)
	fmt.Printf("%s\n", k.name)
	failed := compareSail("the main", mainOf(k), orcMain, induced)
	if k.p.HeadsailArea > 0 {
		failed = append(failed, compareSail("the headsails", headsailsOf(k), orcJib, induced)...)
	}
	if len(failed) > 0 {
		return errors.New("the trimmed sails are not ORC's:\n  " + strings.Join(failed, "\n  "))
	}
	return nil
}

// compareSail prints one sail against its source and returns the angles at
// which it is not within sailTolerance.
func compareSail(name string, c coefficients, src orcSail, induced float64) []string {
	fmt.Printf("%s against %s\n", name, src.name)
	fmt.Println("  AWA  trim |   lift    ORC |   drag    ORC |  drive    ORC |   side    ORC")
	var failed []string
	for _, o := range src.points {
		awa := o.awa * deg
		cl, cd, angle := trimmed(c, awa)
		orcCD := o.cd + (src.quadratic+induced)*o.cl*o.cl
		sinA, cosA := math.Sincos(awa)
		drive, side := cl*sinA-cd*cosA, cl*cosA+cd*sinA
		orcDrive, orcSide := o.cl*sinA-orcCD*cosA, o.cl*cosA+orcCD*sinA
		fmt.Printf("  %3.0f %5.1f | %6.3f %6.3f | %6.3f %6.3f | %6.3f %6.3f | %6.3f %6.3f\n",
			o.awa, angle, cl, o.cl, cd, orcCD, drive, orcDrive, side, orcSide)
		// From a beam reach aft the drive changes little between an attached
		// trim and a stalled one, so the side force depends on which of two
		// nearly equal trims is best; it is shown but held to the source only
		// at its side angles.
		if o.awa >= src.from && o.awa <= src.to {
			total := math.Hypot(orcDrive, orcSide)
			sideOff := false
			for _, a := range src.side {
				sideOff = sideOff || (a == o.awa && math.Abs(side-orcSide) > sailTolerance*total)
			}
			if math.Abs(drive-orcDrive) > sailTolerance*total || sideOff {
				failed = append(failed, fmt.Sprintf("%s at %g°: drive %.3f against %.3f, side %.3f against %.3f", name, o.awa, drive, orcDrive, side, orcSide))
			}
		}
	}
	return failed
}
