// SPDX-License-Identifier: AGPL-3.0-only

// Package race keeps a world's races ashore: making a race, its card,
// entering it and the limits on how often a sailor races, the owner's
// hand on it before it starts, its calendar file, and the world's own
// harbour races off Port Royal on their timetable. A race is made by any
// sailor, human or machine alike, for one kind of boat on one of the
// world's courses, and joined by its link's code; the harbour races are
// the world's, owned by the Harbourmaster, and found on Port Royal's
// harbour board as well.
//
// Every limit is counted from the rows the store keeps, inside the
// transaction that makes or enters a race, never from counters: a sailor
// may be entered in Ahead races not yet started, have Daily races start
// in any 24 hours, make Made races in any 24 hours and own Owned races not
// yet finished (store.RaceSettings). A crew aboard another's boat and a
// time trial's runs take no one's place and are not counted.
//
// A race goes up to its start here: open to entry, or closed by its owner,
// and from its warning signal, two minutes before the start, starting.
// The races' clerk (Clerk) hands it then to the committee in the world
// (package committee), which runs it, and writes it racing, and finished
// with what everyone came to.
package race

import (
	"errors"
	"fmt"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The kinds of race.
const (
	KindRace  = "race"  // boats start together on a gun
	KindTrial = "trial" // a race of one, sailed alone as often as anyone likes while it is open
)

// Who may enter.
const (
	WhoEveryone  = "everyone"
	WhoHumans    = "humans"
	WhoMachines  = "machines"
	WhoNewcomers = "newcomers" // sailors who have sailed fewer than Newcomer races
)

// The kinds of course.
const (
	CourseBuoy   = "buoy"   // laid to the wind in a racing area off Port Royal
	CourseIsland = "island" // one of the world's island courses, open once charted
)

// The shapes of a buoy course.
const (
	ShapeWindwardLeeward = "windward-leeward" // up to a windward mark and down to a leeward gate
	ShapeTriangle        = "triangle"         // windward, wing and leeward marks
)

// The phases a race is in, as its card tells it.
const (
	PhaseOpen      = "open"      // entries taken
	PhaseClosed    = "closed"    // entry closed by its owner, or a trial past its last run
	PhaseStarting  = "starting"  // from its warning signal until it is under way
	PhaseRacing    = "racing"    // under way
	PhaseFinished  = "finished"  // over
	PhaseCancelled = "cancelled" // called off
	PhaseEnded     = "ended"     // its world has ended
)

// The numbers of racing ashore.
const (
	// Warning is how long before its start a race's warning signal is: its
	// boats are placed on the line then, and entry closes.
	Warning = 2 * time.Minute
	// Lead is the least time ahead a race may be made to start.
	Lead = 5 * time.Minute
	// Clash is how near another race's start a race may not be entered:
	// a boat sails one race at a time.
	Clash = 20 * time.Minute
	// AreaApart is how far apart two buoy races' starts in one racing area
	// must be.
	AreaApart = 10 * time.Minute
	// Newcomer is how many races a sailor has sailed when they stop being
	// a newcomer.
	Newcomer = 5
	// Day is the rolling day the limits count over.
	Day = 24 * time.Hour
	// HarbourAhead is how far ahead the harbour races are made at least;
	// further when the board's HarbourShown need it.
	HarbourAhead = 6 * time.Hour
	// HarbourShown is how many harbour races the board lists.
	HarbourShown = 3
	// HarbourAfter is how long after a world begins its first harbour race
	// may start.
	HarbourAfter = 10 * time.Minute
)

// The minutes a buoy course is sized to, short and long: the committee's.
const (
	ShortMinutes = committee.ShortSeconds / 60
	LongMinutes  = committee.LongSeconds / 60
)

// Sailor is who asks: an account, a machine sailor's or a human's, and a
// machine sailor's owner.
type Sailor struct {
	ID      store.AccountID
	Machine bool
	Owner   store.AccountID
}

// Errors of asking about a race.
var (
	// ErrNotFound is no race of the code asked.
	ErrNotFound = errors.New("race: no such race")
	// ErrNotOwner is an owner's action asked by another.
	ErrNotOwner = errors.New("race: not the race's owner")
	// ErrNoWorld is a race asked of when no world is sailed.
	ErrNoWorld = errors.New("race: no world is sailed")
)

// The reasons a race refuses, as codes the client and the race tool put
// into words.
const (
	// Entering.
	RefuseFull      = "full"
	RefuseClosed    = "closed"
	RefuseStarted   = "started"
	RefuseCancelled = "cancelled"
	RefuseFinished  = "finished"
	RefuseHumans    = "humans"
	RefuseMachines  = "machines"
	RefuseNewcomers = "newcomers"
	RefuseBlocked   = "blocked"
	RefuseAhead     = "ahead"
	RefuseDaily     = "daily"
	RefuseEntered   = "entered"
	RefuseClash     = "clash"
	RefuseLate      = "late"
	// Making.
	RefuseMade   = "made"
	RefuseOwned  = "owned"
	RefuseSoon   = "soon"
	RefuseCourse = "course"
	RefuseAreas  = "areas"
	RefuseWho    = "who"
	RefuseBoat   = "boat"
	RefuseKind   = "kind"
	RefuseName   = "name"
	// The owner's hand.
	RefuseMoved       = "moved"
	RefuseNotEntered  = "not-entered"
	RefuseNotFinished = "not-finished"
)

// Refusal is a race refused, and why: Until, if not zero, is when it
// would not be (the next race may start then, the latest start allowed);
// Name, for a name refused, the moderation's reason.
type Refusal struct {
	Reason string
	Until  time.Time
	Name   string
}

func (r *Refusal) Error() string {
	if r.Until.IsZero() {
		return "race: refused: " + r.Reason
	}
	return fmt.Sprintf("race: refused: %s until %s", r.Reason, r.Until.UTC().Format(time.RFC3339))
}

func refuse(reason string) error { return &Refusal{Reason: reason} }

func refuseUntil(reason string, until time.Time) error { return &Refusal{Reason: reason, Until: until} }

// RefusalOf is err's refusal, if it is one.
func RefusalOf(err error) (*Refusal, bool) {
	var r *Refusal
	ok := errors.As(err, &r)
	return r, ok
}
