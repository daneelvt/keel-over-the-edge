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
	// What the autopilot remembers between steps (pilot.go): all three are 0
	// while it has never been used.
	PilotTrim  float64 // its standing helm, positive turning the bow toward the wind, −1 … 1
	PilotWay   float64 // the way it is turning: WayHold, WayTack or WayGybe
	PilotOrder float64 // the order count of the last order it took
	// GroundTimer is how many steps the boat has been aground and all but
	// still: its sailor pushes it off when it reaches the ground's time.
	GroundTimer float64
}

// Control holds what the player sets. Helm and Sheet are targets: the rudder
// and the sheet follow them at the rates in Params. The autopilot's values
// are whole numbers, as the wire carries them; while it is on, it sets the
// helm and Helm is not read.
type Control struct {
	Helm  float64 // -1 hard to port … 1 hard to starboard: turns the bow that way
	Sheet float64 // 0 hauled in hard … 1 let fly
	Pilot float64 // the autopilot's mode: PilotOff, PilotWind or PilotHeading
	// Target is what it holds, in 65536ths of a turn: in PilotWind the angle
	// off the wind, positive with the wind over starboard (from 32768 on,
	// the angle less a whole turn); in PilotHeading the heading.
	Target float64
	Order  float64 // the order count, 0 … 3: a value the state has not taken is a new order
	Way    float64 // the way of the latest order: WayHold, WayTack or WayGybe
}

// Env is the world at the boat during the step.
type Env struct {
	WindSpeed    float64 // true wind 10 m above the sea, m/s
	WindFrom     float64 // direction the true wind comes from, rad clockwise from north
	MeanFrom     float64 // the direction the wind comes from without its gusts or any shadow: what the autopilot steers by
	CurrentEast  float64 // the water's own motion, the current: east, m/s
	CurrentNorth float64 // and north, m/s
}

// Params describe a kind of boat: the catalog's physics values, in the order
// of the catalog's schema (shared/catalog.schema.json), which
// go run ./tools/catalog checks. Angles are in degrees, as the catalog gives
// them; Prepare turns them into radians and every other derived constant.
type Params struct {
	// Hull.
	Displacement    float64                  // boat, rig and sailor, kg
	WaterlineLength float64                  // m
	HullDraught     float64                  // the hull's own draught, foils aside, m
	CentreOfGravity float64                  // height of the centre of gravity above the waterline, m
	DragAreaStep    float64                  // speed between entries of DragArea, m/s
	DragArea        [25]float64              // upright resistance as a drag area at 0, 1, 2 … steps of speed, m²
	CrossFlowDrag   float64                  // drag coefficient of the hull moving sideways, on length × draught
	AddedMassSurge  float64                  // kg
	AddedMassSway   float64                  // kg, hull and foils
	Munk            float64                  // the hull's added mass in sway less in surge, for the Munk moment, kg
	YawInertia      float64                  // added inertia included, kg·m²
	RollInertia     float64                  // added inertia included, kg·m²
	RollDamping     float64                  // the hull's own roll damping, N·m·s/rad
	RightingLever   [19]float64              // with the sailor on the centreline, every 10° of heel from 0° to 180°, m
	WaterlineBeam   float64                  // m
	WaterplaneArea  float64                  // m²
	WaterplanePitch float64                  // the waterplane's second moment of area about its transverse axis, m⁴
	AddedMassHeave  float64                  // kg
	PitchInertia    float64                  // added inertia included, kg·m²
	HeaveDamping    float64                  // fraction of critical
	PitchDamping    float64                  // fraction of critical
	WaveForce       float64                  // share of the Froude–Krylov force of a wave's slope
	WaveYaw         float64                  // share of that force's moment along the hull
	Outline         [OutlineStations]float64 // half-beam at the sheer at stations equally spaced from transom to stem, m
	Transom         float64                  // the transom's distance aft of the centre of gravity, m
	Stem            float64                  // the stem's distance forward of the centre of gravity, m

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
	CloseHauled       float64     // the close-hauled course's angle off the true wind, degrees

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

	// Autopilot.
	Gain      float64 // helm per radian off course
	Damping   float64 // helm per rad/s of turn, against it
	TrimTime  float64 // s for the standing helm to take up a steady error
	TrimLimit float64 // the most standing helm, a share of the helm
	TrimBand  float64 // the standing helm grows only this near the course, degrees
	TackHelm  float64 // the most helm in a tack
	GybeHelm  float64 // the most helm in a gybe
	ByTheLee  float64 // the most it sails by the lee before counting the boat gybed, degrees
	OnCourse  float64 // a turn ends this near the target, degrees
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
	Breaking   float64 // the most significant height the waves keep in shallow water, as a share of its depth
	// Swell.
	SwellLeast     float64 // a swell lower than this is none, m
	SwellSpreading float64 // the exponent s of its spreading cos²ˢ(θ/2), a whole number
	SwellSigma     float64 // its spectrum's width, a share of its peak frequency
	SwellSteps     float64 // Newton's steps that find when it left its system, a whole number
	CurrentMost    float64 // the most a current against the waves raises them, a multiple
	ShadowLeast    float64 // the least share of a swell that reaches behind land
	LeeReach       float64 // how far upwind of a place land calms its waves, m
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
	PilotHelm         float64 // the helm the step sailed with: the autopilot's while it is on, −1 … 1
	PilotOff          float64 // how far the autopilot has to turn the boat, rad, positive to starboard; 0 while it is off
	PilotHeading      float64 // the heading the autopilot steers for, rad clockwise from north; the heading while it is off
	Depth             float64 // the water under the daggerboard as the step began, m; negative over land
	Aground           float64 // Afloat, OnBottom or AgainstLand
	PushedOff         float64 // 1 if the step pushed the boat off, else 0
}

