// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// TestForecastTool: at a busy minute of the sample week, with a squall line
// and a low on the disk, forecast lists every system alive and born within
// the horizon by its kind's name, its wind now, where it is from the boat
// and where it will truly be in 30, 60 and 90 minutes, as the week's own
// keyframes put it; and each front, warm or cold, and when it reaches the
// boat. No cone and no forming low: the forecast is the truth. It stays
// within a few thousand tokens.
func TestForecastTool(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	cfg := tl.Config()
	isLine := func(k physics.System) bool { return cfg.Kinds[int(k.Kind)].Shape == physics.ShapeLine && k.Length > 0 }
	isLow := func(k physics.System) bool {
		return cfg.Kinds[int(k.Kind)].Shape == physics.ShapeLow && int(k.Kind) != cfg.Week.Storms
	}
	// The first minute after the opening with a squall line and a low on
	// the disk, and a front crossing it.
	minute := int64(60 * physics.StepsPerSecond)
	edge := tl.Prepared().Edge()
	var tick int64
	var line, low physics.System
	for at := cfg.Week.Opening + tl.Origin(); at < 5*24*60*minute && tick == 0; at += minute {
		var k physics.Keyframe
		tl.Keyframe(at, nil, &k)
		var gotLine, gotLow bool
		for _, s := range k.Systems {
			if s.On == 0 || !weather.OnDisk(&s, edge) {
				continue
			}
			if isLine(s) && cat.Weather.Systems[int(s.Kind)].Lightning != nil && !gotLine {
				line, gotLine = s, true
			}
			if isLow(s) && !gotLow {
				low, gotLow = s, true
			}
		}
		if gotLine && gotLow && len(tl.SpellsOver(at, at, nil)) > 0 && frontCrossing(tl, at) {
			tick = at
		}
	}
	if tick == 0 {
		t.Fatal("no minute in five days with a squall line, a low and a front on the disk")
	}
	_, kinds := cat.Prepare()
	w, err := sim.New(sim.Config{Capacity: 4, Kinds: kinds, Workers: 1, Tick: tick, Weather: tl, Encounters: cat.PrepareEncounters()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	w.Tick()
	is := forecast.New(forecast.Config{Timeline: tl})
	is.Update(context.Background(), tick, nil, nil)
	s := &Sea{Number: 1, Bus: w.Bus(), Timeline: tl, Forecast: is, Words: weather.WordsOf(cat), Catalog: cat, Start: "Port Royal"}
	for _, k := range cat.Weather.Systems {
		s.SystemKinds = append(s.SystemKinds, k.Name)
	}
	f := w.Bus().Frames.Acquire()
	defer f.Release()
	x, y := 500.0, -1200.0
	text, r := forecastWords(s, f, &forecastArgs{}, x, y, true)
	if r != nil {
		t.Fatal(r)
	}
	t.Logf("at tick %d:\n%s", f.Tick, text)
	golden(t, "forecast", text)
	if n := estimateTokens(text); n > 3000 {
		t.Errorf("the forecast is about %d tokens", n)
	}
	for _, no := range []string{"within", "forming", "cone"} {
		if strings.Contains(text, no) {
			t.Errorf("the forecast says %q", no)
		}
	}
	if !strings.Contains(text, "front from the") {
		t.Error("no front")
	}
	// The squall line's and the low's lines, each with where it will be.
	for _, sys := range []physics.System{line, low} {
		name := cat.Weather.Systems[int(sys.Kind)].Name
		var got string
		for _, l := range strings.Split(text, "\n") {
			if strings.HasPrefix(l, " "+name+" ") || strings.HasPrefix(l, " "+name+",") {
				if strings.Contains(l, chart.Format(sys.East/4, sys.North/4)) {
					got = l
				}
			}
		}
		if got == "" {
			t.Fatalf("no %s at %s", name, chart.Format(sys.East/4, sys.North/4))
		}
		for _, m := range forecastAhead {
			var k physics.Keyframe
			tl.Keyframe(f.Tick+m*minute, nil, &k)
			var truth *physics.System
			for i := range k.Systems {
				if k.Systems[i].On != 0 && k.Systems[i].Seed == sys.Seed && k.Systems[i].Kind == sys.Kind {
					truth = &k.Systems[i]
				}
			}
			if truth == nil {
				if !strings.Contains(got, "gone by then") {
					t.Fatalf("the %s is gone %d minutes on, but not said so: %s", name, m, got)
				}
				break
			}
			dx, dy := truth.East/4-x, truth.North/4-y
			want := fmt.Sprintf(" · %d min: %s %s", m, chart.BearingText(physics.Atan2(dx, dy)), chart.DistanceText(math.Sqrt(dx*dx+dy*dy)))
			if !strings.Contains(got, want) {
				t.Fatalf("the %s %d minutes on is at %s: %s", name, m, want, got)
			}
		}
		if !strings.Contains(got, " kn, gusts ") || !strings.Contains(got, ", F") {
			t.Fatalf("the %s has no wind: %s", name, got)
		}
	}
}

// frontCrossing says whether a front's line is crossing the disk's reach
// at a tick.
func frontCrossing(tl *weather.Timeline, at int64) bool {
	for _, s := range tl.SpellsOver(at, at, nil) {
		if s.Front != 0 && s.Begin < float64(at) && float64(at) < s.Begin+s.Change {
			return true
		}
	}
	return false
}
