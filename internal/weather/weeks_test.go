// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"fmt"
	"math"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// TestWeeks makes the weeks of many seeds and holds each to its checks and
// to the rules a sailor learns: fifty in the short run, KEEL_WEEKS of them
// if it is set, as the nightly run sets it to a thousand, from seed 1, or
// the one after KEEL_WEEKS_FROM. Its tally of them is written to
// KEEL_WEEKS_SUMMARY, if that is set, in Markdown. The storms' swell is
// held to its rule over the first five weeks on a grid half a mile apart,
// and in the long run over the first two hundred, a quarter of a mile; and
// so are the signs in the sky before the weather: the clouds' leads on
// their own wind, and a front's cirrus's on its line.
func TestWeeks(t *testing.T) {
	cat, tl := load(t)
	cfg := tl.Config()
	n, from := 50, uint64(0)
	if v := os.Getenv("KEEL_WEEKS"); v != "" {
		var err error
		if n, err = strconv.Atoi(v); err != nil {
			t.Fatalf("KEEL_WEEKS=%q", v)
		}
	}
	if v := os.Getenv("KEEL_WEEKS_FROM"); v != "" {
		var err error
		if from, err = strconv.ParseUint(v, 10, 64); err != nil {
			t.Fatalf("KEEL_WEEKS_FROM=%q", v)
		}
	}
	// The refuge is sampled every this many minutes: every minute in the
	// long run.
	every := int64(10)
	if n > 100 {
		every = 1
	}
	swellWeeks, swellGrid := 5, 0.5*nauticalMile
	if n > 100 {
		swellWeeks, swellGrid = 200, 0.25*nauticalMile
	}
	waves, _ := cat.Prepare()
	var tally weeksTally
	tally.shares = make([]float64, len(cfg.Regimes))
	for seed := from + 1; seed <= from+uint64(n); seed++ {
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
		if tally.weeks < swellWeeks {
			checkSwell(wt, w, waves, swellGrid, &tally)
			checkCloudLeads(cat, wt, w, swellGrid, &tally)
			checkFrontCirrus(cat, wt, w, swellGrid, &tally)
			checkFogWall(cat, wt, w, swellGrid, &tally)
		}
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
	// Where a storm's own 20-knot wind reaches a place half an hour or more
	// after the storm is whole, its swell comes first, all but at one place
	// in a hundred, and at nineteen places in twenty by ten minutes or more.
	if s := &tally.swell[2]; s.moving > 0 {
		if early := float64(s.movingShort) / float64(s.moving); early > 0.05 {
			t.Errorf("the swell came less than 10 minutes before a storm's 20-knot wind at %.1f%% of %d places it reached by moving", 100*early, s.moving)
		}
		if late := float64(s.moving-s.movingFirst) / float64(s.moving); late > 0.01 {
			t.Errorf("a storm's 20-knot wind came before its swell at %d of %d places it reached by moving", s.moving-s.movingFirst, s.moving)
		}
	}
	// A squall's tower comes before its gust front at every place, and by
	// five minutes or more at nineteen in twenty; a storm's cloud before its
	// 20-knot wind at every place, and by ten minutes or more at nineteen in
	// twenty; a front's cirrus forty minutes or more before its line,
	// wherever it crosses.
	for i, c := range tally.clouds {
		if c.places == 0 || cloudSigns[i].form == catalog.CloudFormCumulus {
			continue
		}
		if c.windFirst > 0 {
			t.Errorf("%s: the wind came first at %d of %d places", cloudSigns[i].name, c.windFirst, c.places)
		}
		if s := share(c.short, c.places); s > 5 {
			t.Errorf("%s: under %.0f minutes at %.1f%% of %d places", cloudSigns[i].name, cloudSigns[i].warnings, s, c.places)
		}
	}
	if tally.cirrusShort > 0 {
		t.Errorf("a front's cirrus came less than %d minutes before its line at %d of %d places", frontWarning, tally.cirrusShort, len(tally.cirrus))
	}
	// A fog bank's wall whitens the horizon toward it three minutes or more
	// before a boat sailing toward it at 4 knots meets very poor
	// visibility, at nineteen approaches in twenty.
	if f := &tally.fog; f.approaches > 0 {
		if s := share(f.short, f.approaches); s > 5 {
			t.Errorf("a fog bank's wall gave under %d minutes at %.1f%% of %d approaches", fogWarning, s, f.approaches)
		}
	}
	report := tally.markdown(cat) + tally.cloudsMarkdown() + tally.fogMarkdown()
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
	swell                                        [3]swellLead // by the storm's wind: 10, 15 and 20 knots
	swellStorms                                  int
	clouds                                       [3]cloudLead // by cloudSigns
	fronts, cirrusShort                          int
	cirrus                                       []float64 // a front's cirrus's leads on its line, minutes
	fog                                          fogWall
}

// swellLead is the swell's lead on a storm's own wind at the places that
// wind reaches: all of them, and those reached half an hour or more after
// the storm is whole, by its moving; how many of each the swell came to at
// least ten minutes before, and at all before, and the leads, minutes.
type swellLead struct {
	all, allShort                    int
	moving, movingShort, movingFirst int
	leads, movingLeads               []float64
}

// swellKnots are the storm's own winds the swell's lead is measured to.
var swellKnots = [3]float64{10, 15, 20}

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
	b.WriteString("| Storm hours a week, centre from the centre | 0–1 NM | 1–2 NM | 2–3 NM | 3–4 NM | 4–5 NM | beyond |\n|---|---|---|---|---|---|---|\n|")
	for _, h := range t.stormHours {
		fmt.Fprintf(&b, " %.2f |", h/weeks)
	}
	fmt.Fprintf(&b, "\n\nFronts: %d points checked, the veer across the line from %.0f° to %.0f°.\n", t.frontPoints, minOf(t.veers), maxOf(t.veers))
	fmt.Fprintf(&b, "Buys Ballot's law: %d points where a storm is the wind, all with its centre on the left.\n", t.ballotPoints)
	fmt.Fprintf(&b, "The refuge: %d points, the strongest mean wind %.2f knots, with its gusts %.2f.\n", t.refugePoints, t.refugeMean/knot, t.refugeWind/knot)
	if t.showersByDay > 0 {
		fmt.Fprintf(&b, "Showers by day over islands: %.0f%%.\n", 100*float64(t.showersOnIslands)/float64(t.showersByDay))
	}
	if t.swellStorms > 0 {
		fmt.Fprintf(&b, "\nThe storms' swell, over %d storms: its lead, from 0.3 of its height at the storm's edge, on the storm's own wind.\n\n", t.swellStorms)
		b.WriteString("| The storm's wind | Places it reaches | Lead: median, share under 10 min | Reached 30 min or more after it is whole: places, 10th percentile, median, share under 10 min, share the wind came first |\n|---|---|---|---|\n")
		for i, s := range t.swell {
			fmt.Fprintf(&b, "| %.0f kn | %d | %.1f min, %.1f%% | %d, %.1f min, %.1f min, %.1f%%, %.1f%% |\n", swellKnots[i], s.all,
				percentile(s.leads, 0.5), share(s.allShort, s.all), s.moving, percentile(s.movingLeads, 0.1), percentile(s.movingLeads, 0.5),
				share(s.movingShort, s.moving), share(s.moving-s.movingFirst, s.moving))
		}
	}
	return b.String()
}

