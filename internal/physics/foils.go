// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The daggerboard and the rudder: low-aspect foils under the hull (Day 2017,
// after Keuning and Verwerft 2009).

// foilLoads adds a foil's force to l and returns its level force to
// starboard. angle turns the foil's chord from the centreline, positive
// turning the bow to starboard; inflow is the share of the boat's speed the
// foil sees along the hull; downwash the share of the sideways flow from
// leeway that a foil ahead of it cancels; lift multiplies its lift
// (carry-over and heel); wet is how much of it is in the water.
func (b *Prepared) foilLoads(f *foil, m *motion, sinAngle, cosAngle, inflow, downwash, lift, wet float64, l *loads) float64 {
	if !(wet > 0) {
		return 0
	}
	pf := b.flow(m, f.x, 0, f.z, 0, 0, false)
	pf.x *= inflow
	pf.y += float64(float64(downwash*m.v) * m.cosHeel)
	// The chord runs aft from the leading edge.
	a, side, sinA, cosA := attack(&pf, -cosAngle, sinAngle)
	cl, cd := b.foilCoefficients(f, a, sinA, cosA)
	fx, fy := force(&pf, float64(float64(side*cl)*lift), cd, float64(f.area*wet))
	l.add(m, fx, fy, f.x, 0, f.z)
	return float64(fy * m.cosHeel)
}

// foilCoefficients returns a foil's lift and drag coefficients at angle of
// attack a in [0, π], whose sine and cosine are sinA and cosA. Attached flow
// gives Helmbold's lift slope and induced drag; past the stall the flow turns
// into a flat plate's normal force. Water reaching the foil from behind works
// it in reverse.
func (b *Prepared) foilCoefficients(f *foil, a, sinA, cosA float64) (cl, cd float64) {
	reverse := 1.0
	if a > math.Pi/2 {
		a = math.Pi - a
		reverse = -1
	}
	attached := float64(f.slope * a)
	sep := smooth(float64((a - b.foilStall) * b.invFoilStallWidth))
	plate := float64(b.plateNormal * sinA)
	clAttached := float64(reverse * attached)
	clSeparated := float64(plate * cosA)
	cdAttached := float64(float64(f.induced*attached) * attached)
	cdSeparated := float64(plate * sinA)
	cl = clAttached + float64(sep*(clSeparated-clAttached))
	cd = b.foilDrag + (cdAttached + float64(sep*(cdSeparated-cdAttached)))
	return cl, cd
}

// foilsWet returns how much of the foils is in the water at heel φ.
func (b *Prepared) foilsWet(heel float64) float64 {
	return smooth(float64((b.foilDryHeel - math.Abs(heel)) * b.invFoilWetRange))
}
