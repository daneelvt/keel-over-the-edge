// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Prepared holds a kind of boat's constants as a step uses them, derived from
// its Params by Prepare. Everything derived is computed here, in the package,
// so that the server and the client derive the same bits: the client writes
// only the catalog's raw values into Params.
type Prepared struct {
	// Hull.
	massX, massY    float64 // mass with the added mass in surge and in sway, kg
	invMassX        float64
	invMassY        float64
	invYawInertia   float64
	invRollInertia  float64
	munk            float64
	centreOfGravity float64
	hullZ           float64 // depth below the centre of gravity at which the hull's forces act, m
	halfRhoWater    float64
	crossFlow       float64 // ½ρ C L T, N per (m/s)²
	dragArea        [25]float64
	dragAreaInvStep float64
	weight          float64 // N
	rightingLever   [19]float64
	rollDamping     float64
	invLogReference float64 // 1 / ln(10 m / z₀)
	floorWindFactor float64 // the wind profile's value at windFloor, as a fraction of the 10 m wind
	mastheadZ       float64

	// Sail.
	strip              float64 // ½ρ_air × the area of one strip, kg/m
	liftDrag           float64 // induced and quadratic drag per lift coefficient squared
	maxLift            float64
	stallAngle         float64
	invStallAngle      float64
	invStallWidth      float64
	sailDrag           float64
	invLuffAngle       float64
	flogDrag           float64
	normalForce        [19]float64
	effortZ            float64 // depth of the sail's centre of effort, between the strips, m
	footZ, headZ       float64 // depth of each strip's centre of effort below the centre of gravity (negative: above), m
	mastX              float64
	boomZ              float64
	pressureAttached   float64 // m aft of the mast
	pressureSeparated  float64
	twistPowered       float64 // rad
	twistPerFlat       float64 // rad of extra twist per unit of flattening
	twistPerBoom       float64 // rad of extra twist per radian of boom angle
	invTwistTurn       float64
	headBacked         float64 // rad
	invHeadBackedWidth float64
	boomIn, boomOut    float64 // rad
	boomInertia        float64
	invBoomInertia     float64
	boomMoment         float64
	boomDamping        float64
	windageFront       float64 // ½ρ_air × drag area, kg/m
	windageSide        float64
	windageZ           float64
	sailFloat          float64
	sailWaterDamping   float64

	// Foils.
	board, rudder     foil
	foilStall         float64
	invFoilStallWidth float64
	foilDrag          float64
	plateNormal       float64
	heelLoss          float64
	rudderInflow      float64
	downwash          float64
	foilDryHeel       float64
	invFoilWetRange   float64
	rudderMax         float64

	// Sailor.
	sailorWeight float64 // N
	seatHeight   float64
	hikeReach    float64
	leeReach     float64
	hikeSpeed    float64
	invHikeLag   float64
	heelGain     float64
	rollRateGain float64
	flattenFrom  float64
	flattenSlope float64 // loss of lift per m/s of apparent wind
	flattenMin   float64
	fallOutHeel  float64
	climbInHeel  float64
	boardReach   float64
	sailorDrag   float64
	swimTime     float64
	climbTime    float64

	// Rates, per second.
	rudderRate float64 // rad/s
	haulRate   float64 // rad/s
	easeRate   float64 // rad/s
}

// foil is a daggerboard or a rudder.
type foil struct {
	x, z  float64 // centre of pressure ahead of and below the centre of gravity, m
	area  float64 // ½ρ_water × plan area, kg/m
	slope float64 // lift per radian of attack
	// induced is the induced drag per lift coefficient squared, 1/(π A_e).
	induced float64
	// carry multiplies the lift: the hull's carry-over, for the board.
	carry float64
}

// windFloor is the height below which the wind profile falls linearly to
// nothing at the water, rather than following the logarithm, m.
const windFloor = 0.1

