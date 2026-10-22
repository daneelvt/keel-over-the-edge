// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"encoding/json"
	"math"
	"math/big"
	"math/rand/v2"
	"os"
	"reflect"
	"sync"
	"testing"
)

// The wind's numbers are the catalog's, read from its generated JSON: the
// package cannot import the catalog, which imports it.
type catalogWeather struct {
	Weather struct {
		Disk     map[string]any   `json:"disk"`
		Gusts    map[string]any   `json:"gusts"`
		WaveWind map[string]any   `json:"waveWind"`
		Current  map[string]any   `json:"current"`
		Front    map[string]any   `json:"front"`
		Pressure map[string]any   `json:"pressure"`
		Reach    map[string]any   `json:"reach"`
		Systems  []map[string]any `json:"systems"`
		Regimes  []struct {
			ID      string         `json:"id"`
			Wind    map[string]any `json:"wind"`
			Cumulus float64        `json:"cumulus"`
		} `json:"regimes"`
		Clouds     map[string]any `json:"clouds"`
		Visibility struct {
			Contrast float64    `json:"contrast"`
			Words    [3]float64 `json:"words"`
		} `json:"visibility"`
		Lightning struct {
			Slot, Sea, Single, Most, Apart float64
		} `json:"lightning"`
	} `json:"weather"`
	World struct {
		Lights struct {
			ClearAir float64 `json:"clearAir"`
		} `json:"lights"`
		Handout struct {
			Dome float64 `json:"dome"`
		} `json:"handout"`
		Disk struct {
			Radius, Mist float64
		} `json:"disk"`
		Edge struct {
			Mist struct {
				Range, Height float64
			} `json:"mist"`
		} `json:"edge"`
	} `json:"world"`
}

// visibilityOf is the catalog's visibility and lightning, as the server
// takes them.
func visibilityOf(c *catalogWeather) VisibilityParams {
	v, l, wd := &c.Weather.Visibility, &c.Weather.Lightning, &c.World
	return VisibilityParams{
		Contrast: v.Contrast, Words: v.Words, Clear: wd.Lights.ClearAir * nauticalMile, Dome: wd.Handout.Dome,
		MistBand: wd.Disk.Mist * nauticalMile, MistLip: wd.Disk.Radius, MistRange: wd.Edge.Mist.Range, MistHeight: wd.Edge.Mist.Height,
		Slot: l.Slot, Sea: l.Sea, Single: l.Single, Strokes: l.Most, Apart: l.Apart,
	}
}

var weatherOnce = sync.OnceValues(func() (*WeatherParams, error) {
	c, err := readCatalogWeather()
	if err != nil {
		return nil, err
	}
	values := map[string]any{}
	for _, g := range []map[string]any{c.Weather.Disk, c.Weather.Gusts, c.Weather.WaveWind, c.Weather.Current, c.Weather.Front, c.Weather.Pressure, c.Weather.Reach} {
		for k, v := range g {
			values[k] = v
		}
	}
	var p WeatherParams
	return &p, setRecord(&p, values)
})

func readCatalogWeather() (*catalogWeather, error) {
	data, err := os.ReadFile("../catalog/catalog.gen.json")
	if err != nil {
		return nil, err
	}
	var c catalogWeather
	return &c, json.Unmarshal(data, &c)
}

// testWeather is the catalog's wind, prepared.
func testWeather(t testing.TB) *WeatherPrepared {
	t.Helper()
	p, err := weatherOnce()
	if err != nil {
		t.Fatal(err)
	}
	var w WeatherPrepared
	PrepareWeather(p, &w)
	return &w
}

var regimesOnce = sync.OnceValues(func() (map[string]*Regime, error) {
	c, err := readCatalogWeather()
	if err != nil {
		return nil, err
	}
	out := map[string]*Regime{}
	for _, r := range c.Weather.Regimes {
		g := new(Regime)
		if err := setRecord(g, r.Wind); err != nil {
			return nil, err
		}
		out[r.ID] = g
	}
	return out, nil
})

