// SPDX-License-Identifier: AGPL-3.0-only

package physics

// The records a step reads and writes. Every field is a float64, or a fixed
// array of them, so the client reads and writes them through a Float64Array on
// the WebAssembly module's memory, by the field indices tools/physics
// generates into client/src/predict/layout.gen.ts. Changing a record changes
// LayoutVersion (layout.gen.go), and a client refuses a module whose version
// differs.

// The sailor's modes, stored in State.SailorMode.
const (
	Sailing  = 0 // aboard, hiking and sailing
	InWater  = 1 // fallen in, swimming to the daggerboard
	OnBoard  = 2 // on the daggerboard, righting the boat
	Climbing = 3 // climbing back in
)

// State is a boat's state between steps: what the server sends the client to
// replay from.
type State struct {
	X           float64 // position east of the world's centre, m
	Y           float64 // position north of the world's centre, m
	Heading     float64 // direction the bow points, rad clockwise from north, in [-π, π)
	Surge       float64 // speed ahead, m/s
	Sway        float64 // speed to starboard, m/s
	YawRate     float64 // rate of turn, rad/s, positive to starboard
	Heel        float64 // rad, positive with the starboard side down, in [-π, π)
	RollRate    float64 // rad/s, positive heeling to starboard
	Boom        float64 // boom's angle off the centreline, rad, positive to starboard
	BoomRate    float64 // rad/s
	Sailor      float64 // sailor's offset from the centreline, m, positive to starboard
	Rudder      float64 // rudder's angle, rad, positive turning the bow to starboard
	SheetLimit  float64 // furthest the sheet lets the boom out, rad
	SailorMode  float64 // Sailing, InWater, OnBoard or Climbing
	SailorTimer float64 // seconds left to swim to the board or to climb in
	Heave       float64 // the centre of gravity's rise above where it floats in flat water, m
	HeaveRate   float64 // m/s, positive rising
	Pitch       float64 // rad, positive with the bow up
	PitchRate   float64 // rad/s
}

// Control holds what the player sets. Both are targets: the rudder and the
// sheet follow them at the rates in Params.
type Control struct {
	Helm  float64 // -1 hard to port … 1 hard to starboard: turns the bow that way
	Sheet float64 // 0 hauled in hard … 1 let fly
}

// Env is the world at the boat during the step.
type Env struct {
	WindSpeed float64 // true wind 10 m above the sea, m/s
	WindFrom  float64 // direction the true wind comes from, rad clockwise from north
}

