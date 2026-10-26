// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Orders. steer and trim write the boat's control slot as a phone's input
// does, stamped for the next tick, so the physics, the Articles and every
// rule are a human's. An order names where the boat should end up, not a
// nudge: sending the same order twice changes nothing. A tack or a gybe is
// the autopilot's order count raised, which the boat takes once; it is
// raised only when the target is on the other side of the wind from the
// boat's present side and no turn is under way or waiting to be taken, so
// a retried tack turns once.

// steerOrder is what steer asks for: exactly one of a wind angle, a
// heading and a rudder.
type steerOrder struct {
	WindAngle *int   `json:"wind_angle,omitempty"`
	Side      string `json:"side,omitempty"`
	Heading   *int   `json:"heading,omitempty"`
	Rudder    *int   `json:"rudder,omitempty"`
	Via       string `json:"via,omitempty"`
	Boom      *int   `json:"boom,omitempty"`
}

// The ways and sides an order names.
const (
	viaAuto = "auto"
	viaTack = "tack"
	viaGybe = "gybe"

	sidePort      = "port"
	sideStarboard = "starboard"
	sideSame      = "same"
)

// written is what an order wrote, or why it wrote nothing.
type written struct {
	// already: the boat already holds the order; the words say what it
	// holds.
	already bool
	turning string // "tack" or "gybe" for an order that turns the boat
}

// sheetOf is the sheet's index in the control's steps for a boom let out
// to boom degrees on a boat of kind b: the sheet lets the boom out from
// hauled in hard to let fly.
func sheetOf(b *catalog.Boat, boom float64) uint16 {
	in, out := b.Physics.Rig.BoomIn, b.Physics.Rig.BoomOut
	share := min(max((boom-in)/(out-in), 0), 1)
	return uint16(math.Round(share * bus.Steps))
}

// boomOf is the boom's angle the sheet lets out, degrees.
func boomOf(b *catalog.Boat, sheet uint16) float64 {
	in, out := b.Physics.Rig.BoomIn, b.Physics.Rig.BoomOut
	return in + float64(sheet)/bus.Steps*(out-in)
}

// leastAngle is the closest to the wind the autopilot's dial goes on a
// boat of kind b, degrees: ten inside its close-hauled course.
func leastAngle(b *catalog.Boat) int { return int(math.Ceil(b.Physics.Rig.CloseHauled - 10)) }

// turnTarget is an angle in degrees as the pilot word holds it, in steps
// of a turn.
func turnTarget(deg float64) uint16 {
	return uint16(int64(math.Round(deg*physics.TurnSteps/360)) & (physics.TurnSteps - 1))
}

// held is the pair of words in force for the boat in slot sl: the last
// the helm wrote that the boat has not yet taken, or else the frame's.
func held(s *Sea, f *bus.Frame, sl int32) (bus.Word, bus.PilotWord) {
	w, p := s.Bus.Controls.Load(sl)
	if w.Gen() == f.Gen[sl] && p.Gen() == f.Gen[sl] && w.Seq() == p.Seq() && int32(w.Seq()-uint32(f.Tick)) > 0 {
		return w, p
	}
	return f.Control[sl], f.Pilot[sl]
}

// pending reports whether the boat in slot sl has an order count it has
// not taken, or a turn under way.
func pending(f *bus.Frame, sl int32, p bus.PilotWord) bool {
	st := &f.State[sl]
	return uint8(st.PilotWay) != physics.WayHold || p.Mode() != bus.PilotOff && float64(p.Order()) != st.PilotOrder
}

// presentSide is the side the wind is over the boat in slot sl, by the
// mean wind the autopilot steers by: positive starboard.
func presentSide(f *bus.Frame, sl int32) float64 {
	a := wrap(f.Wind[sl].MeanFrom - f.State[sl].Heading)
	if a < 0 {
		return -1
	}
	return 1
}

