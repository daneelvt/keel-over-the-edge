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
}

// The flow over a sail strip, in Out.FootFlow and Out.HeadFlow.
const (
	FlowLuffing  = 0 // too little angle of attack: the cloth flogs
	FlowAttached = 1 // drawing well
	FlowStalled  = 2 // past the stall
	FlowAback    = 3 // the wind on the sail's back, from the leech
)