// testRegime is the catalog's regime of an id.
func testRegime(t testing.TB, id string) *Regime {
	t.Helper()
	regimes, err := regimesOnce()
	if err != nil {
		t.Fatal(err)
	}
	r, ok := regimes[id]
	if !ok {
		t.Fatalf("the catalog has no regime %s", id)
	}
	return r
}

// spellOfRegime is spell number of a regime, from direction from (degrees),
// beginning at begin and lasting length ticks.
func spellOfRegime(t testing.TB, p *WeatherPrepared, id string, number uint32, from float64, begin, length float64) Spell {
	t.Helper()
	s := Spell{Begin: begin, Start: begin, Length: length, From: math.Round(from * degreeSteps)}
	DrawSpell(p, testRegime(t, id), number, 1852, &s)
	return s
}

// weatherOf is a Weather of spells.
func weatherOf(p *WeatherPrepared, spells ...Spell) *Weather {
	w := &Weather{Prepared: p}
	w.Set(spells)
	return w
}

// windAt is the wind at (x, y) at a tick.
func windAt(w *Weather, x, y, tick float64) WindPoint {
	var t WeatherTick
	WeatherAt(w, &t, tick)
	var p WindPoint
	WindPointAt(&t, x, y, &p, nil)
	return p
}

const (
	nm          = nauticalMile
	worldTick   = 7.4e8 // a tick late in a world's life
	hourOfTicks = 3600 * StepsPerSecond
)

// The speed factor rises from 0.65 at the centre to 1.35 at the mist band,
// by a smooth step: 1.0 at mid-disk, 1.2 at 3 NM within 1%, and 0.75 at
// 1 NM, where the steps' table has 0.72.
func TestSpeedFactor(t *testing.T) {
	p := testWeather(t)
	s := Spell{Steady: 0, Speed: 500, Gust: 1000}
	w := weatherOf(p, s)
	for _, c := range []struct{ nm, want, within float64 }{
		{0, 0.65, 1e-12}, {1, 0.7499, 0.001}, {2.1, 1, 1e-12}, {3, 1.2, 0.01}, {4.2, 1.35, 1e-12}, {4.5, 1.35, 1e-12},
	} {
		// 5 m/s at mid-disk is under the refuge's knee at the centre, so
		// the refuge leaves it alone.
		// The sea's wind: without the falls' draft, which blows in the
		// mist band.
		var at WeatherTick
		WeatherAt(w, &at, worldTick)
		mean, _ := MeanWindAt(&at, 0, c.nm*nm)
		got := mean / 5
		if math.Abs(got-c.want) > c.within*c.want {
			t.Errorf("%g NM: the speed factor is %.4f, want %.4f", c.nm, got, c.want)
		}
	}
}

// A steady spell is the old wind: its speed and direction exactly,
// everywhere short of the mist band and at every tick, so every scenario
// sailed in a steady wind sails as before.
func TestSteadySpell(t *testing.T) {
	p := testWeather(t)
	s := SteadySpell(10*knot, 0.4, 0)
	w := weatherOf(p, s)
	speed, from := float64(s.Speed*SeaSpeedStep), wrapAngle(float64(s.From*turnStep))
	rng := rand.New(rand.NewPCG(1, 1))
	for range 10000 {
		x, y := (rng.Float64()-0.5)*20000, (rng.Float64()-0.5)*20000
		if math.Hypot(x, y) > p.MistFrom() {
			continue
		}
		tick := math.Floor(rng.Float64() * (1 << 52))
		var at WeatherTick
		WeatherAt(w, &at, tick)
		if e := WindAt(&at, x, y, nil); e.WindSpeed != speed || e.WindFrom != from {
			t.Fatalf("at (%.0f, %.0f), tick %.0f: %+v, the spell's %v from %v", x, y, tick, e, speed, from)
		}
	}
	if math.Abs(speed-10*knot) > SeaSpeedStep || math.Abs(from-0.4) > turnStep {
		t.Errorf("10 knots from 0.4 rad is %v from %v", speed, from)
	}
}

