// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// hullLoads adds the hull's resistance, its sideways drag, the Munk
// moment, and a long hull's resistance to turning.
//
// The upright resistance is Day and Nixon's (2014), towed in the Kelvin
// Hydrodynamics Laboratory, as a drag area against speed: ½ρ (C_D A)(V) V²,
// along the hull's motion. A cross-flow drag carries the boat when the board
// is stalled or out of the water. The Munk moment of a slender body,
// −(m₂₂ − m₁₁) u v, turns the hull across its motion. All three are of the
// hull's motion through the water, which the waves move under it.
//
// drag scales the drag area: 1 but for a catamaran flying a hull or a
// hull with its bows buried. It returns the resistance's force aft.
func (b *Prepared) hullLoads(m *motion, l *loads, drag float64) float64 {
	u, v := m.u-m.waterX, m.v-m.waterY
	speed := math.Sqrt(float64(u*u) + float64(v*v))
	k := float64(float64(b.halfRhoWater*lookup(b.dragArea[:], speed, b.dragAreaInvStep)) * speed)
	if drag != 1 {
		k = float64(k * drag)
	}
	cross := float64(float64(b.crossFlow*v) * math.Abs(v))
	l.X -= float64(k * u)
	side := float64(k*v) + cross
	l.Y -= side
	l.K += float64(b.hullZ * side)
	l.N -= float64(float64(b.munk*u) * v)
	if b.yawDamping != 0 {
		// A long hull turning drives the water across its ends: the
		// cross flow's moment, ∫ ½ρ C_D T (r x)|r x| x dx along it.
		l.N -= float64(float64(b.yawDamping*m.r) * math.Abs(m.r))
	}
	return float64(k * u)
}

// rightingMoment returns the roll moment of the hull's form and weight, with
// the sailor on the centreline, at heel φ off the water's surface.
func (b *Prepared) rightingMoment(heel float64) float64 {
	lever := lookup(b.rightingLever[:], math.Abs(heel), b.leverInvStep)
	return float64(-sign(heel) * b.weight * lever)
}
