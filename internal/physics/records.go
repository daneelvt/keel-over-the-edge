// SPDX-License-Identifier: AGPL-3.0-only

package physics

// The records a step reads and writes. Every field is a float64, so the
// client reads and writes them through a Float64Array on the WebAssembly
// module's memory, by the field indices tools/physics generates into
// client/src/predict/layout.gen.ts. Changing a record changes LayoutVersion
// (layout.gen.go), and a client refuses a module whose version differs.

// State is a body's state between steps: what the server sends the client to
// replay from.
type State struct {
	X       float64 // position east of the world's centre, m
	Y       float64 // position north of the world's centre, m
	Heading float64 // direction the bow points, rad clockwise from north, in [-π, π)
	Surge   float64 // speed ahead, m/s
	Sway    float64 // speed to starboard, m/s
	YawRate float64 // rate of turn, rad/s, positive to starboard
}

// Control holds what the player sets.
type Control struct {
	Helm float64 // -1 hard to port … 1 hard to starboard
	Trim float64 // how much of the sail's drive is used, 0 … 1
}

// Env is the world at the body during the step.
type Env struct {
	WindSpeed float64 // true wind 10 m above the sea, m/s
	WindFrom  float64 // direction the true wind comes from, rad clockwise from north
}

// Params describe a kind of body. The client writes them once, when it loads.
type Params struct {
	Mass        float64 // kg, crew included
	YawInertia  float64 // kg·m²
	SailArea    float64 // m²
	SailHeight  float64 // height of the sail's centre of effort, m
	DragAhead   float64 // hull resistance ahead, N per (m/s)²
	DragSide    float64 // hull resistance sideways, N per (m/s)²
	RudderPower float64 // turning moment at full helm, N·m per (m/s)²
	YawDamping  float64 // rate at which a turn dies away, 1/s
}
