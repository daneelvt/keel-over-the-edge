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
	// The headsails', as the main's.
	jibMoment     float64 // moment swinging the clew to starboard, N·m
	jibWetDamping float64
	jibTwist      float64 // rad
	jibAttack     [2]float64
	jibFlow       [2]float64
	// The square sails': each group's strips' angles of attack, negative
	// aback, and their flows.
	foreAttack  [2]float64
	foreFlow    [2]float64
	afterAttack [2]float64
	afterFlow   [2]float64
}

// rig is the sails' shape for a step: their areas and heights as reefed.
// A reef shortens a sail's luff to its share: its area goes as the square
// of the share and its strips' heights above the boom, or the tack, with
// it (as the Offshore Racing Congress's VPP, 2023, reefs a sail).
type rig struct {
	share        float64 // the main's share of its luff
	strip        float64 // ½ρ_air × the area of one of its strips, kg/m
	footZ, headZ float64 // depth of each strip's centre of effort below the centre of gravity, m
	effortZ      float64
	jibStrip     float64
	jibFootZ     float64
	jibHeadZ     float64
	foreStrip    float64
	afterStrip   float64
	squareFootZ  float64
	squareHeadZ  float64
}

// rigAt fills r with the sails' shape at reef reef, from 0 to 2.
func (b *Prepared) rigAt(reef float64, r *rig) {
	share := lookup(b.reefs[:], reef, 1)
	r.share = share
	r.strip = float64(float64(b.strip*share) * share)
	r.footZ = b.boomZ - float64(b.footHeight*share)
	r.headZ = b.boomZ - float64(b.headHeight*share)
	r.effortZ = float64(0.5 * (r.footZ + r.headZ))
	if b.jib {
		share = lookup(b.jibReefs[:], reef, 1)
		r.jibStrip = float64(float64(b.jibStrip*share) * share)
		r.jibFootZ = b.jibTackZ - float64(b.jibFootHeight*share)
		r.jibHeadZ = b.jibTackZ - float64(b.jibHeadHeight*share)
	}
	if b.square {
		share = lookup(b.squareReefs[:], reef, 1)
		share2 := float64(share * share)
		r.foreStrip = float64(b.foreStrip * share2)
		r.afterStrip = float64(b.afterStrip * share2)
		r.squareFootZ = b.squareFootZ - float64(b.squareFootHeight*share)
		r.squareHeadZ = b.squareFootZ - float64(b.squareHeadHeight*share)
	}
}

// sailLoads adds both strips' forces to l, at the mast, and fills r. flat is
// the sailor's flattening, twist the head strip's twist beyond the boom,
// g the sails' shape as reefed. The headsails follow the main.
func (b *Prepared) sailLoads(s *State, m *motion, flat, twist float64, g *rig, l *loads, r *sailResult) {
	// The twist falls off to whichever side the boom is on, turning over
	// smoothly as the boom crosses the centreline.
	turn := clamp(float64(s.Boom*b.invTwistTurn), -1, 1)
	for i := range 2 {
		angle, z := s.Boom, g.footZ
		if i == 1 {
			angle, z = s.Boom+float64(twist*turn), g.headZ
		}
		sinB, cosB := SinCos(angle)
		// The chord runs from the mast toward the leech.
		cx, cy := -cosB, sinB
		d := b.pressureAttached
		swing := float64(d * s.BoomRate)
		pf := b.flow(m, b.mastX+float64(d*cx), float64(d*cy), z, float64(swing*sinB), float64(swing*cosB), true)
		a, side, sinA, cosA := attack(&pf, cx, cy)
		cl, cd, sep := b.sail.coefficients(a, sinA, cosA, flat)
		fx, fy := force(&pf, float64(side*cl), cd, g.strip)
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
		r.flow[i] = b.sail.flowOf(a, sep)
	}
	if b.jib {
		b.jibLoads(s, m, flat, g, l, r)
	}
	if b.square {
		b.squareLoads(s.ForeYards, b.foreX, g.foreStrip, m, g, l, r, &r.foreAttack, &r.foreFlow)
		b.squareLoads(s.Yards, b.afterX, g.afterStrip, m, g, l, r, &r.afterAttack, &r.afterFlow)
	}
}

