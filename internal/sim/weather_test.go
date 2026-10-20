// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"fmt"
	"math"
	"runtime"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// sequence is the catalog's weather: a timeline of its own for each world.
func sequence(t testing.TB) *weather.Timeline {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	return tl
}

// weatherWorld is a world in the catalog's weather at tick tick, with its
// sea if sea.
func weatherWorld(t testing.TB, tick int64, workers int, sea bool) *World {
	t.Helper()
	cfg := Config{Capacity: 64, Kinds: kinds(t), Workers: workers, Tick: tick, Grace: 600, Weather: sequence(t)}
	if sea {
		cfg.Waves = waves(t)
	}
	w, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w
}

// secondSpell is the tick the catalog's sample week's second spell begins
// at.
func secondSpell(t testing.TB) int64 {
	t.Helper()
	return int64(sequence(t).Week().Spells[1].Begin)
}

// Every boat sails in the wind at its own place: a boat the tick steps is
// the boat physics.Step gives in physics.WindAt at the boat as the step
// begins, at the tick the step makes, bit for bit, in a gusty spell, through
// a change of spell and under a developer's weather, however the boats are
// split between workers.
func TestTickMatchesStepInWeather(t *testing.T) {
	w := weatherWorld(t, secondSpell(t)-weather.Announce-100, 3, false)
	const boats = 40
	for i := range boats {
		do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1))})
	}
	// Spread over the disk, from the refuge to the rim.
	for i := range boats {
		a := float64(i) * 2.4
		r := 200 + 190*float64(i)
		send(t, w, bus.Command{Op: bus.Place, Boat: uint64(i + 1), State: physics.State{X: math.Round(r * math.Sin(a)), Y: math.Round(r * math.Cos(a)), Heading: a, Surge: 2, SheetLimit: 0.6}})
	}
	w.Tick()
	kind := &kinds(t)[0]
	winds := map[int]bool{}
	var spread [2]float64
	for i := range 900 {
		if i == 600 {
			send(t, w, bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherHeld, Regime: 3}})
		}
		before := slices.Clone(w.Latest().State[:boats])
		w.Tick()
		f := w.Latest()
		winds[int(f.NSpells)] = true
		lo, hi := math.Inf(1), math.Inf(-1)
		for s := range boats {
			want := before[s]
			c := physics.Control{Helm: f.Control[s].Helm(), Sheet: f.Control[s].Sheet()}
			e := windAt(w, f, want.X, want.Y)
			lo, hi = min(lo, e.WindSpeed), max(hi, e.WindSpeed)
			var o physics.Out
			physics.Step(&want, &c, &e, nil, nil, kind, &o)
			if !sameState(f.State[s], want) {
				t.Fatalf("tick %d, slot %d: %+v, Step in the wind at the boat gives %+v", f.Tick, s, f.State[s], want)
			}
		}
		spread = [2]float64{lo, hi}
	}
	if spread[1] < 1.5*spread[0] {
		t.Errorf("the boats' winds run from %.1f to %.1f m/s: not a wind that differs from place to place", spread[0], spread[1])
	}
	if !winds[1] || !winds[2] || !winds[3] {
		t.Errorf("the ticks had %v spells in play: not before a change, through it and under a developer's weather", winds)
	}
}

