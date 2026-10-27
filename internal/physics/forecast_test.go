// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"math/rand/v2"
	"slices"
	"testing"
)

// The forecast is the truth: at every minute over its reach, its
// keyframes are those the server makes from the same records, bit for bit,
// a system born after the issue among them from its birth, and one gone by
// the issue left out; its records' own time is the week's.
func TestForecastIsTheTruth(t *testing.T) {
	p, kinds := testForecast(t)
	const issue, origin = 740_016_000, 1_000_000
	rs := forecastRecords(kinds, issue-origin)
	gone := rs[1]
	gone.Seed, gone.Born, gone.Mature, gone.Decays, gone.Gone = 99, gone.Born-40*minuteTicks, gone.Born-35*minuteTicks, gone.Born-30*minuteTicks, issue-origin-minuteTicks
	slots := []int32{3, 5, 7, 9, 11, 13, 2}
	var f Forecast
	MakeForecast(p, &ForecastInput{Issue: issue, Every: 300, Origin: origin, Records: append(rs, gone), Slots: slots}, &f)
	if f.Head.NSystems != float64(len(rs)) {
		t.Fatalf("%v systems, want the %d alive or born within its reach, not the one gone", f.Head.NSystems, len(rs))
	}
	if want := issue + float64(p.ForecastReach()); f.Head.Until != want {
		t.Errorf("it knows the systems to %v, not %v", f.Head.Until, want)
	}
	later := false
	var k Keyframe
	for at := float64(issue); at <= f.Head.Until; at += minuteTicks {
		ForecastKeyframe(&f, at, &k)
		for i, r := range rs {
			want := SystemAt(&r, at-origin)
			if k.Systems[slots[i]] != want {
				t.Fatalf("%v min on: slot %d is %+v, the truth %+v", (at-issue)/minuteTicks, slots[i], k.Systems[slots[i]], want)
			}
			if i == len(rs)-1 && want.On != 0 {
				later = true
			}
		}
	}
	if !later {
		t.Errorf("the shower born after the issue was never on the forecast")
	}
	// Between keyframes it is interpolated as the server's: the weather it
	// gives is that of the server's two keyframes about the tick.
	w := &Weather{Prepared: p}
	ForecastAt(w, &f, issue+40*minuteTicks+77)
	b := float64(issue + 40*minuteTicks)
	for j, at := range []float64{b, b + 300} {
		if w.Keys[j].Tick != at {
			t.Fatalf("keyframe %d at %v, not %v", j, w.Keys[j].Tick, at)
		}
		for i, r := range rs {
			if w.Keys[j].Systems[slots[i]] != SystemAt(&r, at-origin) {
				t.Errorf("keyframe %d, slot %d: not the server's", j, slots[i])
			}
		}
	}
	// The latest born are left out when it holds no more.
	many := make([]SystemRecord, MaxForecastSystems+5)
	for i := range many {
		many[i] = rs[1]
		many[i].Seed = float64(i + 1)
		many[i].Born += float64(i)
	}
	MakeForecast(p, &ForecastInput{Issue: issue, Every: 300, Origin: origin, Records: many}, &f)
	if f.Head.NSystems != MaxForecastSystems || f.Systems[0].Seed != 1 {
		t.Errorf("%v systems kept of %d, the first seed %v", f.Head.NSystems, len(many), f.Systems[0].Seed)
	}
}

// The spells are forecast as they are, the shifts named, not placed, a
// spell not yet begun with no error of the forecast's own.
func TestForecastSpells(t *testing.T) {
	p, _ := testForecast(t)
	const issue = 740_016_000
	now := spellOfRegime(t, p, "trade", 1, 225, issue-hourOfTicks, 4*hourOfTicks)
	next := spellOfRegime(t, p, "unsettled", 2, 260, issue+30*minuteTicks, 4*hourOfTicks)
	next.Change = 10 * minuteTicks
	var f Forecast
	MakeForecast(p, &ForecastInput{Issue: issue, Spells: []Spell{now, next}}, &f)
	for i, s := range []Spell{now, next} {
		a, b := f.Spells[i], s
		a.Shift, b.Shift = [2]float64{}, [2]float64{}
		if a != b {
			t.Errorf("spell %d was changed: %+v, %+v", i, a, b)
		}
		if f.Head.Shifts[i] != s.Shift[0]+s.Shift[1] || f.Spells[i].Shift != [2]float64{} {
			t.Errorf("spell %d's shifts: %v named, %v placed", i, f.Head.Shifts[i], f.Spells[i].Shift)
		}
	}
}

