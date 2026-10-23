// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The forecast's calibration: at each lead, the share of true positions
// inside their cones, which the cones are sized to hold four times in five
// (Gneiting, Balabdaoui and Raftery 2007: "statistical consistency between
// the distributional forecasts and the observations"). Each system is
// counted once a lead at each issue; the lows forming and the fronts'
// bands are tallied apart.

// calibration is the tally of cases and of those inside, by lead.
type calibration struct {
	cases, inside [physics.MaxForecastSteps]int
}

func (c *calibration) add(k int, in bool) {
	c.cases[k]++
	if in {
		c.inside[k]++
	}
}

// share is the share inside at lead k, %.
func (c *calibration) share(k int) float64 { return share(c.inside[k], c.cases[k]) }

// forecastTally is the forecast's calibration over the weeks: systems alive
// at the issue, lows forming, and fronts.
type forecastTally struct {
	alive, forming, fronts calibration
	steps                  int
}

// checkForecast issues the week's forecasts every ten minutes and tallies,
// at each lead, whether the truth lies inside each cone.
func checkForecast(wt *Timeline, w *Week, ft *forecastTally) {
	p := wt.Prepared()
	every := p.ForecastEvery()
	n := p.ForecastSteps()
	ft.steps = int(n)
	var f physics.Forecast
	reach := p.FrontReach()
	for issue := int64(0); issue+p.ForecastHorizon() < w.Until; issue += every {
		wt.Forecast(issue, nil, nil, 0, &f)
		for i := range int(f.Head.NSystems) {
			s := &f.Systems[i]
			r := recordOf(w, s, issue)
			if r == nil {
				continue
			}
			c := &ft.alive
			if s.Forming != 0 {
				c = &ft.forming
			}
			for k := int32(1); k < n; k++ {
				at := float64(issue) + float64(k)*f.Head.Step
				truth := physics.SystemAt(r, at)
				if !(s.Strength[k] > 0) || truth.On == 0 {
					continue
				}
				d := math.Hypot(truth.East/4-s.East[k], truth.North/4-s.North[k])
				c.add(int(k), d <= physics.ForecastCone(p, &f, s, k))
			}
		}
		for i := range int(f.Head.NSpells) {
			fs := &f.Spells[i]
			if fs.Front == 0 {
				continue
			}
			ts := spellOf(w, fs.Seed)
			if ts == nil {
				continue
			}
			for k := int32(1); k < n; k++ {
				at := float64(issue) + float64(k)*f.Head.Step
				if at < ts.Begin || at > ts.Begin+ts.Change {
					continue
				}
				truth := 2*reach*(at-ts.Begin)/ts.Change - reach
				fc := 2*reach*(at-fs.Begin)/fs.Change - reach
				ft.fronts.add(int(k), math.Abs(truth-fc) <= physics.FrontBand(p, fs, at-float64(issue)))
			}
		}
	}
}

// recordOf is the week's system a forecast's is of: in its slot, of its
// kind and size, alive at the issue, or for a low forming, born after it.
func recordOf(w *Week, s *physics.ForecastSystem, issue int64) *physics.SystemRecord {
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
func spellOf(w *Week, seed float64) *physics.Spell {
	for i := range w.Spells {
		if w.Spells[i].Seed == seed {
			return &w.Spells[i]
		}
	}
	return nil
}

// markdown is the calibration as a table of its shares by lead.
func (ft *forecastTally) markdown(step float64) string {
	var b strings.Builder
	b.WriteString("\nThe forecast's calibration: the share of the truth inside its cone, at each lead.\n\n| Lead |")
	for k := 1; k < ft.steps; k++ {
		fmt.Fprintf(&b, " %.0f min |", float64(k)*step/physics.StepsPerSecond/60)
	}
	b.WriteString("\n|---|" + strings.Repeat("---|", ft.steps-1) + "\n")
	row := func(name string, c *calibration) {
		fmt.Fprintf(&b, "| %s |", name)
		for k := 1; k < ft.steps; k++ {
			fmt.Fprintf(&b, " %.1f%% (%d) |", c.share(k), c.cases[k])
		}
		b.WriteString("\n")
	}
	row("Systems alive at the issue", &ft.alive)
	row("Lows forming", &ft.forming)
	row("Fronts' lines", &ft.fronts)
	return b.String()
}
