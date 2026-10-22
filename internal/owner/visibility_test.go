// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"fmt"
	"log/slog"
	"math"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/light"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// placeSystem places a developer's system of a kind to reach (x, y) a
// minute on, and sails the world until it is there, at its strongest.
func (r *skyRig) placeSystem(t testing.TB, kind string, x, y float64) {
	t.Helper()
	if err := r.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.SetWeather, Weather: bus.Weather{
		Mode: bus.WeatherSystem, Kind: uint16(weather.KindIndex(r.cat, kind)), East: int32(x * 4), North: int32(y * 4),
		In: 60 * physics.StepsPerSecond,
	}}); err != nil {
		t.Fatal(err)
	}
	r.w.Tick()
	if n := len(r.w.Latest().Systems); n != 1 {
		t.Fatalf("%d systems placed", n)
	}
	for r.w.Now() < r.w.Latest().Systems[0].At {
		r.w.Tick()
	}
}

// frameNow is the frame's tick, and the weather at it made as the
// simulation makes it.
func (r *skyRig) frameNow() (int64, *physics.WeatherTick, []bus.Weather, []bus.System) {
	f := r.w.Bus().Frames.Acquire()
	tick := f.Tick
	ws, ss := append([]bus.Weather(nil), f.Weathers...), append([]bus.System(nil), f.Systems...)
	f.Release()
	return tick, physicsAt(r.tl, tick, ws, ss), ws, ss
}

// TestVisibilityFog: a developer's fog bank shows on the grid as very
// poor visibility where it was placed, and good far from it; the grid,
// point by point, is the physics' field; the point in it is very poor, the
// fog making nearly all of it, and the point far from it good, with no fog.
// visibility.json is made in a few tens of milliseconds.
func TestVisibilityFog(t *testing.T) {
	r := newSkyRig(t, 1000)
	r.placeSystem(t, "fog", 3000, 0)
	h := r.o.Handler()
	start := time.Now()
	const asks = 10
	for range asks {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "http://localhost:9090/owner/api/visibility.json", nil))
	}
	took := time.Since(start) / asks
	var page visibilityPage
	size := r.get(t, "/owner/api/visibility.json", &page)
	t.Logf("visibility.json: %v, %d bytes; %d a side", took, size, page.Grid.Side)
	if took > 50*time.Millisecond {
		t.Errorf("visibility.json took %v", took)
	}
	if page.Words != [3]float64{400, 1852, 3704} || page.Lip != round2(r.tl.Prepared().Edge()) ||
		page.Grid.Side*page.Grid.Side != len(page.Grid.Values) || len(page.Lights) != 0 {
		t.Fatalf("the page: words %v, lip %v, grid %d a side, %d values, %d lights", page.Words, page.Lip,
			page.Grid.Side, len(page.Grid.Values), len(page.Lights))
	}
	tick, wt, _, _ := r.frameNow()
	if tick != page.Tick {
		t.Fatalf("the page is of tick %d, the frame %d", page.Tick, tick)
	}
	g := &page.Grid
	thick := math.Inf(1)
	for j := range g.Side {
		for i := range g.Side {
			x, y := g.West+float64(i)*g.Step, g.North-float64(j)*g.Step
			if math.Hypot(x, y) > page.Lip {
				continue
			}
			want := seen(physics.VisibilityAt(wt, x, y))
			got := g.at(x, y)[0]
			if got != want {
				t.Fatalf("the visibility at (%v, %v): %v, the physics' %v", x, y, got, want)
			}
			if math.Hypot(x-3000, y) < 500 {
				thick = min(thick, got)
			}
		}
	}
	far := g.at(-3000, 0)[0]
	t.Logf("the fog bank: %v m at its thickest; %v m far from it", thick, far)
	if thick >= page.Words[0] || far < page.Words[2] {
		t.Fatalf("the fog bank: %v m at its thickest, %v m far from it", thick, far)
	}
	var pt struct {
		Sky *skyPoint
	}
	r.get(t, "/owner/api/point?east=3000&north=0", &pt)
	if s := pt.Sky; s == nil || s.Visibility >= page.Words[0] || s.VisibilityWord != "very poor" || s.Air.Fog < 0.9 ||
		math.Abs(s.Air.Clear+s.Air.Fog+s.Air.Rain+s.Air.Mist-1) > 0.01 {
		t.Fatalf("the point in the fog: %+v", s)
	}
	r.get(t, "/owner/api/point?east=-3000&north=0", &pt)
	if s := pt.Sky; s == nil || s.Visibility < page.Words[2] || s.VisibilityWord != "good" || s.Air.Fog != 0 {
		t.Fatalf("a point far from it: %+v", s)
	}
}