// The typical strongest gust's quantile is the gust field's 90th
// percentile of h′, the field as the gust factor reads it.
func TestTypicalGustQuantile(t *testing.T) {
	p, _ := testForecast(t)
	rng := rand.New(rand.NewPCG(13, 14))
	n := gustSamples()
	hs := make([]float64, n)
	var at WeatherTick
	for i := range hs {
		if i%1000 == 0 {
			s := spellOfRegime(t, p, "trade", rng.Uint32(), 360*rng.Float64(), 0, 0)
			WeatherAt(weatherOf(p, s), &at, math.Floor(rng.Float64()*1e9))
		}
		var wp WindPoint
		WindPointAt(&at, (rng.Float64()-0.5)*16000, (rng.Float64()-0.5)*16000, &wp, nil)
		h := wp.Gust
		if h < 0 {
			h /= 2
		}
		hs[i] = h
	}
	slices.Sort(hs)
	q90 := hs[int(0.9*float64(n))]
	if want := p.forecast.quantile + gustMeanH; math.Abs(q90-want) > 0.01 {
		t.Errorf("the gust field's 90th percentile is %.4f, the catalog's quantile %.4f", q90, want)
	}
}

// A forecast, its gale scan and the weather at a tick from it allocate
// nothing.
func TestForecastAllocatesNothing(t *testing.T) {
	p, kinds := testForecast(t)
	const issue = 740_016_000
	rs := forecastRecords(kinds, issue)
	stormy := spellOfRegime(t, p, "stormy", 3, 250, issue-hourOfTicks, 3*hourOfTicks)
	in := ForecastInput{Issue: issue, Every: 300, Spells: []Spell{stormy, frontSpell(t, p, issue+40*minuteTicks)}, Records: rs}
	f := new(Forecast)
	w := &Weather{Prepared: p}
	var at WeatherTick
	water := make([]uint8, MaxGaleSide*MaxGaleSide)
	on := make([]uint8, len(water))
	var g Gales
	if n := testing.AllocsPerRun(10, func() {
		MakeForecast(p, &in, f)
		GaleScan(p, f, w, &at, water, on, &g)
		ForecastAt(w, f, issue+1234)
		WeatherAt(w, &at, issue+1234)
		TypicalAt(&at, 100, 200)
	}); n != 0 {
		t.Errorf("%v allocations", n)
	}
}

// benchInput is a forecast's input: a stormy spell with a front coming,
// and the systems' records about the issue.
func benchInput(b *testing.B) (*WeatherPrepared, *ForecastInput) {
	p, kinds := testForecast(b)
	const issue = 740_016_000
	return p, &ForecastInput{Issue: issue, Every: 300, Spells: []Spell{
		spellOfRegime(b, p, "stormy", 3, 250, issue-hourOfTicks, 3*hourOfTicks),
		frontSpell(b, p, issue+40*minuteTicks),
	}, Records: forecastRecords(kinds, issue)}
}

func BenchmarkMakeForecast(b *testing.B) {
	p, in := benchInput(b)
	f := new(Forecast)
	for b.Loop() {
		MakeForecast(p, in, f)
	}
	b.ReportMetric(float64(f.Head.NSystems), "systems")
}

// Its gale scan, every point of the grid taken for water.
func BenchmarkGaleScan(b *testing.B) {
	p, in := benchInput(b)
	f := new(Forecast)
	MakeForecast(p, in, f)
	w := &Weather{Prepared: p}
	var at WeatherTick
	water := make([]uint8, MaxGaleSide*MaxGaleSide)
	for i := range water {
		water[i] = 1
	}
	on := make([]uint8, len(water))
	var g Gales
	for b.Loop() {
		GaleScan(p, f, w, &at, water, on, &g)
	}
}

// The synoptic wind leaves the squalls and showers out: with only a squall
// on the water its wind there is the spell's alone.
func TestSynopticLeavesOutTheDomes(t *testing.T) {
	p, kinds := testForecast(t)
	const tick = 740_016_000
	s := spellOfRegime(t, p, "trade", 1, 225, tick-hourOfTicks, 4*hourOfTicks)
	sq := systemAt(kinds["squall"], 0, 0, 75, 0.45*nm, 16, 3)
	sq.Strength = strengthSteps
	w := weatherOf(p, s)
	w.SetKeys([]Keyframe{{Tick: tick}})
	w.SetSystem(0, 0, &sq)
	plain := weatherOf(p, s)
	var a, b WeatherTick
	WeatherAt(w, &a, tick)
	with, _ := MeanWindAt(&a, 300, 0)
	w.Synoptic = true
	WeatherAt(w, &a, tick)
	WeatherAt(plain, &b, tick)
	without, _ := MeanWindAt(&a, 300, 0)
	alone, _ := MeanWindAt(&b, 300, 0)
	if without != alone || with == alone {
		t.Errorf("the mean wind by the squall: %v with it, %v synoptic, %v with no squall", with, without, alone)
	}
}
