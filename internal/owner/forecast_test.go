// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"math/bits"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	position "github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen/chart"
)

// The sample week's ticks the forecast's tests sail from: a day; a front
// crossing the disk at the issue; the first issue with a gale warning in
// force, a little after two days, the issue before it having none; and an
// issue soon after, with three systems alive and a low forming.
const (
	dayTick   int64 = 24 * 3600 * physics.StepsPerSecond
	frontTick int64 = 4_734_000
	galeTick  int64 = 5_202_000
	stormTick int64 = 5_238_000
)

// forecastConfig is the owner's tools on a sky rig's world with the
// catalog's words, risks, fog and outlook, and the world's sky, its epoch
// the sample week's.
func forecastConfig(r *skyRig) Config {
	risks, fog := weather.RisksOf(r.cat)
	regimes := make([]string, len(r.cat.Weather.Regimes))
	for i, g := range r.cat.Weather.Regimes {
		regimes[i] = string(g.ID)
	}
	kinds := make([]string, len(r.cat.Weather.Systems))
	for i, k := range r.cat.Weather.Systems {
		kinds[i] = string(k.ID)
	}
	return Config{
		Frames: r.w.Bus().Frames, Owner: r.w.Bus().Commands.Owner(), Weather: r.tl.Prepared(), Timeline: r.tl,
		Regimes: regimes, SystemKinds: kinds, Sky: r.cat.PrepareSky(),
		World: World{Number: 1, Epoch: time.UnixMicro(weather.SampleEpoch)},
		Words: weather.WordsOf(r.cat), Risks: risks, Fog: fog, Outlook: r.cat.Weather.Forecast.Outlook.Samples,
		Log: slog.New(slog.DiscardHandler),
	}
}

// newForecastRig is the sample week sailed from a tick, the owner's tools
// on it as forecastConfig makes them.
func newForecastRig(t testing.TB, tick int64) *skyRig {
	t.Helper()
	r := newSkyRig(t, tick)
	r.o = New(forecastConfig(r))
	return r
}

// madeForecast is the issue at a tick of the week's own weather, and its
// gale scan over open water, as a world issues them.
func madeForecast(tl *weather.Timeline, tick int64) (physics.Forecast, physics.Gales) {
	p := tl.Prepared()
	var f physics.Forecast
	var g physics.Gales
	tl.Forecast(tl.IssueAt(tick), nil, nil, worldEnd(tl), &f)
	water := make([]uint8, int(p.GaleSide())*int(p.GaleSide()))
	physics.GaleWater(p, nil, water)
	physics.GaleScan(p, &f, new(physics.Weather), new(physics.WeatherTick), water, make([]uint8, len(water)), &g)
	return f, g
}

