// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"testing"
	"time"
	// The zones the ends are told in, wherever the tests run.
	_ "time/tzdata"
)

// countdownFile holds the cases the countdown and the page's are held to.
const countdownFile = "testdata/countdown.json"

type countdownData struct {
	Comment string          `json:"comment"`
	Left    []countdownLeft `json:"left"`
	Ends    []countdownEnd  `json:"ends"`
}

// countdownLeft is a time left, ms, and the countdown's words for it.
type countdownLeft struct {
	Ms   int64  `json:"ms"`
	Text string `json:"text"`
}

// countdownEnd is an end, ms of UTC since 1970, the schedule's zone ("" for
// UTC), and the end as written in it.
type countdownEnd struct {
	Ends int64  `json:"ends"`
	Zone string `json:"zone"`
	Text string `json:"text"`
}

func (c countdownEnd) text(t *testing.T) string {
	zone := time.UTC
	if c.Zone != "" {
		z, err := time.LoadLocation(c.Zone)
		if err != nil {
			t.Fatal(err)
		}
		zone = z
	}
	return EndText(time.UnixMilli(c.Ends), zone)
}

func countdownCases(t *testing.T) countdownData {
	const (
		s = int64(1000)
		m = 60 * s
		h = 60 * m
		d = 24 * h
	)
	var out countdownData
	for _, ms := range []int64{
		-5 * s, 0, 1, 999, s, s + 1, 12 * s, m - 1, m, m + s, 9*m + 12*s, 10*m - 1, 10 * m, 10*m + 1,
		h - 1, h, 5*h + 3*m, 5*h + 3*m + 59*s, d - 1, d, d + 1, d + 59*m, 4*d + 6*h, 4*d + 5*m, 6*d + 23*h + 59*m + 59*s, 30 * d,
	} {
		out.Left = append(out.Left, countdownLeft{Ms: ms, Text: Countdown(time.Duration(ms) * time.Millisecond)})
	}
	for _, c := range []countdownEnd{
		{Ends: time.Date(2026, 10, 25, 22, 0, 0, 0, time.UTC).UnixMilli(), Zone: "America/New_York"},
		{Ends: time.Date(2026, 12, 20, 23, 0, 0, 0, time.UTC).UnixMilli(), Zone: "America/New_York"},
		{Ends: time.Date(2026, 7, 5, 4, 0, 0, 0, time.UTC).UnixMilli(), Zone: "America/New_York"},
		{Ends: time.Date(2026, 7, 5, 16, 30, 0, 0, time.UTC).UnixMilli(), Zone: "America/New_York"},
		{Ends: time.Date(2026, 3, 8, 22, 5, 0, 0, time.UTC).UnixMilli(), Zone: "America/Los_Angeles"},
		{Ends: time.Date(2026, 10, 25, 22, 0, 0, 0, time.UTC).UnixMilli(), Zone: ""},
		{Ends: time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC).UnixMilli(), Zone: "UTC"},
	} {
		c.Text = c.text(t)
		out.Ends = append(out.Ends, c)
	}
	return out
}

// The countdown's own words at the cases a sailor reads most.
func TestCountdownWords(t *testing.T) {
	for _, c := range []struct {
		d    time.Duration
		want string
	}{
		{4*24*time.Hour + 6*time.Hour, "4d 6h"},
		{5*time.Hour + 3*time.Minute, "5h 3m"},
		{9*time.Minute + 12*time.Second, "9m 12s"},
		{12 * time.Second, "12s"},
		{0, "0s"},
		// A part of a second left is a second.
		{time.Millisecond, "1s"},
		{24 * time.Hour, "1d"},
	} {
		if got := Countdown(c.d); got != c.want {
			t.Errorf("%v: %q, want %q", c.d, got, c.want)
		}
	}
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	if got := EndText(time.Date(2026, 10, 25, 22, 0, 0, 0, time.UTC), ny); got != "Sunday, 6:00 PM EDT" {
		t.Errorf("the week's end: %q", got)
	}
}

func TestCountdownFile(t *testing.T) {
	got := countdownCases(t)
	got.Comment = "Written by go test ./internal/lookout -run CountdownFile -update: times left, ms, and the countdown's words for them; ends, ms of UTC, in a schedule's zone (\"\" for UTC), as written in American English in that zone."
	caseFile(t, countdownFile, got, func(t *testing.T, want countdownData) {
		for _, c := range want.Left {
			if s := Countdown(time.Duration(c.Ms) * time.Millisecond); s != c.Text {
				t.Errorf("%d ms: %q, countdown.json %q", c.Ms, s, c.Text)
			}
		}
		for _, c := range want.Ends {
			if s := c.text(t); s != c.Text {
				t.Errorf("%+v: %q", c, s)
			}
		}
	})
}
