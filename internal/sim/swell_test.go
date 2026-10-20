// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// stormTick is a tick of the catalog's sample week a storm's swell is on
// the disk at: the first storm's, half an hour after it is whole.
func stormTick(t testing.TB) int64 {
	t.Helper()
	tl := sequence(t)
	for _, s := range tl.Week().Systems {
		if tl.Prepared().RaisesSwell(s.Kind) {
			return int64(s.Mature) + tl.Origin() + 30*60*physics.StepsPerSecond
		}
	}
	t.Fatal("the sample week has no storm")
	return 0
}

// swellAt is the swell the records give area i at boundary b, as the
// server makes it, over open water.
func swellAt(t testing.TB, w *World, i int, b int64, d dev) physics.SeaInput {
	t.Helper()
	tl := w.timeline
	c := w.sea.centres[i]
	var sw physics.Swell
	for _, src := range tl.SwellSources(b, d.ws, d.ss, nil) {
		sw = physics.CombineSwell(sw, physics.SwellAt(w.sea.waves, tl.Prepared(), &src.Record, c[0], c[1], src.Tick))
	}
	var in physics.SeaInput
	in.SetSwell(sw)
	return in
}

// Each area's swell is its storms' at the keyframe boundary at or before
// the second its inputs are for, held between boundaries, whether it was
// made ahead a share a tick or at once.
func TestAreasSwellIsTheRecords(t *testing.T) {
	at := stormTick(t)
	w := weatherWorld(t, at, 1, true)
	every := w.timeline.Every()
	with := 0
	check := func(f *bus.Frame, areas []physics.SeaInput, second int64) {
		b := (second * bus.SeaPeriod / every) * every
		for i := range areas {
			want := swellAt(t, w, i, b, devOf(f))
			got := areas[i]
			if got.SwellHeight != want.SwellHeight || got.SwellPeriod != want.SwellPeriod || got.SwellFrom != want.SwellFrom {
				t.Fatalf("tick %d, area %d: the swell is %d cm %d %d, the records' at %d %d cm %d %d",
					f.Tick, i, got.SwellHeight, got.SwellPeriod, got.SwellFrom, b, want.SwellHeight, want.SwellPeriod, want.SwellFrom)
			}
			if got.SwellHeight > 0 {
				with++
			}
		}
	}
	for range 25 * physics.StepsPerSecond {
		w.Tick()
		f := w.Latest()
		if f.Tick%bus.SeaPeriod == 0 {
			s := bus.SeaSecond(f.Tick)
			check(f, f.Sea.Now, s)
			check(f, f.Sea.Next, s+1)
		}
	}
	if with == 0 {
		t.Fatal("no area had swell under the week's storm")
	}
}

// A storm's swell does not change how a world replays: one worker and
// three, and a world loaded from a snapshot, sail to the same frames.
func TestSwellReplays(t *testing.T) {
	at := stormTick(t)
	a := weatherWorld(t, at, 1, true)
	b := weatherWorld(t, at, 3, true)
	for i := range 6 {
		do(t, a, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1))})
		do(t, b, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1))})
	}
	var snap []byte
	for k := range 40 * physics.StepsPerSecond {
		a.TickWith(&Input{})
		b.TickWith(&Input{})
		if Digest(a.Latest()) != Digest(b.Latest()) {
			t.Fatalf("one worker and three differ at tick %d", a.Now())
		}
		if k == 13*physics.StepsPerSecond+7 {
			snap = AppendSnapshot(nil, a.Latest())
		}
	}
	twin := weatherWorld(t, 0, 1, true)
	if err := twin.Load(snap); err != nil {
		t.Fatal(err)
	}
	for twin.Now() < a.Now() {
		twin.TickWith(&Input{})
	}
	if x, y := twin.Latest(), a.Latest(); Digest(x) != Digest(y) || !slices.Equal(x.Sea.Now, y.Sea.Now) || !slices.Equal(x.Sea.Next, y.Sea.Next) {
		t.Fatal("the world loaded from a snapshot made another sea")
	}
}

// A storm a developer places raises swell, which reaches the place it is
// placed to meet before the storm's own wind there blows 20 knots.
func TestPlacedStormRaisesSwell(t *testing.T) {
	if testing.Short() {
		t.Skip("an hour of ticks")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	w := weatherWorld(t, 740_000_000, 1, true)
	// A light settled spell held, which stills the week's systems.
	send(t, w, bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherHeld, Regime: 0}})
	for range 5 * bus.SeaPeriod {
		w.Tick()
	}
	if f := w.Latest(); slices.ContainsFunc(f.Sea.Now, func(in physics.SeaInput) bool { return in.SwellHeight > 0 }) {
		t.Fatal("swell under a developer's still weather")
	}
	// In the outer waters, where storms keep their strength.
	col, row := int32(physics.SeaAreas/2), int32(physics.SeaAreas/2+15)
	x, y := physics.SeaAreaCentre(col, row)
	area := row*physics.SeaAreas + col
	send(t, w, bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherSystem, Kind: uint16(weather.KindIndex(cat, "storm")),
		East: int32(x * 4), North: int32(y * 4), In: 50 * 60 * physics.StepsPerSecond}})
	var swellAt, windAt int64
	end := w.Now() + 60*60*physics.StepsPerSecond
	for w.Now() < end && windAt == 0 {
		w.Tick()
		if w.Now()%physics.StepsPerSecond != 0 {
			continue
		}
		f := w.Latest()
		if swellAt == 0 && f.Sea.Now[area].SwellHeight >= 10 {
			swellAt = w.Now()
		}
		var at physics.WeatherTick
		physics.WeatherAt(&w.weather, &at, float64(w.Now()))
		if v, _ := physics.MeanWindAt(&at, x, y); v >= 20*1852.0/3600 {
			windAt = w.Now()
		}
	}
	lead := float64(windAt-swellAt) / physics.StepsPerSecond / 60
	t.Logf("at the area: swell of 10 cm at %d, 20 knots of wind at %d: %.1f minutes ahead", swellAt, windAt, lead)
	if swellAt == 0 || windAt == 0 || !(lead > 0) {
		t.Errorf("the placed storm's swell came at %d, its wind at %d", swellAt, windAt)
	}
}
