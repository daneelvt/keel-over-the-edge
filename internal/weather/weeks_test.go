// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// TestWeeks makes the weeks of many seeds and holds each to its checks and
// to the rules a sailor learns: fifty in the short run, KEEL_WEEKS of them
// if it is set, as the nightly run sets it to a thousand. Its tally of
// them is written to KEEL_WEEKS_SUMMARY, if that is set, in Markdown.
func TestWeeks(t *testing.T) {
	cat, tl := load(t)
	cfg := tl.Config()
	n := 50
	if v := os.Getenv("KEEL_WEEKS"); v != "" {
		var err error
		if n, err = strconv.Atoi(v); err != nil {
			t.Fatalf("KEEL_WEEKS=%q", v)
		}
	}
	// The refuge is sampled every this many minutes: every minute in the
	// long run.
	every := int64(10)
	if n > 100 {
		every = 1
	}
	var tally weeksTally
	tally.shares = make([]float64, len(cfg.Regimes))
	for seed := uint64(1); seed <= uint64(n); seed++ {
		// Epochs at different hours of the day, so the nights fall at
		// different ticks.
		epoch := SampleEpoch + int64(seed%24)*3600*1_000_000
		w := Generate(cfg, seed, epoch, epoch+SampleWeek, testIslands)
		wt, err := New(cfg, w)
		if err != nil {
			t.Fatal(err)
		}
		g := &gen{c: cfg, epochUs: float64(epoch)}
		checkWeek(t, seed, cfg, g, w, &tally)
		checkFronts(t, seed, wt, w, &tally)
		checkStorms(t, seed, wt, w, cfg, &tally)
		checkRefuge(t, seed, wt, w, every, &tally)
		tally.weeks++
		for i, s := range w.Report.Shares {
			tally.shares[i] += s
		}
		tally.storms += w.Report.Storms
		tally.systems += w.Report.Systems
		tally.most = max(tally.most, w.Report.Most)
		tally.refused += w.Report.Refused
		tally.draws += w.Report.Draws
		if t.Failed() {
			t.Fatalf("seed %d failed", seed)
		}
	}
	if tally.showersByDay > 50 {
		if share := float64(tally.showersOnIslands) / float64(tally.showersByDay); share < 0.3 {
			t.Errorf("%.0f%% of the showers by day form over islands", 100*share)
		}
	}
	report := tally.markdown(cat)
	t.Log("\n" + report)
	if path := os.Getenv("KEEL_WEEKS_SUMMARY"); path != "" {
		if err := os.WriteFile(path, []byte(report), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

type weeksTally struct {
	weeks, storms, systems, most, refused, draws int
	shares                                       []float64
	stormHours                                   [6]float64 // by whole nautical miles from the centre, the last beyond
	frontPoints, veerFails, backFails            int
	veers                                        []float64
	ballotPoints                                 int
	refugePoints                                 int
	refugeMean, refugeWind                       float64
	showersByDay, showersOnIslands               int
}

func (t *weeksTally) markdown(cat *catalog.Catalog) string {
	var b strings.Builder
	weeks := float64(t.weeks)
	fmt.Fprintf(&b, "## The weather's weeks\n\n%d weeks, %.1f draws each on average.\n\n", t.weeks, float64(t.draws)/weeks)
	b.WriteString("| Regime | Share of the world's time | The catalog's |\n|---|---|---|\n")
	for i, r := range cat.Weather.Regimes {
		fmt.Fprintf(&b, "| %s | %.1f%% | %.0f%% |\n", r.ID, 100*t.shares[i]/weeks, 100*r.Share)
	}
	fmt.Fprintf(&b, "\nStorms a week (a day's margin with it): %.1f. Systems a week: %.0f; the most at once: %d; not born, the disk full: %d.\n\n",
		float64(t.storms)/weeks, float64(t.systems)/weeks, t.most, t.refused)
	b.WriteString("| Storm hours a week, centre within | 1 NM | 2 NM | 3 NM | 4 NM | 5 NM | beyond |\n|---|---|---|---|---|---|---|\n|")
	for _, h := range t.stormHours {
		fmt.Fprintf(&b, " %.2f |", h/weeks)
	}
	fmt.Fprintf(&b, "\n\nFronts: %d points checked, the veer across the line from %.0f° to %.0f°.\n", t.frontPoints, minOf(t.veers), maxOf(t.veers))
	fmt.Fprintf(&b, "Buys Ballot's law: %d points where a storm is the wind, all with its centre on the left.\n", t.ballotPoints)
	fmt.Fprintf(&b, "The refuge: %d points, the strongest mean wind %.2f knots, with its gusts %.2f.\n", t.refugePoints, t.refugeMean/knot, t.refugeWind/knot)
	if t.showersByDay > 0 {
		fmt.Fprintf(&b, "Showers by day over islands: %.0f%%.\n", 100*float64(t.showersOnIslands)/float64(t.showersByDay))
	}
	return b.String()
}

func minOf(a []float64) float64 {
	m := math.Inf(1)
	for _, x := range a {
		m = min(m, x)
	}
	return m
}

func maxOf(a []float64) float64 {
	m := math.Inf(-1)
	for _, x := range a {
		m = max(m, x)
	}
	return m
}

// checkWeek holds a week to its checks: it passed them; it keeps the disk to
// its most systems, each in a slot of the week's; its fronts are on the
// disk one at a time, nothing else changing while one crosses, each veering
// the wind; fog forms only at night or dawn and in light wind; and showers
// by day form over the islands.
func checkWeek(t *testing.T, seed uint64, cfg *Config, g *gen, w *Week, tally *weeksTally) {
	t.Helper()
	if !w.Report.Passed {
		t.Errorf("seed %d failed its checks: %v", seed, w.Report.Failed)
	}
	if w.Report.Most > cfg.Week.SystemsMost {
		t.Errorf("seed %d: %d systems at once", seed, w.Report.Most)
	}
	busy := math.Inf(-1)
	for i := 1; i < len(w.Spells); i++ {
		s, prev := &w.Spells[i], &w.Spells[i-1]
		if s.Begin < busy {
			t.Errorf("seed %d: spell %d begins at %v while a front is on the disk until %v", seed, i, s.Begin, busy)
		}
		turned := wrap(int32(s.From) - wrap(int32(prev.From)+int32(prev.Drift)))
		if turned > turn/2 {
			turned -= turn
		}
		d := float64(turned) / deg
		if s.Front != 0 {
			busy = s.Begin + s.Change
			if d < 39.99 || d > 90.01 {
				t.Errorf("seed %d: the front of spell %d turns the wind %.1f°, not a veer of 40–90°", seed, i, d)
			}
		} else if d < -30.01 || d > 30.01 {
			t.Errorf("seed %d: spell %d turns the wind %.1f°, more than 30°", seed, i, d)
		}
	}
	for _, s := range w.Systems {
		if s.Slot < 0 || s.Slot >= cfg.Week.SystemsMost {
			t.Errorf("seed %d: a system in slot %d", seed, s.Slot)
		}
		k := &cfg.Kinds[int(s.Kind)]
		x, y := physics.SystemTrack(&s.SystemRecord, s.Born)
		born := int64(s.Born)
		if k.Night {
			if g.sunAt(born, x, y) >= 0 && g.sunAt(born-k.Dawn, x, y) >= 0 {
				t.Errorf("seed %d: a %v-shaped night system born in daylight at tick %d", seed, k.Shape, born)
			}
		}
		if k.CalmBelow > 0 {
			if v := MeanWind(cfg.Prepared, w.Spells, born, x, y); v >= k.CalmBelow {
				t.Errorf("seed %d: a light-wind system born in %.1f knots", seed, v/knot)
			}
		}
		if k.Islands > 0 && g.sunAt(born, x, y) > 0 {
			tally.showersByDay++
			for _, is := range testIslands {
				if math.Hypot(x-is.X, y-is.Y) <= is.Across/2 {
					tally.showersOnIslands++
					break
				}
			}
		}
	}
}

// weatherAt is the physics package's weather of a timeline at a tick: its
// spells in play and its keyframes, with only the systems keep says to.
func weatherAt(tl *Timeline, tick int64, keep func(slot int) bool) (*physics.Weather, *physics.WeatherTick) {
	w := &physics.Weather{Prepared: tl.Prepared()}
	var sp [physics.WeatherSpells]physics.Spell
	n := tl.Spells(tick, nil, &sp)
	w.Set(sp[:n])
	var keys [bus.KeyFrames]physics.Keyframe
	tl.Keyframes(tick, nil, &keys)
	for k := range keys {
		for slot := range keys[k].Systems {
			if keep != nil && !keep(slot) {
				keys[k].Systems[slot] = physics.System{}
			}
		}
	}
	w.SetKeys(keys[:2])
	var at physics.WeatherTick
	physics.WeatherAt(w, &at, float64(tick))
	return w, &at
}

func meanAt(at *physics.WeatherTick, x, y float64) (speed, from float64) {
	return physics.MeanWindAt(at, x, y)
}

// angleTo is the angle from a to b, degrees clockwise, in [−180, 180).
func angleTo(a, b float64) float64 { return math.Mod(b-a+540, 360) - 180 }

// checkFronts holds each front to the rule a sailor learns: the wind veers
// at the line, and ahead of it backs or freshens, and is never lighter
// than the old spell's by more than a knot, at points the
// line crosses as it passes the centre, away from the systems. Where the
// trough's own wind blows along the old spell's, it freshens the wind
// without backing it.
func checkFronts(t *testing.T, seed uint64, tl *Timeline, w *Week, tally *weeksTally) {
	t.Helper()
	none := func(int) bool { return false }
	for i := 1; i < len(w.Spells); i++ {
		s := &w.Spells[i]
		if s.Front == 0 || s.Begin+s.Change > float64(w.Until) {
			continue
		}
		tick := int64(s.Begin + s.Change/2)
		_, at := weatherAt(tl, tick, none)
		alone := &physics.Weather{Prepared: tl.Prepared()}
		alone.Set([]physics.Spell{w.Spells[i-1]})
		var oldAt physics.WeatherTick
		physics.WeatherAt(alone, &oldAt, float64(tick))
		fe, fn := physics.SinCos(s.Toward * (2 * math.Pi / turn))
		for along := -3.5 * nauticalMile; along <= 3.5*nauticalMile; along += 0.5 * nauticalMile {
			px, py := -along*fn, along*fe
			if r := math.Hypot(px, py); r < 1*nauticalMile || r > 3.6*nauticalMile {
				continue
			}
			tally.frontPoints++
			_, ahead := meanAt(at, px+0.3*nauticalMile*fe, py+0.3*nauticalMile*fn)
			_, behind := meanAt(at, px-0.3*nauticalMile*fe, py-0.3*nauticalMile*fn)
			v := angleTo(ahead/degree, behind/degree)
			tally.veers = append(tally.veers, v)
			if v < frontVeerLeast || v > frontVeerMost {
				tally.veerFails++
				t.Errorf("seed %d: the front of spell %d veers the wind %.0f° across its line", seed, i, v)
			}
			fx, fy := px+nauticalMile*fe, py+nauticalMile*fn
			got, gotFrom := meanAt(at, fx, fy)
			was, wasFrom := meanAt(&oldAt, fx, fy)
			if backed := angleTo(wasFrom/degree, gotFrom/degree) < 0; !backed && got <= was || got < was-knot {
				tally.backFails++
				t.Errorf("seed %d: a mile ahead of spell %d's front the wind is %.0f° %.1f knots, the old spell's %.0f° %.1f",
					seed, i, gotFrom/degree, got/knot, wasFrom/degree, was/knot)
			}
		}
	}
}

// checkStorms holds each storm to its track, in the outer waters unless it
// turns in, and to Buys Ballot's law wherever it is the wind; and tallies
// its hours by its distance from the centre.
func checkStorms(t *testing.T, seed uint64, tl *Timeline, w *Week, cfg *Config, tally *weeksTally) {
	t.Helper()
	for _, s := range w.Systems {
		if cfg.Kinds[int(s.Kind)].Track != trackOuter {
			continue
		}
		for tick := s.Born; tick < s.Gone; tick += 5 * ticksPerMinute {
			x, y := physics.SystemTrack(&s.SystemRecord, tick)
			r := math.Hypot(x, y)
			band := min(int(r/nauticalMile), len(tally.stormHours)-1)
			tally.stormHours[band] += 5.0 / 60
			if s.Inward == 0 && (r < cfg.Week.Outer[0]-1 || r > cfg.Week.Outer[1]+1) {
				t.Fatalf("seed %d: a storm keeping to the outer waters is %.2f NM out", seed, r/nauticalMile)
			}
		}
		// Buys Ballot's law, as it matures and at its strongest.
		for _, tick := range []float64{s.Mature, (s.Mature + s.Decays) / 2} {
			at := int64(tick) / tl.Every() * tl.Every()
			slot := s.Slot
			_, all := weatherAt(tl, at, nil)
			_, rest := weatherAt(tl, at, func(k int) bool { return k != slot })
			own := stormOnly(tl, at, slot)
			cx, cy := physics.SystemTrack(&s.SystemRecord, float64(at))
			wob := physics.SystemAt(&s.SystemRecord, float64(at))
			cx, cy = wob.East/4, wob.North/4
			for rr := 0.1 * s.Size; rr < 1.5*s.Size; rr += 0.1 * s.Size {
				for a := 0.0; a < 360; a += 15 {
					x, y := cx+rr*math.Sin(a*degree), cy+rr*math.Cos(a*degree)
					if math.Hypot(x, y) > cfg.Prepared.Edge()*0.97 {
						continue
					}
					o, _ := meanAt(own, x, y)
					rv, _ := meanAt(rest, x, y)
					if !(rv < 0.9*o) || o < 0.5 {
						continue
					}
					tally.ballotPoints++
					_, from := meanAt(all, x, y)
					toward := math.Mod(from/degree+180, 360)
					centre := math.Atan2(cx-x, cy-y) / degree
					if left := angleTo(toward, centre); left < -135 || left > -5 {
						t.Errorf("seed %d: at (%.0f, %.0f) a storm's centre is %.0f° off downwind", seed, x, y, left)
					}
				}
			}
		}
	}
}

// stormOnly is the wind of one system alone, in still air.
func stormOnly(tl *Timeline, tick int64, slot int) *physics.WeatherTick {
	w := &physics.Weather{Prepared: tl.Prepared()}
	w.Set([]physics.Spell{{Gust: 1000, Pressure: 101300}})
	var keys [bus.KeyFrames]physics.Keyframe
	tl.Keyframes(tick, nil, &keys)
	for k := range keys {
		for s := range keys[k].Systems {
			if s != slot {
				keys[k].Systems[s] = physics.System{}
			}
		}
	}
	w.SetKeys(keys[:2])
	var at physics.WeatherTick
	physics.WeatherAt(w, &at, float64(tick))
	return &at
}

// checkRefuge holds the refuge to its limits: within its radius the mean
// wind never over 14 knots and the wind with its gusts never over 18,
// whatever the week brings, sampled every few minutes on a grid a tenth of
// a mile apart.
func checkRefuge(t *testing.T, seed uint64, tl *Timeline, w *Week, every int64, tally *weeksTally) {
	t.Helper()
	const step = 0.1 * nauticalMile
	for tick := int64(0); tick < w.Until; tick += every * ticksPerMinute {
		_, at := weatherAt(tl, tick, nil)
		for x := -nauticalMile; x <= nauticalMile; x += step {
			for y := -nauticalMile; y <= nauticalMile; y += step {
				if x*x+y*y > nauticalMile*nauticalMile {
					continue
				}
				var p physics.WindPoint
				physics.WindPointAt(at, x, y, &p, nil)
				tally.refugePoints++
				tally.refugeMean = max(tally.refugeMean, p.MeanSpeed)
				tally.refugeWind = max(tally.refugeWind, p.Speed)
				if p.MeanSpeed > 14*knot+1e-9 || p.Speed > 18*knot+1e-9 {
					t.Fatalf("seed %d: at tick %d at (%.0f, %.0f) the mean wind is %.2f knots, with its gusts %.2f", seed, tick, x, y, p.MeanSpeed/knot, p.Speed/knot)
				}
			}
		}
	}
}

// The least and the most the wind veers across a front's line, 0.3 NM
// either side of it: the spells' veer, 40–90°, less or more their shifts,
// which swing each spell's wind up to 12° either way, and their
// differences across the disk, up to 5° each, and the trough's own wind,
// which backs the wind ahead of the line and veers it behind by 10–30°
// more.
const (
	frontVeerLeast = 15
	frontVeerMost  = 150
)
