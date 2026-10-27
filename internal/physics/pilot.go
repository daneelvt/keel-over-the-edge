// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The autopilot steers, and only steers: it sets the helm at the start of a
// step, the rudder follows it at the sailor's rate, and the sheet and every
// force are the step's as ever. It holds an angle off the mean wind (its
// shifts and drift, not its gusts: a wind vane mode that "will react to
// long-term wind shifts, but will not correct for short-term changes such
// as gusts", as Raymarine's manual has it) or a compass heading, and turns
// to its target the short way, or through head to wind or dead downwind as
// ordered.
//
// The law is the course-keeper's proportional–integral–derivative one
// (Fossen 2011): helm = gain × the angle off course − damping × the rate of
// turn + the standing helm, which grows slowly while the boat is near its
// course and so takes up the rudder the boat needs to go straight (what
// Raymarine calls AutoTrim). It is kept as helm toward the wind, so a tack
// carries it over mirrored, and it grows only near the course and up to a
// limit, so it never winds up against a rudder held hard over in a turn
// (Åström and Murray 2008).
//
// Water reaching the rudder from behind works it in reverse, so a boat
// going astern turns the other way to its helm: the autopilot then puts
// the helm the other way, as a helmsman does, and its standing helm, the
// rudder the boat needs going ahead, waits. A tack or gybe that has no
// steerage and gains too little on its course stalls: the autopilot gives
// it up and holds the angle the boat turned from, on its old side, until
// the next order.
//
// Everything it remembers is in the State, so a replay from the server's
// state steers as the server did.

// The autopilot's modes, in Control.Pilot.
const (
	PilotOff     = 0
	PilotWind    = 1 // hold an angle off the wind
	PilotHeading = 2 // hold a compass heading
)

// The ways the autopilot turns to its target, in Control.Way and
// State.PilotWay.
const (
	// WayHold: the short way, but never through dead downwind, which a
	// gybe inhibitor forbids; a target across dead downwind is reached
	// through the wind.
	WayHold = 0
	WayTack = 1 // through head to wind
	WayGybe = 2 // through dead downwind
	// A tack or a gybe that stalled: the autopilot holds the angle the
	// boat turned from, in State.PilotLeft, until the next order. Never
	// an order's way.
	WayTackStalled = 3
	WayGybeStalled = 4
)

// PilotOrders is how many values Control.Order takes: it counts orders
// modulo PilotOrders.
const PilotOrders = 4

// pilotPrepared is a kind of boat's autopilot, from its Params.
type pilotPrepared struct {
	pilotGain     float64 // helm per radian
	pilotDamping  float64 // helm per rad/s
	pilotIntegral float64 // standing helm per radian off course per second
	trimLimit     float64
	trimBand      float64 // rad
	tackHelm      float64
	gybeHelm      float64
	byTheLee      float64 // rad
	onCourse      float64 // rad
	astern        float64 // m/s
	steerage      float64 // m/s
	stallTime     float64 // s
	stallGain     float64 // rad
}

func (b *pilotPrepared) prepare(p *Params) {
	b.pilotGain = p.Gain
	b.pilotDamping = p.Damping
	b.pilotIntegral = p.Gain / p.TrimTime
	b.trimLimit = p.TrimLimit
	b.trimBand = float64(p.TrimBand * degree)
	b.tackHelm = p.TackHelm
	b.gybeHelm = p.GybeHelm
	b.byTheLee = float64(p.ByTheLee * degree)
	b.onCourse = float64(p.OnCourse * degree)
	b.astern = p.Astern
	b.steerage = p.Steerage
	b.stallTime = p.StallTime
	b.stallGain = float64(p.StallGain * degree)
}

// PilotOn reports whether a control has the autopilot on.
func PilotOn(c *Control) bool { return c.Pilot == PilotWind || c.Pilot == PilotHeading }

// pilotOff is the autopilot switched off: it forgets its standing helm and
// any turn, and follows the order count, so that switching it on is no
// order.
func pilotOff(s *State, c *Control, o *Out) {
	s.PilotTrim, s.PilotWay = 0, WayHold
	s.PilotWatch, s.PilotMark, s.PilotLeft = 0, 0, 0
	s.PilotOrder = math.Floor(control(c.Order, 0, PilotOrders-1))
	o.PilotOff, o.PilotHeading = 0, s.Heading
}