// squareLoads adds a group of square sails' strips' forces to l, at their
// centres of pressure, and fills r's drive and side force and the strips'
// attack and flow. yards is the group's yards' angle off the centreline,
// positive braced for the wind over port (the port yardarm forward), and
// x its mast's place. The yards hold the sails: their forces pass to the
// hull through the braces.
//
// A square sail is the same from either yardarm: the flow meets it at an
// angle of attack off the yards' line, from 0, edge on, to 90°, square to
// it, on its after face, where it draws and bellies forward (Tadano and
// others 1991), or on its fore face, aback, where it lies flat against
// its mast and gives the normal force of separated flow, driving the ship
// astern. Its lift is across the flow toward the face the wind is not on.
func (b *Prepared) squareLoads(yards, x, strip float64, m *motion, g *rig, l *loads, r *sailResult, attackOut, flowOut *[2]float64) {
	out := sign(yards)
	if out == 0 {
		out = 1
	}
	for i := range 2 {
		angle, z := math.Abs(yards), g.squareFootZ
		if i == 1 {
			angle, z = min2(angle+b.squareTwist, math.Pi/2), g.squareHeadZ
		}
		sinY, cosY := SinCos(angle)
		// Along the yards from the arm braced forward to the one aft, and
		// the normal out of the sails' after face.
		cx, cy := -cosY, float64(out*sinY)
		nx, ny := -sinY, float64(-out*cosY)
		// The flow at the mast: the yards are short beside the ship's
		// turning.
		pf := b.flow(m, x, 0, z, 0, 0, true)
		a, _, _, _ := attack(&pf, cx, cy)
		// The arm the flow meets first, and the angle off the yards' line.
		from := -1.0
		if a > math.Pi/2 {
			a, from = math.Pi-a, 1
		}
		face := float64(pf.x*nx) + float64(pf.y*ny)
		aback := face > 0
		d := b.squarePressure
		sinA, cosA := SinCos(a)
		var cl, cd, sep float64
		if aback {
			n := lookup(b.squareSail.normalForce[:], a, 18/math.Pi)
			cl, cd, sep = float64(n*cosA), b.squareSail.drag+float64(n*sinA), 1
		} else {
			cl, cd, sep = b.squareSail.coefficients(a, sinA, cosA, 1)
		}
		// The centre of pressure moves in to the mast as the flow
		// separates.
		cp := float64(float64(from*d) * (1 - sep))
		px, py := float64(cp*cx), float64(cp*cy)
		// Lift toward the leeward face: the face the flow leaves by.
		lx, ly := nx, ny
		if !aback {
			lx, ly = -nx, -ny
		}
		if float64(-pf.y*lx)+float64(pf.x*ly) < 0 {
			cl = -cl
		}
		fx, fy := force(&pf, cl, cd, strip)
		l.add(m, fx, fy, x+px, py, z)
		r.drive += fx
		r.side += float64(fy * m.cosHeel)
		if pf.height < 0 {
			fz := float64(b.sailFloat*pf.height) - float64(b.sailWaterDamping*pf.vz)
			l.K += float64(pf.side * fz)
		}
		attackOut[i] = a
		flowOut[i] = b.squareSail.flowOf(a, sep)
		if aback {
			attackOut[i], flowOut[i] = -a, FlowAback
		}
	}
}