// Prepare derives a boat's constants from its parameters. It is called once
// for each kind of boat, by the server at start and by the client after
// writing Params.
func Prepare(p *Params, b *Prepared) {
	m := p.Displacement
	b.massX = m + p.AddedMassSurge
	b.massY = m + p.AddedMassSway
	b.invMassX = 1 / b.massX
	b.invMassY = 1 / b.massY
	b.invYawInertia = 1 / p.YawInertia
	b.invRollInertia = 1 / p.RollInertia
	b.munk = p.Munk
	cg := p.CentreOfGravity
	b.centreOfGravity = cg
	b.hullZ = cg + float64(0.5*p.HullDraught)
	b.halfRhoWater = 0.5 * waterDensity
	b.crossFlow = float64(float64(0.5*waterDensity) * float64(float64(p.CrossFlowDrag*p.WaterlineLength)*p.HullDraught))
	b.dragArea = p.DragArea
	b.dragAreaInvStep = 1 / p.DragAreaStep
	b.weight = float64(m * gravity)
	b.rightingLever = p.RightingLever
	b.rollDamping = p.RollDamping
	b.invLogReference = 1 / Log(10/seaRoughness)
	b.floorWindFactor = float64(Log(windFloor/seaRoughness) * b.invLogReference)
	b.mastheadZ = cg - (p.BoomHeight + p.Luff)

	// Each strip is half the sail. Induced drag follows the Offshore Racing
	// Congress's VPP (2023, eq. 5.34): A/(π h_eff²).
	b.strip = float64(float64(0.5*airDensity) * (0.5 * p.SailArea))
	b.liftDrag = p.SailArea/float64(math.Pi*float64(p.EffectiveHeight*p.EffectiveHeight)) + p.QuadraticDrag
	b.maxLift = p.MaxLift
	b.stallAngle = float64(p.StallAngle * degree)
	b.invStallAngle = 1 / b.stallAngle
	b.invStallWidth = 1 / (p.StallWidth * degree)
	b.sailDrag = p.SailDrag
	b.invLuffAngle = 1 / (p.LuffAngle * degree)
	b.flogDrag = p.FlogDrag
	b.normalForce = p.NormalForce
	b.boomZ = cg - p.BoomHeight
	b.footZ = b.boomZ - float64(p.FootStrip*p.Luff)
	b.headZ = b.boomZ - float64(p.HeadStrip*p.Luff)
	b.effortZ = float64(0.5 * (b.footZ + b.headZ))
	b.mastX = p.MastPosition
	b.pressureAttached = float64(p.PressureAttached * p.Foot)
	b.pressureSeparated = float64(p.PressureSeparated * p.Foot)
	b.twistPowered = float64(p.TwistPowered * degree)
	b.twistPerFlat = (p.TwistDepowered - p.TwistPowered) * degree / (1 - p.FlattenMin)
	b.invTwistTurn = 1 / (p.TwistTurn * degree)
	b.twistPerBoom = p.TwistEased / p.BoomOut
	b.headBacked = float64(p.HeadBacked * degree)
	b.invHeadBackedWidth = 1 / (p.HeadBackedWidth * degree)
	b.boomIn = float64(p.BoomIn * degree)
	b.boomOut = float64(p.BoomOut * degree)
	b.boomInertia = p.BoomInertia
	b.invBoomInertia = 1 / p.BoomInertia
	b.boomMoment = p.BoomMoment
	b.boomDamping = p.BoomDamping
	b.windageFront = float64(float64(0.5*airDensity) * p.WindageFront)
	b.windageSide = float64(float64(0.5*airDensity) * p.WindageSide)
	b.windageZ = cg - p.WindageHeight
	b.sailFloat = p.SailFloat
	b.sailWaterDamping = p.SailWaterDamping

	// The foils' centres of pressure are at PressureDepth of their span
	// below the hull (Keuning and Vermeulen 2003, as used by Day 2017).
	// Their lift slope is Helmbold's, with an effective aspect ratio of twice
	// span over chord: the hull acts as an end plate. The board's lift gains
	// the hull's carry-over, 1 + k·T_c/b (Keuning and Verwerft 2009).
	keel := cg + p.HullDraught
	b.board = newFoil(p.BoardSpan, p.BoardChord, p.BoardPosition, keel+float64(p.PressureDepth*p.BoardSpan))
	b.board.carry = 1 + p.CarryOver*p.HullDraught/p.BoardSpan
	b.rudder = newFoil(p.RudderSpan, p.RudderChord, -p.RudderPosition, keel+float64(p.PressureDepth*p.RudderSpan))
	b.foilStall = float64(p.FoilStall * degree)
	b.invFoilStallWidth = 1 / (p.FoilStallWidth * degree)
	b.foilDrag = p.FoilDrag
	b.plateNormal = p.PlateNormal
	b.heelLoss = p.HeelLoss
	b.rudderInflow = p.RudderInflow
	b.downwash = p.Downwash
	b.foilDryHeel = float64(p.FoilDryHeel * degree)
	b.invFoilWetRange = 1 / ((p.FoilDryHeel - p.FoilWetHeel) * degree)
	b.rudderMax = float64(p.RudderAngle * degree)

	b.sailorWeight = float64(p.SailorMass * gravity)
	b.seatHeight = p.SailorSeatHeight
	b.hikeReach = p.HikeReach
	b.leeReach = p.LeeReach
	b.hikeSpeed = p.HikeSpeed
	b.invHikeLag = 1 / p.HikeLag
	b.heelGain = p.HeelGain
	b.rollRateGain = p.RollRateGain
	b.flattenFrom = p.FlattenFrom
	b.flattenSlope = (1 - p.FlattenMin) / (p.FlattenTo - p.FlattenFrom)
	b.flattenMin = p.FlattenMin
	b.fallOutHeel = float64(p.FallOutHeel * degree)
	b.climbInHeel = float64(p.ClimbInHeel * degree)
	b.boardReach = p.BoardReach
	b.sailorDrag = p.SailorDrag
	b.swimTime = p.SwimTime
	b.climbTime = p.ClimbTime

	b.rudderRate = 2 * b.rudderMax / p.RudderTime
	b.haulRate = (b.boomOut - b.boomIn) / p.SheetHaulTime
	b.easeRate = (b.boomOut - b.boomIn) / p.SheetEaseTime
}

func newFoil(span, chord, x, z float64) foil {
	aspect := 2 * span / chord
	return foil{
		x:       x,
		z:       z,
		area:    float64(float64(0.5*waterDensity) * float64(span*chord)),
		slope:   2 * math.Pi * aspect / (2 + math.Sqrt(float64(aspect*aspect)+4)),
		induced: 1 / (math.Pi * aspect),
		carry:   1,
	}
}