// The sea lags the wind: after a step of wind the waves' wind is 63% of the
// way after four minutes and 95% after twelve, in every area, and the sea
// rises with it.
func TestTheSeaLagsTheWind(t *testing.T) {
	if testing.Short() {
		t.Skip("an hour of ticks")
	}
	w := weatherWorld(t, 1000, 1, true)
	breeze, gale := steady(5, 1), steady(15, 1)
	do(t, w, bus.Command{Op: bus.SetWeather, Weather: breeze})
	// Half an hour for the sea to forget the weather before.
	for range 1800 * bus.SeaPeriod {
		w.Tick()
	}
	f := w.Latest()
	if !uniform(f.Sea.Now, physics.SeaInput{Speed: 500, From: breeze.Dir, Fetch: f.Sea.Now[0].Fetch}) {
		t.Fatalf("after half an hour of 5 m/s the sea's wind is %+v", f.Sea.Now[0])
	}
	calm := w.sea.view.Window.Hs[0]
	do(t, w, bus.Command{Op: bus.SetWeather, Weather: gale})
	from := w.Latest().Weathers[len(w.Latest().Weathers)-1].From
	for _, c := range []struct {
		seconds int64
		want    float64
	}{{0, 0}, {240, 1 - math.Exp(-1)}, {720, 1 - math.Exp(-3)}, {1800, 1}} {
		for w.Now() < from+c.seconds*bus.SeaPeriod {
			w.Tick()
		}
		f := w.Latest()
		got := (float64(f.Sea.Now[0].Speed) - 500) / 1000
		// A step between the samples' grid points runs ahead by up to one
		// sample's weight.
		if got < c.want-0.02 || got > c.want+0.12*math.Exp(-float64(c.seconds)/240)+0.02 || !uniform(f.Sea.Now, f.Sea.Now[0]) {
			t.Errorf("%d s after the wind rose the sea's wind is %.1f%% of the way, want %.1f%%", c.seconds, 100*got, 100*c.want)
		}
	}
	if hs := w.sea.view.Window.Hs[0]; hs < 3*calm {
		t.Errorf("the gale's sea is %.2f m, the breeze's was %.2f m", hs, calm)
	}
}

// A world loaded from a snapshot sails on exactly as the world that was not
// stopped, in the catalog's weather, with a developer's weather set shortly
// before: the wave wind's samples, made again, are the ones it had.
func TestSnapshotResumesTheWeather(t *testing.T) {
	ats, gap := []int64{40, 95, 1700}, int64(4000)
	if testing.Short() {
		// One snapshot, restored half a minute later.
		ats, gap = []int64{95}, 900
	}
	for _, at := range ats {
		start := secondSpell(t) - 300
		w := weatherWorld(t, start, 2, true)
		for i := range 8 {
			do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1))})
		}
		do(t, w, bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherHeld, Regime: 2}})
		for w.Now() < start+at {
			w.Tick()
		}
		snap := AppendSnapshot(nil, w.Latest())
		twin := weatherWorld(t, 0, 1, true)
		if err := twin.Load(snap); err != nil {
			t.Fatal(err)
		}
		if Digest(twin.Latest()) != Digest(w.Latest()) || twin.Latest().Spells != w.Latest().Spells {
			t.Fatalf("snapshot %d ticks in: the loaded world differs", at)
		}
		for range 150 {
			w.TickWith(&Input{})
			twin.TickWith(&Input{})
			if a, b := w.Latest(), twin.Latest(); Digest(a) != Digest(b) {
				t.Fatalf("snapshot %d ticks in: the worlds differ at tick %d", at, a.Tick)
			}
		}
		// Restored a while later, it is the world that sailed on empty.
		later := w.Now() + gap
		restored := weatherWorld(t, later, 1, true)
		if _, err := restored.Restore(snap, later); err != nil {
			t.Fatal(err)
		}
		fresh := weatherWorld(t, start, 1, true)
		fresh.TickWith(&Input{Commands: []bus.Command{{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherHeld, Regime: 2}}}})
		for fresh.Now() < start+8 {
			fresh.TickWith(&Input{})
		}
		fresh.TickWith(&Input{Commands: []bus.Command{{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherHeld, Regime: 2}}}})
		for fresh.Now() < later {
			fresh.TickWith(&Input{})
		}
		a, b := restored.Latest(), fresh.Latest()
		if !slices.Equal(a.Sea.Now, b.Sea.Now) || !slices.Equal(a.Sea.Next, b.Sea.Next) || a.Spells != b.Spells {
			t.Fatalf("snapshot %d ticks in: restored at tick %d, the sea or the spells are not those of a world that sailed on", at, later)
		}
	}
}