// jibLoads adds the headsails' strips' forces to l, at the tack, and fills
// r's headsail values. They are the main's strips about the stay, the clew
// in place of the boom, with no backed head: a backed jib only presses its
// clew across.
func (b *Prepared) jibLoads(s *State, m *motion, flat float64, g *rig, l *loads, r *sailResult) {
	turn := clamp(float64(s.Jib*b.invTwistTurn), -1, 1)
	twist := b.jibTwist + float64(b.jibTwistPerAngle*math.Abs(s.Jib))
	r.jibTwist = twist
	for i := range 2 {
		angle, z := s.Jib, g.jibFootZ
		if i == 1 {
			angle, z = s.Jib+float64(twist*turn), g.jibHeadZ
		}
		sinJ, cosJ := SinCos(angle)
		cx, cy := -cosJ, sinJ
		d := b.jibPressureAttached
		swing := float64(d * s.JibRate)
		pf := b.flow(m, b.jibX+float64(d*cx), float64(d*cy), z, float64(swing*sinJ), float64(swing*cosJ), true)
		a, side, sinA, cosA := attack(&pf, cx, cy)
		cl, cd, sep := b.jibSail.coefficients(a, sinA, cosA, flat)
		fx, fy := force(&pf, float64(side*cl), cd, g.jibStrip)
		l.add(m, fx, fy, b.jibX, 0, z)
		cp := b.jibPressureAttached + float64(sep*(b.jibPressureSeparated-b.jibPressureAttached))
		r.jibMoment += float64(cp * (float64(fx*sinJ) + float64(fy*cosJ)))
		r.drive += fx
		r.side += float64(fy * m.cosHeel)
		if pf.height < 0 {
			fz := float64(b.sailFloat*pf.height) - float64(b.sailWaterDamping*pf.vz)
			l.K += float64(pf.side * fz)
			r.jibWetDamping += float64(float64(b.sailWaterDamping*d) * d)
		}
		r.jibAttack[i] = float64(side * a)
		r.jibFlow[i] = b.jibSail.flowOf(a, sep)
	}
}

// flowOf is a strip's flow at angle of attack a, its flow separated by sep.
func (k *sailCoefficients) flowOf(a, sep float64) float64 {
	switch {
	case a > math.Pi/2:
		return FlowAback
	case a < 1/k.invLuffAngle:
		return FlowLuffing
	case sep > 0.5:
		return FlowStalled
	}
	return FlowAttached
}

// coefficients returns a strip's lift and drag coefficients at angle of
// attack a in [0, π], whose sine and cosine are sinA and cosA, with the sail
// flattened to flat; and how far its flow has separated, from 0 to 1.
//
// Attached flow: lift f·C_Lmax·sin(π/2 · a/a_s), and drag C_D0 + (k_i +
// k_pm)·C_L², the induced and quadratic drag of ORC's VPP (2023, eq. 5.34).
// Below the luffing angle the cloth flogs: little lift, a little more drag.
// Separated flow: a normal force from the table, acting across the chord.
func (k *sailCoefficients) coefficients(a, sinA, cosA, flat float64) (cl, cd, sep float64) {
	luff := smooth(float64(a * k.invLuffAngle))
	t := min2(float64(a*k.invStallAngle), 2)
	clAttached := float64(float64(float64(flat*k.maxLift)*Sin(float64(math.Pi/2*t))) * luff)
	cdAttached := (k.drag + float64(float64(k.liftDrag*clAttached)*clAttached)) + float64(k.flogDrag*(1-luff))
	n := lookup(k.normalForce[:], a, 18/math.Pi)
	clSeparated := float64(n * cosA)
	cdSeparated := k.drag + float64(n*sinA)
	sep = smooth(float64((a - k.stallAngle) * k.invStallWidth))
	cl = clAttached + float64(sep*(clSeparated-clAttached))
	cd = cdAttached + float64(sep*(cdSeparated-cdAttached))
	return cl, cd, sep
}

// SailCoefficients returns a main's strip's lift and drag coefficients at
// angle of attack a, in [0, π], with the sail flattened to flat. It is for
// tools/polar, which compares the trimmed sail with ORC's.
func SailCoefficients(b *Prepared, a, flat float64) (cl, cd float64) {
	sinA, cosA := SinCos(a)
	cl, cd, _ = b.sail.coefficients(a, sinA, cosA, flat)
	return cl, cd
}

// HeadsailCoefficients returns the same of a headsail's strip, for
// tools/polar, which compares it with ORC's jib.
func HeadsailCoefficients(b *Prepared, a, flat float64) (cl, cd float64) {
	sinA, cosA := SinCos(a)
	cl, cd, _ = b.jibSail.coefficients(a, sinA, cosA, flat)
	return cl, cd
}

// HeadsailTwist returns a headsail's upper strip's twist beyond the clew's
// line with the clew at angle radians, for tools/polar.
func HeadsailTwist(b *Prepared, angle float64) float64 {
	return b.jibTwist + float64(b.jibTwistPerAngle*math.Abs(angle))
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