// steer writes a steering order to the boat in slot sl of f. refusal is
// non-empty for an order refused, in words that say what to send instead.
func (h *helm) steer(s *Sea, f *bus.Frame, sl int32, o *steerOrder) (w written, refusal string) {
	b := s.boat(f.Kind[sl])
	word, pw := held(s, f, sl)
	sheet := word.SheetIndex()
	if o.Boom != nil {
		if *o.Boom < 4 || *o.Boom > 95 {
			return w, refusalBoom(*o.Boom, b)
		}
		sheet = sheetOf(b, float64(*o.Boom))
	}
	seq := uint32(f.Tick + 1)
	gen := f.Gen[sl]
	order, way := pw.Order(), uint8(bus.WayHold)
	given := 0
	for _, set := range []bool{o.WindAngle != nil, o.Heading != nil, o.Rudder != nil} {
		if set {
			given++
		}
	}
	if given > 1 {
		given = 0
	}
	switch {
	case given == 0:
		return w, "Send exactly one of wind_angle (with side), heading or rudder: wind_angle 45 side starboard, heading 120, or rudder -10."
	case o.Rudder != nil:
		r := *o.Rudder
		most := int(b.Physics.Foils.RudderAngle)
		if r < -most || r > most {
			return w, fmt.Sprintf("The rudder goes %d° each way at most: send rudder from %d to %d, negative to port.", most, -most, most)
		}
		helm := uint16(math.Round((float64(r)/float64(most) + 1) / 2 * bus.Steps))
		next := bus.Pack(seq, helm, sheet, gen)
		if pw.Mode() == bus.PilotOff && word.HelmIndex() == helm && word.SheetIndex() == sheet {
			return written{already: true}, ""
		}
		s.Bus.Controls.Store(sl, next, bus.PackPilot(seq, bus.PilotOff, bus.WayHold, order, 0, gen))
		return w, ""
	case o.WindAngle != nil:
		a := *o.WindAngle
		if least := leastAngle(b); a < least {
			return w, fmt.Sprintf("Can't hold wind %d°: inside %d° the sail cannot draw. Close-hauled is about %d°. Try wind_angle %d.",
				a, least, int(b.Physics.Rig.CloseHauled), int(b.Physics.Rig.CloseHauled))
		}
		if a > 180 {
			return w, "wind_angle is the angle off the true wind, 30 to 180: 180 is dead downwind."
		}
		sign := presentSide(f, sl)
		switch o.Side {
		case sidePort:
			sign = -1
		case sideStarboard:
			sign = 1
		case "", sideSame:
		default:
			return w, "side is port, starboard or same: the tack to sail on, the side the wind comes over."
		}
		target := turnTarget(sign * float64(a))
		turn, refused := h.turnFor(f, sl, pw, sign, float64(a), o.Via)
		if refused != "" {
			return w, refused
		}
		if turn != "" {
			order, way = (order+1)&3, wayOf(turn)
		}
		if turn == "" && pw.Mode() == bus.PilotWind && pw.Target() == target && word.SheetIndex() == sheet {
			return written{already: true, turning: pendingTurn(f, sl, pw)}, ""
		}
		s.Bus.Controls.Store(sl, bus.Pack(seq, bus.Steps/2, sheet, gen), bus.PackPilot(seq, bus.PilotWind, way, order, target, gen))
		return written{turning: turn}, ""
	case o.Heading != nil:
		hd := *o.Heading
		if hd < 0 || hd > 359 {
			return w, "heading is a compass heading, 0 to 359 degrees true."
		}
		// The side the wind will be over on the heading, and how far off
		// it the heading is.
		off := wrap(f.Wind[sl].MeanFrom - rad(float64(hd)))
		if least := leastAngle(b); math.Abs(deg(off)) < float64(least) {
			return w, fmt.Sprintf("Can't hold heading %s: it is %d° off the wind, and inside %d° the sail cannot draw. The wind is from %s.",
				three(hd), degrees(math.Abs(off)), least, three(degrees(f.Wind[sl].MeanFrom)))
		}
		sign := 1.0
		if off < 0 {
			sign = -1
		}
		target := turnTarget(float64(hd))
		turn, refused := h.turnFor(f, sl, pw, sign, deg(math.Abs(off)), o.Via)
		if refused != "" {
			return w, refused
		}
		if turn != "" {
			order, way = (order+1)&3, wayOf(turn)
		}
		if turn == "" && pw.Mode() == bus.PilotHeading && pw.Target() == target && word.SheetIndex() == sheet {
			return written{already: true, turning: pendingTurn(f, sl, pw)}, ""
		}
		s.Bus.Controls.Store(sl, bus.Pack(seq, bus.Steps/2, sheet, gen), bus.PackPilot(seq, bus.PilotHeading, way, order, target, gen))
		return written{turning: turn}, ""
	}
	return w, ""
}

// pendingTurn is the turn the boat in slot sl is making or has yet to
// take, "" for none.
func pendingTurn(f *bus.Frame, sl int32, pw bus.PilotWord) string {
	if !pending(f, sl, pw) {
		return ""
	}
	way := uint8(f.State[sl].PilotWay)
	if way == physics.WayHold {
		way = pw.Way()
	}
	switch way {
	case physics.WayTack:
		return viaTack
	case physics.WayGybe:
		return viaGybe
	}
	return ""
}

