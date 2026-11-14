// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"slices"
	"strings"
	"testing"
	"time"
)

func newYork(t *testing.T) *time.Location {
	t.Helper()
	z, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	return z
}

// week is a world's week as the schedule makes it: from Sunday 6 pm to the
// next, New York time.
func week(t *testing.T) (begins, ends time.Time, zone *time.Location) {
	zone = newYork(t)
	begins = time.Date(2026, time.November, 15, 18, 0, 0, 0, zone)
	return begins, begins.AddDate(0, 0, 7), zone
}

// TestSlotsAcrossTheWeeksEnd: harbour races every three hours on the hour,
// the first after the world begins, the last three hours before it ends,
// none after: the next world has its own.
func TestSlotsAcrossTheWeeksEnd(t *testing.T) {
	begins, ends, zone := week(t)
	w := windowOf(begins, ends, 3*time.Hour)
	all := Slots(w, begins.Add(-time.Hour), ends.Add(24*time.Hour), 3, zone)
	if first := all[0].At; !first.Equal(begins.Add(3 * time.Hour)) {
		t.Errorf("the first harbour race starts %s, want 9 pm the day the world begins", first.In(zone))
	}
	if last := all[len(all)-1].At; !last.Equal(ends.Add(-3 * time.Hour)) {
		t.Errorf("the last harbour race starts %s, want 3 pm the day it ends", last.In(zone))
	}
	// Sunday 9 pm, six days of eight, and Sunday 00 to 15.
	if len(all) != 1+6*8+6 {
		t.Errorf("%d harbour races in the week", len(all))
	}
	for _, s := range all {
		if s.At.In(zone).Minute() != 0 || s.Hour%3 != 0 || s.At.In(zone).Hour() != s.Hour {
			t.Errorf("a harbour race at %s", s.At.In(zone))
		}
	}
	// Six hours ahead of 2 pm on the world's last day: only 3 pm.
	near := Slots(w, ends.Add(-4*time.Hour), ends.Add(2*time.Hour), 3, zone)
	if len(near) != 1 || near[0].Hour != 15 {
		t.Errorf("the last hours make %v", near)
	}
	// Across the week's end into the next world: nothing of this one's.
	if after := Slots(w, ends.Add(-time.Hour), ends.Add(6*time.Hour), 3, zone); len(after) != 0 {
		t.Errorf("races made after the cut-off: %v", after)
	}
	// From when the window opens, a slot exactly at its first moment counts.
	if s := Slots(Window{First: begins}, begins.Add(-time.Minute), begins, 6, zone); len(s) != 1 {
		t.Errorf("a slot at the window's first moment: %v", s)
	}
}

// TestGreenhornDays: one newcomers' race a day, half the week's at the US
// hours, each a day's own hour in the window, no hour twice while hours of
// its kind remain, the same from the same seed.
func TestGreenhornDays(t *testing.T) {
	begins, ends, zone := week(t)
	w := windowOf(begins, ends, 3*time.Hour)
	for seed := range uint64(40) {
		days := GreenhornDays(seed, w, 3, 50, zone)
		if len(days) != 8 {
			t.Fatalf("seed %d: %d days", seed, len(days))
		}
		us := 0
		used := map[int]int{}
		for _, d := range days {
			at := at(d.Day, d.Hour, zone)
			if !w.in(at) {
				t.Errorf("seed %d: the newcomers' race at %s is outside the world", seed, at.In(zone))
			}
			if usHour(d.Hour) {
				us++
			}
			used[d.Hour]++
		}
		if us != 4 {
			t.Errorf("seed %d: %d of 8 at US hours", seed, us)
		}
		// Four days of each kind and four hours of each: every hour once.
		for h, n := range used {
			if n > 1 {
				t.Errorf("seed %d: hour %d used %d times", seed, h, n)
			}
		}
		// The first day has only 9 pm in the window (6 pm is when it
		// begins): a US day.
		if days[0].Hour != 21 {
			t.Errorf("seed %d: the first day's newcomers' race at %d", seed, days[0].Hour)
		}
		if again := GreenhornDays(seed, w, 3, 50, zone); !slices.Equal(again, days) {
			t.Errorf("seed %d: another week from the same seed", seed)
		}
	}
	// The hours move from world to world.
	seen := map[string]bool{}
	for seed := range uint64(20) {
		var b strings.Builder
		for _, d := range GreenhornDays(seed, w, 3, 50, zone) {
			b.WriteByte(byte('a' + d.Hour))
		}
		seen[b.String()] = true
	}
	if len(seen) < 10 {
		t.Errorf("only %d weeks of newcomers' hours from 20 seeds", len(seen))
	}
	// All at US hours, or none but those that must be.
	for _, share := range []int{0, 100} {
		us := 0
		for _, d := range GreenhornDays(7, w, 3, share, zone) {
			if usHour(d.Hour) {
				us++
			}
		}
		want := map[int]int{0: 1, 100: 8}[share]
		if us != want {
			t.Errorf("share %d%%: %d at US hours, want %d", share, us, want)
		}
	}
}

