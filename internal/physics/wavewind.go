// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The sea lags the wind: it builds after the wind rises and goes down after
// it falls. The wind that raises a sea area's waves is the mean wind at the
// area's centre, its gusts left out, averaged over the last few minutes with
// an exponential weight. Over the six nautical miles of open water a real
// sea takes two to three hours to build (US Army Corps of Engineers, Coastal
// Engineering Manual, 2008, II-2, the minimum duration of fetch-limited
// growth), which at the world's pace, twelve times the real one, is ten to
// fifteen minutes: an average with a time constant of four minutes reaches
// 95% in twelve.
//
// The average is of samples on a grid of world time: the last few, each a
// constant share of the one after it, and between grid points the present
// wind, weighed by the time since the last. Each sample stands for the
// interval of the grid that ends at its point, and is taken at its middle,
// so that the sum follows the continuous average: a step of wind is 63% of
// the way after one time constant. It is a pure function of the tick and the
// weather, so a server that restarts makes the same sea.
//
// Speed and direction are averaged apart: the speed as a mean of speeds,
// the direction as that of the mean of the wind's vectors, so that a wind
// that veers does not lower the sea as it turns.

// WaveSample is the mean wind at a point of the grid: its speed, m/s, and
// its vector's east and north parts, pointing where it comes from.
type WaveSample struct {
	Speed, East, North float64
}

// WaveSampleAt is the mean wind at (x, y) at the tick t was set to, as a
// sample of the wave wind.
func WaveSampleAt(t *WeatherTick, x, y float64) WaveSample {
	speed, from := MeanWindAt(t, x, y)
	sin, cos := SinCos(from)
	return WaveSample{Speed: speed, East: float64(speed * sin), North: float64(speed * cos)}
}

// WaveSampleTick is the tick the sample of grid point k is taken at: the
// middle of the interval that ends at the point.
func (w *WeatherPrepared) WaveSampleTick(k int64) int64 {
	g := int64(w.waveGrid)
	return k*g - g/2
}

// WaveGridOf is the grid point of the newest sample at or before a tick:
// its index, counted from tick 0.
func (w *WeatherPrepared) WaveGridOf(tick int64) int64 {
	g := int64(w.waveGrid)
	k := tick / g
	if tick%g < 0 {
		k--
	}
	return k
}

// WaveAverage is the average of the samples on the grid up to the newest:
// ring holds one sample per grid point, the grid point k's at index k
// modulo its length, which is at least the catalog's number of samples, and
// newest is the index of the newest grid point. The samples are summed
// newest first, so the result depends on their values alone, not on where
// the ring begins.
func (w *WeatherPrepared) WaveAverage(ring []WaveSample, newest int64) WaveSample {
	n := int64(len(ring))
	var sum WaveSample
	for i := range int64(w.waveSamples) {
		j := (newest - i) % n
		if j < 0 {
			j += n
		}
		s, weight := &ring[j], w.waveWeights[i]
		sum.Speed += float64(weight * s.Speed)
		sum.East += float64(weight * s.East)
		sum.North += float64(weight * s.North)
	}
	return sum
}

// WaveDecay is the average's share of the wave wind since ticks after its
// newest sample: the present has the rest.
func (w *WeatherPrepared) WaveDecay(since float64) float64 {
	return Exp(-float64(max2(since, 0) * w.invWaveTime))
}

// WaveBlend is the wave wind from the samples' average, which weighs share,
// and the present mean wind: its speed and the direction it comes from.
func WaveBlend(avg, now WaveSample, share float64) (speed, from float64) {
	rest := 1 - share
	speed = float64(share*avg.Speed) + float64(rest*now.Speed)
	east := float64(share*avg.East) + float64(rest*now.East)
	north := float64(share*avg.North) + float64(rest*now.North)
	if east == 0 && north == 0 {
		return speed, 0
	}
	return speed, Atan2(east, north)
}

// WaveWindAt is the wave wind at (x, y) at a tick, computed afresh in the
// spells of w: what a client that makes its own sea uses, once a second for
// each area about its boat. The server keeps the samples instead, made in
// the spells of their own times.
func WaveWindAt(w *Weather, x, y float64, tick float64, scratch *WeatherTick, ring *[MaxWaveSamples]WaveSample) (speed, from float64) {
	p := w.Prepared
	grid := p.waveSample
	k := math.Floor(tick / grid)
	if float64(k*grid) > tick {
		k--
	}
	n := int64(p.waveSamples)
	half := float64(p.waveGrid / 2)
	for i := range n {
		WeatherAt(w, scratch, float64((k-float64(i))*grid)-half)
		// The ring as if the newest grid point were 0: one i points older
		// is at index −i modulo n.
		ring[(n-i)%n] = WaveSampleAt(scratch, x, y)
	}
	WeatherAt(w, scratch, tick)
	now := WaveSampleAt(scratch, x, y)
	return WaveBlend(p.WaveAverage(ring[:n], 0), now, p.WaveDecay(tick-float64(k*grid)))
}
