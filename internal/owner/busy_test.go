// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"fmt"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// TestBusy: busy.json tallies the sample week's minutes from its opening:
// something on the disk nearly every minute, a storm on it some of the
// time, more than one system on average; the minutes so far are those to
// the tick asked about, none before the opening, the whole week's at its
// end; the regimes' minutes add up to the whole; and the week is tallied
// once.
func TestBusy(t *testing.T) {
	r := newForecastRig(t, 2*dayTick)
	tl := r.tl
	opening := tl.Config().Week.Opening + tl.Origin()
	start := time.Now()
	var page busyPage
	r.get(t, "/owner/api/busy.json", &page)
	took := time.Since(start)
	w := page.Week
	t.Logf("busy.json in %v: the week %+v", took, w)
	now := r.w.Latest().Tick
	ends := weather.TicksOf(tl.Week().Epoch, tl.Week().Ends) + tl.Origin()
	if page.At != now || page.Opening != opening || w.Minutes != int((ends-opening+minuteTicks-1)/minuteTicks) || page.Until != opening+int64(w.Minutes-1)*minuteTicks {
		t.Fatalf("the page: at %d, opening %d, until %d, %d minutes", page.At, page.Opening, page.Until, w.Minutes)
	}
	if w.Empty > 1 || w.Storms <= 0 || w.Lows < w.Storms || w.Rain <= 0 || w.Lines <= 0 || w.Systems < 2 {
		t.Fatalf("the week is not busy: %+v", w)
	}
	if so := page.SoFar.Minutes; so != int((now-opening)/minuteTicks)+1 {
		t.Fatalf("%d minutes so far, at %d from the opening at %d", so, now, opening)
	}
	sum := 0
	for i, g := range w.Regimes {
		sum += g.Minutes
		if g.ID != r.o.cfg.Regimes[i] {
			t.Fatalf("regime %d: %+v", i, g)
		}
	}
	if sum != w.Minutes || len(w.Regimes) != len(r.o.cfg.Regimes) {
		t.Fatalf("the regimes' minutes add up to %d of %d", sum, w.Minutes)
	}
	// Before the opening, nothing so far; at the end, the whole week.
	r.get(t, fmt.Sprintf("/owner/api/busy.json?at=%d", opening-1), &page)
	if page.SoFar.Minutes != 0 || page.SoFar.Systems != 0 {
		t.Fatalf("before the opening: %+v", page.SoFar)
	}
	start = time.Now()
	r.get(t, fmt.Sprintf("/owner/api/busy.json?at=%d", ends+dayTick), &page)
	if fmt.Sprint(page.SoFar) != fmt.Sprint(w) || time.Since(start) > took/2+50*time.Millisecond {
		t.Fatalf("at the end, in %v: %+v; the week %+v", time.Since(start), page.SoFar, w)
	}
	if code := r.code(t, "/owner/api/busy.json?at=x"); code != 400 {
		t.Fatalf("at, not a tick: %d", code)
	}
}

// TestWeatherKinds: weather.json names each kind with its shape, the line
// among them, and marks the week's storms' kind; the week's storms' births
// are its storms, the other lows' its lows; a line alive is given its
// length.
func TestWeatherKinds(t *testing.T) {
	r := newForecastRig(t, 1000)
	tl := r.tl
	cfg := tl.Config()
	var page weatherPage
	r.get(t, "/owner/api/weather.json", &page)
	lines := 0
	for i, k := range page.Kinds {
		want := map[float64]string{physics.ShapeNone: "none", physics.ShapeDome: "dome", physics.ShapeLow: "low", physics.ShapeLine: "line"}[cfg.Kinds[i].Shape]
		if k.Shape != want || k.Storm != (i == cfg.Week.Storms) || k.Name != r.cat.Weather.Systems[i].Name || k.Symbol != string(r.cat.Weather.Systems[i].Symbol) {
			t.Fatalf("kind %d: %+v", i, k)
		}
		if k.Shape == "line" {
			lines++
		}
	}
	if lines < 2 {
		t.Fatalf("%d kinds of line", lines)
	}
	storms, lows := 0, 0
	for _, s := range tl.Week().Systems {
		switch k := int(s.Kind); {
		case k == cfg.Week.Storms:
			storms++
		case cfg.Kinds[k].Shape == physics.ShapeLow:
			lows++
		}
	}
	if len(page.Storms) != storms || len(page.Lows) != lows || storms == 0 || lows == 0 {
		t.Fatalf("%d storms and %d lows; the week's %d and %d", len(page.Storms), len(page.Lows), storms, lows)
	}
	// A line alive, at its birth and a minute after.
	for _, s := range tl.Week().Systems {
		if cfg.Kinds[int(s.Kind)].Shape != physics.ShapeLine || s.Slot < 0 {
			continue
		}
		at := int64(s.Born) + tl.Origin() + minuteTicks
		r.get(t, fmt.Sprintf("/owner/api/weather.json?at=%d", at), &page)
		for _, j := range page.Systems {
			if j.Slot == s.Slot && j.Kind == int(s.Kind) {
				if j.Length != s.Length || j.Length <= 0 {
					t.Fatalf("a line's length %v; its record's %v", j.Length, s.Length)
				}
				return
			}
		}
		t.Fatalf("the line born at %v is not on the page a minute after", s.Born)
	}
	t.Fatal("no line in the week")
}