// GroundParams describe how a boat meets the ground: the catalog's world
// values of its groups surfaces and grounding, in the order of its schema.
// PrepareGround derives the constants grounding is computed with.
type GroundParams struct {
	Friction     [GroundSurfaces]float64 // Coulomb's coefficient of a hull on each surface, by the surface's index
	StillSpeed   float64                 // a boat aground slower than this is still, m/s
	StillTime    float64                 // still this long, its sailor pushes it off, s
	PushDepth    float64                 // into water this deep, m
	PushReach    float64                 // within this distance, m
	Restitution  float64                 // the share of its closing speed a hull parts from land with
	LandFriction float64                 // Coulomb's coefficient of a hull sliding along land
}

// ShelterParams describe how a shelter table is worked out from the land:
// the catalog's world values of its group shelter, in the order of its
// schema. Heights' multiples are of the land's height.
type ShelterParams struct {
	Reach   float64    // how far upwind land is looked for, m
	Step    float64    // the march's step, m
	Near    float64    // in the lee closer than this many heights the wind is at its least
	Far     float64    // and beyond this many it is whole again
	Least   float64    // the least factor
	Most    float64    // the greatest
	SpeedUp float64    // the most land beside the wind's path speeds it, a share
	Flank   float64    // land beside the path speeds it within this many heights of it
	Turn    float64    // the most land on one side turns the wind, degrees
	Offsets [4]float64 // how far beside the path land is looked for, m
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
	Edge           float64    // the lip of the falls, the disk's radius, nautical miles
	FallDraftFrom  float64    // the falls draw the air toward the lip from here, nautical miles
	FallDraft      float64    // and at the lip this fast, knots

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

	// The current: each part linear between its points, nothing before the
	// first and its last value beyond the last.
	CirculationAt [3]float64 // the circulation's points, nautical miles from the centre
	Circulation   [3]float64 // its speed at each, knots
	DrainAt       [3]float64 // the drain's points, nautical miles from the centre: the last is the lip
	Drain         [3]float64 // its speed toward the lip at each, knots
	Shallow       float64    // in water shallower than this the current falls off with the depth, m

	// A front: a line across the disk lying in a trough, the spell it
	// brings behind it and the one before ahead of it.
	TroughAhead  float64 // the trough deepens toward the line as e^(−s / this), nautical miles
	TroughBehind float64 // and fills behind it within this, a Gaussian's width, nautical miles
	FrontWind    float64 // its own wind at its steepest, knots
	FrontTurning float64 // its wind blows toward the trough turned clockwise by this, degrees
	Blend        float64 // the spells blend across the line within this either side, nautical miles
	FrontGusts   float64 // the gust factor's excess rises by this behind the line
	GustsBehind  float64 // over this behind it, nautical miles

	// The pressure.
	Slope    float64 // its slope across the disk, low on the left of the base wind: hPa a knot of it a nautical mile
	Rise     float64 // how fast it rises behind a front's line, hPa a minute
	RiseMost float64 // and how far, hPa

	// How far the systems reach.
	InwardFrom  float64 // within this of the centre a system is at its weakest, nautical miles
	InwardTo    float64 // and beyond this it is whole, nautical miles
	InwardLeast float64 // what a front, a squall or a shower keeps of itself at its weakest
	Cut         float64 // a system reaches this many of its widths from its centre
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
	Gust   float64 // its gust factor, in thousandths: at 1000 it has no gusts
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
	Pressure   float64 // its pressure's level, in hundredths of a hPa
	// Front is 1 if the spell arrives by a front: a line that enters the
	// disk's reach at Begin and leaves it at the far side Change ticks
	// later, moving toward Toward, in 65536ths of a turn clockwise from
	// north, at an even speed; its trough is Trough deep, in hundredths of
	// a hPa. The spell before blows ahead of the line, this one behind it.
	Front  float64
	Toward float64
	Trough float64
	// Still is 1 if the week's systems do not blow while this is the spell
	// in effect: a developer's weather.
	Still float64
}

