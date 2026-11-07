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

	// In waves.
	halfLength, halfBeam float64 // half the waterplane's length and beam, m
	twistArm             float64 // L²/12: the sway force's lever along the hull per unit of k_x, m²
	heaveStiffness       float64 // ρ g A_wp, N/m
	heaveDamping         float64 // N·s/m
	invHeaveMass         float64
	pitchStiffness       float64 // ρ g I_L, N·m/rad
	pitchDamping         float64 // N·m·s/rad
	invPitchInertia      float64
	waveSurge, waveSway  float64 // the Froude–Krylov force per unit of slope, with the added mass's share, N
	waveYaw              float64 // the share of the sway force that turns the hull, N
	// foilDecay is how much of each wave's motion reaches the foils' depth
	// d: e^(−k d).
	foilDecay       [SeaComponents]float64
	floorWindFactor float64 // the wind profile's value at windFloor, as a fraction of the 10 m wind
	mastheadZ       float64

	// Sail: the main.
	strip              float64 // ½ρ_air × the area of one strip at full sail, kg/m
	sail               sailCoefficients
	trimBelow          float64 // rad: below this angle of attack the sail luffs, for Out.Sail
	easeAbove          float64 // rad: past this, with its flow separated, it stalls
	letFly             float64 // rad: a sheet let out past this cannot be eased
	effortZ            float64 // depth of the sail's centre of effort at full sail, between the strips, m
	footZ, headZ       float64 // depth of each strip's centre of effort below the centre of gravity (negative: above) at full sail, m
	footHeight         float64 // each strip's centre of effort above the boom at full sail, m
	headHeight         float64
	reefs              [3]float64 // the share of the luff kept at each reef
	reefRate           float64    // reefs a second
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

	// The headsails, if the boat has any.
	jib                  bool
	jibStrip             float64 // ½ρ_air × the area of one strip at full sail, kg/m
	jibSail              sailCoefficients
	jibX                 float64 // the tack ahead of the centre of gravity, m
	jibTackZ             float64 // the tack's depth below the centre of gravity, m
	jibFootHeight        float64 // each strip's centre of effort above the tack at full sail, m
	jibHeadHeight        float64
	jibPressureAttached  float64 // m aft of the tack
	jibPressureSeparated float64
	jibTwist             float64 // rad
	jibTwistPerAngle     float64 // rad of extra twist per radian of the clew's angle
	jibIn, jibOut        float64 // rad
	jibInvInertia        float64
	jibMoment            float64
	jibDamping           float64
	jibReefs             [3]float64
	jibHaulRate          float64 // rad/s
	jibEaseRate          float64 // rad/s

	// The square sails, if the boat has any: a fore and an after group on
	// yards the braces hold, and the crew that hauls them round.
	square           bool
	foreStrip        float64 // ½ρ_air × the area of one of the fore group's strips at full sail, kg/m
	afterStrip       float64
	squareSail       sailCoefficients
	foreX, afterX    float64 // each group's mast ahead of the centre of gravity, m
	squareFootZ      float64 // the sails' foot's depth below the centre of gravity, m
	squareFootHeight float64 // each strip's centre of effort above the foot at full sail, m
	squareHeadHeight float64
	squarePressure   float64 // m out along the yards with the flow attached
	squareTwist      float64 // rad
	squareReefs      [3]float64
	braceSharp       float64 // rad
	braceRate        float64 // rad/s
	hauls, letGo     float64 // rad
	squareTrimBelow  float64 // rad: below this angle of attack the square sails lift, for Out.Sail
	squareEaseAbove  float64 // rad: past this they are stalled

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

	// The ground.
	fixed          bool    // the board is a fixed keel
	draught        float64 // the deepest the boat reaches below the water, m: the keel's tip, or the hull with its board pushed up
	hullDraught    float64 // m
	invHullDraught float64
	boardDepth     float64 // how deep the board reaches below the water, m
	rudderDepth    float64
	invBoardSpan   float64
	invRudderSpan  float64
	groundRings    int32   // rings of hexagons about the one under the centre of gravity the hull may touch
	pushOffAngle   float64 // off the wind a boat pushed off points, rad

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

	// Encounters.
	outline      outline
	length       float64 // overall, transom to stem, m
	mastHeight   float64 // the masthead's height above the waterline, m
	effortHeight float64 // the sail's centre of effort's height above the waterline, m
	closeHauled  float64 // rad

	// Rates, per second.
	rudderRate float64 // rad/s
	haulRate   float64 // rad/s
	easeRate   float64 // rad/s

	pilotPrepared
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