// wayOf is a turn's way, as the pilot word holds it.
func wayOf(turn string) uint8 {
	if turn == viaGybe {
		return bus.WayGybe
	}
	return bus.WayTack
}

// turnFor is the turn an order on the side sign at angle degrees off the wind
// needs, "tack", "gybe" or "" for none, by the way asked: none when the
// boat is on that side already, or is turning or has a turn it has not
// taken; auto tacks through the wind, and never gybes: a turn between two
// courses abaft the beam it leaves to the agent.
func (h *helm) turnFor(f *bus.Frame, sl int32, pw bus.PilotWord, sign, angle float64, via string) (string, string) {
	if presentSide(f, sl) == sign || pending(f, sl, pw) {
		return "", ""
	}
	switch via {
	case viaTack:
		return viaTack, ""
	case viaGybe:
		return viaGybe, ""
	case "", viaAuto:
		// Abaft the beam both now and after, the short way is through dead
		// downwind; otherwise it is through the wind.
		now := deg(math.Abs(wrap(f.Wind[sl].MeanFrom - f.State[sl].Heading)))
		if now <= 90 || angle <= 90 {
			return viaTack, ""
		}
		return "", fmt.Sprintf("Getting onto the other side at %d° means turning through dead downwind, which auto never does. "+
			"Send via gybe to gybe, or via tack to come round through the wind.", int(angle))
	}
	return "", "via is auto, tack or gybe: how to turn if the side changes."
}

// trim lets the boom out to boom degrees, the helm held as it is.
func (h *helm) trim(s *Sea, f *bus.Frame, sl int32, boom int) (written, string) {
	b := s.boat(f.Kind[sl])
	if boom < 4 || boom > 95 {
		return written{}, refusalBoom(boom, b)
	}
	word, pw := held(s, f, sl)
	sheet := sheetOf(b, float64(boom))
	if word.SheetIndex() == sheet {
		return written{already: true}, ""
	}
	seq := uint32(f.Tick + 1)
	s.Bus.Controls.Store(sl, bus.Pack(seq, word.HelmIndex(), sheet, f.Gen[sl]),
		bus.PackPilot(seq, pw.Mode(), pw.Way(), pw.Order(), pw.Target(), f.Gen[sl]))
	return written{}, ""
}

// refusalBoom is a boom out of its range.
func refusalBoom(boom int, b *catalog.Boat) string {
	return fmt.Sprintf("The boom swings from %d° (hauled in hard) to %d° (let fly): %d is out of range. A rough guide is half the apparent wind's angle, eased in gusts.",
		int(math.Ceil(b.Physics.Rig.BoomIn)), int(b.Physics.Rig.BoomOut), boom)
}

// orderLine is the one line an order answers with: the boat as the order
// leaves it, from the words written and the frame.
func orderLine(s *Sea, f *bus.Frame, sl int32, w written) string {
	b := s.boat(f.Kind[sl])
	word, pw := held(s, f, sl)
	st := &f.State[sl]
	what := ""
	target := float64(pw.Target()) * 2 * math.Pi / physics.TurnSteps
	switch pw.Mode() {
	case bus.PilotWind:
		a := wrap(target)
		what = fmt.Sprintf("wind %d° %s", degrees(math.Abs(a)), side(a))
	case bus.PilotHeading:
		what = "heading " + three(degrees(target))
	default:
		r := (float64(word.HelmIndex())/bus.Steps*2 - 1) * b.Physics.Foils.RudderAngle
		what = fmt.Sprintf("hand on the helm, rudder %d°", int(math.Round(math.Abs(r))))
		if math.Round(r) != 0 {
			what += " to " + side(r)
		}
	}
	switch {
	case w.turning == viaTack || uint8(st.PilotWay) == physics.WayTack:
		what = "tacking to " + what
	case w.turning == viaGybe || uint8(st.PilotWay) == physics.WayGybe:
		what = "gybing to " + what
	default:
		what = "holding " + what
	}
	if w.already {
		what = "already " + what
	}
	return fmt.Sprintf("%s · %s · boom out to %d° · %s · heel %d°", clockOf(s, f, st.X, st.Y), what,
		int(math.Round(boomOf(b, word.SheetIndex()))), knots1(float64(f.Instruments[sl].SpeedOverGround)), degrees(math.Abs(st.Heel)))
}