// The shapes of a system kind's pressure, in SystemKind.Shape.
const (
	ShapeNone = 0 // no pressure: a patch that scales the wind
	ShapeDome = 1 // a dome, steeper ahead
	ShapeLow  = 2 // a low: a core and a broad shallow low about it
)

// How a system kind weakens toward the centre, in SystemKind.Inward.
const (
	InwardNone = 0 // it does not
	InwardWeak = 1 // to WeatherParams.InwardLeast of itself
	InwardGone = 2 // to nothing
)

// SystemKind describes a kind of weather system: the catalog's values of
// it the wind is computed with.
type SystemKind struct {
	Shape      float64 // ShapeNone, ShapeDome or ShapeLow
	Turning    float64 // its wind blows toward lower pressure turned clockwise by this, degrees
	Width      float64 // its pressure's or its patch's Gaussian width, as a share of a system's size
	Ahead      float64 // a dome is steeper ahead: its distance along its track is times this ahead of its centre
	Broad      float64 // a low's broad low: its share of the depth
	BroadWidth float64 // and its width as a multiple of the core's
	Stretch    float64 // a patch is stretched along its track by this
	Inward     float64 // InwardNone, InwardWeak or InwardGone
	Gusts      float64 // the gust factor's excess rises by this near its core
	// The swell it raises: none if its height is nothing.
	SwellPeriod [2]float64 // the least and the most of its peak period, drawn per system, s
	SwellBand   [2]float64 // the shortest and the longest period it spans, s
	SwellHeight [2]float64 // its significant height at its edge at full strength, m, at the least and the most of its wind
	SwellWind   [2]float64 // the least and the most of its wind, knots
}

// System is a weather system at a keyframe: where it is, how it moves, how
// strong and how large it is, in whole numbers, in the units the wire
// carries, so that a client computes the server's wind from what it is
// sent, bit for bit. Between two keyframes it is interpolated.
type System struct {
	On       float64 // 1 if the slot holds a system
	Kind     float64 // the catalog's index of its kind
	Seed     float64 // a uint32, for drawing it
	Stage    float64 // StageGrowing, StageMature or StageDecaying
	East     float64 // its centre east of the world's, in quarter metres
	North    float64 // and north
	Heading  float64 // the direction it moves toward, in 65536ths of a turn clockwise from north
	Speed    float64 // how fast, in steps of SeaSpeedStep
	Strength float64 // its life and wobble, in 4096ths
	Size     float64 // its radius, m
	Peak     float64 // the wind it adds at its peak at full strength, in steps of SeaSpeedStep; a patch's share of the wind at its core, in thousandths
	Depth    float64 // its pressure at its centre at full strength, in hundredths of a hPa: a dome's above, a low's below
}

// A system's stage of life, in System.Stage.
const (
	StageGrowing  = 0
	StageMature   = 1
	StageDecaying = 2
)

// The tracks of a SystemRecord.
const (
	TrackLine = 0 // a straight line at an even speed
	TrackArc  = 1 // round the centre, closing on it at an even speed
)

// SystemRecord is a system of a world's week as it is stored: its kind, its
// life, its planned track and, apart from it, its wobble. SystemAt makes
// its keyframe at a tick from it. Its fields are whole numbers.
type SystemRecord struct {
	Kind   float64 // the catalog's index of its kind
	Seed   float64 // a uint32
	Born   float64 // the tick it is born at, its strength nothing
	Mature float64 // the tick its strength has grown to the whole of it
	Decays float64 // the tick it begins to decay
	Gone   float64 // the tick it is gone, its strength nothing
	Track  float64 // TrackLine or TrackArc
	// A line: where it is at Born, in quarter metres east and north of the
	// centre, and the direction it moves toward, in 65536ths of a turn.
	East    float64
	North   float64
	Heading float64
	Speed   float64 // how fast it moves along its track, in steps of SeaSpeedStep
	// An arc: its distance from the centre at Born, in quarter metres; its
	// bearing from the centre then, in 65536ths of a turn; which way it goes
	// round, 1 clockwise seen from above and −1 the other way; and how fast
	// it closes on the centre, in steps of SeaSpeedStep.
	Radius float64
	Angle  float64
	Sense  float64
	Inward float64
	Size   float64 // its radius, m
	Peak   float64 // as System's
	Depth  float64 // as System's
	// Its wobble off the track, which a forecast does not know: how far
	// east and north it swings, in quarter metres, each with its period in
	// ticks and its phase at tick 0 in 65536ths of a turn; and its
	// strength's throb, how far it swings, in 4096ths, with its period
	// and phase. A stored week names the throb's fields by their old names.
	Wobble       float64
	WobblePeriod [2]float64
	WobblePhase  [2]float64
	Throb        float64 `week:"Swell"`
	ThrobPeriod  float64 `week:"SwellPeriod"`
	ThrobPhase   float64 `week:"SwellPhase"`
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
	// Front is 1 while a front crosses: then the spells' shares are by
	// which side of its line a point lies, and Share says each one's side,
	// 0 ahead and 1 behind. The line lies FrontLine m from the centre
	// along the way it moves, (FrontSin, FrontCos), the spells blended
	// within FrontBlend m of it.
	Front      float64
	FrontSin   float64
	FrontCos   float64
	FrontLine  float64
	FrontBlend float64
}