// In the catalog's weather every area's wind differs and changes every
// second, so every area's waves are made again each second: the work is
// spread, no tick making more than its share, a tick allocates nothing,
// and the waves the steps sail in are the frame's.
func TestSeaWorkIsSpreadInWeather(t *testing.T) {
	w := weatherWorld(t, secondSpell(t)+20000, 1, true)
	fill(t, w, 20, 1)
	for range 70 {
		w.Tick()
	}
	if n := testing.AllocsPerRun(100, w.Tick); n != 0 {
		t.Errorf("a tick in the catalog's weather allocates %v times", n)
	}
	for w.Now()%bus.SeaPeriod != 0 {
		w.Tick()
	}
	f := w.Latest()
	distinct := map[physics.SeaInput]bool{}
	changed := 0
	for i, in := range f.Sea.Next {
		distinct[in] = true
		if in != f.Sea.Now[i] {
			changed++
		}
	}
	if len(distinct) < seaAreas/2 {
		t.Errorf("the sea's %d areas have %d winds between them", seaAreas, len(distinct))
	}
	t.Logf("%d of %d areas change from one second to the next; %d winds between them", changed, seaAreas, len(distinct))
	other := &w.sea.windows[1-w.sea.now]
	done := 0
	for i, in := range f.Sea.Next {
		if other.Inputs[i] == in {
			done++
		}
	}
	for range bus.SeaPeriod - 1 {
		w.Tick()
		ready := 0
		for i, in := range w.Latest().Sea.Next {
			if other.Inputs[i] == in {
				ready++
			}
		}
		if ready-done > seaShare {
			t.Fatalf("tick %d made %d areas ready, more than its share of %d", w.Now(), ready-done, seaShare)
		}
		done = ready
	}
	if done != seaAreas {
		t.Fatalf("%d of %d areas ready a tick before the second ends", done, seaAreas)
	}
	w.Tick()
	if !slices.Equal(w.sea.view.Window.Inputs, w.Latest().Sea.Now) {
		t.Fatal("the sea made ready did not come into effect")
	}
}

// BenchmarkTickInWeather times the tick with boats spread over the disk in
// A frame's keyframes are the week's systems' at their ticks, as SystemAt
// makes them from the week's records, and a developer's system's in its
// slot.
func TestFrameKeyframesAreTheWeeks(t *testing.T) {
	tl := sequence(t)
	week := tl.Week()
	s := week.Systems[len(week.Systems)/3]
	w := weatherWorld(t, int64(s.Mature)-5, 1, false)
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	send(t, w, bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherSystem, Kind: uint16(weather.KindIndex(cat, "squall")), East: 4000, In: 900}})
	for w.Now()%tl.Every() != 0 {
		w.Tick()
	}
	for range tl.Every() * 2 {
		w.Tick()
	}
	f := w.Latest()
	for k, key := range f.Keys {
		if want := float64(f.Tick - f.Tick%tl.Every() + int64(k)*tl.Every()); key.Tick != want {
			t.Fatalf("keyframe %d is of tick %v, not %v", k, key.Tick, want)
		}
		for _, ws := range week.Systems {
			if ws.Born <= key.Tick && key.Tick < ws.Gone && key.Systems[ws.Slot] != physics.SystemAt(&ws.SystemRecord, key.Tick) {
				t.Fatalf("keyframe %d, slot %d: %+v, the record's %+v", k, ws.Slot, key.Systems[ws.Slot], physics.SystemAt(&ws.SystemRecord, key.Tick))
			}
		}
		if dev := key.Systems[physics.WeekSystems+int(f.Systems[0].Slot)]; dev.On == 0 {
			t.Fatalf("keyframe %d lacks the developer's system", k)
		}
	}
}