// Params describe a kind of boat: the catalog's physics values, in the order
// of the catalog's schema (shared/catalog.schema.json), which
// go run ./tools/catalog checks. Angles are in degrees, as the catalog gives
// them; Prepare turns them into radians and every other derived constant.
type Params struct {
	// Hull.
	Displacement    float64     // boat, rig and sailor, kg
	WaterlineLength float64     // m
	HullDraught     float64     // the hull's own draught, foils aside, m
	CentreOfGravity float64     // height of the centre of gravity above the waterline, m
	DragAreaStep    float64     // speed between entries of DragArea, m/s
	DragArea        [25]float64 // upright resistance as a drag area at 0, 1, 2 … steps of speed, m²
	CrossFlowDrag   float64     // drag coefficient of the hull moving sideways, on length × draught
	AddedMassSurge  float64     // kg
	AddedMassSway   float64     // kg, hull and foils
	Munk            float64     // the hull's added mass in sway less in surge, for the Munk moment, kg
	YawInertia      float64     // added inertia included, kg·m²
	RollInertia     float64     // added inertia included, kg·m²
	RollDamping     float64     // the hull's own roll damping, N·m·s/rad
	RightingLever   [19]float64 // with the sailor on the centreline, every 10° of heel from 0° to 180°, m
	WaterlineBeam   float64     // m
	WaterplaneArea  float64     // m²
	WaterplanePitch float64     // the waterplane's second moment of area about its transverse axis, m⁴
	AddedMassHeave  float64     // kg
	PitchInertia    float64     // added inertia included, kg·m²
	HeaveDamping    float64     // fraction of critical
	PitchDamping    float64     // fraction of critical
	WaveForce       float64     // share of the Froude–Krylov force of a wave's slope
	WaveYaw         float64     // share of that force's moment along the hull

	// Rig.
	SailArea          float64     // m²
	Luff              float64     // m
	Foot              float64     // m
	BoomHeight        float64     // above the waterline, m
	MastPosition      float64     // ahead of the centre of gravity, m
	FootStrip         float64     // height of the lower strip's centre of effort above the boom, fraction of the luff
	HeadStrip         float64     // height of the upper strip's centre of effort above the boom, fraction of the luff
	PressureAttached  float64     // centre of pressure aft of the mast with the flow attached, fraction of the foot
	PressureSeparated float64     // centre of pressure aft of the mast with the flow separated, fraction of the foot
	EffectiveHeight   float64     // effective rig height for induced drag, m
	QuadraticDrag     float64     // drag growing with the square of lift
	MaxLift           float64     // greatest lift coefficient
	StallAngle        float64     // angle of attack of greatest lift, degrees
	StallWidth        float64     // angle over which the flow separates past the stall, degrees
	SailDrag          float64     // viscous drag coefficient
	LuffAngle         float64     // below this angle of attack the cloth flogs, degrees
	FlogDrag          float64     // extra drag coefficient of flogging cloth
	NormalForce       [19]float64 // normal force coefficient of separated flow, every 10° of attack from 0° to 180°
	TwistPowered      float64     // the upper strip's twist beyond the boom at full power, degrees
	TwistDepowered    float64     // the twist at the flattest, degrees
	TwistEased        float64     // extra twist with the boom let fly, growing with the boom's angle, degrees
	TwistTurn         float64     // boom angle over which the twist turns from one side to the other, degrees
	HeadBacked        float64     // the upper strip's angle of attack at which its leech starts to be backed, degrees
	HeadBackedWidth   float64     // angle over which a backed head comes to drag the boom across, degrees
	BoomIn            float64     // the boom's angle hauled in hard, degrees
	BoomOut           float64     // the boom's angle let fly, degrees
	BoomInertia       float64     // boom and sail about the mast, kg·m²
	BoomMoment        float64     // mass of boom and sail times its distance aft of the mast, kg·m
	BoomDamping       float64     // friction of the boom about the mast, N·m·s/rad
	WindageFront      float64     // drag area of hull, sailor and spars from ahead, m²
	WindageSide       float64     // drag area from abeam, m²
	WindageHeight     float64     // height of the windage's centre above the waterline, m
	SailFloat         float64     // upward force per metre a sail strip is pushed under water, N/m
	SailWaterDamping  float64     // vertical damping of a sail strip in the water, N·s/m

	// Foils.
	BoardSpan      float64 // daggerboard below the hull, m
	BoardChord     float64 // m
	BoardPosition  float64 // ahead of the centre of gravity, m
	RudderSpan     float64 // m
	RudderChord    float64 // m
	RudderPosition float64 // aft of the centre of gravity, m
	RudderAngle    float64 // greatest rudder angle, degrees
	FoilStall      float64 // angle of attack at which the foils stall, degrees
	FoilStallWidth float64 // angle over which their flow separates, degrees
	FoilDrag       float64 // viscous drag coefficient, on plan area
	PlateNormal    float64 // normal force coefficient of a stalled foil
	PressureDepth  float64 // centre of pressure below the hull, fraction of the span
	CarryOver      float64 // the hull's carry-over of the board's lift, k in 1 + k·draught/span
	HeelLoss       float64 // the board's lift lost per radian of heel
	RudderInflow   float64 // the rudder's share of the boat's speed
	Downwash       float64 // share of the sideways flow at the rudder that the board's downwash cancels
	FoilWetHeel    float64 // the foils are fully in the water up to this heel, degrees
	FoilDryHeel    float64 // and out of it from this heel, degrees

	// Sailor.
	SailorMass       float64 // kg
	SailorSeatHeight float64 // seated sailor's centre above the boat's centre of gravity, m
	HikeReach        float64 // furthest out to windward, m
	LeeReach         float64 // furthest out to leeward, m
	HikeSpeed        float64 // fastest the sailor moves across, m/s
	HikeLag          float64 // s
	HeelGain         float64 // m of extra hiking per radian of heel
	RollRateGain     float64 // m per rad/s of roll rate
	FlattenFrom      float64 // apparent wind at which the sailor starts flattening the sail, m/s
	FlattenTo        float64 // apparent wind at which the sail is at its flattest, m/s
	FlattenMin       float64 // flattest, as a fraction of full lift
	FallOutHeel      float64 // past this heel the sailor falls in, degrees
	ClimbInHeel      float64 // the sailor climbs back in below this heel, degrees
	BoardReach       float64 // the sailor's weight on the daggerboard, from the centre of gravity, m
	SailorDrag       float64 // roll damping of the sailor in the water holding on, N·m·s/rad
	SwimTime         float64 // s to reach the daggerboard
	ClimbTime        float64 // s to climb back in

	// Rates.
	RudderTime    float64 // s for the rudder's full travel, one side to the other
	SheetHaulTime float64 // s to haul the sheet in over its full range
	SheetEaseTime float64 // s to ease it out over its full range
}

