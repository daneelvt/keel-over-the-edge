// SPDX-License-Identifier: AGPL-3.0-only

// Package watch is who may watch whose boat. A player watches another
// sailor's boat from that boat's own place, with the sailor's screen and
// nothing on it that acts, holding no boat of their own. A machine sailor
// may be watched whenever it sails; a human only while they allow
// spectators, always or for the voyage. A player may always watch their
// own machine sailors while they are in the water: nothing else in the
// rule stands in the way of that. The game connection and the list of
// sailors to watch both ask the rule here.
package watch

import (
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Target is a sailor someone asks to watch, as the store has it.
type Target struct {
	ID   store.AccountID
	Kind store.Kind
	// Owner is a machine sailor's human; zero for a human's own sailor.
	Owner store.AccountID
	Name  string
	// Always: a human who lets anyone watch, always.
	Always bool
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
	case !b.InWater || t.Stopped || b.Unseen || !(t.Always || b.Voyage):
		return Cannot
	}
	return Yes
}

// Allowing is the human accounts that let anyone watch them always, in
// memory: loaded as keel starts and changed only by the setting's route,
// each after its write, and read where a read of the database would sit
// on a path that must be quick: the encoders, each snapshot, and the list.
// A write that failed after the database's is mended by the next start.
type Allowing struct {
	mu sync.RWMutex
	m  map[store.AccountID]struct{}
}

// NewAllowing is a set of the accounts given.
func NewAllowing(ids []store.AccountID) *Allowing {
	a := &Allowing{m: map[store.AccountID]struct{}{}}
	for _, id := range ids {
		a.m[id] = struct{}{}
	}
	return a
}

// Has reports whether an account lets anyone watch it always. A nil set
// has none.
func (a *Allowing) Has(id store.AccountID) bool {
	if a == nil {
		return false
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	_, ok := a.m[id]
	return ok
}

// Set says whether an account lets anyone watch it always.
func (a *Allowing) Set(id store.AccountID, on bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if on {
		a.m[id] = struct{}{}
	} else {
		delete(a.m, id)
	}
}

// Len is how many accounts let anyone watch them always.
func (a *Allowing) Len() int {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return len(a.m)
}