// TestForecastSystems: forecast.json at a tick is the issue in force then,
// made from the week: each system where the forecast puts it at each step,
// its cone growing from nothing with the lead, a forming low's constant;
// each spell with its regime's risk. With the issuer, the issue is the
// issuer's, the same.
func TestForecastSystems(t *testing.T) {
	r := newForecastRig(t, stormTick)
	tl, p := r.tl, r.tl.Prepared()
	tick := stormTick + 7*60*physics.StepsPerSecond
	var page forecastPage
	size := r.get(t, fmt.Sprintf("/owner/api/forecast.json?at=%d", tick), &page)
	f, _ := madeForecast(tl, tick)
	t.Logf("forecast.json: %d bytes, %d systems, %d spells", size, len(page.Systems), len(page.Spells))
	if page.Issue != tl.IssueAt(tick) || page.At != tick || page.Issued || page.Steps != int(f.Head.Steps) || page.Steps != int(p.ForecastSteps()) ||
		page.Step != p.ForecastStep() || len(page.Systems) != int(f.Head.NSystems) || len(page.Systems) == 0 || len(page.Spells) != int(f.Head.NSpells) {
		t.Fatalf("the page: issue %d at %d, issued %v, %d steps of %d, %d systems, %d spells", page.Issue, page.At, page.Issued,
			page.Steps, page.Step, len(page.Systems), len(page.Spells))
	}
	alive, forming := 0, 0
	for i, s := range page.Systems {
		fs := &f.Systems[i]
		if s.Slot != int(fs.Slot) || s.Kind != int(fs.Kind) || s.Forming != (fs.Forming != 0) || s.ID != string(r.cat.Weather.Systems[s.Kind].ID) {
			t.Fatalf("system %d: %+v", i, s)
		}
		for k, st := range s.Steps {
			if !(fs.Strength[k] > 0) {
				if st != [4]float64{} {
					t.Fatalf("system %d at step %d, not alive: %v", i, k, st)
				}
				continue
			}
			cone := physics.ForecastCone(p, &f, fs, int32(k))
			if st[0] != fs.East[k] || st[1] != fs.North[k] || st[2] != round2(cone) || st[3] != round3(fs.Strength[k]/256) {
				t.Fatalf("system %d at step %d: %v; the forecast's %v, %v, cone %v", i, k, st, fs.East[k], fs.North[k], cone)
			}
			switch {
			case s.Forming && st[2] != round2(physics.ForecastCone(p, &f, fs, 0)):
				t.Fatalf("a forming low's cone at step %d: %v", k, st[2])
			case !s.Forming && k > 0 && st[2] <= s.Steps[k-1][2] && s.Steps[k-1][3] > 0:
				t.Fatalf("system %d's cone does not grow at step %d: %v", i, k, s.Steps)
			}
		}
		if s.Forming {
			forming++
		} else {
			alive++
			if s.Steps[0][2] != 0 {
				t.Fatalf("system %d's cone at the issue: %v", i, s.Steps[0][2])
			}
		}
	}
	if alive < 2 || forming == 0 {
		t.Fatalf("%d systems alive at the issue, %d forming", alive, forming)
	}
	risks, _ := weather.RisksOf(r.cat)
	for i, s := range page.Spells {
		if s.Regime != int(f.Spells[i].Regime) || s.ID != string(r.cat.Weather.Regimes[s.Regime].ID) || s.Risk != risks[s.Regime].Sky || s.Risk == "" {
			t.Fatalf("spell %d: %+v", i, s)
		}
	}

	// The issuer's issue, as the players are sent it.
	is := forecast.New(forecast.Config{Timeline: tl})
	is.Update(context.Background(), tick, nil, nil)
	cfg := forecastConfig(r)
	cfg.Forecasts = is
	r.o = New(cfg)
	var issued forecastPage
	r.get(t, fmt.Sprintf("/owner/api/forecast.json?at=%d", tick), &issued)
	if !issued.Issued || issued.Issue != page.Issue || len(issued.Systems) != len(page.Systems) {
		t.Fatalf("the issuer's: issued %v, issue %d, %d systems", issued.Issued, issued.Issue, len(issued.Systems))
	}
	for i := range page.Systems {
		if fmt.Sprint(issued.Systems[i]) != fmt.Sprint(page.Systems[i]) {
			t.Fatalf("system %d: the issuer's %+v, made here %+v", i, issued.Systems[i], page.Systems[i])
		}
	}
	// A tick a day off is made here, not asked of the issuer.
	r.get(t, fmt.Sprintf("/owner/api/forecast.json?at=%d", tick+dayTick), &issued)
	if issued.Issued || issued.Issue != tl.IssueAt(tick+dayTick) {
		t.Fatalf("a day off: issued %v, issue %d", issued.Issued, issued.Issue)
	}
	if code := r.code(t, "/owner/api/forecast.json?at=x"); code != 400 {
		t.Fatalf("at, not a tick: %d", code)
	}
}

// code is the status of a GET of path.
func (r *skyRig) code(t testing.TB, path string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	r.o.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "http://localhost:9090"+path, nil))
	return rec.Code
}

// galeAt is the gale warning of the issue in force at a tick, if any.
func galeAt(tl *weather.Timeline, tick int64) (weather.Gale, bool) {
	f, g := madeForecast(tl, tick)
	return weather.GaleOf(&f, &g)
}

