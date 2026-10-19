// SPDX-License-Identifier: AGPL-3.0-only

package worlds

import (
	"errors"
	"testing"
	"time"
)

func mustParse(t *testing.T, s string) Schedule {
	t.Helper()
	sc, err := Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return sc
}

func utc(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t.UTC()
}

func TestParse(t *testing.T) {
	sc := mustParse(t, Default)
	if sc.Weekday != time.Sunday || sc.Hour != 18 || sc.Minute != 0 || sc.Zone.String() != "America/New_York" ||
		sc.Notice != 72*time.Hour || sc.Ahead != 24*time.Hour {
		t.Errorf("%+v", sc)
	}
	if got := sc.String(); got != "Sun 18:00 America/New_York notice=72h0m0s ahead=24h0m0s" {
		t.Errorf("String() = %q", got)
	}
	again := mustParse(t, sc.String())
	if again.String() != sc.String() {
		t.Errorf("%q read back as %q", sc.String(), again.String())
	}
	p := mustParse(t, "every=10m from=2026-11-01T00:00:00Z notice=4m ahead=3m")
	if p.Every != 10*time.Minute || !p.From.Equal(utc("2026-11-01T00:00:00Z")) || p.Notice != 4*time.Minute || p.Ahead != 3*time.Minute {
		t.Errorf("%+v", p)
	}
	for _, bad := range []string{
		"",
		"Sun 18:00 America/New_York", // no notice or ahead
		"Sun 18:00 Atlantis/Lemuria notice=72h ahead=24h",         // no such zone
		"Sun 2:30 America/New_York notice=72h ahead=24h",          // not HH:MM
		"Sun 02:30 America/New_York notice=72h ahead=24h",         // skipped in March
		"Sun 01:30 America/New_York notice=72h ahead=24h",         // repeated in November
		"Sunday 18:00 UTC notice=72h ahead=24h",                   // not a weekday's short name
		"Sun 24:00 UTC notice=72h ahead=24h",                      // not an hour
		"Sun 18:00 UTC notice=168h ahead=24h",                     // notice a week
		"Sun 18:00 UTC notice=0s ahead=24h",                       // no notice
		"Sun 18:00 UTC notice=72h ahead=24h colour=blue",          // unknown setting
		"every=10m notice=4m ahead=3m",                            // no anchor
		"every=5m from=2026-11-01T00:00:00Z notice=4m ahead=3m",   // under twice ahead
		"every=10m from=2026-11-01T00:00:00Z notice=10m ahead=3m", // notice the whole period
		"every=10m from=2026-11-01T00:00:00Z notice=4m ahead=3m Sun",
		"Sun 18:00 UTC from=2026-11-01T00:00:00Z notice=4m ahead=3m",
	} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
	if _, err := Parse("Sun 02:30 America/New_York notice=72h ahead=24h"); !errors.Is(err, ErrAmbiguous) {
		t.Errorf("a skipped hour: %v", err)
	}
	// The zones in use: an hour no clock change touches is fine.
	for _, ok := range []string{"Sun 18:00 UTC notice=72h ahead=24h", "Mon 03:00 Pacific/Auckland notice=1h ahead=1h", "Sat 06:00 Europe/London notice=1h ahead=1h"} {
		if _, err := Parse(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
}

func TestNextWeekly(t *testing.T) {
	sc := mustParse(t, Default)
	for _, c := range []struct{ after, want string }{
		// US summer time: 18:00 EDT is 22:00 UTC.
		{"2026-10-20T12:00:00Z", "2026-10-25T22:00:00Z"},
		// On the end itself, and either side of it.
		{"2026-10-25T21:59:59Z", "2026-10-25T22:00:00Z"},
		{"2026-10-25T22:00:00Z", "2026-11-01T23:00:00Z"},
		// November: the clocks go back at 02:00 on 1 November; that
		// Sunday's 18:00 is EST, 23:00 UTC, and so is the next.
		{"2026-10-31T12:00:00Z", "2026-11-01T23:00:00Z"},
		{"2026-11-01T23:00:00Z", "2026-11-08T23:00:00Z"},
		// March: the clocks go forward at 02:00 on 8 March 2026; the week
		// before ends at 23:00 UTC, that Sunday at 22:00 UTC.
		{"2026-03-01T23:00:00Z", "2026-03-08T22:00:00Z"},
		{"2026-02-28T12:00:00Z", "2026-03-01T23:00:00Z"},
		{"2026-03-08T22:00:00Z", "2026-03-15T22:00:00Z"},
		// 2027: forward on 14 March, back on 7 November.
		{"2027-03-08T00:00:00Z", "2027-03-14T22:00:00Z"},
		{"2027-11-01T00:00:00Z", "2027-11-07T23:00:00Z"},
	} {
		got := sc.Next(utc(c.after))
		if !got.Equal(utc(c.want)) {
			t.Errorf("after %s: %s, want %s", c.after, got.Format(time.RFC3339), c.want)
		}
		if l := got.In(sc.Zone); l.Weekday() != time.Sunday || l.Hour() != 18 || l.Minute() != 0 {
			t.Errorf("after %s: %s in New York", c.after, l)
		}
	}
}

func TestNextPeriodic(t *testing.T) {
	sc := mustParse(t, "every=10m from=2026-11-01T00:00:00Z notice=4m ahead=3m")
	for _, c := range []struct{ after, want string }{
		{"2026-11-01T00:00:00Z", "2026-11-01T00:10:00Z"},
		{"2026-11-01T00:09:59Z", "2026-11-01T00:10:00Z"},
		{"2026-11-01T00:10:00Z", "2026-11-01T00:20:00Z"},
		{"2026-10-31T23:55:00Z", "2026-11-01T00:00:00Z"},
		{"2026-10-31T23:40:00Z", "2026-10-31T23:50:00Z"},
		{"2026-11-08T12:34:56Z", "2026-11-08T12:40:00Z"},
	} {
		if got := sc.Next(utc(c.after)); !got.Equal(utc(c.want)) {
			t.Errorf("after %s: %s, want %s", c.after, got.Format(time.RFC3339), c.want)
		}
	}
}

func TestEndOf(t *testing.T) {
	sc := mustParse(t, Default)
	for _, c := range []struct{ begins, want string }{
		// A world begun at an end lasts the week.
		{"2026-10-25T22:00:00Z", "2026-11-01T23:00:00Z"},
		// Begun an hour before Sunday's end: the next Sunday's.
		{"2026-10-25T21:00:00Z", "2026-11-01T23:00:00Z"},
		// Begun a day and a minute before: this Sunday's.
		{"2026-10-24T21:59:00Z", "2026-10-25T22:00:00Z"},
		// Begun on a Tuesday, late: this Sunday's.
		{"2026-10-20T08:00:00Z", "2026-10-25T22:00:00Z"},
	} {
		if got := sc.EndOf(utc(c.begins)); !got.Equal(utc(c.want)) {
			t.Errorf("begun %s: ends %s, want %s", c.begins, got.Format(time.RFC3339), c.want)
		}
	}
	p := mustParse(t, "every=10m from=2026-11-01T00:00:00Z notice=4m ahead=3m")
	if got := p.EndOf(utc("2026-11-01T00:10:00Z")); !got.Equal(utc("2026-11-01T00:20:00Z")) {
		t.Errorf("periodic: %s", got)
	}
	if got := p.EndOf(utc("2026-11-01T00:18:00Z")); !got.Equal(utc("2026-11-01T00:30:00Z")) {
		t.Errorf("periodic, begun late: %s", got)
	}
}

func TestClosing(t *testing.T) {
	sc := mustParse(t, Default)
	end := utc("2026-11-01T23:00:00Z")
	for at, want := range map[string]bool{
		"2026-10-29T22:59:59Z": false,
		"2026-10-29T23:00:00Z": true, // Thursday 7 pm EDT: three days before
		"2026-11-01T22:59:59Z": true,
	} {
		if got := sc.Closing(end, utc(at)); got != want {
			t.Errorf("%s: closing %v", at, got)
		}
	}
}
