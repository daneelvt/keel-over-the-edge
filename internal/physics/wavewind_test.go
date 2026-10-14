// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// waveWindAt is the wave wind at a place and tick, computed afresh.
func waveWindAt(w *Weather, x, y, tick float64) (speed, from float64) {
	var scratch WeatherTick
	var ring [MaxWaveSamples]WaveSample
	return WaveWindAt(w, x, y, tick, &scratch, &ring)
}

// The sea follows a step of wind as an average with a time constant of
// four minutes does: 63% of the way after 240 s and 95% after 720 s,
// within 2%, for a step on the samples' grid, and it does not move before
// the wind does. A step between grid points is taken as if it had come at
// the grid point before it, so the wave wind is ahead by up to one
// sample's weight at first, and by less as that decays.
func TestWaveWindFollowsAStep(t *testing.T) {
	p := testWeather(t)
	params, _ := weatherOnce()
	grid := float64(p.waveGrid)
	oneSample := 1 - math.Exp(-params.WaveSample/params.WaveTimeConstant)
	for _, offset := range []float64{0, 1, grid / 3, grid / 2, grid - 1} {
		at := 822000*grid + offset
		a := SteadySpell(5, 1, 0)
		b := SteadySpell(15, 1, at)
		w := weatherOf(p, a, b)
		for _, seconds := range []float64{-30, -1.0 / StepsPerSecond, 0, 240, 720, 3600} {
			speed, from := waveWindAt(w, 300, -200, at+seconds*StepsPerSecond)
			got, want, ahead := (speed-5)/10, 0.0, 0.0
			if seconds >= 0 {
				want = 1 - math.Exp(-seconds/params.WaveTimeConstant)
				if offset > 0 {
					ahead = oneSample * math.Exp(-seconds/params.WaveTimeConstant)
				}
			}
			if got < want-0.02 || got > want+ahead+0.02 {
				t.Errorf("a step %v ticks past the grid: after %v s the wave wind is %.1f%% of the way, want %.1f%% and at most %.1f%% more", offset, seconds, 100*got, 100*want, 100*ahead)
			}
			if math.Abs(wrapAngle(from-1)) > 1e-4 {
				t.Errorf("after %v s the wave wind comes from %v", seconds, from)
			}
		}
	}
}

// A wind that veers a quarter turn turns the wave wind with it, and does
// not lower its speed by more than 1% on the way: the speed is a mean of
// speeds, not the length of a mean vector, which would fall by a third.
func TestWaveWindThroughAVeer(t *testing.T) {
	p := testWeather(t)
	at := 822000 * float64(p.waveGrid)
	w := weatherOf(p, SteadySpell(10, 0, 0), SteadySpell(10, math.Pi/2, at))
	turned := 0.0
	for seconds := 0.0; seconds <= 1500; seconds += 7 {
		speed, from := waveWindAt(w, 0, 0, at+seconds*StepsPerSecond)
		if math.Abs(speed-10) > 0.1 {
			t.Fatalf("%v s into the veer the wave wind is %.3f m/s", seconds, speed)
		}
		if from < turned-1e-9 || from > math.Pi/2+1e-9 {
			t.Fatalf("%v s into the veer the wave wind comes from %.2f°, after %.2f°", seconds, from/deg, turned/deg)
		}
		turned = from
	}
	if math.Abs(turned-math.Pi/2) > 0.01 {
		t.Errorf("25 minutes after the veer the wave wind comes from %.2f°", turned/deg)
	}
}

// The wave wind leaves the gusts out: over a minute at a place its spread
// is under 1% of the wind's own.
func TestWaveWindLeavesTheGustsOut(t *testing.T) {
	p := testWeather(t)
	w := weatherOf(p, spellOfRegime(t, p, "unsettled", 6, 120, 0, 0))
	spread := func(v []float64) float64 {
		var sum, sq float64
		for _, x := range v {
			sum += x
			sq += x * x
		}
		m := sum / float64(len(v))
		return math.Sqrt(max(sq/float64(len(v))-m*m, 0))
	}
	var waves, winds []float64
	for place := range 20 {
		x, y := 300*float64(place)-3000, 2000.0
		var wave, wind []float64
		for second := range 60 {
			tick := worldTick + float64(place*5000+second*StepsPerSecond)
			s, _ := waveWindAt(w, x, y, tick)
			wave = append(wave, s)
			wind = append(wind, windAt(w, x, y, tick).Speed)
		}
		waves, winds = append(waves, spread(wave)), append(winds, spread(wind))
	}
	var a, b float64
	for i := range waves {
		a += waves[i]
		b += winds[i]
	}
	t.Logf("over a minute the wave wind's spread is %.4f m/s, the wind's %.3f m/s", a/20, b/20)
	if a > 0.01*b {
		t.Errorf("over a minute the wave wind's spread is %.4f m/s, the wind's %.3f m/s", a/20, b/20)
	}
}

// The samples kept in a ring, brought up one grid point at a time, give
// the wave wind computed afresh, bit for bit: wherever the ring begins.
func TestWaveWindFromARing(t *testing.T) {
	p := testWeather(t)
	w := weatherOf(p, spellOfRegime(t, p, "trade", 2, 30, 0, 4*hourOfTicks))
	n := int64(p.waveSamples)
	ring := make([]WaveSample, n)
	const x, y = 1200.0, -3400.0
	var at WeatherTick
	sample := func(k int64) {
		WeatherAt(w, &at, float64(p.WaveSampleTick(k)))
		ring[((k%n)+n)%n] = WaveSampleAt(&at, x, y)
	}
	first := p.WaveGridOf(int64(worldTick))
	for k := first - n + 1; k <= first; k++ {
		sample(k)
	}
	for tick := int64(worldTick); tick < int64(worldTick)+5*int64(p.waveGrid); tick += 97 {
		k := p.WaveGridOf(tick)
		for j := first + 1; j <= k; j++ {
			sample(j)
		}
		first = max(first, k)
		WeatherAt(w, &at, float64(tick))
		speed, from := WaveBlend(p.WaveAverage(ring, k), WaveSampleAt(&at, x, y), p.WaveDecay(float64(tick-k*int64(p.waveGrid))))
		wantSpeed, wantFrom := waveWindAt(w, x, y, float64(tick))
		if math.Float64bits(speed) != math.Float64bits(wantSpeed) || math.Float64bits(from) != math.Float64bits(wantFrom) {
			t.Fatalf("tick %d: %v from %v out of the ring, %v from %v afresh", tick, speed, from, wantSpeed, wantFrom)
		}
	}
	if p.WaveGridOf(-1) != -1 || p.WaveGridOf(0) != 0 || p.WaveGridOf(int64(p.waveGrid)) != 1 {
		t.Error("the grid is not counted from tick 0")
	}
}
