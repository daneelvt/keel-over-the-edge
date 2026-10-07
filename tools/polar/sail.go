// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The low-lift mainsail of the Offshore Racing Congress's VPP (2023,
// Table 5.1): the greatest lift coefficient a trimmed mainsail reaches at each
// apparent wind angle, and its viscous drag. Day (2017) found it matches a
// Laser's sail in a wind tunnel: 1.30 to 1.36 at 28°, against ORC's 1.347.
var orc = []struct{ awa, cl, cd float64 }{
	{7, 0.862, 0.026},
	{9, 1.052, 0.023},
	{12, 1.164, 0.023},
	{28, 1.347, 0.033},
	{60, 1.353, 0.113},
	{90, 1.267, 0.383},
	{120, 0.931, 0.969},
	{150, 0.388, 1.316},
	{180, -0.112, 1.345},
}

// orcQuadratic is ORC's drag growing with lift squared, kpm (Table 5.1).
const orcQuadratic = 0.01379

// sailTolerance is how far the trimmed sail's drive may be from ORC's at 28°
// and above, and its side force at 28° and 60°, as a fraction of ORC's total
// force there.
const sailTolerance = 0.05

// trimmed returns the sail's coefficients at apparent wind angle awa
// (radians) with the boom set for the most drive within its limits: both
// strips, the head twisted beyond the boom at full power.
func trimmed(b *physics.Prepared, p *physics.Params, awa float64) (cl, cd, boom float64) {
	bestDrive := math.Inf(-1)
	sinA, cosA := math.Sincos(awa)
	for d := p.BoomIn; d <= p.BoomOut+1e-9; d += 0.25 {
		var l, c float64
		for _, twist := range []float64{0, physics.SailTwist(b, d*deg, 1)} {
			a := awa - d*deg - twist
			sl, sc := physics.SailCoefficients(b, math.Abs(a), 1)
			if a < 0 {
				sl = -sl
			}
			l += sl / 2
			c += sc / 2
		}
		if drive := l*sinA - c*cosA; drive > bestDrive {
			bestDrive, cl, cd, boom = drive, l, c, d
		}
	}
	return cl, cd, boom
}

// runSail prints the trimmed sail against ORC's, as lift and drag and as
// drive and side force, and fails if drive or side force at 28° and above
// is further from ORC's than sailTolerance.
func runSail(b *physics.Prepared, p *physics.Params) error {
	induced := p.SailArea / (math.Pi * p.EffectiveHeight * p.EffectiveHeight)
	fmt.Println("  AWA  boom |   lift    ORC |   drag    ORC |  drive    ORC |   side    ORC")
	var failed []string
	for _, o := range orc {
		awa := o.awa * deg
		cl, cd, boom := trimmed(b, p, awa)
		orcCD := o.cd + (orcQuadratic+induced)*o.cl*o.cl
		sinA, cosA := math.Sincos(awa)
		drive, side := cl*sinA-cd*cosA, cl*cosA+cd*sinA
		orcDrive, orcSide := o.cl*sinA-orcCD*cosA, o.cl*cosA+orcCD*sinA
		fmt.Printf("  %3.0f %5.1f | %6.3f %6.3f | %6.3f %6.3f | %6.3f %6.3f | %6.3f %6.3f\n",
			o.awa, boom, cl, o.cl, cd, orcCD, drive, orcDrive, side, orcSide)
		// From a beam reach aft the drive changes little between an attached
		// trim and a stalled one, so the side force depends on which of two
		// nearly equal trims is best; it is shown but not held to ORC's.
		if o.awa >= 28 {
			total := math.Hypot(orcDrive, orcSide)
			sideOff := math.Abs(side-orcSide) > sailTolerance*total && o.awa <= 60
			if math.Abs(drive-orcDrive) > sailTolerance*total || sideOff {
				failed = append(failed, fmt.Sprintf("%g°: drive %.3f against %.3f, side %.3f against %.3f", o.awa, drive, orcDrive, side, orcSide))
			}
		}
	}
	if len(failed) > 0 {
		return errors.New("the trimmed sail is not ORC's:\n  " + strings.Join(failed, "\n  "))
	}
	return nil
}