// SeaParams describe the waves long enough to move a boat: the catalog's sea
// values, in the order of its schema. PrepareSea derives the waves from them.
type SeaParams struct {
	Shortest   float64 // the shortest wavelength, m
	Longest    float64 // the longest wavelength, m
	Gamma      float64 // the JONSWAP spectrum's peak enhancement
	SigmaBelow float64 // the peak's width below the peak frequency
	SigmaAbove float64 // and above it
	Spreading  float64 // the exponent s of the spreading cos²ˢ(θ/2), a whole number
	FetchCap   float64 // the fetch of open water, nautical miles
	Cull       float64 // waves lower than this fraction of an area's highest are left out
}

// Out holds values derived during a step for drawing and the player's
// instruments. A step writes it and never reads it, and it is not part of the
// state, so it is never sent: a client reads it from its own prediction.
type Out struct {
	ApparentWindSpeed float64 // at the masthead, m/s
	ApparentWindAngle float64 // at the masthead, where it comes from off the bow, rad, positive from starboard
	SailWindSpeed     float64 // at the sail's centre of effort, m/s
	SailWindAngle     float64 // at the sail's centre of effort, rad, positive from starboard
	FootAttack        float64 // the lower strip's angle of attack, rad, negative with the wind on its other face
	HeadAttack        float64 // the upper strip's, rad
	FootFlow          float64 // the lower strip's flow: FlowLuffing, FlowAttached, FlowStalled or FlowAback
	HeadFlow          float64 // the upper strip's
	Drive             float64 // the sail's force ahead, N
	SideForce         float64 // the sail's level force to starboard, N
	BoardLift         float64 // the daggerboard's level force to starboard, N
	RudderLift        float64 // the rudder's level force to starboard, N
	Leeway            float64 // angle of the boat's motion off its heading, rad, positive to starboard
	SpeedOverGround   float64 // m/s
	CourseOverGround  float64 // rad clockwise from north
	HeelingMoment     float64 // roll moment of the wind and water, N·m, positive heeling to starboard
	RightingMoment    float64 // roll moment of the hull's form and the sailor's weight, N·m
	Flattening        float64 // the sailor's flattening of the sail, fraction of full lift
	Twist             float64 // the upper strip's twist beyond the boom, rad
	WaveHeight        float64 // the sea's height under the hull, averaged over its waterplane, m
	WaveSlopeAhead    float64 // the sea's slope under the hull, rising toward the bow
	WaveSlopeAcross   float64 // and rising toward starboard
	SpeedThroughWater float64 // m/s: the boat's speed less the waves' own motion
}

// The flow over a sail strip, in Out.FootFlow and Out.HeadFlow.
const (
	FlowLuffing  = 0 // too little angle of attack: the cloth flogs
	FlowAttached = 1 // drawing well
	FlowStalled  = 2 // past the stall
	FlowAback    = 3 // the wind on the sail's back, from the leech
)

// WeatherParams describe the wind over the disk, its gusts and how the sea
// follows it: the catalog's weather values of its groups disk, gusts and
// waveWind, in the order of its schema. PrepareWeather derives the constants
// the wind is computed with.
type WeatherParams struct {
	// The disk.
	SpeedCentre    float64    // the wind's speed at the centre, as a share of a spell's
	SpeedRim       float64    // and at the rim
	Rim            float64    // where the share reaches SpeedRim: the mist band, nautical miles
	RefugeInner    float64    // within this the refuge's limits hold in full, nautical miles
	RefugeOuter    float64    // and beyond this not at all, nautical miles
	RefugeMeanKnee float64    // the refuge softens the mean wind above this, knots
	RefugeMean     float64    // toward this, knots
	RefugeWindKnee float64    // and the wind with its gusts above this, knots
	RefugeWind     float64    // toward this, knots
	RimGusts       float64    // the gust factor's excess grows by this share toward the rim
	RimGustsFrom   float64    // from here to the rim, nautical miles
	AcrossTurn     [2]float64 // the shortest and longest time the axis of the difference across the disk takes to turn once, hours

	// The gusts.
	GustAlong  float64 // the largest cells of the gust field along the wind, m
	GustAcross float64 // and across it, m
	GustLife   float64 // the largest cells' life, s
	GustSpeed  float64 // how fast the field travels, as a share of a spell's wind
	GustVeer   float64 // how far the strongest gust veers and the deepest lull backs, degrees
	Change     float64 // how long one spell takes to give way to the next, minutes

	// The wave wind.
	WaveTimeConstant float64 // the time constant of the average the sea follows, s
	WaveSample       float64 // the wind is sampled on a grid of world time this far apart, s
	WaveSamples      float64 // and this many samples are kept
}

