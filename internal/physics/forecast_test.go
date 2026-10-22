// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"math/rand/v2"
	"slices"
	"testing"
)

// At the issue every system the forecast knows is where the truth has it,
// as strong as it is; ahead, it is where its planned track takes it from
// there, a storm round its arc, never on a straight line.
func TestForecastFromThePresent(t *testing.T) {
	p, kinds := testForecast(t)
	const issue = 740_016_000
	rs := forecastRecords(kinds, issue)
	var f Forecast
	MakeForecast(p, &ForecastInput{Issue: issue, Records: rs}, &f)
	if f.Head.NSystems != 5 {
		t.Fatalf("%v systems, want the five alive or forming, not the shower born after the issue", f.Head.NSystems)
	}
	for i := range int(f.Head.NSystems) {
		s := &f.Systems[i]
		r := &rs[int(s.Slot)]
		if s.Forming != 0 {
			continue
		}
		truth := SystemAt(r, issue)
		if math.Hypot(s.East[0]-truth.East/4, s.North[0]-truth.North/4) > 0.75 {
			t.Errorf("slot %v: at the issue (%v, %v), the truth (%v, %v)", s.Slot, s.East[0], s.North[0], truth.East/4, truth.North/4)
		}
		if math.Abs(s.Strength[0]/256-truth.Strength/4096) > 1.0/256 {
			t.Errorf("slot %v: strength %v at the issue, the truth %v", s.Slot, s.Strength[0]/256, truth.Strength/4096)
		}
		// Ahead, the track's own motion from the true place at the issue.
		v, _ := recordAt(r, issue)
		te, tn, _, _ := trackAt(r, issue)
		for k := range int32(f.Head.Steps) {
			if !(s.Strength[k] > 0) {
				continue
			}
			e, n, _, _ := trackAt(r, issue+float64(k)*f.Head.Step)
			if math.Hypot(s.East[k]-(e+v.east-te), s.North[k]-(n+v.north-tn)) > 0.75 {
				t.Errorf("slot %v step %d: off its planned track", s.Slot, k)
			}
		}
	}
	// The storm on its arc: its forecast an hour on is on the arc, far
	// from where a straight line from its heading at the issue would put
	// it.
	storm := &f.Systems[3]
	r := &rs[int(storm.Slot)]
	if r.Track != TrackArc {
		t.Fatalf("system 3 is not the storm")
	}
	_, _, heading, speed := trackAt(r, issue)
	ux, uy := SinCos(heading)
	d := speed * 3600
	line := [2]float64{storm.East[0] + d*ux, storm.North[0] + d*uy}
	if miss := math.Hypot(storm.East[6]-line[0], storm.North[6]-line[1]); miss < 300 {
		t.Errorf("the storm an hour on is %.0f m from a straight line: not round its arc", miss)
	}
	// The low forming: nothing until it is born, then its plan, its cone
	// the forming one.
	forming := &f.Systems[4]
	if forming.Forming == 0 || forming.Seed != 0 {
		t.Fatalf("system 4 is not a low forming, or carries a seed: %+v", forming)
	}
	for k := range int32(f.Head.Steps) {
		at := issue + float64(k)*f.Head.Step
		born := at >= rs[4].Born
		if born != (forming.Strength[k] > 0) && !(at == rs[4].Born) {
			t.Errorf("step %d: the low forming has strength %v, born %v", k, forming.Strength[k], born)
		}
		if born {
			e, n := SystemTrack(&rs[4], at)
			if math.Hypot(forming.East[k]-e, forming.North[k]-n) > 0.75 {
				t.Errorf("step %d: the low forming is not on its plan", k)
			}
		}
		if c := ForecastCone(p, &f, forming, k); c != p.forecast.forming {
			t.Errorf("step %d: its cone %v, not the forming %v", k, c, p.forecast.forming)
		}
	}
	// The squall beyond the lip is forecast to cross it.
	if sq := &f.Systems[0]; sq.Crosses <= issue || math.Abs(math.Hypot(sq.CrossEast, sq.CrossNorth)-p.Edge()) > 1 {
		t.Errorf("the squall beyond the lip crosses at %v, at (%v, %v)", sq.Crosses, sq.CrossEast, sq.CrossNorth)
	}
}

