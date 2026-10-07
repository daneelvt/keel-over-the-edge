// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Frames. The heading frame is level and turns with the boat's heading: x
// ahead, y to starboard, z down, its origin at the boat's centre of gravity.
// The body frame is the heading frame rolled by the heel about x. A point
// (y, z) of the body frame is at y cos φ − z sin φ, y sin φ + z cos φ in the
// heading frame. Sails and foils lie in the body frame's x–y plane, so they
// meet only the flow's components in that plane: this is how heel reduces the
// crosswind a sail feels by cos φ (Offshore Racing Congress VPP 2023, 7.1).

// motion is the boat's motion during a substep, and the true wind.
type motion struct {
	u, v, r, p       float64 // surge, sway, yaw rate, roll rate
	sinHeel, cosHeel float64
	// windX and windY are the true wind's velocity 10 m up, in the heading
	// frame: where the air moves, m/s.
	windX, windY float64
}

// pointFlow is the flow past a point of the boat.
type pointFlow struct {
	x, y   float64 // the flow in the body frame's x and y, m/s
	height float64 // the point's height above the water, m
	side   float64 // the point's offset to starboard in the heading frame, m
	vz     float64 // the point's own speed downward, m/s
}

// windFactor returns the true wind at height z above the water as a fraction
// of the wind 10 m up: the logarithmic profile over the open sea (ORC VPP
// 2023, 7.1, with the open sea's roughness), falling linearly to nothing
// below windFloor.
func (b *Prepared) windFactor(z float64) float64 {
	if z >= windFloor {
		return float64(Log(z/seaRoughness) * b.invLogReference)
	}
	if z > 0 {
		return float64(z * (b.floorWindFactor * (1 / windFloor)))
	}
	return 0
}

// flow returns the flow past the point (x, y, z) of the body frame: the
// air's velocity at the point's height, or still water's if air is false,
// less the point's own velocity from the boat's surge, sway, yaw and roll.
// (ex, ey) is the point's own velocity in the body frame, for a point on the
// swinging boom.
func (b *Prepared) flow(m *motion, x, y, z, ex, ey float64, air bool) pointFlow {
	yh := float64(y*m.cosHeel) - float64(z*m.sinHeel)
	zh := float64(y*m.sinHeel) + float64(z*m.cosHeel)
	// The point's velocity in the heading frame: v + ω × r, with ω = (p, 0, r).
	vx := (m.u - float64(m.r*yh)) + ex
	vy := ((m.v + float64(m.r*x)) - float64(m.p*zh)) + float64(ey*m.cosHeel)
	vz := float64(m.p*yh) + float64(ey*m.sinHeel)
	f := pointFlow{height: b.centreOfGravity - zh, side: yh, vz: vz}
	fx, fy := -vx, -vy
	if air {
		w := b.windFactor(f.height)
		fx += float64(w * m.windX)
		fy += float64(w * m.windY)
	}
	f.x = fx
	f.y = float64(fy*m.cosHeel) - float64(vz*m.sinHeel)
	return f
}

// speed returns the flow's speed in the body frame's plane.
func (f *pointFlow) speed() float64 {
	return math.Sqrt(float64(f.x*f.x) + float64(f.y*f.y))
}

// loads sums the forces and moments on the boat during a substep: X ahead
// and Y to starboard in the heading frame, N turning the bow to starboard and
// K heeling to starboard, about the centre of gravity.
type loads struct {
	X, Y, N, K float64
}

// add applies a force (fx, fy) in the body frame's x–y plane at the body
// point (x, y, z).
func (l *loads) add(m *motion, fx, fy, x, y, z float64) {
	yh := float64(y*m.cosHeel) - float64(z*m.sinHeel)
	level := float64(fy * m.cosHeel)
	l.X += fx
	l.Y += level
	l.N += float64(x*level) - float64(yh*fx)
	l.K -= float64(z * fy)
}

// force returns a foil's or sail strip's force from its coefficients: lift
// across the flow, drag along it. scale is ½ρ × area; the force is scale ×
// speed × (cl × the flow turned a right angle + cd × the flow).
func force(f *pointFlow, cl, cd, scale float64) (fx, fy float64) {
	q := float64(scale * f.speed())
	fx = float64(q * (float64(cd*f.x) - float64(cl*f.y)))
	fy = float64(q * (float64(cl*f.x) + float64(cd*f.y)))
	return fx, fy
}

// attack returns the angle in [0, π] between a flow and a chord running from
// leading edge to trailing edge (cx, cy), with the side of the chord the flow
// comes from: positive when lift, for this sign, pushes the chord the way the
// flow turned a right angle points. It also returns the angle's sine and
// cosine. With no flow, the angle is 0.
func attack(f *pointFlow, cx, cy float64) (angle, side, sin, cos float64) {
	u := f.speed()
	if !(u > 0) {
		// No flow: no angle, rather than whatever the signs of zero give.
		return 0, 0, 0, 1
	}
	cross := float64(cx*f.y) - float64(cy*f.x)
	dot := float64(cx*f.x) + float64(cy*f.y)
	return Atan2(math.Abs(cross), dot), sign(cross), math.Abs(cross) / u, dot / u
}