// The spells a regime draws lie in its ranges: wind, gust factor, two
// shifts making its amplitude with periods at least a minute and a half
// apart, the difference across the disk, the drift, the axis's turn; and
// the same number draws the same spell.
func TestDrawSpell(t *testing.T) {
	p := testWeather(t)
	params, _ := weatherOnce()
	for _, id := range []string{"settled", "trade", "unsettled", "stormy"} {
		r := testRegime(t, id)
		for n := range uint32(2000) {
			s := spellOfRegime(t, p, id, n, 0, 0, 0)
			if again := spellOfRegime(t, p, id, n, 0, 0, 0); again != s {
				t.Fatalf("%s %d: drawn twice, %+v and %+v", id, n, s, again)
			}
			knots := s.Speed * SeaSpeedStep / knot
			periods := []float64{s.Period[0] / minuteTicks, s.Period[1] / minuteTicks}
			switch {
			case knots < r.Speed[0]-0.01 || knots > r.Speed[1]+0.01:
				t.Fatalf("%s %d: %.2f knots", id, n, knots)
			case s.Gust != math.Round(r.GustFactor*1000):
				t.Fatalf("%s %d: a gust factor of %v", id, n, s.Gust)
			case math.Abs((s.Shift[0]+s.Shift[1])/degreeSteps-r.Shift) > 0.01 || s.Shift[0] < s.Shift[1] || math.Abs(s.Shift[0]-2*s.Shift[1]) > 1:
				t.Fatalf("%s %d: shifts of %v", id, n, s.Shift)
			case periods[0] < r.Period[0] || periods[0] > r.Period[1] || periods[1] < r.Period[0] || periods[1] > r.Period[1]:
				t.Fatalf("%s %d: periods of %v minutes", id, n, periods)
			case math.Abs(s.Period[0]-s.Period[1]) < shiftGap && r.Period[1]-r.Period[0] >= 3:
				t.Fatalf("%s %d: periods of %v minutes, too close", id, n, periods)
			case math.Abs(s.Across/degreeSteps-r.Across) > 0.01:
				t.Fatalf("%s %d: %v across", id, n, s.Across)
			case math.Abs(s.Drift/degreeSteps) > r.Drift+0.01:
				t.Fatalf("%s %d: a drift of %v", id, n, s.Drift)
			case s.AxisPeriod < params.AcrossTurn[0]*hourOfTicks || s.AxisPeriod > params.AcrossTurn[1]*hourOfTicks:
				t.Fatalf("%s %d: the axis turns in %v ticks", id, n, s.AxisPeriod)
			case s.Phase[0] >= TurnSteps || s.Phase[1] >= TurnSteps || s.Axis >= TurnSteps || s.Seed >= 1<<32:
				t.Fatalf("%s %d: %+v", id, n, s)
			}
		}
	}
}

// The shifts swing as the spell says: their amplitudes and periods,
// measured from the direction at the centre over two hours, are the
// spell's within 2%.
func TestShifts(t *testing.T) {
	p := testWeather(t)
	for _, id := range []string{"settled", "trade", "unsettled"} {
		s := spellOfRegime(t, p, id, 7, 90, 0, 0)
		s.Drift = 0
		w := weatherOf(p, s)
		// The direction each second for two hours, less the spell's own.
		const seconds = 7200
		dirs := make([]float64, seconds)
		base := wrapAngle(s.From * turnStep)
		for i := range dirs {
			dirs[i] = wrapAngle(windAt(w, 0, 0, worldTick+float64(i*StepsPerSecond)).MeanFrom - base)
		}
		for k := range 2 {
			wantPeriod, wantAmp := s.Period[k]/StepsPerSecond, s.Shift[k]*turnStep
			period, amp := strongest(dirs, 0.8*wantPeriod, 1.2*wantPeriod)
			if math.Abs(period-wantPeriod) > 0.02*wantPeriod || math.Abs(amp-wantAmp) > 0.02*wantAmp {
				t.Errorf("%s, shift %d: %.1f s and %.2f°, the spell's %.1f s and %.2f°", id, k, period, amp/deg, wantPeriod, wantAmp/deg)
			}
		}
	}
}