// Prepare derives a boat's constants from its parameters, and from the
// sea's waves what the boat needs of each. It is called once for each kind of
// boat, after PrepareSea, by the server at start and by the client after
// writing Params. With no waves the boat is ready for flat water only.
func Prepare(p *Params, w *Waves, b *Prepared) {
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

	// The hull floats on its waterplane as a mass on a spring; the damping
	// is a fraction of critical, 2 √(stiffness × mass).
	b.halfLength = float64(0.5 * p.WaterlineLength)
	b.halfBeam = float64(0.5 * p.WaterlineBeam)
	b.twistArm = float64(p.WaterlineLength*p.WaterlineLength) / 12
	heaveMass := m + p.AddedMassHeave
	b.heaveStiffness = float64(float64(waterDensity*gravity) * p.WaterplaneArea)
	b.heaveDamping = float64(float64(2*p.HeaveDamping) * math.Sqrt(float64(b.heaveStiffness*heaveMass)))
	b.invHeaveMass = 1 / heaveMass
	b.pitchStiffness = float64(float64(waterDensity*gravity) * p.WaterplanePitch)
	b.pitchDamping = float64(float64(2*p.PitchDamping) * math.Sqrt(float64(b.pitchStiffness*p.PitchInertia)))
	b.invPitchInertia = 1 / p.PitchInertia
	b.waveSurge = float64(float64(p.WaveForce*b.massX) * gravity)
	b.waveSway = float64(float64(p.WaveForce*b.massY) * gravity)
	b.waveYaw = float64(p.WaveYaw * b.waveSway)

	// Each strip is half the sail. Induced drag follows the Offshore Racing
	// Congress's VPP (2023, eq. 5.34): A/(π h_eff²), of the whole rig's
	// area, main, headsails and square sails, on the rig's effective
	// height.
	b.strip = float64(float64(0.5*airDensity) * (0.5 * p.SailArea))
	area := ((p.SailArea + p.HeadsailArea) + p.SquareForeArea) + p.SquareAfterArea
	liftDrag := area/float64(math.Pi*float64(p.EffectiveHeight*p.EffectiveHeight)) + p.QuadraticDrag
	b.sail.prepare(p.MaxLift, p.StallAngle, p.StallWidth, p.SailDrag, &p.NormalForce, liftDrag, p.LuffAngle, p.FlogDrag)
	// The sail luffs, for the sailor, below half its stall angle: a boat
	// there makes half the speed of its best trim or less, which lies
	// within a few degrees of the stall angle on every point of sailing
	// but a run; it stalls past 1.75 times it.
	b.trimBelow = float64(0.5 * b.sail.stallAngle)
	b.easeAbove = float64(1.75 * b.sail.stallAngle)
	b.boomZ = cg - p.BoomHeight
	b.footHeight = float64(p.FootStrip * p.Luff)
	b.headHeight = float64(p.HeadStrip * p.Luff)
	b.footZ = b.boomZ - b.footHeight
	b.headZ = b.boomZ - b.headHeight
	b.effortZ = float64(0.5 * (b.footZ + b.headZ))
	b.reefs = p.Reefs
	b.reefRate = 1 / p.ReefTime
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
	// Let fly: within a twentieth of the sheet's travel of all the way out.
	b.letFly = b.boomOut - float64(0.05*(b.boomOut-b.boomIn))
	b.boomInertia = p.BoomInertia
	b.invBoomInertia = 1 / p.BoomInertia
	b.boomMoment = p.BoomMoment
	b.boomDamping = p.BoomDamping
	b.windageFront = float64(float64(0.5*airDensity) * p.WindageFront)
	b.windageSide = float64(float64(0.5*airDensity) * p.WindageSide)
	b.windageZ = cg - p.WindageHeight
	b.sailFloat = p.SailFloat
	b.sailWaterDamping = p.SailWaterDamping
	b.prepareHeadsails(p)
	b.prepareSquare(p)

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
	b.fixed = p.Fixed != 0
	b.draught = p.HullDraught
	if b.fixed {
		b.draught = p.HullDraught + p.BoardSpan
	}
	b.hullDraught = p.HullDraught
	b.invHullDraught = 1 / p.HullDraught
	b.boardDepth = p.HullDraught + p.BoardSpan
	b.rudderDepth = p.HullDraught + p.RudderSpan
	b.invBoardSpan = 1 / p.BoardSpan
	b.invRudderSpan = 1 / p.RudderSpan
	// A deep-water wave's motion dies away with depth as e^(−k z). The
	// foils feel it at the board's centre of pressure.
	depth := b.board.z - cg
	for i := range b.foilDecay {
		b.foilDecay[i] = 1
		if w != nil {
			b.foilDecay[i] = Exp(float64(-w.K[i] * depth))
		}
	}

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

	b.prepareOutline(p)
	// A hexagon the hull's bounding circle reaches has its centre within
	// the circle's radius and a hexagon's of the centre of gravity.
	b.groundRings = toInt32(math.Ceil((b.outline.radius+hexRadius)/hexRing)) + 1
	b.length = p.Transom + p.Stem
	b.mastHeight = p.BoomHeight + p.Luff
	b.effortHeight = cg - b.effortZ
	b.closeHauled = float64(p.CloseHauled * degree)
	b.pushOffAngle = b.closeHauled + 10*degree

	b.rudderRate = 2 * b.rudderMax / p.RudderTime
	b.haulRate = (b.boomOut - b.boomIn) / p.SheetHaulTime
	b.easeRate = (b.boomOut - b.boomIn) / p.SheetEaseTime
	b.pilotPrepared.prepare(p)
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

// sailCoefficients holds the constants a sail's lift and drag are worked out
// with (sail.go).
type sailCoefficients struct {
	maxLift       float64
	stallAngle    float64 // rad
	invStallAngle float64
	invStallWidth float64
	drag          float64
	liftDrag      float64 // induced and quadratic drag per lift coefficient squared
	invLuffAngle  float64
	flogDrag      float64
	normalForce   [19]float64
}

func (k *sailCoefficients) prepare(maxLift, stallAngle, stallWidth, drag float64, normal *[19]float64, liftDrag, luffAngle, flogDrag float64) {
	k.maxLift = maxLift
	k.stallAngle = float64(stallAngle * degree)
	k.invStallAngle = 1 / k.stallAngle
	k.invStallWidth = 1 / (stallWidth * degree)
	k.drag = drag
	k.liftDrag = liftDrag
	k.invLuffAngle = 1 / (luffAngle * degree)
	k.flogDrag = flogDrag
	k.normalForce = *normal
}

// prepareHeadsails derives the headsails' constants, if the boat has any.
// They are worked as the main is, two strips each half their area, with the
// main's luffing angle and flogging drag and the whole rig's induced drag;
// their sheet hauls and eases at the main's rates over its own travel.
func (b *Prepared) prepareHeadsails(p *Params) {
	if !(p.HeadsailArea > 0) {
		return
	}
	b.jib = true
	b.jibStrip = float64(float64(0.5*airDensity) * (0.5 * p.HeadsailArea))
	b.jibSail.prepare(p.HeadsailMaxLift, p.HeadsailStallAngle, p.HeadsailStallWidth, p.HeadsailDrag,
		&p.HeadsailNormalForce, b.sail.liftDrag, p.LuffAngle, p.FlogDrag)
	b.jibX = p.HeadsailTack
	b.jibTackZ = p.CentreOfGravity - p.HeadsailTackHeight
	b.jibFootHeight = float64(p.HeadsailFootStrip * p.HeadsailLuff)
	b.jibHeadHeight = float64(p.HeadsailHeadStrip * p.HeadsailLuff)
	b.jibPressureAttached = float64(p.HeadsailPressureAttached * p.HeadsailFoot)
	b.jibPressureSeparated = float64(p.HeadsailPressureSeparated * p.HeadsailFoot)
	b.jibTwist = float64(p.HeadsailTwist * degree)
	b.jibTwistPerAngle = p.HeadsailTwistEased / p.HeadsailOut
	b.jibIn = float64(p.HeadsailIn * degree)
	b.jibOut = float64(p.HeadsailOut * degree)
	b.jibInvInertia = 1 / p.HeadsailInertia
	b.jibMoment = p.HeadsailMoment
	b.jibDamping = p.HeadsailDamping
	b.jibReefs = p.HeadsailReefs
	b.jibHaulRate = (b.jibOut - b.jibIn) / p.SheetHaulTime
	b.jibEaseRate = (b.jibOut - b.jibIn) / p.SheetEaseTime
}

// prepareSquare derives the square sails' constants, if the boat has any.
// Each group is two strips each half its area, with the main's luffing
// angle and flogging drag and the whole rig's induced drag. The braces
// swing the yards over their travel from sharp up on one side, through
// square, to sharp up on the other in the brace time.
func (b *Prepared) prepareSquare(p *Params) {
	if !(p.SquareForeArea > 0 || p.SquareAfterArea > 0) {
		return
	}
	b.square = true
	b.foreStrip = float64(float64(0.5*airDensity) * (0.5 * p.SquareForeArea))
	b.afterStrip = float64(float64(0.5*airDensity) * (0.5 * p.SquareAfterArea))
	b.squareSail.prepare(p.SquareMaxLift, p.SquareStallAngle, p.SquareStallWidth, p.SquareDrag,
		&p.SquareNormalForce, b.sail.liftDrag, p.LuffAngle, p.FlogDrag)
	b.foreX = p.SquareForeMast
	b.afterX = p.SquareAfterMast
	b.squareFootZ = p.CentreOfGravity - p.SquareFootHeight
	b.squareFootHeight = float64(p.SquareFootStrip * p.SquareLuff)
	b.squareHeadHeight = float64(p.SquareHeadStrip * p.SquareLuff)
	// Half the sails' mean width, the greater group's.
	width := float64(0.5 * max2(p.SquareForeArea, p.SquareAfterArea) / p.SquareLuff)
	b.squarePressure = float64(p.SquarePressure * width)
	b.squareTwist = float64(p.SquareTwist * degree)
	b.squareReefs = p.SquareReefs
	b.braceSharp = float64(p.BraceSharp * degree)
	b.braceRate = float64(2*(math.Pi/2-b.braceSharp)) / p.BraceTime
	b.hauls = float64(p.Hauls * degree)
	b.letGo = float64(p.LetGo * degree)
	b.squareTrimBelow = float64(0.5 * b.squareSail.stallAngle)
	b.squareEaseAbove = float64(1.75 * b.squareSail.stallAngle)
}