// A front's band holds its line four times in five: over many fronts, the
// true line at a lead lies within the band about the forecast's at that
// lead about 80% of the time.
func TestFrontBand(t *testing.T) {
	p, _ := testForecast(t)
	rng := rand.New(rand.NewPCG(5, 6))
	reach := p.FrontReach()
	inside, cases := 0, 0
	for range 20000 {
		issue := math.Floor(rng.Float64() * 1e8)
		change := math.Round(2 * reach / ((4 + 4*rng.Float64()) * knotSpeed) * StepsPerSecond)
		s := Spell{Begin: issue - math.Round(rng.Float64()*change), Change: change, Front: 1, Seed: float64(rng.Uint32()), Speed: 800, Gust: 1300}
		lead := math.Round(rng.Float64() * 90 * minuteTicks)
		at := issue + lead
		fs := s
		forecastSpell(&p.forecast, &fs, issue)
		truth := 2*reach*(at-s.Begin)/s.Change - reach
		fc := 2*reach*(at-fs.Begin)/fs.Change - reach
		cases++
		if math.Abs(truth-fc) <= FrontBand(p, &fs, lead) {
			inside++
		}
	}
	if s := float64(inside) / float64(cases); s < 0.78 || s > 0.82 {
		t.Errorf("a front's band held its line %.1f%% of %d times", 100*s, cases)
	}
}

// A spell already blowing at the issue is forecast as it is, its shifts
// named, not placed; one not yet begun with the forecast's own error, the
// same at every issue.
func TestForecastSpells(t *testing.T) {
	p, _ := testForecast(t)
	const issue = 740_016_000
	now := spellOfRegime(t, p, "trade", 1, 225, issue-hourOfTicks, 4*hourOfTicks)
	next := spellOfRegime(t, p, "unsettled", 2, 260, issue+30*minuteTicks, 4*hourOfTicks)
	next.Change = 10 * minuteTicks
	var f, g Forecast
	MakeForecast(p, &ForecastInput{Issue: issue, Spells: []Spell{now, next}}, &f)
	MakeForecast(p, &ForecastInput{Issue: issue - 10*minuteTicks, Spells: []Spell{now, next}}, &g)
	a, b := f.Spells[0], now
	a.Shift, b.Shift = [2]float64{}, [2]float64{}
	if a != b {
		t.Errorf("the spell blowing was changed: %+v, %+v", a, b)
	}
	if f.Head.Shifts[0] != now.Shift[0]+now.Shift[1] || f.Spells[0].Shift != [2]float64{} {
		t.Errorf("the shifts: %v named, %v placed", f.Head.Shifts[0], f.Spells[0].Shift)
	}
	if f.Spells[1].From == next.From && f.Spells[1].Speed == next.Speed {
		t.Errorf("the spell to come has no error")
	}
	if f.Spells[1] != g.Spells[1] {
		t.Errorf("the spell to come differs between issues: %+v, %+v", f.Spells[1], g.Spells[1])
	}
	// Its errors are about the standard deviations asked over many spells.
	var dirs, speeds []float64
	for i := range 4000 {
		s := next
		s.Seed = float64(uint32(i) * 2654435761)
		forecastSpell(&p.forecast, &s, issue)
		dirs = append(dirs, wrapAngle((s.From-next.From)*turnStep)/degree)
		speeds = append(speeds, s.Speed/next.Speed-1)
	}
	if sd := stdDev(dirs); math.Abs(sd-15) > 1 {
		t.Errorf("the next spell's direction errs by %.1f° (standard deviation), not 15°", sd)
	}
	if sd := stdDev(speeds); math.Abs(sd-0.1) > 0.008 {
		t.Errorf("its speed errs by %.3f, not 0.1", sd)
	}
}

func stdDev(a []float64) float64 {
	var m, q float64
	for _, x := range a {
		m += x
	}
	m /= float64(len(a))
	for _, x := range a {
		q += (x - m) * (x - m)
	}
	return math.Sqrt(q / float64(len(a)))
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
	in := ForecastInput{Issue: issue, Spells: []Spell{stormy, frontSpell(t, p, issue+40*minuteTicks)}, Records: rs}
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