// strongest finds the period between lo and hi seconds of the strongest
// oscillation in a signal sampled each second, under a Hann window, and its
// amplitude.
func strongest(signal []float64, lo, hi float64) (period, amp float64) {
	n := len(signal)
	at := func(period float64) float64 {
		var re, im, sum float64
		for i, v := range signal {
			w := 0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(n-1))
			a := 2 * math.Pi * float64(i) / period
			re += w * v * math.Cos(a)
			im += w * v * math.Sin(a)
			sum += w
		}
		return 2 * math.Hypot(re, im) / sum
	}
	best := lo
	for p := lo; p <= hi; p += 0.25 {
		if at(p) > at(best) {
			best = p
		}
	}
	return best, at(best)
}

// The direction differs across the disk along the spell's axis: by the
// spell's amount at the mist band, either way, and not at all across the
// axis.
func TestAcrossTheDisk(t *testing.T) {
	p := testWeather(t)
	s := spellOfRegime(t, p, "trade", 3, 200, 0, 0)
	w := weatherOf(p, s)
	for _, tick := range []float64{worldTick, worldTick + 3*hourOfTicks} {
		var at WeatherTick
		WeatherAt(w, &at, tick)
		st := &at.at[0]
		r := 4.2 * nm
		centre := windAt(w, 0, 0, tick).MeanFrom
		east := windAt(w, r*st.sinB, r*st.cosB, tick).MeanFrom
		west := windAt(w, -r*st.sinB, -r*st.cosB, tick).MeanFrom
		side := windAt(w, r*st.cosB, -r*st.sinB, tick).MeanFrom
		want := s.Across * turnStep
		if math.Abs(wrapAngle(east-centre)-want) > 1e-12 || math.Abs(wrapAngle(west-centre)+want) > 1e-12 || math.Abs(wrapAngle(side-centre)) > 1e-12 {
			t.Errorf("tick %.0f: %.3f° and %.3f° either way along the axis, %.3f° across it; want ±%.3f°", tick,
				wrapAngle(east-centre)/deg, wrapAngle(west-centre)/deg, wrapAngle(side-centre)/deg, want/deg)
		}
	}
}

// Through a change of spell the wind is continuous, and its direction
// moves the shorter way round: from 350° to 20°, through north.
func TestChangeOfSpell(t *testing.T) {
	p := testWeather(t)
	change := float64(p.change)
	a := spellOfRegime(t, p, "trade", 1, 350, 0, 4*hourOfTicks)
	b := spellOfRegime(t, p, "unsettled", 2, 20, worldTick, 3*hourOfTicks)
	a.Shift, b.Shift, a.Across, b.Across, a.Drift, b.Drift = [2]float64{}, [2]float64{}, 0, 0, 0, 0
	b.Change = change
	w := weatherOf(p, a, b)
	prev := windAt(w, 0, 0, worldTick-1)
	for tick := worldTick; tick <= worldTick+change+1; tick++ {
		now := windAt(w, 0, 0, tick)
		// 30° over the change by a smooth step: at most 1.5 × 30° / its
		// ticks in a tick.
		if d := math.Abs(wrapAngle(now.MeanFrom - prev.MeanFrom)); d > 1.01*1.5*30*deg/change {
			t.Fatalf("tick %.0f: the direction jumps %.4f°", tick, d/deg)
		}
		if d := math.Abs(now.MeanSpeed - prev.MeanSpeed); d > 1e-3 {
			t.Fatalf("tick %.0f: the speed jumps %.5f m/s", tick, d)
		}
		if f := wrapAngle(now.MeanFrom) / deg; f > 20.01 || f < -10.01 {
			t.Fatalf("tick %.0f: the wind comes from %.2f°, not between 350° and 20° through north", tick, f)
		}
		prev = now
	}
	if f := windAt(w, 0, 0, worldTick+change).MeanFrom / deg; math.Abs(f-20) > 0.01 {
		t.Errorf("after the change the wind comes from %.3f°", f)
	}
}