// TestVisibilityFlashes: each flash of the last minute about a developer's
// squall is on the page where physics.Flashes puts it, from the weather at
// its slot's start, with its slot and its tick; none is older than a
// minute or yet to come.
func TestVisibilityFlashes(t *testing.T) {
	r := newSkyRig(t, 1000)
	r.placeSystem(t, "squall", 3000, 0)
	p := r.tl.Prepared()
	slot := int64(p.SlotTicks())
	var page visibilityPage
	// A flash a slot comes with a chance at full strength: sailed on a
	// slot at a time until one has come.
	for k := 0; ; k++ {
		r.get(t, "/owner/api/visibility.json", &page)
		if len(page.Flashes) > 0 {
			break
		}
		if k == 30 {
			t.Fatal("no flash in five minutes of a squall")
		}
		for range slot {
			r.w.Tick()
		}
	}
	tick, _, ws, ss := r.frameNow()
	if tick != page.Tick {
		t.Fatalf("the page is of tick %d, the frame %d", page.Tick, tick)
	}
	var want []flashJSON
	from := float64(tick - 60*physics.StepsPerSecond)
	var fl [physics.MaxFlashes]physics.Flash
	for s := p.FlashSlot(from); s <= p.FlashSlot(float64(tick)); s++ {
		wt := physicsAt(r.tl, int64(s)*slot, ws, ss)
		for _, f := range fl[:physics.Flashes(wt, s, fl[:])] {
			if f.Tick >= from && f.Tick <= float64(tick) {
				want = append(want, flashJSON{Slot: int(f.Slot), Tick: round2(f.Tick), East: round2(f.East), North: round2(f.North),
					Sea: f.Sea != 0, Strokes: int(f.Strokes)})
			}
		}
	}
	t.Logf("%d flashes in the last minute: %+v", len(page.Flashes), page.Flashes)
	if fmt.Sprint(page.Flashes) != fmt.Sprint(want) {
		t.Fatalf("the flashes: %+v, physics.Flashes' %+v", page.Flashes, want)
	}
	for _, f := range page.Flashes {
		if math.Hypot(f.East-3000, f.North) > 2000 || f.Strokes < 1 {
			t.Fatalf("a flash far from the squall: %+v", f)
		}
	}
}

// TestVisibilityLights: by day, a light in a fog bank is lit, by day, and
// sounds its fog signal while its pattern is blasting, and not while it is
// silent; a light in clear air is dark and silent, blasting or not; a
// light with no fog signal has none.
func TestVisibilityLights(t *testing.T) {
	r := newSkyRig(t, 1000)
	r.placeSystem(t, "fog", 3000, 0)
	tick, wt, _, _ := r.frameNow()
	us := worldMicros(tick)
	// An epoch at which the sun is up over the disk at the tick.
	s := r.cat.PrepareSky()
	epoch := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	for sky.SunAltitude(s, sky.Time(s, float64(epoch.UnixMicro()), float64(us)), 0, 0) < 0.3 {
		epoch = epoch.Add(30 * time.Minute)
	}
	sig := FogSignal{Notation: "Dia(1) 20s", Steps: []int{3000, 17000}}
	period := int64(20_000_000)
	// A phase a second into a blast now, and one ten seconds into its
	// silence.
	blasting := ((1_000_000-us)%period + period) % period
	silent := ((10_000_000-us)%period + period) % period
	b := worldgen.Empty(1)
	b.Lights = []worldgen.Light{
		{Number: 0, Role: "hazard", X: 3000, Y: 0, Phase: blasting},
		{Number: 1, Role: "hazard", X: 3010, Y: 0, Phase: silent},
		{Number: 2, Role: "hazard", X: -3000, Y: 0, Phase: blasting},
		{Number: 3, Role: "hazard", X: 3000, Y: 10, Phase: blasting},
	}
	o := New(Config{Frames: r.w.Bus().Frames, Weather: r.tl.Prepared(), Timeline: r.tl, Bundle: b, Sky: s,
		World:      World{Number: 1, Epoch: epoch},
		FogSignals: []FogSignal{sig}, LightSignals: []int{0, 0, 0, -1},
		SoundsUnder: r.cat.World.Lights.FogSignal.Sounds * light.NauticalMile, Log: slog.New(slog.DiscardHandler)})
	r.o = o
	var page visibilityPage
	r.get(t, "/owner/api/visibility.json", &page)
	if page.Tick != tick || page.Sounds != 1852 || len(page.Lights) != 4 {
		t.Fatalf("the page: tick %d of %d, sounds %v, %d lights", page.Tick, tick, page.Sounds, len(page.Lights))
	}
	t.Logf("the visibility at the lights: %.0f m in the fog, %.0f m in clear air",
		physics.VisibilityAt(wt, 3000, 0), physics.VisibilityAt(wt, -3000, 0))
	if _, on := light.Blast(sig.Steps, blasting, worldMicros(tick)); !on {
		t.Fatal("the blasting light's pattern is silent")
	}
	want := []lightNow{
		{Number: 0, East: 3000, North: 0, Signal: "Dia(1) 20s", Sounding: true, Lit: true, ByDay: true},
		{Number: 1, East: 3010, North: 0, Signal: "Dia(1) 20s", Sounding: false, Lit: true, ByDay: true},
		{Number: 2, East: -3000, North: 0, Signal: "Dia(1) 20s", Sounding: false, Lit: false, ByDay: false},
		{Number: 3, East: 3000, North: 10, Signal: "", Sounding: false, Lit: true, ByDay: true},
	}
	for i, l := range page.Lights {
		if l != want[i] {
			t.Errorf("light %d: %+v, want %+v", i, l, want[i])
		}
	}
}
