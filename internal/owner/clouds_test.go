// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// skyRig is a world in the catalog's sample week from tick, with no land,
// and the owner's tools of it.
type skyRig struct {
	cat *catalog.Catalog
	tl  *weather.Timeline
	w   *sim.World
	o   *Owner
}

func newSkyRig(t testing.TB, tick int64) *skyRig {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	_, kinds := cat.Prepare()
	w, err := sim.New(sim.Config{Capacity: 8, Kinds: kinds, Workers: 1, Tick: tick, Weather: tl, Encounters: cat.PrepareEncounters()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	w.Tick()
	o := New(Config{Frames: w.Bus().Frames, Owner: w.Bus().Commands.Owner(), Weather: tl.Prepared(), Timeline: tl, Log: slog.New(slog.DiscardHandler)})
	return &skyRig{cat: cat, tl: tl, w: w, o: o}
}

// get asks the owner's tools for path, as the owner's browser does,
// decodes its JSON into v and returns its length.
func (r *skyRig) get(t testing.TB, path string, v any) int {
	t.Helper()
	rec := httptest.NewRecorder()
	r.o.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "http://localhost:9090"+path, nil))
	if rec.Code != 200 {
		t.Fatalf("%s: %d %s", path, rec.Code, rec.Body)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return rec.Body.Len()
}

// at is the grid's values at the point nearest (x, y).
func (g *cloudGrid) at(x, y float64) []float64 {
	per := len(g.Values) / (g.Side * g.Side)
	i := int(math.Round((x - g.West) / g.Step))
	j := int(math.Round((g.North - y) / g.Step))
	k := (j*g.Side + i) * per
	return g.Values[k : k+per]
}

// TestCloudsComingFront: the cirrus a coming front carries ahead of its
// line is on the page, beyond the lip, before its spell is in play, as the
// frame's coming front has it; without it there would be none there.
func TestCloudsComingFront(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	// A second before the first coming front's spell is announced.
	var c physics.ComingFront
	for tick := int64(0); tick < tl.Week().Until && c.On == 0; tick += 60 * physics.StepsPerSecond {
		c = tl.Coming(tick, nil)
	}
	if c.On == 0 {
		t.Fatal("the sample week has no front coming")
	}
	tick := int64(c.Begin) - weather.Announce - physics.StepsPerSecond
	r := newSkyRig(t, tick)
	var page cloudsPage
	r.get(t, "/owner/api/clouds.json", &page)
	if page.Lip != round2(r.tl.Prepared().Edge()) || page.Layers[0] <= page.Layers[1] || page.Layers[1] <= page.Layers[2] ||
		page.Words != [3]float64{2.5, 10, 50} || page.Sheets.Side*page.Sheets.Side*physics.Layers != len(page.Sheets.Values) {
		t.Fatalf("the page: lip %v, layers %v, words %v, sheets %d a side, %d values", page.Lip, page.Layers, page.Words, page.Sheets.Side, len(page.Sheets.Values))
	}
	// The weather of the spells in play alone.
	var sp [physics.WeatherSpells]physics.Spell
	w := &physics.Weather{Prepared: r.tl.Prepared()}
	w.Set(sp[:r.tl.Spells(page.Tick, nil, &sp)])
	var alone physics.WeatherTick
	physics.WeatherAt(w, &alone, float64(page.Tick))
	most, without := 0.0, 0.0
	g := &page.Sheets
	for j := range g.Side {
		for i := range g.Side {
			x, y := g.West+float64(i)*g.Step, g.North-float64(j)*g.Step
			if v := g.at(x, y)[physics.LayerCirrus]; v > most {
				most, without = v, physics.SheetAt(&alone, x, y).Cirrus
			}
		}
	}
	t.Logf("the coming front toward %.0f°: cirrus %.3f at most, %.3f there without it", c.Toward*360/physics.TurnSteps, most, without)
	if most < 0.5 || without > most-0.3 {
		t.Fatalf("the coming front's cirrus: %.3f at most, %.3f there without it", most, without)
	}
}

// TestCloudsSquall: a developer's squall stands on the page about where
// it was placed to reach, a cumulonimbus with its rain beneath; the rain's
// grid is the physics' field at its points; the point under it has its
// rain and its cloud, and one far from it neither. clouds.json is made in
// a few tens of milliseconds.
func TestCloudsSquall(t *testing.T) {
	r := newSkyRig(t, 1000)
	if err := r.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.SetWeather, Weather: bus.Weather{
		Mode: bus.WeatherSystem, Kind: uint16(weather.KindIndex(r.cat, "squall")), East: 3000 * 4, In: 60 * physics.StepsPerSecond,
	}}); err != nil {
		t.Fatal(err)
	}
	r.w.Tick()
	f := r.w.Latest()
	if len(f.Systems) != 1 {
		t.Fatalf("%d systems placed", len(f.Systems))
	}
	for r.w.Now() < r.w.Latest().Systems[0].At {
		r.w.Tick()
	}
	h := r.o.Handler()
	start := time.Now()
	const asks = 10
	for range asks {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "http://localhost:9090/owner/api/clouds.json", nil))
	}
	took := time.Since(start) / asks
	var page cloudsPage
	size := r.get(t, "/owner/api/clouds.json", &page)
	t.Logf("clouds.json: %v, %d bytes; %d clouds, %d cumulus", took, size, len(page.Clouds), len(page.Cumulus))
	if took > 50*time.Millisecond {
		t.Errorf("clouds.json took %v", took)
	}
	var sq *cloudJSON
	for i := range page.Clouds {
		if c := &page.Clouds[i]; c.Form == "cumulonimbus" && math.Hypot(c.East-3000, c.North) < 500 {
			sq = c
		}
	}
	if sq == nil || sq.Top <= sq.Base || sq.Cloud < 0.99 || sq.Ahead <= sq.Behind || sq.Rain < 10 {
		t.Fatalf("the squall's cloud: %+v of %+v", sq, page.Clouds)
	}
	// The rain's grid, point by point, is the physics' field.
	f = r.w.Latest()
	tick := f.Tick
	ws, ss := append([]bus.Weather(nil), f.Weathers...), append([]bus.System(nil), f.Systems...)
	if tick != page.Tick {
		t.Fatalf("the page is of tick %d, the frame %d", page.Tick, tick)
	}
	wt := physicsAt(r.tl, tick, ws, ss)
	g := &page.Rain
	wet := 0
	for j := range g.Side {
		for i := range g.Side {
			x, y := g.West+float64(i)*g.Step, g.North-float64(j)*g.Step
			if math.Hypot(x, y) > page.Lip {
				continue
			}
			want := round1(physics.RainAt(wt, x, y))
			if got := g.at(x, y)[0]; got != want {
				t.Fatalf("the rain at (%v, %v): %v, the physics' %v", x, y, got, want)
			}
			if want > 0 {
				wet++
			}
		}
	}
	if g.at(sq.East, sq.North)[0] < 10 || wet == 0 {
		t.Fatalf("the rain under the squall: %v mm an hour; %d points wet", g.at(sq.East, sq.North)[0], wet)
	}
	var pt struct {
		Sky *skyPoint
	}
	r.get(t, fmt.Sprintf("/owner/api/point?east=%.2f&north=%.2f", sq.East, sq.North), &pt)
	if s := pt.Sky; s == nil || s.Rain < 10 || s.RainWord == "none" || s.Cloud == nil || s.Cloud.Form != "cumulonimbus" || s.Cloud.Top != sq.Top {
		t.Fatalf("the point under the squall: %+v", s)
	}
	r.get(t, "/owner/api/point?east=-6000&north=0", &pt)
	if s := pt.Sky; s == nil || s.Rain != 0 || s.RainWord != "none" || s.Cloud != nil {
		t.Fatalf("a point far from it: %+v", s)
	}
}