func share(n, of int) float64 {
	if of == 0 {
		return 0
	}
	return 100 * float64(n) / float64(of)
}

// percentile is a's p-quantile, nearest rank, or NaN for none.
func percentile(a []float64, p float64) float64 {
	if len(a) == 0 {
		return math.NaN()
	}
	s := slices.Clone(a)
	slices.Sort(s)
	return s[min(int(p*float64(len(s))), len(s)-1)]
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
			wob := physics.SystemAt(&s.SystemRecord, float64(at))
			cx, cy := wob.East/4, wob.North/4
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

// checkSwell tallies the week's storms' swell's lead on their own wind: on
// a grid step apart over the disk, every minute from a storm's birth to its
// end, the first tick its swell, over open water, is 0.3 of its height at
// its edge, and the first its own wind, alone in still air, blows 10, 15
// and 20 knots.
func checkSwell(tl *Timeline, w *Week, waves *physics.Waves, step float64, tally *weeksTally) {
	p := tl.Prepared()
	edge := 0.97 * p.Edge()
	type place struct {
		x, y  float64
		swell int64
		wind  [3]int64
	}
	for _, s := range w.Systems {
		r := &s.SystemRecord
		if !p.RaisesSwell(r.Kind) {
			continue
		}
		tally.swellStorms++
		h := 0.3 * physics.SwellHeight(p, r)
		var places []place
		for x := -edge; x <= edge; x += step {
			for y := -edge; y <= edge; y += step {
				if math.Hypot(x, y) <= edge {
					places = append(places, place{x: x, y: y, swell: -1, wind: [3]int64{-1, -1, -1}})
				}
			}
		}
		for tick := int64(r.Born); tick < int64(r.Gone); tick += ticksPerMinute {
			own := stormOnly(tl, tick, s.Slot)
			for i := range places {
				pl := &places[i]
				if pl.swell < 0 && physics.SwellAt(waves, p, r, pl.x, pl.y, float64(tick)).Height >= h {
					pl.swell = tick
				}
				if pl.wind[0] >= 0 && pl.wind[1] >= 0 && pl.wind[2] >= 0 {
					continue
				}
				v, _ := meanAt(own, pl.x, pl.y)
				for k, kn := range swellKnots {
					if pl.wind[k] < 0 && v >= kn*knot {
						pl.wind[k] = tick
					}
				}
			}
		}
		for _, pl := range places {
			for k := range swellKnots {
				if pl.wind[k] < 0 {
					continue
				}
				sl := &tally.swell[k]
				lead := math.Inf(-1)
				if pl.swell >= 0 {
					lead = float64(pl.wind[k]-pl.swell) / ticksPerMinute
				}
				sl.all++
				sl.leads = append(sl.leads, lead)
				short := lead < 10
				if short {
					sl.allShort++
				}
				if float64(pl.wind[k]) >= r.Mature+30*ticksPerMinute {
					sl.moving++
					sl.movingLeads = append(sl.movingLeads, lead)
					if short {
						sl.movingShort++
					}
					if lead > 0 {
						sl.movingFirst++
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