// TestForecastFront: a front crossing at the issue has its forecast line at
// each step it crosses, where its forecast spell puts it, and its band about
// it, nothing at the issue and widening with the lead.
func TestForecastFront(t *testing.T) {
	r := newForecastRig(t, 1000)
	p := r.tl.Prepared()
	var page forecastPage
	r.get(t, fmt.Sprintf("/owner/api/forecast.json?at=%d", frontTick), &page)
	f, _ := madeForecast(r.tl, frontTick)
	if len(page.Fronts) == 0 {
		t.Fatal("no front")
	}
	var s *physics.Spell
	for i := range int(f.Head.NSpells) {
		if f.Spells[i].Front != 0 && f.Spells[i].Begin <= float64(frontTick) {
			s = &f.Spells[i]
		}
	}
	fr := page.Fronts[0]
	if s == nil || fr.Begin != int64(s.Begin) || fr.Cross != int64(s.Change) || fr.Toward != round2(s.Toward*360/physics.TurnSteps) {
		t.Fatalf("the front %+v; the forecast's %+v", fr, s)
	}
	reach := p.FrontReach()
	last := -1.0
	for k, l := range fr.Lines {
		at := f.Head.Issue + float64(k)*f.Head.Step
		if l == nil {
			if at >= s.Begin && at <= s.Begin+s.Change {
				t.Fatalf("no line at step %d, as it crosses", k)
			}
			continue
		}
		line := 2*reach*(at-s.Begin)/s.Change - reach
		band := physics.FrontBand(p, s, at-f.Head.Issue)
		if l[0] != round2(line) || l[1] != round2(band) || (k == 0) != (l[1] == 0) || l[1] <= last && k > 0 {
			t.Fatalf("step %d: line %v, band %v; the forecast's %v, %v", k, l[0], l[1], line, band)
		}
		last = l[1]
	}
	t.Logf("the front's band at the last step: %.0f m", last)
}

// TestForecastGale: the first gale warning of the sample week is on the
// page, keyed by its own issue, in the words the news tells it, from the
// nearest island charted; each step's area is the scan's points; the next
// issue in force keeps its key. Through the issuer, the same.
func TestForecastGale(t *testing.T) {
	r := newForecastRig(t, 1000)
	tl, p := r.tl, r.tl.Prepared()
	words := weather.WordsOf(r.cat)
	f, g := madeForecast(tl, galeTick)
	gale, ok := weather.GaleOf(&f, &g)
	if !ok {
		t.Fatal("no gale at the sample week's first")
	}
	if _, before := galeAt(tl, galeTick-p.ForecastEvery()); before {
		t.Fatal("a gale at the issue before the first")
	}
	// An island charted to the north of the disk, and one not charted
	// nearer the gale: the warning is told from the charted.
	b := worldgen.Empty(1)
	b.Islands = []worldgen.Island{{Number: 0, Name: "Gannet Holm", X: 0, Y: 3000, Group: -1}, {Number: 1, Name: "Unknown", X: gale.East, Y: gale.North, Group: -1}}
	r.o.cfg.Bundle = b
	r.o.cfg.Charted = func() []Charted { return []Charted{{Subject: "island", Number: 0}} }
	want := weather.Warning{
		From: gale.From, Force: int(gale.Force), East: gale.East, North: gale.North, Place: "Gannet Holm", PlaceNorth: 3000,
		First: float64(int64(gale.First)*p.ForecastStep()) / (60 * physics.StepsPerSecond),
	}
	text := weather.WarningText(&want, &words)

	var page forecastPage
	r.get(t, fmt.Sprintf("/owner/api/forecast.json?at=%d", galeTick+100), &page)
	gj := page.Gale
	if gj == nil || gj.Key != galeTick || gj.Force != int(gale.Force) || gj.Words != text || gj.Place != "Gannet Holm" || gj.First != int(gale.First) ||
		!strings.Contains(text, "of Gannet Holm") {
		t.Fatalf("the gale %+v; want %q", gj, text)
	}
	t.Logf("the warning: %q", gj.Words)
	if page.GaleSide != int(p.GaleSide()) || page.GaleGrid != round2(p.GaleGrid()) || len(gj.Areas) != page.Steps {
		t.Fatalf("the grid: %d a side, %v apart, %d areas", page.GaleSide, page.GaleGrid, len(gj.Areas))
	}
	for k, a := range gj.Areas {
		raw, err := base64.StdEncoding.DecodeString(a)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, c := range raw {
			n += bits.OnesCount8(c)
		}
		if float64(n) != g.Steps[k].Points || (a == "") != (g.Steps[k].Points == 0) || a != "" && len(raw) != (page.GaleSide*page.GaleSide+7)/8 {
			t.Fatalf("step %d: %d points in its area, the scan's %v", k, n, g.Steps[k].Points)
		}
	}
	// The scan the page makes is the physics' own.
	if got, _ := r.o.galeAreas(p, &f); got != g {
		t.Fatal("the page's gale scan is not physics.GaleScan's")
	}
	// The issue after, if a gale is still in force, keeps the first's key.
	next := galeTick + p.ForecastEvery()
	if _, still := galeAt(tl, next); still {
		r.get(t, fmt.Sprintf("/owner/api/forecast.json?at=%d", next), &page)
		if page.Gale == nil || page.Gale.Key != galeTick {
			t.Fatalf("the issue after: %+v", page.Gale)
		}
	}

	// Through the issuer, told from the island it named.
	is := forecast.New(forecast.Config{Timeline: tl, Nearest: func(float64, float64) forecast.Place {
		return forecast.Place{Subject: 1, Number: 0}
	}})
	is.Update(context.Background(), galeTick+100, nil, nil)
	cfg := forecastConfig(r)
	cfg.Forecasts, cfg.Bundle, cfg.Charted = is, b, r.o.cfg.Charted
	r.o = New(cfg)
	var issued forecastPage
	rec := r.get(t, fmt.Sprintf("/owner/api/forecast.json?at=%d", galeTick+100), &issued)
	if !issued.Issued || issued.Gale == nil || issued.Gale.Key != galeTick || issued.Gale.Words != text {
		t.Fatalf("the issuer's: %d, issued %v, gale %+v", rec, issued.Issued, issued.Gale)
	}
}

