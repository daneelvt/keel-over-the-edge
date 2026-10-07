// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The test body: a small boat-like body on flat water, driven by a sail and
// turned by a rudder. It stands in for a boat until the Jolly boat's model
// replaces it, and exists to prove the harness: a step uses every function a
// boat will (SinCos, Atan2, Sqrt, Exp, Log, Floor), so the golden runs show
// that all of them agree between the server and the browser.

const (
	airDensity   = 1.225  // kg/m³
	seaRoughness = 0.0002 // roughness length of the open sea, m
	sideForce    = 0.6    // sideways force of the sail, as a fraction of its drive
)

// Step advances a body by one step of Dt seconds.
func Step(s *State, c *Control, e *Env, p *Params) {
	sinH, cosH := SinCos(s.Heading)

	// The true wind at the sail's height, from the logarithmic profile over
	// the sea, and the apparent wind: the true wind less the body's own
	// velocity. Vectors point the way the air moves.
	wind := e.WindSpeed * (Log(p.SailHeight/seaRoughness) / Log(10/seaRoughness))
	sinW, cosW := SinCos(e.WindFrom)
	vx := float64(s.Surge*sinH) + float64(s.Sway*cosH)
	vy := float64(s.Surge*cosH) - float64(s.Sway*sinH)
	ax := float64(-wind*sinW) - vx
	ay := float64(-wind*cosW) - vy
	aws := math.Sqrt(float64(ax*ax) + float64(ay*ay))
	// The angle the apparent wind comes from, off the bow, positive from
	// starboard.
	awa := wrapAngle(Atan2(-ax, -ay) - s.Heading)

	// The sail drives ahead with the wind abeam and not at all head to wind;
	// its sideways force pushes the body away from the wind.
	q := 0.5 * airDensity * (aws * aws) * p.SailArea * c.Trim
	sinA, _ := SinCos(awa)
	off := math.Abs(awa)
	drive := float64(float64(q*math.Abs(sinA)) * (1 - Exp(-4*off)))
	side := float64(-sideForce * q * sinA)

	resistAhead := float64(p.DragAhead * s.Surge * math.Abs(s.Surge))
	resistSide := float64(p.DragSide * s.Sway * math.Abs(s.Sway))
	moment := p.RudderPower * c.Helm * s.Surge * math.Abs(s.Surge)

	// Semi-implicit Euler, with the turn dying away exactly.
	surgeAcc := (drive-resistAhead)/p.Mass + float64(s.YawRate*s.Sway)
	swayAcc := (side-resistSide)/p.Mass - float64(s.YawRate*s.Surge)
	s.Surge += float64(surgeAcc * Dt)
	s.Sway += float64(swayAcc * Dt)
	s.YawRate = float64(s.YawRate*Exp(-p.YawDamping*Dt)) + float64(moment/p.YawInertia*Dt)
	s.Heading = wrapAngle(s.Heading + float64(s.YawRate*Dt))

	sinH, cosH = SinCos(s.Heading)
	s.X += float64((float64(s.Surge*sinH) + float64(s.Sway*cosH)) * Dt)
	s.Y += float64((float64(s.Surge*cosH) - float64(s.Sway*sinH)) * Dt)
}

// 2π in two parts; the first holds 33 bits, so a multiple of it by an integer
// below 2^20 is exact.
const (
	twoPi1  = 4 * pio2_1
	twoPi1t = 4 * pio2_1t
)

// wrapAngle returns a, less the whole turns that bring it into [-π, π].
func wrapAngle(a float64) float64 {
	n := math.Floor(float64(a*(invPio2/4)) + 0.5)
	return (a - float64(n*twoPi1)) - float64(n*twoPi1t)
}
