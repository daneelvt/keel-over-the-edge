// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A week made by the first version, stored, is read and sailed as it was
// made: its keyframes are its records' own.
func TestFirstVersionSailedAsMade(t *testing.T) {
	_, tl := load(t)
	cfg := *tl.Config()
	cfg.Week.Wobble = 0.4 * nauticalMile
	cfg.Week.WobblePeriod = [2]int64{20 * ticksPerMinute, 60 * ticksPerMinute}
	w := Generate(&cfg, 5, SampleEpoch, SampleEpoch+SampleWeek, testIslands)
	w.Version = 1
	data, digest, err := w.Encode()
	if err != nil {
		t.Fatal(err)
	}
	r, err := Decode(data, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	wt, err := New(tl.Config(), r)
	if err != nil {
		t.Fatal(err)
	}
	if r.Version != 1 {
		t.Errorf("read back as version %d", r.Version)
	}
	checked := 0
	for i := range r.Systems {
		s := &r.Systems[i]
		at := int64(s.Born+s.Gone) / 2
		var k physics.Keyframe
		wt.Keyframe(at, nil, &k)
		if k.Systems[s.Slot] != physics.SystemAt(&w.Systems[i].SystemRecord, float64(at)) {
			t.Fatalf("system %d is not sailed as made", i)
		}
		checked++
	}
	if checked == 0 {
		t.Fatal("no systems")
	}
}

// A forecast is a function of its issue: made twice it is the same, and a
// restart, a timeline made again from the same week, issues the same.
func TestForecastIsAFunctionOfItsIssue(t *testing.T) {
	_, tl := load(t)
	w := tl.Week()
	again, err := New(tl.Config(), w)
	if err != nil {
		t.Fatal(err)
	}
	var a, b physics.Forecast
	for issue := int64(0); issue < 2*24*hourTicks; issue += 7 * tl.Prepared().ForecastEvery() {
		tl.Forecast(issue, nil, nil, 0, &a)
		again.Forecast(issue, nil, nil, 0, &b)
		if a != b {
			t.Fatalf("issue %d: the forecast differs", issue)
		}
	}
}

// The forecast is the truth: at every minute of its reach, the keyframe
// it makes is the timeline's own, bit for bit, every system on it, those
// born after the issue from their births.
func TestForecastIsTheWeek(t *testing.T) {
	_, tl := load(t)
	w := tl.Week()
	p := tl.Prepared()
	var f physics.Forecast
	var got, want physics.Keyframe
	issues, later := 0, 0
	for issue := int64(2 * hourTicks); issue < w.Until-p.ForecastReach(); issue += 37 * p.ForecastEvery() {
		tl.Forecast(int64(issue), nil, nil, 0, &f)
		issues++
		for at := int64(issue); at <= int64(f.Head.Until); at += 60 * physics.StepsPerSecond {
			physics.ForecastKeyframe(&f, float64(at), &got)
			tl.Keyframe(at, nil, &want)
			if got != want {
				t.Fatalf("issue %d, %d minutes on: the forecast's keyframe is not the truth's", issue, (at-int64(issue))/(60*physics.StepsPerSecond))
			}
		}
		for i := range int(f.Head.NSystems) {
			if r := &f.Systems[i]; r.Born >= float64(issue)+40*60*physics.StepsPerSecond {
				later++
			}
		}
	}
	if later == 0 {
		t.Errorf("over %d issues no system born 40 minutes or more after one", issues)
	}
}

// The world's end: no step after it.
func TestForecastStopsAtTheEnd(t *testing.T) {
	_, tl := load(t)
	p := tl.Prepared()
	var f physics.Forecast
	issue := 30 * hourTicks
	tl.Forecast(int64(issue), nil, nil, int64(issue)+35*60*physics.StepsPerSecond, &f)
	if f.Head.Steps != 4 {
		t.Errorf("%v steps to an end 35 minutes on, want 4 (0, 10, 20 and 30 minutes)", f.Head.Steps)
	}
	tl.Forecast(int64(issue), nil, nil, 0, &f)
	if f.Head.Steps != float64(p.ForecastSteps()) {
		t.Errorf("%v steps with no end", f.Head.Steps)
	}
}

// A developer's system placed is forecast in its slot, by its plan.
func TestForecastsADevelopersSystem(t *testing.T) {
	_, tl := load(t)
	const tick = 10 * hourTicks
	ss := tl.Place(nil, bus.Weather{Mode: bus.WeatherSystem, Kind: uint16(kindIndex(t, tl, "squall")), East: 1000, North: -500, In: 120 * physics.StepsPerSecond}, tick, nil)
	var f physics.Forecast
	issue := tl.IssueAt(tick + 600*physics.StepsPerSecond)
	tl.Forecast(issue, nil, ss, 0, &f)
	found := false
	for i := range int(f.Head.NSystems) {
		if f.Head.Slots[i] == weekSlots {
			found = true
			if r := tl.DeveloperRecord(ss[0]); f.Systems[i].Kind != r.Kind || f.Systems[i].Born != r.Born {
				t.Errorf("the developer's squall is forecast from %+v, its record %+v", f.Systems[i], r)
			}
		}
	}
	if !found {
		t.Error("the developer's squall is not forecast")
	}
	var got, want physics.Keyframe
	for at := issue; at <= int64(f.Head.Until); at += 60 * physics.StepsPerSecond {
		physics.ForecastKeyframe(&f, float64(at), &got)
		tl.Keyframe(at, ss, &want)
		if got.Systems[weekSlots] != want.Systems[weekSlots] {
			t.Errorf("%d minutes on, the developer's squall is not the truth's", (at-issue)/(60*physics.StepsPerSecond))
		}
	}
}

func kindIndex(t *testing.T, tl *Timeline, shape string) int {
	t.Helper()
	for i, k := range tl.Config().Kinds {
		if k.Shape == physics.ShapeDome && k.Track == trackWind && shape == "squall" {
			return i
		}
	}
	t.Fatalf("no %s", shape)
	return 0
}