// The phases of the shifts and of the axis are exact at any tick a world
// reaches: the same as math/big's.
func TestPhasesExact(t *testing.T) {
	for _, tick := range []float64{7.4e8, 1<<31 + 1, 1 << 52, 1<<53 - 1} {
		for _, period := range []float64{7200, 11881, 648001, 3} {
			turns := 1 / period
			got := cycle(turns, tick) / (2 * math.Pi)
			x := new(big.Float).SetPrec(200).Mul(big.NewFloat(turns).SetPrec(200), big.NewFloat(tick).SetPrec(200))
			whole, _ := x.Int(nil)
			frac, _ := new(big.Float).Sub(x, new(big.Float).SetInt(whole)).Float64()
			if math.Abs(got-frac) > 1e-15 && math.Abs(math.Abs(got-frac)-1) > 1e-15 {
				t.Errorf("tick %.0f, period %.0f: a fraction of %.17g, math/big's %.17g", tick, period, got, frac)
			}
		}
	}
}

// The refuge is never exceeded: within a nautical mile of the centre the
// mean wind stays under 14 knots and the wind with its gusts under 18,
// sampled every minute on a 50 m grid through stormy spells; beyond its
// blend the refuge changes nothing.
func TestRefuge(t *testing.T) {
	p := testWeather(t)
	params, _ := weatherOnce()
	spells := 20
	minutes := 30
	if testing.Short() {
		spells, minutes = 4, 10
	}
	rng := rand.New(rand.NewPCG(5, 5))
	var meanMost, windMost float64
	for n := range spells {
		s := spellOfRegime(t, p, "stormy", uint32(n), 360*rng.Float64(), 0, 2*hourOfTicks)
		w := weatherOf(p, s)
		for range minutes {
			tick := float64(rng.IntN(2*hourOfTicks)) + worldTick
			var at WeatherTick
			WeatherAt(w, &at, tick)
			for x := -nm; x <= nm; x += 50 {
				for y := -nm; y <= nm; y += 50 {
					if x*x+y*y > nm*nm {
						continue
					}
					var pt WindPoint
					WindPointAt(&at, x, y, &pt, nil)
					meanMost, windMost = max(meanMost, pt.MeanSpeed), max(windMost, pt.Speed)
				}
			}
		}
	}
	t.Logf("within a mile: the mean wind at most %.2f knots, the wind %.2f", meanMost/knot, windMost/knot)
	if meanMost >= params.RefugeMean*knot || windMost >= params.RefugeWind*knot {
		t.Errorf("within a mile the mean wind reached %.2f knots and the wind %.2f", meanMost/knot, windMost/knot)
	}
	if meanMost < 12*knot || windMost < 15*knot {
		t.Errorf("a stormy spell's wind within a mile is only %.2f knots, %.2f with gusts", meanMost/knot, windMost/knot)
	}
	// Outside the refuge's blend, its limits are not felt.
	s := spellOfRegime(t, p, "stormy", 1, 0, 0, 0)
	w := weatherOf(p, s)
	pt := windAt(w, 0, 1.5*nm, worldTick)
	factor := p.speedCentre + p.speedSpan*smooth(1.5*nm/p.rim)
	if math.Abs(pt.MeanSpeed-s.Speed*SeaSpeedStep*factor) > 1e-9 {
		t.Errorf("at 1.5 NM the mean wind is %.3f m/s, not the spell's %.3f", pt.MeanSpeed, s.Speed*SeaSpeedStep*factor)
	}
}

