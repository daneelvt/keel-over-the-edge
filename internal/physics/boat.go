// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The boat is a rigid body in surge, sway, yaw and roll, heaving and pitching
// on the waves (waves.go), with the boom as a body of its own and the
// sailor's position. Every force comes
// from the flow a part of the boat meets, including the flow from the boat's
// own turning and rolling: the sail's two strips, the windage of hull, sailor
// and spars, the daggerboard and rudder, and the hull. Tacks, gybes, luffing,
// weather helm and capsizes are not scripted; they follow from the forces.
// This is how velocity prediction programs for dinghies are built (Day
// 2017), and the dynamic models of Keuning, Vermeulen and de Ridder (2005)
// and Masuyama and Ogihara (2020).
//
// Equations of motion in the heading frame, with added masses m₁₁ and m₂₂:
//
//	(m + m₁₁) u̇ − (m + m₂₂) v r = X
//	(m + m₂₂) v̇ + (m + m₁₁) u r = Y
//	I_zz ṙ = N,  I_xx ṗ = K,  I_b δ̈ = M_boom
//
// integrated by semi-implicit Euler, Substeps times a step: velocities
// first, then positions from the new velocities.

// Step advances a boat by one step of Dt seconds. sea is the sea about the
// boat at the step's tick, or nil for flat water; g the ground under it, or
// nil for the open sea; b is the boat's kind, from Prepare. It only reads
// sea and g, and writes o and never reads it.
func Step(s *State, c *Control, e *Env, sea *Sea, g *Ground, b *Prepared, o *Out) {
	step(s, c, e, sea, g, b, o, Substeps)
}

// step is Step in n substeps; the tests compare Substeps with more.
func step(s *State, c *Control, e *Env, sea *Sea, g *Ground, b *Prepared, o *Out, n int32) {
	helm := control(c.Helm, -1, 1)
	sheet := control(c.Sheet, 0, 1)
	if PilotOn(c) {
		helm = b.pilot(s, c, e, o)
	} else {
		pilotOff(s, c, o)
	}
	if s.SailorMode != Sailing {
		// Nobody holds the tiller or the sheet.
		helm, sheet = 0, 1
	}
	o.PilotHelm = helm
	// The rudder and the sheet follow the controls as fast as the sailor's
	// hands can move them; the sheet eases faster than it hauls.
	s.Rudder = approach(s.Rudder, float64(helm*b.rudderMax), float64(b.rudderRate*Dt))
	limit := b.boomIn + float64(sheet*(b.boomOut-b.boomIn))
	rate := b.haulRate
	if limit > s.SheetLimit {
		rate = b.easeRate
	}
	s.SheetLimit = approach(clamp(s.SheetLimit, b.boomIn, b.boomOut), limit, float64(rate*Dt))

	wind := e.WindSpeed
	if !(wind > 0) {
		wind = 0
	}
	sinW, cosW := SinCos(e.WindFrom)
	// The sea is read once, where the boat is as the step begins: the waves
	// change little in a step, and their rates carry them across it. Over
	// shallow ground they are capped by the depth at the boat's hexagon.
	var v wave
	if sea != nil {
		sinH, cosH := SinCos(s.Heading)
		v.read(sea, s, sinH, cosH, b.halfLength, b.halfBeam, &b.foilDecay)
		v.capDepth(sea, g, s.X, s.Y)
		v.twist = float64(v.twist * b.twistArm)
	}
	// The current moves the water under the boat as the waves do, but
	// steadily over the ground: the substeps turn it into the heading
	// frame as the boat turns.
	if e.CurrentEast != 0 || e.CurrentNorth != 0 {
		v.current, v.currentEast, v.currentNorth = true, e.CurrentEast, e.CurrentNorth
	}
	// So is the ground: where the bottom reaches a foil or the hull.
	var bd bed
	if g != nil {
		sinH, cosH := SinCos(s.Heading)
		bd.read(g, s, b, sinH, cosH)
	}
	dt := Dt / float64(n)
	for i := range n {
		b.substep(s, wind, sinW, cosW, dt, &v, &bd, o, i == n-1)
		v.advance(dt)
	}
	s.Heading = wrapAngle(s.Heading)
	s.Heel = wrapAngle(s.Heel)
	o.Depth, o.Aground, o.PushedOff = -DeepWater/10, Afloat, 0
	if g != nil {
		o.Depth = bd.depth
		b.ground(s, e, g, &bd, o)
	}
}

