// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Who reads a log, and how the sailors in it are named: one rule for the
// log and the news alike.
//
// A log is read only by a sailor signed in to the game. Its sailor always
// reads it, and a player always reads their own machine sailors'. Anyone
// else reads it if its setting says sailors may: a machine sailor's
// always does; a human's says what they chose, or by default an adult's
// yes and a teen's (or one whose age is not known) no. A block, either
// way, refuses it.
//
// A sailor named in a log or the news is named to its reader by name when
// they are the reader, or a machine sailor, or a human whose own log the
// reader may read and who is in the reader's age band; anyone else is
// counted, not named. A block either way, between the reader or the log's
// sailor and the one named, makes them "a sailor"; an account deleted is
// a former sailor.

// Reader is who reads: a sailor signed in, their age band; or the game's
// owner, who reads everything (All).
type Reader struct {
	ID   store.AccountID
	Band aboard.Band
	All  bool
}

// Sailor is a sailor as the rules of reading and naming see them: whether
// a machine sailor, and whose; their age band (a machine sailor's is its
// owner's); who may read their log, as set (store.LogShownDefault for
// their band's default); and whether their account is deleted.
type Sailor struct {
	ID      store.AccountID
	Machine bool
	Owner   store.AccountID
	Band    aboard.Band
	Shown   string
	Gone    bool
}

// BandOf is the age band of a month of birth as the database keeps it, 0
// for none, at now.
func BandOf(born int32, now time.Time) aboard.Band {
	b, ok := aboard.BornOf(born)
	if !ok {
		return aboard.Unknown
	}
	return aboard.BandOf(b, now)
}

// SailorOf is a sailor as the log reads their account at now.
func SailorOf(p store.LogPerson, now time.Time) Sailor {
	return Sailor{ID: p.ID, Machine: p.Kind == store.AI, Owner: p.Owner, Band: BandOf(p.Born, now), Shown: p.Shown}
}

// Shown is who may read s's log: store.LogShownSailors or
// store.LogShownMe, the default resolved.
func Shown(s Sailor) string {
	switch {
	case s.Machine:
		return store.LogShownSailors
	case s.Shown != store.LogShownDefault:
		return s.Shown
	case s.Band == aboard.Adult:
		return store.LogShownSailors
	}
	return store.LogShownMe
}

// Own reports whether s's log is r's own: their sailor's, or one of their
// machine sailors'.
func Own(r Reader, s Sailor) bool {
	return s.ID == r.ID || s.Machine && s.Owner == r.ID
}

// MayRead reports whether r may read s's log; blocked is a block between
// them, either way.
func MayRead(r Reader, s Sailor, blocked bool) bool {
	switch {
	case s.Gone:
		return r.All
	case r.All, Own(r, s):
		return true
	case blocked:
		return false
	}
	return Shown(s) == store.LogShownSailors
}

// Naming is how a sailor is named to a reader.
type Naming uint8

// The ways a sailor is named.
const (
	// Named: by their name; a machine sailor marked as one.
	Named Naming = iota
	// Counted: not named, but counted ("with two aboard"), or their boat
	// named instead.
	Counted
	// Hidden: "a sailor", for a block.
	Hidden
	// Former: "a former sailor", their account deleted.
	Former
)

// NameOf is how s is named to r; blocked is a block between s and r, or
// between s and the sailor whose log it is, either way.
func NameOf(r Reader, s Sailor, blocked bool) Naming {
	switch {
	case s.Gone:
		return Former
	case r.All:
		return Named
	case blocked:
		return Hidden
	case s.ID == r.ID, s.Machine:
		return Named
	case MayRead(r, s, false) && s.Band == r.Band && (s.Band == aboard.Teen || s.Band == aboard.Adult):
		return Named
	}
	return Counted
}
