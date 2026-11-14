// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"math/rand/v2"
	"slices"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The harbour races' timetable: a race off Port Royal every few hours on
// the hour in the world's schedule's zone (every three by default: 00, 03
// … 21), from just after a world begins to the last start before its end,
// in a fixed rotation of boats moved on by a day each day, so every hour
// has its turn of each. Once a day one of them is for newcomers, the
// Greenhorn Cup, at an hour that moves from day to day: set from the
// world's seed as it begins, a share of the week's (half by default) at
// the hours that suit the US (noon and after), the rest at the others, no
// hour twice in a week while hours of its kind are left.

// usHour reports whether an hour of the day suits the US: noon or later
// in the schedule's zone, which is the US's own.
func usHour(h int) bool { return h >= 12 }

// rotationEpoch is the day the boats' rotation counts days from.
var rotationEpoch = time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)

// dayOf is the date of t in zone, at midnight UTC.
func dayOf(t time.Time, zone *time.Location) time.Time {
	y, m, d := t.In(zone).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// at is the time of an hour of a day (a date at midnight UTC) in zone.
func at(day time.Time, hour int, zone *time.Location) time.Time {
	return time.Date(day.Year(), day.Month(), day.Day(), hour, 0, 0, 0, zone)
}

// Window is a world's time for harbour races: the first start may be at
// or after First, the last at or before Last.
type Window struct {
	First, Last time.Time
}

// windowOf is the harbour races' window of a world beginning at begins
// and ending at ends, cutoff before which no race starts.
func windowOf(begins, ends time.Time, cutoff time.Duration) Window {
	w := Window{First: begins.Add(HarbourAfter)}
	if !ends.IsZero() {
		w.Last = ends.Add(-cutoff)
	}
	return w
}

// in reports whether t is in the window.
func (w Window) in(t time.Time) bool {
	return !t.Before(w.First) && (w.Last.IsZero() || !t.After(w.Last))
}

// Slot is a harbour race's time: its start, the date it falls on and its
// hour in the zone.
type Slot struct {
	At   time.Time
	Day  time.Time
	Hour int
}

// Slots are the harbour races' times in the window from after from to
// until, every every hours on the hour in zone.
func Slots(w Window, from, until time.Time, every int, zone *time.Location) []Slot {
	if every <= 0 {
		return nil
	}
	var out []Slot
	for day := dayOf(from, zone); !day.After(dayOf(until, zone)); day = day.AddDate(0, 0, 1) {
		for h := 0; h < 24; h += every {
			t := at(day, h, zone)
			if t.After(from) && !t.After(until) && w.in(t) {
				out = append(out, Slot{At: t, Day: day, Hour: h})
			}
		}
	}
	return out
}

// GreenhornDays sets each day of a world's window its newcomers' hour,
// from the world's seed: usShare percent of the days at hours that suit
// the US, the rest at the others, each day's hour one of its own in the
// window, no hour twice while hours of its kind are left. A day whose
// hours in the window are all of one kind takes that kind.
func GreenhornDays(seed uint64, w Window, every int, usShare int, zone *time.Location) []store.HarbourDay {
	if every <= 0 || w.Last.IsZero() {
		return nil
	}
	type day struct {
		date      time.Time
		us, other []int
		isUS      bool
	}
	var days []*day
	for d := dayOf(w.First, zone); !d.After(dayOf(w.Last, zone)); d = d.AddDate(0, 0, 1) {
		x := &day{date: d}
		for h := 0; h < 24; h += every {
			if !w.in(at(d, h, zone)) {
				continue
			}
			if usHour(h) {
				x.us = append(x.us, h)
			} else {
				x.other = append(x.other, h)
			}
		}
		if len(x.us)+len(x.other) > 0 {
			days = append(days, x)
		}
	}
	if len(days) == 0 {
		return nil
	}
	rnd := rand.New(rand.NewPCG(seed, 0x677265656e))
	wantUS := (len(days)*usShare + 50) / 100
	// The days that can only be of one kind take it; the rest, in an order
	// drawn from the seed, are the US's until the share is reached.
	var free []*day
	us := 0
	for _, d := range days {
		switch {
		case len(d.other) == 0:
			d.isUS = true
			us++
		case len(d.us) == 0:
		default:
			free = append(free, d)
		}
	}
	rnd.Shuffle(len(free), func(i, j int) { free[i], free[j] = free[j], free[i] })
	for _, d := range free {
		if us < wantUS {
			d.isUS = true
			us++
		}
	}
	// Hours: the days with fewest hours of their kind choose first, each
	// the hour of its kind used least so far, ties drawn from the seed.
	order := slices.Clone(days)
	hoursOf := func(d *day) []int {
		if d.isUS {
			return d.us
		}
		return d.other
	}
	slices.SortStableFunc(order, func(a, b *day) int { return len(hoursOf(a)) - len(hoursOf(b)) })
	used := map[int]int{}
	hour := map[*day]int{}
	for _, d := range order {
		hours := hoursOf(d)
		least := -1
		var best []int
		for _, h := range hours {
			switch n := used[h]; {
			case least < 0 || n < least:
				least, best = n, []int{h}
			case n == least:
				best = append(best, h)
			}
		}
		h := best[rnd.IntN(len(best))]
		used[h]++
		hour[d] = h
	}
	out := make([]store.HarbourDay, len(days))
	for i, d := range days {
		out[i] = store.HarbourDay{Day: d.date, Hour: hour[d]}
	}
	return out
}

// rotation is the boat of the rotation for a slot: the slot's place in
// its day moved on by the day's number since the epoch.
func rotation(boats []string, s Slot, every int) string {
	if len(boats) == 0 {
		return ""
	}
	days := int(s.Day.Sub(rotationEpoch) / (24 * time.Hour))
	i := (s.Hour/every + days) % len(boats)
	if i < 0 {
		i += len(boats)
	}
	return boats[i]
}

// usual is the rotation's usual boat, the one most often in it (the first
// of those as often): the Greenhorn Cup's, and the one whose races go
// without their boats in their names.
func usual(boats []string) string {
	best, most := "", 0
	n := map[string]int{}
	for _, b := range boats {
		n[b]++
		if n[b] > most {
			best, most = b, n[b]
		}
	}
	return best
}
