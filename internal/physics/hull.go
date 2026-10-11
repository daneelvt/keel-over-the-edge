// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// hullLoads adds the hull's resistance, its sideways drag and the Munk
// moment.
//
// The upright resistance is Day and Nixon's (2014), towed in the Kelvin
// Hydrodynamics Laboratory, as a drag area against speed: ½ρ (C_D A)(V) V²,
// along the hull's motion. A cross-flow drag carries the boat when the board
// is stalled or out of the water. The Munk moment of a slender body,
// −(m₂₂ − m₁₁) u v, turns the hull across its motion. All three are of the
// hull's motion through the water, which the waves move under it.
func (b *Prepared) hullLoads(m *motion, l *loads) {
	u, v := m.u-m.waterX, m.v-m.waterY
	speed := math.Sqrt(float64(u*u) + float64(v*v))
	k := float64(float64(b.halfRhoWater*lookup(b.dragArea[:], speed, b.dragAreaInvStep)) * speed)
	cross := float64(float64(b.crossFlow*v) * math.Abs(v))
	l.X -= float64(k * u)
	side := float64(k*v) + cross
	l.Y -= side
	l.K += float64(b.hullZ * side)
	l.N -= float64(float64(b.munk*u) * v)
}

// rightingMoment returns the roll moment of the hull's form and weight, with
// the sailor on the centreline, at heel φ off the water's surface.
func (b *Prepared) rightingMoment(heel float64) float64 {
	lever := lookup(b.rightingLever[:], math.Abs(heel), 18/math.Pi)
	return float64(-sign(heel) * b.weight * lever)
}
