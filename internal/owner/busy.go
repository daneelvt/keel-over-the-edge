// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"math"
	"net/http"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// How busy the world's weather has been: each minute of its week from the
// opening, the systems on the disk, any part of them within the lip, from
// their records as the keyframes have them, and the fronts crossing it;
// and of the minutes so far, the share with nothing on the disk, with rain
// somewhere, with a storm or a low, with a storm, with a front or a trough,
// and the systems on the disk on average, over the week and by the regime
// in effect. The week's minutes are tallied once, on the first request,
// and kept; each request sums them to the minute shown. It reads the
// week's own weather, as the world sails it without a developer's hand.

// minuteTicks is a minute of world time in ticks.
const minuteTicks = 60 * physics.StepsPerSecond

// busyMinute is a minute of the week: the systems on the disk, what of
// them there is, and the regime in effect.
type busyMinute struct {
	systems uint8
	regime  uint8
	// Nothing on the disk, rain on it, a storm or a low, a storm, a front
	// or a trough.
	empty, rain, low, storm, line bool
}

// busyCache is a week's minutes, tallied once.
type busyCache struct {
	mu      sync.Mutex
	week    *weather.Week
	opening int64 // the week's tick its first minute is at, in its own ticks
	minutes []busyMinute
}

// busyFigures are the figures of a span of minutes: shares, %, and the
// systems on the disk on average.
type busyFigures struct {
	Minutes int     `json:"minutes"`
	Empty   float64 `json:"empty"`
	Rain    float64 `json:"rain"`
	Lows    float64 `json:"lows"` // a storm or a low
	Storms  float64 `json:"storms"`
	Lines   float64 `json:"lines"` // a front or a trough
	Systems float64 `json:"systems"`
	// Regimes are the same of the minutes of each regime, by its index.
	Regimes []busyRegime `json:"regimes"`
}

// busyRegime is a regime's minutes in a span: how many, the share with
// nothing on the disk, %, and the systems on the disk on average.
type busyRegime struct {
	ID      string  `json:"id"`
	Minutes int     `json:"minutes"`
	Empty   float64 `json:"empty"`
	Systems float64 `json:"systems"`
}

// busyPage is busy.json.
type busyPage struct {
	At int64 `json:"at"` // the tick the figures are summed to
	// Opening is the tick the week's first minute counted is at, after its
	// opening; Until its last minute's.
	Opening int64 `json:"opening"`
	Until   int64 `json:"until"`
	// SoFar are the figures from the opening to the tick, Week those of the
	// whole week.
	SoFar busyFigures `json:"soFar"`
	Week  busyFigures `json:"week"`
}

// busyJSON serves busy.json: the weather's figures from the week's
// opening to a tick, ?at= or now, and over the whole week.
func (o *Owner) busyJSON(w http.ResponseWriter, r *http.Request) {
	tl, now, _, _ := o.weatherState()
	if tl == nil || tl.Week() == nil {
		http.Error(w, "the world has no week of weather yet", http.StatusNotFound)
		return
	}
	tick, ok := at(r, now)
	if !ok {
		http.Error(w, "at is a tick", http.StatusBadRequest)
		return
	}
	writeJSON(w, o.busyPage(tl, tick))
}

func (o *Owner) busyPage(tl *weather.Timeline, tick int64) *busyPage {
	c := &o.fc.busy
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tally(tl, o.cfg.WeatherKinds)
	origin := tl.Origin()
	n := len(c.minutes)
	page := &busyPage{At: tick, Opening: c.opening + origin, Until: c.opening + origin + int64(max(n-1, 0))*minuteTicks}
	so := 0
	if local := tick - origin; local >= c.opening {
		so = min(int((local-c.opening)/minuteTicks)+1, n)
	}
	page.SoFar = figuresOf(c.minutes[:so], o.cfg.Regimes)
	page.Week = figuresOf(c.minutes, o.cfg.Regimes)
	return page
}

