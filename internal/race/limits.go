// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"slices"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The limits, as rules on the rows counted: the same for every account,
// human or machine.

// phaseOf is the phase race r is in at now; current is the number of the
// world sailed, latest the last time a race may start in it.
func phaseOf(r *store.Race, now time.Time, current int, latest time.Time) string {
	if r.WorldNumber != current {
		if r.State == store.RaceCancelled {
			return PhaseCancelled
		}
		return PhaseEnded
	}
	switch r.State {
	case store.RaceCancelled:
		return PhaseCancelled
	case store.RaceFinished:
		return PhaseFinished
	case store.RaceRacing:
		return PhaseRacing
	}
	if r.Kind == KindTrial {
		if r.State == store.RaceClosed || !latest.IsZero() && now.After(latest) {
			return PhaseClosed
		}
		return PhaseOpen
	}
	if !now.Before(r.StartsAt.Add(-Warning)) {
		return PhaseStarting
	}
	if r.State == store.RaceClosed {
		return PhaseClosed
	}
	return PhaseOpen
}

// entering is what an entry is judged by besides the rows: the race, who
// asks, the most boats of its kind, whether they are a newcomer and
// whether a block stands between them and its owner, the limits, now and
// the last time a race may start in the world.
type entering struct {
	race     *store.Race
	sailor   Sailor
	most     int
	newcomer bool
	blocked  bool
	limits   store.RaceSettings
	now      time.Time
	latest   time.Time
}

// refusedEntry is why an entry is refused, as the rows read in its
// transaction stand, or nil to enter it.
func (in *entering) refusedEntry(e store.RaceEntering) error {
	r := in.race
	switch e.State {
	case store.RaceCancelled:
		return refuse(RefuseCancelled)
	case store.RaceFinished:
		return refuse(RefuseFinished)
	case store.RaceRacing:
		return refuse(RefuseStarted)
	case store.RaceClosed:
		return refuse(RefuseClosed)
	}
	if r.Kind == KindTrial {
		if !in.latest.IsZero() && in.now.After(in.latest) {
			return refuse(RefuseLate)
		}
	} else if !in.now.Before(e.StartsAt.Add(-Warning)) {
		return refuse(RefuseStarted)
	}
	if e.HasEntry && e.Entry.Removed {
		return refuse(RefuseBlocked)
	}
	if e.HasEntry && !e.Entry.Withdrawn {
		return refuse(RefuseEntered)
	}
	switch {
	case r.Who == WhoHumans && in.sailor.Machine:
		return refuse(RefuseHumans)
	case r.Who == WhoMachines && !in.sailor.Machine:
		return refuse(RefuseMachines)
	case r.Who == WhoNewcomers && !in.newcomer:
		return refuse(RefuseNewcomers)
	}
	if in.blocked {
		return refuse(RefuseBlocked)
	}
	if r.Kind != KindTrial && e.Entered >= in.most {
		return refuse(RefuseFull)
	}
	if r.Kind == KindTrial {
		// A trial's runs take no one's place: never counted.
		return nil
	}
	return in.refusedByLimits(e.StartsAt, e.Mine)
}

// counted reports whether a race the sailor entered counts toward their
// day's races: a race, not this one, not cancelled, whose boat was placed
// on its line or which has not been run yet. A boat that never came to
// the line (did not start) is not counted.
func (in *entering) counted(m store.EntryStart) bool {
	if m.Kind != KindRace || m.Race == in.race.ID && m.World == in.race.World || m.State == store.RaceCancelled {
		return false
	}
	return m.Started || m.State == store.RaceOpen || m.State == store.RaceClosed
}

// refusedByLimits is why entering a race starting at start is refused by
// the limits on how often a sailor races, or nil.
func (in *entering) refusedByLimits(start time.Time, mine []store.EntryStart) error {
	var ahead, day []time.Time
	for _, m := range mine {
		if !in.counted(m) {
			continue
		}
		if (m.State == store.RaceOpen || m.State == store.RaceClosed) && m.At.Sub(start).Abs() < Clash {
			return refuseUntil(RefuseClash, m.At.Add(Clash))
		}
		if (m.State == store.RaceOpen || m.State == store.RaceClosed) && m.At.After(in.now) {
			ahead = append(ahead, m.At)
		}
		if m.At.After(start.Add(-Day)) && !m.At.After(start) {
			day = append(day, m.At)
		}
	}
	if len(ahead) >= in.limits.Ahead {
		// Another may be entered once the soonest has started.
		return refuseUntil(RefuseAhead, slices.MinFunc(ahead, func(a, b time.Time) int { return a.Compare(b) }))
	}
	if len(day) >= in.limits.Daily {
		// The next may start a day after the oldest that must fall out of
		// the day.
		slices.SortFunc(day, func(a, b time.Time) int { return a.Compare(b) })
		return refuseUntil(RefuseDaily, day[len(day)-in.limits.Daily].Add(Day))
	}
	return nil
}

// refusedMaking is why the limits refuse a sailor making a race, as the
// rows read in its transaction stand: its made races in the last day and
// those it owns not over; or nil.
func refusedMaking(m store.RaceMaking, limits store.RaceSettings) error {
	if len(m.Made) >= limits.Made {
		made := slices.Clone(m.Made)
		slices.SortFunc(made, func(a, b time.Time) int { return a.Compare(b) })
		return refuseUntil(RefuseMade, made[len(made)-limits.Made].Add(Day))
	}
	if m.Owned >= limits.Owned {
		return refuse(RefuseOwned)
	}
	return nil
}

// freeArea is the first of the racing areas, by number, with no buoy race
// in busy starting within AreaApart of at; false for none.
func freeArea(areas []Area, busy []store.BuoyStart, at time.Time) (int, bool) {
	for _, a := range areas {
		free := true
		for _, b := range busy {
			if b.Area == a.Number && b.At.Sub(at).Abs() < AreaApart {
				free = false
				break
			}
		}
		if free {
			return a.Number, true
		}
	}
	return 0, false
}