// TestGaleWarnings: gales.json lists every gale warning from the world's
// beginning to the issue in force now, each the issues in a row with a
// gale, keyed by the first, with the most force of any; the last in force
// now if its gale is.
func TestGaleWarnings(t *testing.T) {
	now := int64(galeTick + 2*3600*physics.StepsPerSecond)
	r := newForecastRig(t, now)
	tl, p := r.tl, r.tl.Prepared()
	words := weather.WordsOf(r.cat)
	start := time.Now()
	var page galesPage
	r.get(t, "/owner/api/gales.json", &page)
	t.Logf("gales.json: %v, %d warnings", time.Since(start), len(page.Warnings))
	issue := tl.IssueAt(r.w.Latest().Tick)
	if page.Issue != issue || page.Every != p.ForecastEvery() {
		t.Fatalf("the page: issue %d of %d, every %d", page.Issue, issue, page.Every)
	}
	// The warnings, found issue by issue.
	var want []galeWarning
	for at := int64(0); at <= issue; at += p.ForecastEvery() {
		f, g := madeForecast(tl, at)
		gale, ok := weather.GaleOf(&f, &g)
		if !ok {
			continue
		}
		if n := len(want); n > 0 && want[n-1].Last == at-p.ForecastEvery() {
			want[n-1].Last, want[n-1].Force = at, max(want[n-1].Force, int(gale.Force))
			continue
		}
		w := weather.Warning{From: gale.From, Force: int(gale.Force), East: gale.East, North: gale.North,
			First: float64(int64(gale.First)*p.ForecastStep()) / (60 * physics.StepsPerSecond)}
		want = append(want, galeWarning{Key: at, Last: at, Force: int(gale.Force), Words: weather.WarningText(&w, &words)})
	}
	if len(want) == 0 || len(page.Warnings) != len(want) || want[0].Key != galeTick {
		t.Fatalf("%d warnings, want %d", len(page.Warnings), len(want))
	}
	for i, w := range want {
		got := page.Warnings[i]
		if got.Key != w.Key || got.Last != w.Last || got.Force != w.Force || got.Words != w.Words || got.InForce != (w.Last == issue) {
			t.Fatalf("warning %d: %+v; want %+v", i, got, w)
		}
	}
	// Asked again, the same, from what was kept.
	start = time.Now()
	var again galesPage
	r.get(t, "/owner/api/gales.json", &again)
	if fmt.Sprint(again.Warnings) != fmt.Sprint(page.Warnings) || time.Since(start) > time.Second {
		t.Fatalf("asked again, in %v: %+v", time.Since(start), again.Warnings)
	}
}

