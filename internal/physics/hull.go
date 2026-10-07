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
// −(m₂₂ − m₁₁) u v, turns the hull across its motion.
func (b *Prepared) hullLoads(m *motion, l *loads) {
	speed := math.Sqrt(float64(m.u*m.u) + float64(m.v*m.v))
	k := float64(float64(b.halfRhoWater*lookup(b.dragArea[:], speed, b.dragAreaInvStep)) * speed)
	cross := float64(float64(b.crossFlow*m.v) * math.Abs(m.v))
	l.X -= float64(k * m.u)
	side := float64(k*m.v) + cross
	l.Y -= side
	l.K += float64(b.hullZ * side)
	l.N -= float64(float64(b.munk*m.u) * m.v)
}

// rightingMoment returns the roll moment of the hull's form and weight, with
// the sailor on the centreline, at heel φ.
func (b *Prepared) rightingMoment(heel float64) float64 {
	lever := lookup(b.rightingLever[:], math.Abs(heel), 18/math.Pi)
	return float64(-sign(heel) * b.weight * lever)
}