// Regime describes the wind of a kind of spell: the catalog's values of a
// regime's wind, in the order of its schema. DrawSpell draws a spell's
// numbers from them.
type Regime struct {
	Speed      [2]float64 // the least and the most of its wind at mid-disk, knots
	GustFactor float64    // its strongest gusts as a multiple of the mean
	Shift      float64    // how far its two oscillating shifts swing together, degrees each way
	Period     [2]float64 // the shortest and longest period of a shift, minutes
	Across     float64    // how far the wind's direction differs from the centre to the rim, degrees
	Drift      float64    // the most its direction moves over a spell, degrees
}

// Spell is a spell of weather: a stretch of time with one base wind, its
// shifts and its gust field. Its fields are whole numbers, in the units the
// wire carries, so that a client computes the server's wind from what it is
// sent, bit for bit; SpellOf turns them into the values the wind is
// computed with.
type Spell struct {
	Begin  float64 // the tick its change from the spell before begins
	Change float64 // how many ticks the change takes; 0 is at once
	Start  float64 // the tick its drift, its gust field's travel and the field's life count from
	Length float64 // the ticks over which it drifts by Drift; 0 for no drift
	Regime float64 // the catalog's index of its regime
	Steady float64 // 1: the same wind everywhere, with no shifts, gusts, rim or refuge
	Speed  float64 // its wind at mid-disk, in steps of SeaSpeedStep
	From   float64 // the direction its wind comes from at Start, in 65536ths of a turn clockwise from north
	Drift  float64 // how far that direction veers over Length, in 65536ths of a turn; negative backs
	Gust   float64 // its gust factor, in thousandths
	// The two oscillating shifts: each one's amplitude and phase at tick 0,
	// in 65536ths of a turn, and its period in ticks.
	Shift  [2]float64
	Period [2]float64
	Phase  [2]float64
	// The difference across the disk: how far the direction differs at the
	// rim from the centre, in 65536ths of a turn; the axis it differs along
	// at tick 0, a direction in 65536ths of a turn; and the ticks the axis
	// takes to turn once.
	Across     float64
	Axis       float64
	AxisPeriod float64
	Seed       float64 // the gust field's seed, a uint32
}

// WindPoint is the wind at a point in full: what the client's instruments
// and drawing read beside the wind a step sails in.
type WindPoint struct {
	Speed      float64 // the wind 10 m up, m/s
	From       float64 // the direction it comes from, rad clockwise from north
	MeanSpeed  float64 // the wind without its gusts: what the sea follows and the Beaufort scale reads, m/s
	MeanFrom   float64 // rad clockwise from north
	Gust       float64 // the gust field, from −1 in the deepest lull to 1 in the strongest gust
	Factor     float64 // the gust factor: Speed over MeanSpeed, before the refuge
	DriftEast  float64 // how fast the gust field travels: east, m/s
	DriftNorth float64 // and north, m/s
}

// GustFrame is the gust field's frame at a moment, for drawing it: for each
// of the spells in play that has gusts, its share of the mix, the
// direction of its frame, how far the field has travelled and how long it
// has lived, and its octaves' seeds. A GPU carries on from these and the
// catalog's cells to the field at each tile.
type GustFrame struct {
	Spells  float64    // how many spells in play have gusts: 0, 1 or 2
	Share   [2]float64 // each one's weight in the mix of their fields
	Sin     [2]float64 // the sine of the direction its frame turns with
	Cos     [2]float64 // and the cosine
	Travel  [2]float64 // how far its field has travelled downwind, m
	Seconds [2]float64 // how long its field has lived, s
	Seed    [2 * 3]float64
	Excess  float64 // the gust factor less 1, as the spells mix it
}
