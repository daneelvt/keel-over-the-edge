// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The boat is a rigid body in surge, sway, yaw and roll on flat water, with
// the boom as a body of its own and the sailor's position. Every force comes
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

// Step advances a boat by one step of Dt seconds. b is the boat's kind,
// from Prepare. It writes o and never reads it.
func Step(s *State, c *Control, e *Env, b *Prepared, o *Out) {
	step(s, c, e, b, o, Substeps)
}

// step is Step in n substeps; the tests compare Substeps with more.
func step(s *State, c *Control, e *Env, b *Prepared, o *Out, n int32) {
	helm := control(c.Helm, -1, 1)
	sheet := control(c.Sheet, 0, 1)
	if s.SailorMode != Sailing {
		// Nobody holds the tiller or the sheet.
		helm, sheet = 0, 1
	}
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
	dt := Dt / float64(n)
	for i := range n {
		b.substep(s, wind, sinW, cosW, dt, o, i == n-1)
	}
	s.Heading = wrapAngle(s.Heading)
	s.Heel = wrapAngle(s.Heel)
}

func (b *Prepared) substep(s *State, wind, sinW, cosW, dt float64, o *Out, last bool) {
	sinH, cosH := SinCos(s.Heading)
	m := motion{u: s.Surge, v: s.Sway, r: s.YawRate, p: s.RollRate}
	m.sinHeel, m.cosHeel = SinCos(s.Heel)
	// The true wind comes from WindFrom: the air moves the other way.
	m.windX = float64(-wind * (float64(cosW*cosH) + float64(sinW*sinH)))
	m.windY = float64(-wind * (float64(sinW*cosH) - float64(cosW*sinH)))

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
	wet := b.foilsWet(s.Heel)
	boardLift := float64(b.board.carry * max2(1-float64(b.heelLoss*math.Abs(s.Heel)), 0))
	board := b.foilLoads(&b.board, &m, 0, 1, 1, 0, boardLift, wet, &l)
	sinR, cosR := SinCos(s.Rudder)
	rudder := b.foilLoads(&b.rudder, &m, sinR, cosR, b.rudderInflow, b.downwash, 1, wet, &l)

	b.hullLoads(&m, &l)
	l.K -= float64((b.rollDamping + b.sailorDamping(s)) * m.p)
	heeling := l.K
	righting := b.rightingMoment(s.Heel)
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

	s.Surge += float64(float64((l.X+float64(float64(b.massY*m.v)*m.r))*b.invMassX) * dt)
	s.Sway += float64(float64((l.Y-float64(float64(b.massX*m.u)*m.r))*b.invMassY) * dt)
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