// TestCalibration: calibration.json is the share of the truth inside the
// cones at each lead over every issue whose horizon has passed, three days
// of the sample week with its first front and its first storm, near four
// in five for the systems alive at the issue; carried forward from an
// earlier tally, it is the tally made at once.
func TestCalibration(t *testing.T) {
	r := newForecastRig(t, 3*dayTick)
	tl, p := r.tl, r.tl.Prepared()
	var page calibrationPage
	r.get(t, "/owner/api/calibration.json", &page)
	now := r.w.Latest().Tick
	issues := 0
	for at := int64(0); at+p.ForecastHorizon() <= now; at += p.ForecastEvery() {
		issues++
	}
	if page.Issues != issues || page.From != 0 || len(page.Leads) != int(p.ForecastSteps())-1 || page.Leads[0] != 10 ||
		len(page.Alive) != len(page.Leads) || len(page.Forming) != len(page.Leads) || len(page.Fronts) != len(page.Leads) {
		t.Fatalf("the page: %d issues of %d, from %d, leads %v", page.Issues, issues, page.From, page.Leads)
	}
	share := func(c [][2]int) (float64, int) {
		in, n := 0, 0
		for _, x := range c {
			in, n = in+x[0], n+x[1]
		}
		return 100 * float64(in) / float64(max(n, 1)), n
	}
	alive, n := share(page.Alive)
	forming, nf := share(page.Forming)
	fronts, nfr := share(page.Fronts)
	t.Logf("three days: %.1f%% of %d systems alive at the issue, %.1f%% of %d lows forming, %.1f%% of %d fronts' lines", alive, n, forming, nf, fronts, nfr)
	if n < 500 || alive < 65 || alive > 95 {
		t.Fatalf("the cones held %.1f%% of %d systems", alive, n)
	}
	// Each lead's tally, as the week's forecasts and truth make it.
	var want [physics.MaxForecastSteps][2]int
	var f physics.Forecast
	for at := int64(0); at+p.ForecastHorizon() <= now; at += p.ForecastEvery() {
		tl.Forecast(at, nil, nil, worldEnd(tl), &f)
		for i := range int(f.Head.NSystems) {
			s := &f.Systems[i]
			rec := recordOf(tl.Week(), s, at)
			if rec == nil || s.Forming != 0 {
				continue
			}
			for k := int32(1); k < int32(f.Head.Steps); k++ {
				truth := physics.SystemAt(rec, float64(at)+float64(k)*f.Head.Step)
				if s.Strength[k] > 0 && truth.On != 0 {
					want[k][1]++
					if math.Hypot(truth.East/4-s.East[k], truth.North/4-s.North[k]) <= physics.ForecastCone(p, &f, s, k) {
						want[k][0]++
					}
				}
			}
		}
	}
	for k, c := range page.Alive {
		if c != want[k+1] {
			t.Fatalf("lead %v: %v, want %v", page.Leads[k], c, want[k+1])
		}
	}
	// Carried forward from half the day, the same as made at once.
	o := New(forecastConfig(r))
	o.calibrationPage(tl, now/2)
	carried := o.calibrationPage(tl, now)
	if fmt.Sprint(carried.Alive, carried.Forming, carried.Fronts, carried.Issues) != fmt.Sprint(page.Alive, page.Forming, page.Fronts, page.Issues) {
		t.Fatalf("carried forward: %+v; at once %+v", carried, page)
	}
}

