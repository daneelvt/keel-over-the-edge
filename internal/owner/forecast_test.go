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
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	position "github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen/chart"
)

// dayTick is a day of world time.
const dayTick int64 = 24 * 3600 * physics.StepsPerSecond

// sampleTicks are the sample week's ticks the forecast's tests sail from:
// the first issue with a gale warning in force, the issue before it having
// none; an issue with a front crossing the disk, and one with a warm front
// crossing; and an issue after the opening with three systems alive and
// one born after it. Found once.
var sampleTicks = sync.OnceValues(func() (sampleWeek, error) {
	cat, err := catalog.Load()
	if err != nil {
		return sampleWeek{}, err
	}
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		return sampleWeek{}, err
	}
	every := tl.Prepared().ForecastEvery()
	var s sampleWeek
	var f physics.Forecast
	for at := int64(0); at < 4*dayTick && (s.gale == 0 || s.front == 0 || s.warm == 0 || s.busy == 0); at += every {
		if _, ok := galeAt(tl, at); ok && s.gale == 0 {
			s.gale = at
		}
		tl.Forecast(at, nil, nil, worldEnd(tl), &f)
		for i := range int(f.Head.NSpells) {
			sp := &f.Spells[i]
			if sp.Front != 0 && sp.Begin < float64(at) && float64(at) < sp.Begin+sp.Change {
				if s.front == 0 {
					s.front = at
				}
				if sp.Warm != 0 && s.warm == 0 {
					s.warm = at
				}
			}
		}
		alive, born := 0, 0
		for i := range int(f.Head.NSystems) {
			if r := &f.Systems[i]; r.Born+f.Head.Origin <= float64(at) {
				alive++
			} else {
				born++
			}
		}
		if s.busy == 0 && at > tl.Config().Week.Opening && alive >= 3 && born > 0 {
			s.busy = at
		}
	}
	if s.gale == 0 || s.front == 0 || s.warm == 0 || s.busy == 0 {
		return s, fmt.Errorf("the sample week's first four days lack a tick: %+v", s)
	}
	return s, nil
})

// sampleWeek are the ticks sampleTicks finds.
type sampleWeek struct{ gale, front, warm, busy int64 }

