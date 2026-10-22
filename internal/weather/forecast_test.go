// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The week's second version slows its systems' wobble and nothing else:
// made with the first version's wobble, a seed's spells and every other
// draw of its systems are the same.
func TestWobbleOnlyChangesTheWobble(t *testing.T) {
	_, tl := load(t)
	cfg := *tl.Config()
	old := cfg
	old.Week.Wobble = 0.4 * nauticalMile
	old.Week.WobblePeriod = [2]int64{20 * ticksPerMinute, 60 * ticksPerMinute}
	a := Generate(&cfg, 3, SampleEpoch, SampleEpoch+SampleWeek, testIslands)
	b := Generate(&old, 3, SampleEpoch, SampleEpoch+SampleWeek, testIslands)
	if len(a.Spells) != len(b.Spells) || len(a.Systems) != len(b.Systems) {
		t.Fatalf("%d spells and %d systems, with the old wobble %d and %d", len(a.Spells), len(a.Systems), len(b.Spells), len(b.Systems))
	}
	for i := range a.Spells {
		if a.Spells[i] != b.Spells[i] {
			t.Errorf("spell %d differs", i)
		}
	}
	for i := range a.Systems {
		x, y := a.Systems[i], b.Systems[i]
		x.Wobble, x.WobblePeriod, x.ThrobPeriod = 0, [2]float64{}, 0
		y.Wobble, y.WobblePeriod, y.ThrobPeriod = 0, [2]float64{}, 0
		if x != y {
			t.Errorf("system %d differs beyond its wobble", i)
		}
	}
}

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

// Nothing of the future but the forecast: a forecast's systems are those
// alive at the issue and the lows forming, the rest of the week's
// systems, born after the issue, are not in it.
func TestForecastKnowsNoMore(t *testing.T) {
	_, tl := load(t)
	w := tl.Week()
	p := tl.Prepared()
	var f physics.Forecast
	issues, forming := 0, 0
	for issue := int64(0); issue < w.Until-p.ForecastHorizon(); issue += p.ForecastEvery() {
		tl.Forecast(issue, nil, nil, 0, &f)
		issues++
		for i := range int(f.Head.NSystems) {
			s := &f.Systems[i]
			r := recordOf(w, s, issue)
			if r == nil {
				t.Fatalf("issue %d: a system of no record", issue)
			}
			if r.Born > float64(issue) {
				forming++
				if s.Forming == 0 || tl.Config().Kinds[int(r.Kind)].Shape != physics.ShapeLow || s.Seed != 0 {
					t.Errorf("issue %d: a system born after it, not a low forming without its seed", issue)
				}
			}
		}
	}
	if forming == 0 {
		t.Errorf("over %d issues no low forming", issues)
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
		if s := &f.Systems[i]; s.Slot == weekSlots {
			found = true
			r := tl.DeveloperRecord(ss[0])
			e, n := physics.SystemTrack(&r, float64(issue))
			if math.Hypot(s.East[0]-e, s.North[0]-n) > 1 {
				t.Errorf("the developer's squall at (%v, %v), its record at (%v, %v)", s.East[0], s.North[0], e, n)
			}
		}
	}
	if !found {
		t.Error("the developer's squall is not forecast")
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
