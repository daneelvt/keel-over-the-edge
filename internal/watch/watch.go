// SPDX-License-Identifier: AGPL-3.0-only

// Package watch is who may watch whose boat. A player watches another
// sailor's boat from that boat's own place, with the sailor's screen and
// nothing on it that acts, holding no boat of their own. A machine sailor
// may be watched whenever it sails; a human only in a voyage they allow
// spectators for, a choice made each voyage and never kept. A player may always watch their
// own machine sailors while they are in the water: nothing else in the
// rule stands in the way of that. The game connection and the list of
// sailors to watch both ask the rule here.
package watch

import "github.com/daneelvt/keel-over-the-edge/internal/store"

// Target is a sailor someone asks to watch, as the store has it.
type Target struct {
	ID   store.AccountID
	Kind store.Kind
	// Owner is a machine sailor's human; zero for a human's own sailor.
	Owner store.AccountID
	Name  string
	// Stopped: the account, or its owner, is stopped by the game's
	// operator.
	Stopped bool
}

// Machine reports whether the target is a machine sailor, sailed by an AI
// agent.
func (t Target) Machine() bool { return t.Kind == store.AI }

// Mine reports whether the target is one of viewer's own machine sailors.
func (t Target) Mine(viewer store.AccountID) bool {
	return t.Machine() && t.Owner == viewer && viewer != (store.AccountID{})
}

// Boat is what the world says of the target's boat now.
type Boat struct {
	// InWater: the boat is in the world, sailed or in its grace.
	InWater bool
	// Unseen: the owner's tools keep it out of every other view.
	Unseen bool
	// Voyage: its human allows spectators for this voyage.
	Voyage bool
}

// Verdict is the rule's answer.
type Verdict uint8

// The verdicts. Every refusal of a human reads the same, whether they are
// at sea or not, so that a refusal never tells a stranger where a human
// who does not allow spectators is.
const (
	// Yes: the viewer may watch.
	Yes Verdict = iota
	// Own: the viewer's own boat.
	Own
	// NotAtSea: a machine sailor not in the water.
	NotAtSea
	// Cannot: a human not at sea or not allowing spectators, or a boat the
	// owner's tools keep unseen.
	Cannot
)

// Allowed is the rule: may viewer watch t, whose boat is b?
func Allowed(t Target, b Boat, viewer store.AccountID) Verdict {
	switch {
	case t.ID == viewer:
		return Own
	case t.Mine(viewer):
		if b.InWater && !t.Stopped {
			return Yes
		}
		return NotAtSea
	case t.Machine():
		switch {
		case !b.InWater || t.Stopped:
			return NotAtSea
		case b.Unseen:
			return Cannot
		}
		return Yes
	case !b.InWater || t.Stopped || b.Unseen || !b.Voyage:
		return Cannot
	}
	return Yes
}
