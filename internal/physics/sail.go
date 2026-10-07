// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The sail is two horizontal strips, foot and head, each half its area, each
// with its centre of effort at its own height. The foot strip's chord lies
// along the boom; the head strip's is twisted further out by the twist, as a
// real sail's upper part falls off to leeward. Each strip's force comes from
// its angle of attack: attached flow below the stall, the normal force of
// separated flow beyond it, blended across the stall. The coefficients are
// fitted so that the sail, trimmed at its best within the boom's limits,
// gives the low-lift mainsail of the Offshore Racing Congress's VPP (2023,
// Table 5.1), which Day (2017) found matches a Laser's sail in a wind tunnel.
//
// The boom and sail turn about the mast. The sheet stops the boom at its
// limit but never pulls it in: inside the limit the sail is free, so it
// luffs when eased too far, presses on the sheet when trimmed, and swings
// across when the wind gets behind its leech.

// sailResult is what the sail did during a substep.
type sailResult struct {
	boomMoment float64 // moment swinging the boom to starboard, N·m
	wetDamping float64 // the boom's damping by the sail in the water, N·m·s/rad
	drive      float64 // N
	side       float64 // level force to starboard, N
	attack     [2]float64
	flow       [2]float64
}

// sailLoads adds both strips' forces to l, at the mast, and fills r. flat is
// the sailor's flattening, twist the head strip's twist beyond the boom.
func (b *Prepared) sailLoads(s *State, m *motion, flat, twist float64, l *loads, r *sailResult) {
	// The twist falls off to whichever side the boom is on, turning over
	// smoothly as the boom crosses the centreline.
	turn := clamp(float64(s.Boom*b.invTwistTurn), -1, 1)
	for i := range 2 {
		angle, z := s.Boom, b.footZ
		if i == 1 {
			angle, z = s.Boom+float64(twist*turn), b.headZ
		}
		sinB, cosB := SinCos(angle)
		// The chord runs from the mast toward the leech.
		cx, cy := -cosB, sinB
		d := b.pressureAttached
		swing := float64(d * s.BoomRate)
		pf := b.flow(m, b.mastX+float64(d*cx), float64(d*cy), z, float64(swing*sinB), float64(swing*cosB), true)
		a, side, sinA, cosA := attack(&pf, cx, cy)
		cl, cd, sep := b.sailCoefficients(a, sinA, cosA, flat)
		fx, fy := force(&pf, float64(side*cl), cd, b.strip)
		l.add(m, fx, fy, b.mastX, 0, z)

		// The centre of pressure moves aft as the flow separates; the moment
		// of the force about the mast swings the boom.
		cp := b.pressureAttached + float64(sep*(b.pressureSeparated-b.pressureAttached))
		moment := float64(cp * (float64(fx*sinB) + float64(fy*cosB)))
		if i == 1 {
			// Sailing by the lee, the wind gets behind the head's leech. The
			// soft head swings across ahead of the mast to the side the wind
			// blows toward, and its leech drags the boom over after it: the
			// accidental gybe. A rigid sail would only be pressed harder onto
			// the sheet.
			if backed := smooth(float64((a - b.headBacked) * b.invHeadBackedWidth)); backed > 0 {
				toward := clamp(pf.y/float64(0.25*pf.speed()), -1, 1)
				pull := float64(toward * float64(cp*math.Sqrt(float64(fx*fx)+float64(fy*fy))))
				moment += float64(backed * (pull - moment))
			}
		}
		r.boomMoment += moment
		r.drive += fx
		r.side += float64(fy * m.cosHeel)

		// A strip pushed under water floats back up, and the water damps it:
		// the sail lying on the water holds a capsized boat on its side.
		if pf.height < 0 {
			fz := float64(b.sailFloat*pf.height) - float64(b.sailWaterDamping*pf.vz)
			l.K += float64(pf.side * fz)
			r.wetDamping += float64(float64(b.sailWaterDamping*d) * d)
		}

		r.attack[i] = float64(side * a)
		switch {
		case a > math.Pi/2:
			r.flow[i] = FlowAback
		case a < 1/b.invLuffAngle:
			r.flow[i] = FlowLuffing
		case sep > 0.5:
			r.flow[i] = FlowStalled
		default:
			r.flow[i] = FlowAttached
		}
	}
}

// sailCoefficients returns a strip's lift and drag coefficients at angle of
// attack a in [0, π], whose sine and cosine are sinA and cosA, with the sail
// flattened to flat; and how far its flow has separated, from 0 to 1.
//
// Attached flow: lift f·C_Lmax·sin(π/2 · a/a_s), and drag C_D0 + (k_i +
// k_pm)·C_L², the induced and quadratic drag of ORC's VPP (2023, eq. 5.34).
// Below the luffing angle the cloth flogs: little lift, a little more drag.
// Separated flow: a normal force from the table, acting across the chord.
func (b *Prepared) sailCoefficients(a, sinA, cosA, flat float64) (cl, cd, sep float64) {
	luff := smooth(float64(a * b.invLuffAngle))
	t := min2(float64(a*b.invStallAngle), 2)
	clAttached := float64(float64(float64(flat*b.maxLift)*Sin(float64(math.Pi/2*t))) * luff)
	cdAttached := (b.sailDrag + float64(float64(b.liftDrag*clAttached)*clAttached)) + float64(b.flogDrag*(1-luff))
	n := lookup(b.normalForce[:], a, 18/math.Pi)
	clSeparated := float64(n * cosA)
	cdSeparated := b.sailDrag + float64(n*sinA)
	sep = smooth(float64((a - b.stallAngle) * b.invStallWidth))
	cl = clAttached + float64(sep*(clSeparated-clAttached))
	cd = cdAttached + float64(sep*(cdSeparated-cdAttached))
	return cl, cd, sep
}

// SailCoefficients returns a sail strip's lift and drag coefficients at angle
// of attack a, in [0, π], with the sail flattened to flat. It is for
// tools/polar, which compares the trimmed sail with ORC's.
func SailCoefficients(b *Prepared, a, flat float64) (cl, cd float64) {
	sinA, cosA := SinCos(a)
	cl, cd, _ = b.sailCoefficients(a, sinA, cosA, flat)
	return cl, cd
}

// twist returns the head strip's twist beyond the boom: more as the sailor
// flattens the sail, and more as the boom goes out and the leech opens.
func (b *Prepared) twist(boom, flat float64) float64 {
	return (b.twistPowered + float64(b.twistPerFlat*(1-flat))) + float64(b.twistPerBoom*math.Abs(boom))
}

// SailTwist returns the head strip's twist beyond the boom, in radians, with
// the boom at boom radians and the sail flattened to flat. It is for
// tools/polar.
func SailTwist(b *Prepared, boom, flat float64) float64 {
	return b.twist(boom, flat)
}

// flattening returns how far the sailor flattens the sail in an apparent wind
// of speed m/s: not at all up to FlattenFrom, then linearly to FlattenMin at
// FlattenTo (cunningham, vang and outhaul; ORC's FLAT, Day 2017).
func (b *Prepared) flattening(speed float64) float64 {
	return clamp(1-float64(b.flattenSlope*(speed-b.flattenFrom)), b.flattenMin, 1)
}

func min2(a, b float64) float64 {
	if b < a {
		return b
	}
	return a
}