func (b *Prepared) substep(s *State, wind, sinW, cosW, dt float64, v *wave, bd *bed, o *Out, last bool) {
	sinH, cosH := SinCos(s.Heading)
	m := motion{u: s.Surge, v: s.Sway, r: s.YawRate, p: s.RollRate, q: s.PitchRate}
	m.sinHeel, m.cosHeel = SinCos(s.Heel)
	m.rise, m.across = s.Heave-v.height, v.across
	m.waterX, m.waterY, m.foilX, m.foilY = v.waterX, v.waterY, v.foilX, v.foilY
	// The current moves the water the hull and foils meet, and the air
	// near the surface with it: the wind's profile is of the wind over the
	// water, which 10 m up is the wind over the ground less the current.
	var currentX, currentY float64
	if v.current {
		currentX, currentY = currentInFrame(v.currentEast, v.currentNorth, sinH, cosH)
		m.waterX, m.waterY = m.waterX+currentX, m.waterY+currentY
		m.foilX, m.foilY = m.foilX+currentX, m.foilY+currentY
	}
	// The hull lies on the water's surface, which the waves tilt: its
	// stability and how much of its foils are in the water follow the heel
	// off that surface.
	wetHeel := s.Heel + v.across
	// The true wind comes from WindFrom: the air moves the other way.
	m.windX = float64(-wind * (float64(cosW*cosH) + float64(sinW*sinH)))
	m.windY = float64(-wind * (float64(sinW*cosH) - float64(cosW*sinH)))
	if v.current {
		m.current, m.currentX, m.currentY = true, currentX, currentY
		m.windX, m.windY = m.windX-currentX, m.windY-currentY
	}

	// The sailor flattens the sail by the apparent wind at its centre of
	// effort, which flattening also twists.
	ce := b.flow(&m, b.mastX, 0, b.effortZ, 0, 0, true)
	sailWind := ce.speed()
	flat := b.flattening(sailWind)
	twist := b.twist(s.Boom, flat)

	var l loads
	var sail sailResult
	b.sailLoads(s, &m, flat, twist, &l, &sail)

	// Windage of hull, sailor and spars: ½ρ (A_front |cos β| + A_side |sin β|) V
	// times the flow (Day 2017).
	wf := b.flow(&m, 0, 0, b.windageZ, 0, 0, true)
	k := float64(b.windageFront*math.Abs(wf.x)) + float64(b.windageSide*math.Abs(wf.y))
	l.add(&m, float64(k*wf.x), float64(k*wf.y), 0, 0, b.windageZ)

	// The foils. The board's lift gains the hull's carry-over and loses to
	// heel, 1 − 0.382 |φ| (Keuning and Verwerft 2009); the rudder sees part of
	// the boat's speed, and works in the board's downwash (Keuning, Vermeulen
	// and de Ridder 2005).
	wet := b.foilsWet(wetHeel)
	boardWet, rudderWet := wet, wet
	if bd.active {
		// The bottom has pushed the foils up: what is left of them works.
		boardWet, rudderWet = float64(wet*bd.boardCut), float64(wet*bd.rudderCut)
	}
	boardLift := float64(b.board.carry * max2(1-float64(b.heelLoss*math.Abs(s.Heel)), 0))
	board := b.foilLoads(&b.board, &m, 0, 1, 1, 0, boardLift, boardWet, &l)
	sinR, cosR := SinCos(s.Rudder)
	rudder := b.foilLoads(&b.rudder, &m, sinR, cosR, b.rudderInflow, b.downwash, 1, rudderWet, &l)

	b.hullLoads(&m, &l)
	if bd.active {
		bd.loads(&m, b, &l)
	}
	b.waveLoads(v, &l)
	l.K -= float64((b.rollDamping + b.sailorDamping(s)) * m.p)
	heeling := l.K
	righting := b.rightingMoment(wetHeel)
	b.hike(s, heeling+righting, m.cosHeel, dt)
	righting += b.sailorMoment(s, m.sinHeel, m.cosHeel)

	// The boom: the sail's moment, its weight when the boat heels, friction,
	// and the water when the sail is in it. Pressed against its stop, the
	// sheet holds it, and passes the moment to the hull about the mast.
	cosB := Cos(s.Boom)
	boomMoment := (sail.boomMoment + float64(float64(b.boomMoment*gravity)*float64(m.sinHeel*cosB))) -
		float64((b.boomDamping+sail.wetDamping)*s.BoomRate)
	out := sign(s.Boom)
	held := math.Abs(s.Boom) >= s.SheetLimit && float64(boomMoment*out) >= 0 && float64(s.BoomRate*out) >= 0
	if held {
		s.Boom, s.BoomRate = float64(out*s.SheetLimit), 0
		l.N -= float64(boomMoment * m.cosHeel)
	}

	if v.current {
		// In a current the added masses' share of the terms of turning is
		// of the velocity through the water, the hull's own of the velocity
		// over the ground (Fossen 2021, 10.3): with the current steady over
		// the ground, its parts in the heading frame turn as the boat does.
		vr, ur := m.v-currentY, m.u-currentX
		s.Surge += float64(float64(((l.X+float64(float64(b.massY*vr)*m.r))+float64(float64(b.massX*m.r)*currentY))*b.invMassX) * dt)
		s.Sway += float64(float64(((l.Y-float64(float64(b.massX*ur)*m.r))-float64(float64(b.massY*m.r)*currentX))*b.invMassY) * dt)
	} else {
		s.Surge += float64(float64((l.X+float64(float64(b.massY*m.v)*m.r))*b.invMassX) * dt)
		s.Sway += float64(float64((l.Y-float64(float64(b.massX*m.u)*m.r))*b.invMassY) * dt)
	}
	s.YawRate += float64(float64(l.N*b.invYawInertia) * dt)
	s.RollRate += float64(float64((heeling+righting)*b.invRollInertia) * dt)
	if !held {
		s.BoomRate += float64(float64(boomMoment*b.invBoomInertia) * dt)
		s.Boom += float64(s.BoomRate * dt)
		b.boomStop(s, m.cosHeel)
	}
	s.Heading += float64(s.YawRate * dt)
	s.Heel += float64(s.RollRate * dt)
	sinH, cosH = SinCos(s.Heading)
	s.X += float64((float64(s.Surge*sinH) + float64(s.Sway*cosH)) * dt)
	s.Y += float64((float64(s.Surge*cosH) - float64(s.Sway*sinH)) * dt)
	b.float(s, v, dt)
	b.sailorModes(s, dt)

	if last {
		mast := b.flow(&m, b.mastX, 0, b.mastheadZ, 0, 0, true)
		o.ApparentWindSpeed = mast.speed()
		o.ApparentWindAngle = Atan2(-mast.y, -mast.x)
		o.SailWindSpeed = sailWind
		o.SailWindAngle = Atan2(-ce.y, -ce.x)
		o.FootAttack, o.HeadAttack = sail.attack[0], sail.attack[1]
		o.FootFlow, o.HeadFlow = sail.flow[0], sail.flow[1]
		o.Drive, o.SideForce = sail.drive, sail.side
		o.BoardLift, o.RudderLift = board, rudder
		o.Leeway = Atan2(s.Sway, s.Surge)
		o.SpeedOverGround = math.Sqrt(float64(s.Surge*s.Surge) + float64(s.Sway*s.Sway))
		o.CourseOverGround = wrapAngle(s.Heading + o.Leeway)
		o.HeelingMoment, o.RightingMoment = heeling, righting
		o.Flattening, o.Twist = flat, twist
		o.WaveHeight, o.WaveSlopeAhead, o.WaveSlopeAcross = v.height, v.ahead, v.across
		tu, tv := s.Surge-m.waterX, s.Sway-m.waterY
		o.SpeedThroughWater = math.Sqrt(float64(tu*tu) + float64(tv*tv))
	}
}

// boomStop stops a boom that has swung past the sheet's limit dead, and
// passes its momentum to the hull: a crash gybe slews and rolls the boat.
func (b *Prepared) boomStop(s *State, cosHeel float64) {
	out := sign(s.Boom)
	if !(math.Abs(s.Boom) > s.SheetLimit) {
		return
	}
	s.Boom = float64(out * s.SheetLimit)
	if !(float64(s.BoomRate*out) > 0) {
		return
	}
	sinB, cosB := SinCos(s.Boom)
	j := float64(b.boomMoment * s.BoomRate)
	s.YawRate -= float64(float64(float64(b.boomInertia*s.BoomRate)*cosHeel) * b.invYawInertia)
	s.Surge += float64(float64(j*sinB) * b.invMassX)
	s.Sway += float64(float64(float64(j*cosB)*cosHeel) * b.invMassY)
	s.RollRate -= float64(float64(float64(b.boomZ*j)*cosB) * b.invRollInertia)
	s.BoomRate = 0
}
