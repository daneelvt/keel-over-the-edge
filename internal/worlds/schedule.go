// SPDX-License-Identifier: AGPL-3.0-only

// Package worlds is a world's life: the published schedule its end is set
// by, and the states it passes through. A world is next from the day before
// it begins, while it is made and checked; active while it is sailed, from
// its beginning to its end; ended after; and dropped once its partitions
// are gone. Closing, the last days of an active world, and generating, a
// next world with no terrain stored yet, are not stored: they follow from
// the clock and the rows, wherever they are needed.
package worlds

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Schedule is when worlds end: every week on a weekday at a local hour in a
// time zone, so the hour stays the same there all year and moves in UTC
// with the zone's daylight saving; or, for tests and a developer's world,
// every period counted from an anchor in UTC. Notice is how long before
// its end a world is closing; Ahead, how long before its end the next world
// is made, and the least a world lasts.
type Schedule struct {
	// Weekly: the weekday and the local time of day, in Zone.
	Weekday      time.Weekday
	Hour, Minute int
	Zone         *time.Location
	// Periodic, when Every is not zero: every Every from From.
	Every time.Duration
	From  time.Time

	Notice, Ahead time.Duration
}

// Default is the published schedule: every Sunday at 6 pm in New York,
// closing three days before, the next world made a day ahead.
const Default = "Sun 18:00 America/New_York notice=72h ahead=24h"

// weekdays are the weekdays' names a schedule may use.
var weekdays = map[string]time.Weekday{
	"sun": time.Sunday, "mon": time.Monday, "tue": time.Tuesday, "wed": time.Wednesday,
	"thu": time.Thursday, "fri": time.Friday, "sat": time.Saturday,
}

// Parse reads a schedule:
//
//	Sun 18:00 America/New_York notice=72h ahead=24h
//	every=10m from=2026-11-01T00:00:00Z notice=4m ahead=3m
//
// The zone is an IANA name, loaded from the system's or Go's embedded
// database. A weekly hour the zone ever skips or repeats in the coming year
// is refused, as time.Date would choose one of two instants for it, or
// another hour. A period must be at least twice Ahead; Notice must be
// shorter than the time between two ends; both must be positive.
func Parse(s string) (Schedule, error) {
	var sc Schedule
	fields := strings.Fields(s)
	var rest []string
	for _, f := range fields {
		k, v, ok := strings.Cut(f, "=")
		if !ok {
			rest = append(rest, f)
			continue
		}
		var err error
		switch k {
		case "notice":
			sc.Notice, err = time.ParseDuration(v)
		case "ahead":
			sc.Ahead, err = time.ParseDuration(v)
		case "every":
			sc.Every, err = time.ParseDuration(v)
		case "from":
			sc.From, err = time.Parse(time.RFC3339, v)
			sc.From = sc.From.UTC()
		default:
			return Schedule{}, fmt.Errorf("%q: unknown setting %q", s, k)
		}
		if err != nil {
			return Schedule{}, fmt.Errorf("%q: %s: %w", s, k, err)
		}
	}
	if sc.Notice <= 0 || sc.Ahead <= 0 {
		return Schedule{}, fmt.Errorf("%q: notice and ahead must both be set, and positive", s)
	}
	if sc.Every != 0 {
		if len(rest) > 0 {
			return Schedule{}, fmt.Errorf("%q: a period takes no weekday, hour or zone", s)
		}
		if sc.From.IsZero() {
			return Schedule{}, fmt.Errorf("%q: a period needs from, its anchor in UTC", s)
		}
		if sc.Every < 2*sc.Ahead {
			return Schedule{}, fmt.Errorf("%q: every must be at least twice ahead", s)
		}
		if sc.Notice >= sc.Every {
			return Schedule{}, fmt.Errorf("%q: notice must be shorter than every", s)
		}
		return sc, nil
	}
	if len(rest) != 3 || !sc.From.IsZero() {
		return Schedule{}, fmt.Errorf("%q: want a weekday, a local time and a zone (Sun 18:00 America/New_York), or every= and from=", s)
	}
	wd, ok := weekdays[strings.ToLower(rest[0])]
	if !ok {
		return Schedule{}, fmt.Errorf("%q: %q is not a weekday (Sun, Mon, … Sat)", s, rest[0])
	}
	hh, mm, ok := strings.Cut(rest[1], ":")
	h, err1 := strconv.Atoi(hh)
	m, err2 := strconv.Atoi(mm)
	if !ok || err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 || len(mm) != 2 {
		return Schedule{}, fmt.Errorf("%q: %q is not a time of day, HH:MM", s, rest[1])
	}
	zone, err := time.LoadLocation(rest[2])
	if err != nil {
		return Schedule{}, fmt.Errorf("%q: the zone: %w", s, err)
	}
	sc.Weekday, sc.Hour, sc.Minute, sc.Zone = wd, h, m, zone
	if sc.Notice >= week || sc.Ahead > week/2 {
		return Schedule{}, fmt.Errorf("%q: notice must be shorter than a week, and ahead at most half of one", s)
	}
	if err := sc.checkHour(time.Now()); err != nil {
		return Schedule{}, fmt.Errorf("%q: %w", s, err)
	}
	return sc, nil
}