// tally tallies the timeline's week's minutes, once a week.
func (c *busyCache) tally(tl *weather.Timeline, kinds []WeatherKind) {
	w := tl.Week()
	if c.week == w {
		return
	}
	cfg := tl.Config()
	p := tl.Prepared()
	edge, reach := p.Edge(), p.FrontReach()
	c.week, c.opening, c.minutes = w, cfg.Week.Opening, nil
	ends := weather.TicksOf(w.Epoch, w.Ends)
	longest := 0.0
	for i := range w.Systems {
		longest = math.Max(longest, w.Systems[i].Gone-w.Systems[i].Born)
	}
	first, spell := 0, 0
	for tick := c.opening; tick < ends; tick += minuteTicks {
		at := float64(tick)
		for spell+1 < len(w.Spells) && w.Spells[spell+1].Begin <= at {
			spell++
		}
		for first < len(w.Systems) && w.Systems[first].Born < at-longest {
			first++
		}
		var m busyMinute
		front := false
		for _, s := range w.Spells[max(spell-1, 0) : spell+1] {
			if s.Front != 0 && s.Change > 0 && at >= s.Begin && at <= s.Begin+s.Change {
				line := 2*reach*(at-s.Begin)/s.Change - reach
				front = front || math.Abs(line) < edge
			}
		}
		n := 0
		for i := first; i < len(w.Systems) && w.Systems[i].Born <= at; i++ {
			s := physics.SystemAt(&w.Systems[i].SystemRecord, at)
			if s.On == 0 || !weather.OnDisk(&s, edge) {
				continue
			}
			n++
			k := int(s.Kind)
			if k < len(kinds) {
				m.rain = m.rain || kinds[k].Rain
				m.line = m.line || kinds[k].Trough
			}
			if k < len(cfg.Kinds) {
				m.low = m.low || cfg.Kinds[k].Shape == physics.ShapeLow
			}
			m.storm = m.storm || k == cfg.Week.Storms
		}
		m.systems = uint8(min(n, math.MaxUint8))
		if len(w.Spells) > 0 {
			m.regime = uint8(w.Spells[spell].Regime)
		}
		m.empty = n == 0 && !front
		m.rain = m.rain || front
		m.line = m.line || front
		c.minutes = append(c.minutes, m)
	}
}

// figuresOf are the figures of a span of minutes, the regimes named by
// regimes.
func figuresOf(minutes []busyMinute, regimes []string) busyFigures {
	var f busyFigures
	var empty, rain, lows, storms, lines, systems int
	type regime struct{ minutes, empty, systems int }
	by := make([]regime, len(regimes))
	for _, m := range minutes {
		systems += int(m.systems)
		for _, c := range []struct {
			on bool
			n  *int
		}{{m.empty, &empty}, {m.rain, &rain}, {m.low, &lows}, {m.storm, &storms}, {m.line, &lines}} {
			if c.on {
				*c.n++
			}
		}
		if r := int(m.regime); r < len(by) {
			by[r].minutes++
			by[r].systems += int(m.systems)
			if m.empty {
				by[r].empty++
			}
		}
	}
	n := len(minutes)
	f.Minutes = n
	f.Empty, f.Rain, f.Lows, f.Storms, f.Lines = percent(empty, n), percent(rain, n), percent(lows, n), percent(storms, n), percent(lines, n)
	f.Systems = mean(systems, n)
	f.Regimes = []busyRegime{}
	for i, r := range by {
		f.Regimes = append(f.Regimes, busyRegime{ID: regimes[i], Minutes: r.minutes, Empty: percent(r.empty, r.minutes), Systems: mean(r.systems, r.minutes)})
	}
	return f
}

// percent is a share of n, %, to a tenth; 0 of none.
func percent(k, n int) float64 {
	if n == 0 {
		return 0
	}
	return math.Round(1000*float64(k)/float64(n)) / 10
}

// mean is a sum over n, to a hundredth; 0 of none.
func mean(sum, n int) float64 {
	if n == 0 {
		return 0
	}
	return round2(float64(sum) / float64(n))
}