// TestRotation: the boats in turn, moved on a day each day, so the boat of
// an hour changes from day to day; the usual boat is the commonest.
func TestRotation(t *testing.T) {
	_, _, zone := week(t)
	boats := []string{"a", "a", "b", "a", "c", "a", "a", "a"}
	if u := usual(boats); u != "a" {
		t.Errorf("usual %q", u)
	}
	day := dayOf(time.Date(2026, time.November, 17, 12, 0, 0, 0, zone), zone)
	noon := Slot{Day: day, Hour: 12}
	next := Slot{Day: day.AddDate(0, 0, 1), Hour: 12}
	var week []string
	for i := range 8 {
		week = append(week, rotation(boats, Slot{Day: day.AddDate(0, 0, i), Hour: 12}, 3))
	}
	if !slices.Contains(week, "b") || !slices.Contains(week, "c") {
		t.Errorf("noon's boats over eight days: %v", week)
	}
	if rotation(boats, noon, 3) == rotation(boats, next, 3) && rotation(boats, noon, 3) != "a" {
		t.Errorf("the same boat at noon two days running")
	}
}

func TestHourNames(t *testing.T) {
	for h, want := range map[int]string{0: "the Midnight Run", 12: "the Noon Gun", 21: "the Lantern Race", 14: "the 2 pm Harbour Race"} {
		if got := HourName(h, ""); got != want {
			t.Errorf("%d: %q", h, got)
		}
	}
	if got := HourName(12, Plural("Skiff")); got != "the Noon Gun, skiffs" {
		t.Errorf("%q", got)
	}
}

func TestSuggest(t *testing.T) {
	_, _, zone := week(t)
	tuesday := time.Date(2026, time.November, 17, 12, 0, 0, 0, zone)
	for seed := range uint64(30) {
		name := Suggest(KindRace, CourseIsland, "", "Round Gannet Holm", "Port Royal", tuesday, zone, seed)
		if !strings.HasPrefix(name, "the Gannet Holm G") {
			t.Errorf("%q", name)
		}
		buoy := Suggest(KindRace, CourseBuoy, ShapeTriangle, "", "Port Royal", tuesday, zone, seed)
		if buoy != "Tuesday Triangle" && !strings.HasPrefix(buoy, "the Port Royal ") {
			t.Errorf("%q", buoy)
		}
	}
	for course, want := range map[string]string{
		"Port Royal to Saltcliff":             "the Saltcliff Challenge",
		"The Three Sisters":                   "the Three Sisters Challenge",
		"Round the Saltcliff Light":           "the Saltcliff Light Challenge",
		"Round Tern Cay, Egg Island and Shag": "the Tern Cay Challenge",
		"Round Gannet Holm from Saltcliff":    "the Gannet Holm Challenge",
	} {
		if got := Suggest(KindTrial, CourseIsland, "", course, "Port Royal", tuesday, zone, 1); got != want {
			t.Errorf("%s: %q, want %q", course, got, want)
		}
	}
}

// TestCalendar: one event, its lines folded at 75 octets and ended CRLF,
// its text escaped.
func TestCalendar(t *testing.T) {
	start := time.Date(2026, time.November, 17, 17, 0, 0, 0, time.UTC)
	f := string(Calendar("abc@x", start, 12, "the Gannet Holm Gallop, at last; a race", strings.Repeat("Round Gannet Holm ", 8),
		"https://play.example/?r=abcdefghij", start.Add(-time.Hour)))
	for _, want := range []string{"BEGIN:VCALENDAR\r\n", "DTSTART:20261117T170000Z\r\n", "DTEND:20261117T171200Z\r\n",
		`SUMMARY:the Gannet Holm Gallop\, at last\; a race`, "TRIGGER:-PT10M", "END:VCALENDAR\r\n"} {
		if !strings.Contains(f, want) {
			t.Errorf("no %q in\n%s", want, f)
		}
	}
	for _, l := range strings.Split(strings.TrimSuffix(f, "\r\n"), "\r\n") {
		if len(l) > 75 {
			t.Errorf("a line of %d octets: %q", len(l), l)
		}
	}
}