// Computing the wind allocates nothing, and never gives a NaN, at any
// place, in any spell, at any tick up to 2⁵².
func TestWindAllocatesNothingNorNaN(t *testing.T) {
	p := testWeather(t)
	rng := rand.New(rand.NewPCG(3, 9))
	ids := []string{"settled", "trade", "unsettled", "stormy"}
	for i := range 10000 {
		a := spellOfRegime(t, p, ids[i%4], rng.Uint32(), 360*rng.Float64(), math.Floor(rng.Float64()*(1<<52)), float64(rng.IntN(1<<30)))
		b := spellOfRegime(t, p, ids[(i+1)%4], rng.Uint32(), 360*rng.Float64(), a.Begin+float64(rng.IntN(1<<20)), 0)
		b.Change = float64(rng.IntN(20000))
		w := weatherOf(p, a, b)
		x, y := (rng.Float64()-0.5)*20000, (rng.Float64()-0.5)*20000
		tick := math.Floor(rng.Float64() * (1 << 52))
		if rng.IntN(2) == 0 {
			tick = b.Begin + float64(rng.IntN(int(b.Change)+1))
		}
		pt := windAt(w, x, y, tick)
		for _, v := range []float64{pt.Speed, pt.From, pt.MeanSpeed, pt.MeanFrom, pt.Gust, pt.Factor} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				t.Fatalf("spells %+v and %+v at (%.0f, %.0f), tick %.0f: %+v", a, b, x, y, tick, pt)
			}
		}
		if pt.Speed < 0 || pt.Factor <= 0 {
			t.Fatalf("a wind of %+v", pt)
		}
	}
	w := weatherOf(p, spellOfRegime(t, p, "trade", 1, 0, 0, 0))
	var at WeatherTick
	var e Env
	if n := testing.AllocsPerRun(1000, func() {
		WeatherAt(w, &at, worldTick)
		e = WindAt(&at, 400, -800, nil)
	}); n != 0 {
		t.Errorf("the wind allocates %v times", n)
	}
	_ = e
}

// BenchmarkWindAt times the wind at a boat in a trade spell, and in a
// change of spell, with the tick's part computed once.
func BenchmarkWindAt(b *testing.B) {
	p := testWeather(b)
	trade := spellOfRegime(b, p, "trade", 1, 0, 0, 4*hourOfTicks)
	next := spellOfRegime(b, p, "unsettled", 2, 60, worldTick, 3*hourOfTicks)
	next.Change = float64(p.change)
	for _, c := range []struct {
		name string
		w    *Weather
	}{{"spell", weatherOf(p, trade)}, {"change", weatherOf(p, trade, next)}} {
		b.Run(c.name, func(b *testing.B) {
			var at WeatherTick
			WeatherAt(c.w, &at, worldTick+100)
			rng := rand.New(rand.NewPCG(1, 2))
			xs := make([]float64, 1<<16)
			for i := range xs {
				xs[i] = (rng.Float64() - 0.5) * 15000
			}
			sum := 0.0
			i := 0
			for b.Loop() {
				sum += WindAt(&at, xs[i&65535], xs[(i+7)&65535], nil).WindSpeed
				i++
			}
			_ = sum
		})
		b.Run(c.name+"/tick", func(b *testing.B) {
			var at WeatherTick
			tick := worldTick
			for b.Loop() {
				WeatherAt(c.w, &at, tick)
				tick++
			}
		})
	}
}

// The catalog's weather reads into WeatherParams field for field.
func TestCatalogWeather(t *testing.T) {
	p, err := weatherOnce()
	if err != nil {
		t.Fatal(err)
	}
	if v := reflect.ValueOf(*p); v.FieldByName("GustLife").Float() != 240 || v.FieldByName("WaveSamples").Float() != 40 {
		t.Fatalf("%+v", *p)
	}
}
