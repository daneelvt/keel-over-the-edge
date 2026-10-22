// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"math"
	"net/http"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// How well the forecast has held the truth so far this world: at each
// lead, of every issue from the world's beginning to the last whose
// horizon has passed, the share of the systems alive at the issue whose
// true place lay inside their cones, of the lows forming, and of the
// fronts' true lines inside their bands, the cones being sized to hold the
// truth four times in five. Each issue is tallied once, as the world sails
// past its horizon, and kept. The forecasts tallied are the week's own, as
// the world sails without a developer's hand, so a developer's weather
// never spoils the tally.

// calibrationLog is the tally so far: at each step, of each kind of case,
// the cases inside and the cases.
type calibrationLog struct {
	mu      sync.Mutex
	started bool
	next    int64 // the next issue to tally
	issues  int
	alive   [physics.MaxForecastSteps][2]int
	forming [physics.MaxForecastSteps][2]int
	fronts  [physics.MaxForecastSteps][2]int
	f       physics.Forecast
}

// tally adds a case at step k to c.
func tally(c *[physics.MaxForecastSteps][2]int, k int32, in bool) {
	c[k][1]++
	if in {
		c[k][0]++
	}
}

// extend tallies each issue not yet tallied whose horizon has passed by
// now.
func (l *calibrationLog) extend(tl *weather.Timeline, now int64) {
	week := tl.Week()
	p := tl.Prepared()
	every := max(p.ForecastEvery(), 1)
	if !l.started {
		l.started, l.next = true, firstIssue(tl)
	}
	origin := tl.Origin()
	reach := p.FrontReach()
	end := worldEnd(tl)
	f := &l.f
	for ; l.next+p.ForecastHorizon() <= now; l.next += every {
		issue := l.next
		tl.Forecast(issue, nil, nil, end, f)
		l.issues++
		n := int32(f.Head.Steps)
		for i := range int(f.Head.NSystems) {
			s := &f.Systems[i]
			r := recordOf(week, s, issue-origin)
			if r == nil {
				continue
			}
			c := &l.alive
			if s.Forming != 0 {
				c = &l.forming
			}
			for k := int32(1); k < n; k++ {
				at := float64(issue) + float64(k)*f.Head.Step
				truth := physics.SystemAt(r, at-float64(origin))
				if !(s.Strength[k] > 0) || truth.On == 0 {
					continue
				}
				d := math.Hypot(truth.East/4-s.East[k], truth.North/4-s.North[k])
				tally(c, k, d <= physics.ForecastCone(p, f, s, k))
			}
		}
		for i := range int(f.Head.NSpells) {
			fs := &f.Spells[i]
			if fs.Front == 0 {
				continue
			}
			ts := spellOf(week, fs.Seed)
			if ts == nil {
				continue
			}
			for k := int32(1); k < n; k++ {
				at := float64(issue) + float64(k)*f.Head.Step
				local := at - float64(origin)
				if local < ts.Begin || local > ts.Begin+ts.Change {
					continue
				}
				truth := 2*reach*(local-ts.Begin)/ts.Change - reach
				fc := 2*reach*(at-fs.Begin)/fs.Change - reach
				tally(&l.fronts, k, math.Abs(truth-fc) <= physics.FrontBand(p, fs, at-float64(issue)))
			}
		}
	}
}

// recordOf is the week's system a forecast's is of: in its slot, of its
// kind and size, alive at the issue (in the week's own ticks), or for a low
// forming, born after it.
func recordOf(w *weather.Week, s *physics.ForecastSystem, issue int64) *physics.SystemRecord {
	for i := range w.Systems {
		r := &w.Systems[i]
		if float64(r.Slot) != s.Slot || r.Kind != s.Kind || r.Size != s.Size || r.Gone <= float64(issue) {
			continue
		}
		if s.Forming == 0 && r.Born <= float64(issue) || s.Forming != 0 && r.Born > float64(issue) {
			return &r.SystemRecord
		}
	}
	return nil
}

// spellOf is the week's spell of a seed.
func spellOf(w *weather.Week, seed float64) *physics.Spell {
	for i := range w.Spells {
		if w.Spells[i].Seed == seed {
			return &w.Spells[i]
		}
	}
	return nil
}

// calibrationPage is calibration.json.
type calibrationPage struct {
	Now    int64 `json:"now"`
	From   int64 `json:"from"`   // the first issue tallied
	Next   int64 `json:"next"`   // the next to be, once its horizon has passed
	Issues int   `json:"issues"` // how many are tallied
	// Leads are the leads, minutes, from the first step after the issue's
	// own; and at each, of the systems alive at the issue, the lows forming
	// and the fronts, the cases inside and the cases.
	Leads   []float64 `json:"leads"`
	Alive   [][2]int  `json:"alive"`
	Forming [][2]int  `json:"forming"`
	Fronts  [][2]int  `json:"fronts"`
}

// calibration serves calibration.json: the tally so far, carried forward
// to now.
func (o *Owner) calibration(w http.ResponseWriter, _ *http.Request) {
	tl, now, _, _ := o.weatherState()
	if tl == nil || tl.Week() == nil {
		http.Error(w, "the world has no week of weather yet", http.StatusNotFound)
		return
	}
	writeJSON(w, o.calibrationPage(tl, now))
}

func (o *Owner) calibrationPage(tl *weather.Timeline, now int64) *calibrationPage {
	p := tl.Prepared()
	l := &o.fc.cal
	l.mu.Lock()
	defer l.mu.Unlock()
	l.extend(tl, now)
	page := &calibrationPage{
		Now: now, From: firstIssue(tl), Next: l.next, Issues: l.issues,
		Leads: []float64{}, Alive: [][2]int{}, Forming: [][2]int{}, Fronts: [][2]int{},
	}
	for k := int32(1); k < p.ForecastSteps(); k++ {
		page.Leads = append(page.Leads, float64(int64(k)*p.ForecastStep())/(60*physics.StepsPerSecond))
		page.Alive = append(page.Alive, l.alive[k])
		page.Forming = append(page.Forming, l.forming[k])
		page.Fronts = append(page.Fronts, l.fronts[k])
	}
	return page
}
