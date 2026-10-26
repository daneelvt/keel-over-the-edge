// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"strconv"
	"strings"
	"time"
)

// The countdown to the world's end, which the game shows at all times, by
// the world clock: over a day it reads in days and hours ("4d 6h"), on
// the last day in hours and minutes, in the last ten minutes in minutes
// and seconds, a part that is nought left out, and the end itself "0s".
// The end is told in the zone the schedule is published in: "Sunday, 6:00
// PM EDT". The page's twin is client/src/ui/countdown.ts, in English; both
// are held to testdata/countdown.json.

// SecondsFrom is the time left under which the countdown reads in minutes
// and seconds.
const SecondsFrom = 10 * time.Minute

// LastMinute is what the page announces once in the world's last minute.
const LastMinute = "The falls take this world in a minute."

// Parts are the countdown's parts, as it reads them for a time left: two
// of them, the others nought.
type Parts struct {
	Days, Hours, Minutes, Seconds int
}

// CountdownParts are the parts the countdown reads in for d left, its
// seconds rounded up.
func CountdownParts(d time.Duration) Parts {
	s := int64(0)
	if d > 0 {
		s = int64((d + time.Second - 1) / time.Second)
	}
	switch {
	case time.Duration(s)*time.Second >= 24*time.Hour:
		return Parts{Days: int(s / 86400), Hours: int(s % 86400 / 3600)}
	case time.Duration(s)*time.Second >= SecondsFrom:
		return Parts{Hours: int(s / 3600), Minutes: int(s % 3600 / 60)}
	}
	return Parts{Minutes: int(s / 60), Seconds: int(s % 60)}
}

// Countdown is d left as the countdown reads it: "4d 6h", "5h 3m", "9m
// 12s", "12s", "0s".
func Countdown(d time.Duration) string {
	p := CountdownParts(d)
	var out []string
	for _, v := range []struct {
		n    int
		unit string
	}{{p.Days, "d"}, {p.Hours, "h"}, {p.Minutes, "m"}, {p.Seconds, "s"}} {
		if v.n > 0 {
			out = append(out, strconv.Itoa(v.n)+v.unit)
		}
	}
	if len(out) == 0 {
		return "0s"
	}
	return strings.Join(out, " ")
}

// EndText is when the world ends, in a zone, as the page writes it in
// American English for a player whose own zone is the schedule's: "Sunday,
// 6:00 PM EDT". A nil zone is UTC. The zone's name is its abbreviation in
// the time zone database, which is the page's for UTC and the American
// zones; for others the page may write an offset ("GMT+1") instead.
func EndText(ends time.Time, zone *time.Location) string {
	if zone == nil {
		zone = time.UTC
	}
	return ends.In(zone).Format("Monday, 3:04 PM MST")
}