// ticksOf is the sample week's ticks, or the test's end.
func ticksOf(t testing.TB) sampleWeek {
	t.Helper()
	s, err := sampleTicks()
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// forecastConfig is the owner's tools on a sky rig's world with the
// catalog's words, outlook and kinds, and the world's sky, its epoch the
// sample week's.
func forecastConfig(r *skyRig) Config {
	regimes := make([]string, len(r.cat.Weather.Regimes))
	for i, g := range r.cat.Weather.Regimes {
		regimes[i] = string(g.ID)
	}
	kinds := make([]string, len(r.cat.Weather.Systems))
	var wk []WeatherKind
	for i, k := range r.cat.Weather.Systems {
		kinds[i] = string(k.ID)
		wk = append(wk, WeatherKind{Name: k.Name, Symbol: string(k.Symbol), Rain: k.Rain.Rate > 0, Trough: k.Symbol == catalog.SystemKindSymbolDashed})
	}
	return Config{
		Frames: r.w.Bus().Frames, Owner: r.w.Bus().Commands.Owner(), Weather: r.tl.Prepared(), Timeline: r.tl,
		Regimes: regimes, SystemKinds: kinds, WeatherKinds: wk, Sky: r.cat.PrepareSky(),
		World: World{Number: 1, Epoch: time.UnixMicro(weather.SampleEpoch)},
		Words: weather.WordsOf(r.cat), Outlook: r.cat.Weather.Forecast.Outlook.Samples,
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
// made from the week: every system alive at the issue or born within its
// reach, with its track each minute to the last tick the forecast knows,
// and the track is the truth, the week's own keyframes at those minutes,
// to the bit. With the issuer, the issue is the issuer's, the same.
func TestForecastSystems(t *testing.T) {
	busy := ticksOf(t).busy
	r := newForecastRig(t, busy)
	tl, p := r.tl, r.tl.Prepared()
	tick := busy + 7*60*physics.StepsPerSecond
	var page forecastPage
	size := r.get(t, fmt.Sprintf("/owner/api/forecast.json?at=%d", tick), &page)
	f, _ := madeForecast(tl, tick)
	t.Logf("forecast.json: %d bytes, %d systems, %d spells", size, len(page.Systems), len(page.Spells))
	if page.Issue != tl.IssueAt(tick) || page.At != tick || page.Issued || page.Steps != int(f.Head.Steps) || page.Steps != int(p.ForecastSteps()) ||
		page.Step != p.ForecastStep() || page.Until != page.Issue+p.ForecastReach() || page.Every != trackEvery ||
		len(page.Systems) != int(f.Head.NSystems) || len(page.Systems) == 0 || len(page.Spells) != int(f.Head.NSpells) {
		t.Fatalf("the page: issue %d at %d, issued %v, %d steps of %d, until %d, %d systems, %d spells", page.Issue, page.At, page.Issued,
			page.Steps, page.Step, page.Until, len(page.Systems), len(page.Spells))
	}
	alive, born := 0, 0
	for i, s := range page.Systems {
		fs := &f.Systems[i]
		if s.Slot != int(f.Head.Slots[i]) || s.Kind != int(fs.Kind) || s.Seed != uint32(fs.Seed) || s.ID != string(r.cat.Weather.Systems[s.Kind].ID) ||
			s.Born != int64(fs.Born+f.Head.Origin) || s.Gone != int64(fs.Gone+f.Head.Origin) || s.Size != fs.Size || s.Length != fs.Length {
			t.Fatalf("system %d: %+v", i, s)
		}
		if s.From < page.Issue || s.From < s.Born || s.From-trackEvery >= max(s.Born, page.Issue) || (s.From-page.Issue)%trackEvery != 0 {
			t.Fatalf("system %d's track from %d, born %d, the issue %d", i, s.From, s.Born, page.Issue)
		}
		for k, pt := range s.Track {
			at := s.From + int64(k)*trackEvery
			var truth physics.Keyframe
			tl.Keyframe(at, nil, &truth)
			ts := &truth.Systems[s.Slot]
			if at > page.Until || ts.On == 0 || ts.Seed != float64(s.Seed) ||
				pt != [4]float64{ts.East / 4, ts.North / 4, round3(ts.Strength / 4096), round2(ts.Heading * 360 / physics.TurnSteps)} {
				t.Fatalf("system %d at %d: %v; the truth %+v", i, at, pt, ts)
			}
		}
		if last := s.From + int64(len(s.Track))*trackEvery; last <= page.Until && last < s.Gone {
			t.Fatalf("system %d's track stops at %d, before it is gone at %d or the forecast's last %d", i, last, s.Gone, page.Until)
		}
		if s.Born <= page.Issue {
			alive++
		} else {
			born++
		}
	}
	if alive < 3 || born == 0 {
		t.Fatalf("%d systems alive at the issue, %d born after it", alive, born)
	}
	for i, s := range page.Spells {
		if s.Regime != int(f.Spells[i].Regime) || s.ID != string(r.cat.Weather.Regimes[s.Regime].ID) || s.Warm != (f.Spells[i].Warm != 0) {
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

// TestForecastFront: a front crossing at the issue is on the page as its
// forecast spell has it, and a warm front is told from a cold.
func TestForecastFront(t *testing.T) {
	ticks := ticksOf(t)
	r := newForecastRig(t, 1000)
	for _, tick := range []int64{ticks.front, ticks.warm} {
		var page forecastPage
		r.get(t, fmt.Sprintf("/owner/api/forecast.json?at=%d", tick), &page)
		f, _ := madeForecast(r.tl, tick)
		var want []forecastFrontJSON
		for i := range int(f.Head.NSpells) {
			if s := &f.Spells[i]; s.Front != 0 && s.Change > 0 {
				want = append(want, forecastFrontJSON{Toward: round2(s.Toward * 360 / physics.TurnSteps), Begin: int64(s.Begin), Cross: int64(s.Change), Warm: s.Warm != 0})
			}
		}
		if len(want) == 0 || fmt.Sprint(page.Fronts) != fmt.Sprint(want) || page.Reach != round2(r.tl.Prepared().FrontReach()) {
			t.Fatalf("at %d the fronts %+v; the forecast's %+v", tick, page.Fronts, want)
		}
		if tick == ticks.warm && !slices.ContainsFunc(page.Fronts, func(f forecastFrontJSON) bool { return f.Warm }) {
			t.Fatalf("at %d no warm front: %+v", tick, page.Fronts)
		}
	}
}

// TestForecastGale: the first gale warning of the sample week is on the
// page, keyed by its own issue, in the words the news tells it, from the
// nearest island charted; each step's area is the scan's points; the next
// issue in force keeps its key. Through the issuer, the same.
func TestForecastGale(t *testing.T) {
	galeTick := ticksOf(t).gale
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
	galeTick := ticksOf(t).gale
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

// TestPlaceWeather: place.json's box at a point is weather.BoxOf of
// weather.PlaceAt there at the tick, its points about it; its position
// chart.Format's; its outlook the forecast's. An island's is measured over
// its bounds, a place's about it.
func TestPlaceWeather(t *testing.T) {
	galeTick := ticksOf(t).gale
	r := newForecastRig(t, galeTick)
	land := newRig(t, 0)
	r.o.cfg.Bundle = land.o.cfg.Bundle
	tl := r.tl
	words := weather.WordsOf(r.cat)
	tick := int64(galeTick + 40*60*physics.StepsPerSecond)
	minute := int64(60 * physics.StepsPerSecond)
	boxAt := func(points [9][2]float64) weather.Box {
		pw := weather.PlaceAt(physicsAt(tl, tick, nil, nil), physicsAt(tl, tick-5*minute, nil, nil), physicsAt(tl, tick-15*minute, nil, nil), &points)
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