// The sea follows a squall: the wave wind at an area under its track rises
// after the wind there does, by the lag of its average, and goes down to
// the wind again after the squall has gone.
func TestSeaFollowsASquall(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	start := int64(740_000_000)
	w := weatherWorld(t, start, 1, true)
	// A light settled spell, held, and a squall to reach an area's centre
	// three minutes on.
	send(t, w, bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherHeld, Regime: 0}})
	for range 20 * bus.SeaPeriod {
		w.Tick()
	}
	col, row := int32(physics.SeaAreas/2+7), int32(physics.SeaAreas/2)
	x, y := physics.SeaAreaCentre(col, row)
	area := row*physics.SeaAreas + col
	send(t, w, bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherSystem, Kind: uint16(weather.KindIndex(cat, "squall")),
		East: int32(x * 4), North: int32(y * 4), In: 180 * physics.StepsPerSecond}})
	// The wind at the area's centre, and the wave wind there, each second.
	windAt := func() float64 {
		var at physics.WeatherTick
		physics.WeatherAt(&w.weather, &at, float64(w.Now()))
		v, _ := physics.MeanWindAt(&at, x, y)
		return v
	}
	before, wave0 := windAt(), float64(w.Latest().Sea.Now[area].Speed)*physics.SeaSpeedStep
	var windPeak, wavePeak float64
	var windAtPeak, waveAtPeak int64
	end := w.Now() + 45*60*physics.StepsPerSecond
	for w.Now() < end {
		w.Tick()
		if w.Now()%physics.StepsPerSecond != 0 {
			continue
		}
		if v := windAt(); v > windPeak {
			windPeak, windAtPeak = v, w.Now()
		}
		if v := float64(w.Latest().Sea.Now[area].Speed) * physics.SeaSpeedStep; v > wavePeak {
			wavePeak, waveAtPeak = v, w.Now()
		}
	}
	wind, wave := windAt(), float64(w.Latest().Sea.Now[area].Speed)*physics.SeaSpeedStep
	lag := float64(waveAtPeak-windAtPeak) / physics.StepsPerSecond
	t.Logf("at the area: the wind %.2f m/s, at most %.2f; the wave wind %.2f, at most %.2f, %.0f s after the wind's most; at the end %.2f and %.2f",
		before, windPeak, wave0, wavePeak, lag, wind, wave)
	if windPeak < 2*before || wavePeak < 1.2*wave0 || lag < 60 {
		t.Errorf("the sea did not rise behind the squall's wind, with a lag")
	}
	if math.Abs(wave-wind) > 0.1*wind {
		t.Errorf("after the squall the wave wind is %.2f m/s, the wind %.2f", wave, wind)
	}
}

// the catalog's weather, in a trade spell and in the stormy one: every
// boat's own wind, and every sea area's waves made again each second; and
// in the week's weather under a storm and four squalls.
func BenchmarkTickInWeather(b *testing.B) {
	cat, err := catalog.Load()
	if err != nil {
		b.Fatal(err)
	}
	tl := sequence(b)
	var storm int64
	for _, s := range tl.Week().Systems {
		if tl.Config().Kinds[int(s.Kind)].Shape == physics.ShapeLow {
			storm = int64(s.Mature)
			break
		}
	}
	for _, n := range []int{100, 1000} {
		b.Run(fmt.Sprintf("storm-and-squalls/%d", n), func(b *testing.B) {
			w, err := New(Config{Kinds: kinds(b), Waves: waves(b), Weather: tl, Workers: runtime.GOMAXPROCS(0), Tick: storm})
			if err != nil {
				b.Fatal(err)
			}
			b.Cleanup(w.Close)
			fill(b, w, n, 1)
			for i := range 4 {
				send(b, w, bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherSystem, Kind: uint16(weather.KindIndex(cat, "squall")),
					East: int32(i * 2000), North: 4 * 1000, In: 30 * physics.StepsPerSecond}})
			}
			for range 70 * physics.StepsPerSecond {
				w.Tick()
			}
			b.ReportAllocs()
			for b.Loop() {
				w.Tick()
			}
			b.ReportMetric(float64(w.Workers()), "workers")
		})
	}
	for _, regime := range []uint16{1, 3} {
		for _, n := range []int{100, 1000, 4000} {
			b.Run(fmt.Sprintf("regime%d/%d", regime, n), func(b *testing.B) {
				w, err := New(Config{Kinds: kinds(b), Waves: waves(b), Weather: sequence(b), Workers: runtime.GOMAXPROCS(0), Tick: 740_000_000})
				if err != nil {
					b.Fatal(err)
				}
				b.Cleanup(w.Close)
				fill(b, w, n, 1)
				send(b, w, bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherHeld, Regime: regime}})
				for range 4 * bus.SeaPeriod {
					w.Tick()
				}
				b.ReportAllocs()
				for b.Loop() {
					w.Tick()
				}
				b.ReportMetric(float64(w.Workers()), "workers")
				b.ReportMetric(float64(w.sea.view.Window.Count), "waves")
			})
		}
	}
}