// TestPlaceWeather: place.json's box at a point is weather.BoxOf of
// weather.PlaceAt there at the tick, its points about it, the sun's height
// the sky's; its position chart.Format's; its outlook the forecast's. An
// island's is measured over its bounds, a place's about it.
func TestPlaceWeather(t *testing.T) {
	r := newForecastRig(t, galeTick)
	land := newRig(t, 0)
	r.o.cfg.Bundle = land.o.cfg.Bundle
	tl := r.tl
	words := weather.WordsOf(r.cat)
	risks, fog := weather.RisksOf(r.cat)
	tick := int64(galeTick + 40*60*physics.StepsPerSecond)
	minute := int64(60 * physics.StepsPerSecond)
	s := r.cat.PrepareSky()
	sun := func(t int64, x, y float64) float64 {
		return sky.SunAltitude(s, sky.Time(s, float64(weather.SampleEpoch), float64(worldMicros(t))), x, y)
	}
	boxAt := func(points [9][2]float64) weather.Box {
		c := points[0]
		pw := weather.PlaceAt(physicsAt(tl, tick, nil, nil), physicsAt(tl, tick-5*minute, nil, nil), physicsAt(tl, tick-15*minute, nil, nil),
			&points, risks, fog, [2]float64{sun(tick, c[0], c[1]), sun(tick-fog.Dawn, c[0], c[1])})
		return weather.BoxOf(&pw, &words)
	}
	var page placeWeatherPage
	r.get(t, fmt.Sprintf("/owner/api/place.json?east=1500&north=-2500&at=%d", tick), &page)
	want := boxAt(weather.PlacePoints(1500, -2500, nil))
	if page.Box != want || page.Position != position.Format(1500, -2500) || page.East != 1500 || page.North != -2500 || page.Name != "" ||
		page.At != tick || page.Issue != tl.IssueAt(tick) || want.Wind == "" {
		t.Fatalf("the point: %+v; want %+v", page, want)
	}
	if page.Outlook == "" || !strings.HasSuffix(page.Outlook, ".") || strings.Count(page.Outlook, ". ") != 2 {
		t.Fatalf("the outlook: %q", page.Outlook)
	}
	t.Logf("%s: %+v; %s", page.Position, page.Box, page.Outlook)

	b := land.o.cfg.Bundle
	x0, y0, x1, y1, _ := chart.IslandBounds(b, 0)
	r.get(t, fmt.Sprintf("/owner/api/place.json?island=0&at=%d", tick), &page)
	if want := boxAt(weather.PlacePoints(2000, 0, &[4]float64{x0, y0, x1, y1})); page.Box != want || page.Name != "Hill" || page.Position != position.Format(2000, 0) {
		t.Fatalf("the island: %+v; want %+v", page, want)
	}
	r.get(t, fmt.Sprintf("/owner/api/place.json?place=1&at=%d", tick), &page)
	if want := boxAt(weather.PlacePoints(2000, 110, nil)); page.Box != want || page.Name != "Blowers Rocks" {
		t.Fatalf("the place: %+v; want %+v", page, want)
	}
	for path, code := range map[string]int{"island=7": 404, "place=9": 404, "east=x&north=0": 400, "east=0&north=0&at=x": 400} {
		if got := r.code(t, "/owner/api/place.json?"+path); got != code {
			t.Errorf("%s: %d, want %d", path, got, code)
		}
	}
}

// TestPlaceAtAPosition: a flagged boat is put at a position as written,
// within its minute; one over land, beyond the lip or not a position is
// refused.
func TestPlaceAtAPosition(t *testing.T) {
	r := newRig(t, 0)
	ann := r.join(t, 1, "Ann", store.Human, true)
	text := func(s string) *string { return &s }
	for name, pos := range map[string]string{
		"over land":        position.Format(2000, 0),
		"beyond the lip":   position.Format(0, 8600),
		"not a position":   "somewhere north",
		"a south latitude": "67°24′S 045°12′",
	} {
		code, body := r.do(t, "POST", "/owner/api/place", PlaceRequest{Boat: ann, Position: text(pos)})
		r.w.Tick()
		if code < 400 {
			t.Errorf("%s: %d %s", name, code, body)
		}
	}
	at := position.Format(-3000, 4000)
	code, body := r.do(t, "POST", "/owner/api/place", PlaceRequest{Boat: ann, Position: &at})
	r.w.Tick()
	if code != 200 {
		t.Fatalf("to %s: %d %s", at, code, body)
	}
	if st := r.w.Latest().State[0]; math.Hypot(st.X+3000, st.Y-4000) > 5 || position.Format(st.X, st.Y) != at {
		t.Fatalf("at %+v, %s; asked for %s", st, position.Format(st.X, st.Y), at)
	}
	var pt struct {
		Position string `json:"position"`
	}
	if code, body := r.do(t, "GET", "/owner/api/point?east=-3000&north=4000", nil); code != 200 || json.Unmarshal(body, &pt) != nil || pt.Position != at {
		t.Fatalf("the point's position: %d %s", code, body)
	}
}