// pilot returns the helm the autopilot sets, and writes the heading it
// steers for and how far off it the boat is to o. While the sailor is out
// of the boat it takes orders but neither steers nor learns.
//
// Angles are off the mean wind: the wind's direction less the heading,
// positive with the wind over starboard, so dead downwind is ±π. The boat's
// tack is the side the wind comes over, except within byTheLee of dead
// downwind, where it is the side its boom is not on: a boat a little by the
// lee is still on the tack its boom says, and one further by the lee has
// gybed, or is about to (the boom of a dinghy goes over by itself a little
// further on).
func (b *Prepared) pilot(s *State, c *Control, e *Env, o *Out) float64 {
	wind := e.MeanFrom
	angle := wrapAngle(wind - s.Heading)
	order := math.Floor(control(c.Order, 0, PilotOrders-1))
	turn := false
	if order != s.PilotOrder {
		s.PilotOrder = order
		s.PilotWay = WayHold
		if c.Way == WayTack || c.Way == WayGybe {
			s.PilotWay, s.PilotLeft, turn = c.Way, angle, true
		}
	}
	target := float64(control(c.Target, 0, TurnSteps) * turnStep)
	if c.Pilot == PilotHeading {
		target = wind - target
	}
	stalled := s.PilotWay == WayTackStalled || s.PilotWay == WayGybeStalled
	if stalled {
		target = s.PilotLeft
	}
	target = wrapAngle(target)

	tack := 1.0
	if angle < 0 {
		tack = -1
	}
	if math.Abs(angle) > math.Pi-b.byTheLee && s.Boom != 0 {
		tack = -sign(s.Boom)
	}
	// The boat's angle and the target's, on the boat's tack: the boat's is
	// negative only by the lee, and is counted on past dead downwind.
	at := float64(tack * angle)
	if at < -math.Pi/2 {
		at += 2 * math.Pi
	}
	side := float64(tack * target)
	to := side
	switch s.PilotWay {
	case WayTack:
	case WayGybe:
		if to < 0 {
			to += 2 * math.Pi
		}
	default:
		if to < 0 {
			switch {
			case c.Pilot == PilotHeading && to < -math.Pi+b.byTheLee:
				// A heading a little by the lee is sailed by the lee.
				to += 2 * math.Pi
			case at >= math.Pi/2 && to <= -math.Pi/2:
				// Both aft of the beam on opposite tacks: the boat has gybed
				// by itself, or its target is across dead downwind from
				// it. It holds the same angle on its own tack, rather than
				// turn all the way round or gybe.
				to = -to
			}
		}
	}
	// How far to turn, as helm: positive turns the bow to starboard.
	off := float64(tack * (at - to))
	o.PilotOff = off
	o.PilotHeading = wrapAngle(wind - float64(tack*to))

	limit := 1.0
	switch s.PilotWay {
	case WayTack:
		limit = b.tackHelm
	case WayGybe:
		limit = b.gybeHelm
	}
	// The water along the hull, the current's taken from the boat's
	// motion: from behind, the rudder works in reverse.
	ahead := s.Surge
	if e.CurrentEast != 0 || e.CurrentNorth != 0 {
		sinH, cosH := SinCos(s.Heading)
		ahead -= float64(e.CurrentEast*sinH) + float64(e.CurrentNorth*cosH)
	}
	astern := ahead < -b.astern
	steer := float64(b.pilotGain*off) - float64(b.pilotDamping*s.YawRate)
	if astern {
		steer = -steer
	} else {
		steer += float64(tack * s.PilotTrim)
	}
	helm := clamp(steer, -limit, limit)
	if s.SailorMode != Sailing {
		return helm
	}
	near := math.Abs(off) < b.onCourse
	switch {
	case stalled:
		s.PilotWatch = min2(s.PilotWatch+Dt, b.stallTime)
	case s.PilotWay != WayHold && side >= 0 && near:
		s.PilotWay = WayHold
	case s.PilotWay != WayHold:
		b.watchTurn(s, o, off, ahead, turn, side >= 0)
	}
	if s.PilotWay == WayHold && math.Abs(off) < b.trimBand && !astern {
		grow := float64(float64(tack*b.pilotIntegral) * float64(off*Dt))
		s.PilotTrim = clamp(s.PilotTrim+grow, -b.trimLimit, b.trimLimit)
	}
	return helm
}

// watchTurn watches a tack or gybe under way gain on its course, off
// from it, with ahead the water along the hull: begun this step, or
// gaining stallGain since the watch began, the watch begins again; gaining
// less in stallTime with no steerage, the turn stalls. Past head to wind,
// or dead downwind, on its target's side, the boat has come round, if
// slowly, and the turn is over; short of it the autopilot holds the angle
// the boat turned from, and the seconds count on from the stall for a
// while.
func (b *Prepared) watchTurn(s *State, o *Out, off, ahead float64, turn, across bool) {
	off = math.Abs(off)
	if turn || s.PilotMark-off >= b.stallGain {
		s.PilotWatch, s.PilotMark = 0, off
		return
	}
	s.PilotWatch = min2(s.PilotWatch+Dt, b.stallTime)
	if !(s.PilotWatch >= b.stallTime && math.Abs(ahead) < b.steerage) {
		return
	}
	s.PilotWatch, s.PilotMark = 0, 0
	if across {
		s.PilotWay = WayHold
		return
	}
	s.PilotWay += WayTackStalled - WayTack
	o.PilotStalled = 1
}
