// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"net/http"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The gale warnings of the world so far: each issue from the world's
// beginning scanned for its gale once, in order, and the issues in a row
// with a gale one warning, keyed by the first of them, as the issuer keys
// it. The scan takes a millisecond and more an issue, a second or two for
// a week, so it is carried forward from where it last stopped, never made
// again. It reads the week's own weather, as the world sails it without a
// developer's hand.

// galeRun is a warning: the issue it came into force at, the last it was
// in force at, the most force of any of them, and its gale as its first
// issue gave it.
type galeRun struct {
	key, last int64
	force     int32
	gale      weather.Gale
}

// galeLog is the gale warnings scanned so far, and the room the scan works
// in.
type galeLog struct {
	mu      sync.Mutex
	started bool
	next    int64 // the next issue to scan
	runs    []galeRun
	f       physics.Forecast
	g       physics.Gales
	w       physics.Weather
	t       physics.WeatherTick
	on      []uint8
}

// firstIssue is the world's first issue: the first boundary of the
// forecast's every at or after the week's beginning, and never before the
// world's.
func firstIssue(tl *weather.Timeline) int64 {
	every := max(tl.Prepared().ForecastEvery(), 1)
	from := max(tl.Origin(), 0)
	return (from + every - 1) / every * every
}

// extend scans each issue not yet scanned up to to.
func (l *galeLog) extend(o *Owner, tl *weather.Timeline, to int64) {
	p := tl.Prepared()
	every := max(p.ForecastEvery(), 1)
	if !l.started {
		l.started, l.next = true, firstIssue(tl)
		l.on = make([]uint8, len(o.galeWater(p)))
	}
	water := o.galeWater(p)
	end := worldEnd(tl)
	for ; l.next <= to; l.next += every {
		tl.Forecast(l.next, nil, nil, end, &l.f)
		physics.GaleScan(p, &l.f, &l.w, &l.t, water, l.on, &l.g)
		g, ok := weather.GaleOf(&l.f, &l.g)
		if !ok {
			continue
		}
		if n := len(l.runs); n > 0 && l.runs[n-1].last == l.next-every {
			r := &l.runs[n-1]
			r.last, r.force = l.next, max(r.force, g.Force)
			continue
		}
		l.runs = append(l.runs, galeRun{key: l.next, last: l.next, force: g.Force, gale: g})
	}
}

// keyOf is the issue a gale warning in force at an issue came into force
// at: the first of the issues in a row before it with a gale, or itself.
func (l *galeLog) keyOf(o *Owner, tl *weather.Timeline, issue int64) int64 {
	every := max(tl.Prepared().ForecastEvery(), 1)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.extend(o, tl, issue-every)
	for i := range l.runs {
		if r := &l.runs[i]; r.key <= issue-every && issue-every <= r.last {
			return r.key
		}
	}
	return issue
}

// galesPage is gales.json.
type galesPage struct {
	Now      int64         `json:"now"`
	Issue    int64         `json:"issue"` // the issue in force now
	Every    int64         `json:"every"` // ticks between issues
	Warnings []galeWarning `json:"warnings"`
}

// galeWarning is a gale warning of the world, in force now or past.
type galeWarning struct {
	Key     int64 `json:"key"`  // the issue it came into force at
	Last    int64 `json:"last"` // the last issue it was in force at
	InForce bool  `json:"inForce"`
	Force   int   `json:"force"` // the most of any of its issues
	// Words are as its first issue told it, from the island or place
	// charted now nearest its strongest point.
	Words string  `json:"words"`
	From  float64 `json:"from"` // degrees
	East  float64 `json:"east"`
	North float64 `json:"north"`
}

// gales serves gales.json: every gale warning from the world's beginning to
// the issue in force now, the oldest first.
func (o *Owner) gales(w http.ResponseWriter, _ *http.Request) {
	tl, now, _, _ := o.weatherState()
	if tl == nil || tl.Week() == nil {
		http.Error(w, "the world has no week of weather yet", http.StatusNotFound)
		return
	}
	writeJSON(w, o.galesPage(tl, now))
}

func (o *Owner) galesPage(tl *weather.Timeline, now int64) *galesPage {
	issue := tl.IssueAt(now)
	l := &o.fc.gales
	l.mu.Lock()
	l.extend(o, tl, issue)
	runs := make([]galeRun, 0, len(l.runs))
	for _, r := range l.runs {
		if r.key <= issue {
			runs = append(runs, r)
		}
	}
	l.mu.Unlock()
	page := &galesPage{Now: now, Issue: issue, Every: tl.Prepared().ForecastEvery(), Warnings: []galeWarning{}}
	nearest := nearestOf(o.chartedPoints())
	for _, r := range runs {
		x := &forecast.Issue{Tick: r.key, Key: r.key, Gale: &r.gale}
		warn := o.warningOf(tl, x, false, nearest)
		page.Warnings = append(page.Warnings, galeWarning{
			Key: r.key, Last: min(r.last, issue), InForce: r.last >= issue, Force: int(r.force),
			Words: weather.WarningText(&warn, &o.cfg.Words), From: round2(degrees(r.gale.From)),
			East: round2(r.gale.East), North: round2(r.gale.North),
		})
	}
	return page
}