// EncounterParams describe boats meeting: the catalog's encounters values
// of its groups contact, shadow and articles, in the order of its schema.
// PrepareEncounters derives the constants they are computed with.
type EncounterParams struct {
	// Contact.
	Restitution float64 // the share of the closing speed the hulls part with
	Friction    float64 // Coulomb's coefficient of the hulls sliding along each other
	Passes      float64 // passes of the impulses over a tick's contacts
	Slop        float64 // penetration left alone, m
	Push        float64 // the share of the rest pushed apart in a tick
	Cap         float64 // the most a contact pushes boats apart in a tick, m
	Apart       float64 // ticks apart before touching again is a new bump

	// Shadow, in units of the source's rig height.
	Deficit      float64    // the share of the wind lost on the axis one rig height behind
	Near         float64    // closer than this the loss is no greater
	Width        float64    // the wake's half-width parameter at one rig height
	Header       float64    // how far the wake turns the wind one rig height behind, degrees
	Deflection   [2]float64 // the wake's turn off the apparent wind toward the windward side, close-hauled and beyond a reach, degrees
	DeflectionAt [2]float64 // the apparent wind angles each holds at, degrees
	Reach        float64    // how far the wake reaches
	Taper        float64    // where it begins to fade
	Sources      float64    // the most wakes a boat feels at once

	// Articles.
	Room       float64 // the window for giving room, s
	Turn       float64 // a change of course is one of more than this, degrees
	Course     float64 // the time constant of a boat's course, s
	Pairs      float64 // boats closer than this many hull lengths are a pair
	HeadToWind float64 // within this of head to wind a boat keeps her tack, degrees
}

// Wake is the wake a boat's sail leaves for the next tick: where it starts,
// the way it runs and how tall the rig that casts it stands. A step's
// boat leaves one in the frame it writes, and the boats near it feel it in
// the next tick (ShadowAt).
type Wake struct {
	X      float64 // where the wake starts: the sail's centre of effort, east, m
	Y      float64 // and north, m
	East   float64 // the unit vector the wake runs along: east
	North  float64 // and north
	Height float64 // the rig's height above the water as it stands: the length the wake scales with, m; 0 casts none
	Side   float64 // 1 when the apparent wind came over the source's starboard side, −1 over its port side
}

// Course is what the Articles keep of a boat between ticks: her tack, whether
// she is tacking, how long since her tack changed and her course, her
// heading smoothed.
type Course struct {
	Tack    float64 // −1 port, 1 starboard; 0 before the boat's first tick
	Tacking float64 // 1 from passing head to wind until she is close-hauled, else 0
	Settled float64 // ticks since her tack last changed, up to CourseSettled
	Course  float64 // her heading, smoothed over the articles' course time, rad
}

// Encounter is two boats as the Articles judge them, the first and the
// second: each one's pose, the true wind at it and its course, and what
// the pair remembers of who has had right of way since when.
type Encounter struct {
	X, Y, Heading [2]float64
	Heel, Boom    [2]float64
	SailorMode    [2]float64
	WindFrom      [2]float64 // the true wind at each, before any shadow
	Tack, Tacking [2]float64 // each one's Course
	Settled       [2]float64
	Course        [2]float64
	Since         float64 // ticks since the pair's keep-clear boat last changed
	By            float64 // whose action changed it: Neither, First or Second
}

// Verdict is what the Articles say of two boats: which keeps clear and by
// which Article, and, at a contact, whose fault it is and by which Article,
// which a limit on the right-of-way boat (15, 16.1) may have moved.
type Verdict struct {
	Keeper       float64 // Neither, First or Second
	Article      float64 // the Article that makes it keep clear
	Fault        float64 // Neither, First or Second
	FaultArticle float64 // the Article that puts the fault there
}

// Which boat of an Encounter.
const (
	Neither = 0
	First   = 1
	Second  = 2
)

// Contact is two hulls touching: the normal from the first toward the
// second, how deep they overlap along it, the centre of their overlap and
// how fast they close along the normal.
type Contact struct {
	NormalEast  float64
	NormalNorth float64
	Depth       float64 // m
	X, Y        float64 // m
	Closing     float64 // m/s, positive closing
}