const week = 7 * 24 * time.Hour

// ErrAmbiguous is a weekly hour that the zone skips or repeats.
var ErrAmbiguous = errors.New("the hour is skipped or repeated in the zone when its clocks change")

// checkHour refuses a weekly hour the zone skips or repeats on any of the
// schedule's days in the year from now: a zone's clocks change by at most
// two hours, so an instant within two hours either side reading the same
// wall time is a repeat, and time.Date's answer reading another wall time
// is a skip.
func (sc Schedule) checkHour(now time.Time) error {
	day := now.In(sc.Zone)
	for range 371 {
		y, mo, d := day.Date()
		day = time.Date(y, mo, d+1, 12, 0, 0, 0, sc.Zone)
		if day.Weekday() != sc.Weekday {
			continue
		}
		y, mo, d = day.Date()
		t := time.Date(y, mo, d, sc.Hour, sc.Minute, 0, 0, sc.Zone)
		if !sameWall(t, y, mo, d, sc.Hour, sc.Minute) {
			return fmt.Errorf("%w: %04d-%02d-%02d", ErrAmbiguous, y, mo, d)
		}
		for _, off := range []time.Duration{-2 * time.Hour, -time.Hour, -30 * time.Minute, 30 * time.Minute, time.Hour, 2 * time.Hour} {
			if sameWall(t.Add(off), y, mo, d, sc.Hour, sc.Minute) {
				return fmt.Errorf("%w: %04d-%02d-%02d", ErrAmbiguous, y, mo, d)
			}
		}
	}
	return nil
}

// sameWall reports whether t reads the wall time given in its location.
func sameWall(t time.Time, y int, mo time.Month, d, h, m int) bool {
	ty, tmo, td := t.Date()
	return ty == y && tmo == mo && td == d && t.Hour() == h && t.Minute() == m
}

// Next is the schedule's first end after t, in UTC.
func (sc Schedule) Next(t time.Time) time.Time {
	if sc.Every != 0 {
		n := t.Sub(sc.From) / sc.Every
		end := sc.From.Add(n * sc.Every)
		for !end.After(t) {
			end = end.Add(sc.Every)
		}
		for end.Add(-sc.Every).After(t) {
			end = end.Add(-sc.Every)
		}
		return end.UTC()
	}
	local := t.In(sc.Zone)
	y, mo, d := local.Date()
	for i := 0; ; i++ {
		day := time.Date(y, mo, d+i, 12, 0, 0, 0, sc.Zone)
		if day.Weekday() != sc.Weekday {
			continue
		}
		dy, dmo, dd := day.Date()
		end := time.Date(dy, dmo, dd, sc.Hour, sc.Minute, 0, 0, sc.Zone)
		if end.After(t) {
			return end.UTC()
		}
	}
}

// EndOf is the end of a world that begins at begins: the schedule's first
// end at least Ahead after it, so a world begun late, or by hand, lasts
// until the published end after next rather than ending before anyone has
// seen it, and its successor can be made ahead.
func (sc Schedule) EndOf(begins time.Time) time.Time {
	return sc.Next(begins.Add(sc.Ahead - time.Nanosecond))
}

// Closing reports whether a world that ends at end is closing at t: in its
// last Notice.
func (sc Schedule) Closing(end, t time.Time) bool {
	return !t.Before(end.Add(-sc.Notice))
}

// String writes the schedule as Parse reads it.
func (sc Schedule) String() string {
	if sc.Zone == nil && sc.Every == 0 {
		return ""
	}
	if sc.Every != 0 {
		return fmt.Sprintf("every=%v from=%s notice=%v ahead=%v", sc.Every, sc.From.Format(time.RFC3339), sc.Notice, sc.Ahead)
	}
	return fmt.Sprintf("%s %02d:%02d %s notice=%v ahead=%v", sc.Weekday.String()[:3], sc.Hour, sc.Minute, sc.Zone, sc.Notice, sc.Ahead)
}
