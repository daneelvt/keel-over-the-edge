// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// seaAreas is the number of the world's sea areas.
const seaAreas = physics.SeaAreas * physics.SeaAreas

// seaShare is how many areas of the next second's sea a tick brings up to
// date: all of them within the second, with a tick to spare.
const seaShare = (seaAreas + bus.SeaPeriod - 2) / (bus.SeaPeriod - 1)

// sea is the world's waves: every area's amplitudes, for the frame's sea in
// effect and for the one the next second brings.
//
// A frame holds what raises the waves, area by area (bus.Sea). The
// amplitudes that follows from are large, and a pure function of it, so they
// are kept here, outside the frames: two windows of the whole world, one in
// effect, which the steps read, and one being made ready for the second
// after. Each tick brings a share of the second's areas up to date, and
// only an area whose inputs changed costs anything, so a steady sea costs
// nothing and a changing one spreads its work evenly over the second.
//
// What raises an area's waves is its wave wind: the mean wind at its
// centre averaged over the last few minutes (physics.WaveSample). The
// samples of that average, on a grid of world time, are kept here too, with
// each area's average of them: a pure function of the tick and the frames'
// weathers, so a world loaded from a snapshot makes them again and gets the
// same.
type sea struct {
	waves   *physics.Waves
	windows [2]physics.SeaWindow
	now     int // the window in effect
	cursor  int32
	fresh   bool // the window in effect is the latest frame's sea
	time    physics.SeaTick
	view    physics.Sea
	// at is what a step reads: view, or nil in a world of flat water.
	at *physics.Sea

	timeline *weather.Timeline
	prepared *physics.WeatherPrepared
	// samples holds each area's ring of the wave wind's samples, grid
	// point k's at k modulo ring; avg each area's average of them up to
	// grid point newest. They hold nothing until made.
	samples []physics.WaveSample
	avg     []physics.WaveSample
	ring    int64
	newest  int64
	made    bool
	centres [][2]float64
	// inputs are every area's inputs at the tick inputsAt.
	inputs   []physics.SeaInput
	inputsAt int64
	hasInput bool

	scratch physics.Weather
	at1     physics.WeatherTick
	spells  [physics.WeatherSpells]physics.Spell
}

func (s *sea) init(waves *physics.Waves, t *weather.Timeline) {
	s.waves = waves
	s.timeline = t
	s.prepared = t.Prepared()
	s.scratch.Prepared = s.prepared
	if waves == nil {
		return
	}
	for i := range s.windows {
		s.windows[i] = physics.SeaWindow{
			Size:   physics.SeaAreas,
			Inputs: make([]physics.SeaInput, seaAreas),
			Amp:    make([]float64, seaAreas*physics.SeaComponents),
			Hs:     make([]float64, seaAreas),
			Peak:   make([]float64, seaAreas),
		}
	}
	s.view = physics.Sea{Waves: waves, Window: &s.windows[0], Tick: &s.time}
	s.at = &s.view
	s.ring = int64(s.prepared.WaveSamples())
	s.samples = make([]physics.WaveSample, seaAreas*s.ring)
	s.avg = make([]physics.WaveSample, seaAreas)
	s.inputs = make([]physics.SeaInput, seaAreas)
	s.centres = make([][2]float64, seaAreas)
	for r := range int32(physics.SeaAreas) {
		for c := range int32(physics.SeaAreas) {
			x, y := physics.SeaAreaCentre(c, r)
			s.centres[r*physics.SeaAreas+c] = [2]float64{x, y}
		}
	}
}

// under sets a sea, in effect and next, to what the wave wind raises over
// open water: in effect at the second of tick, next at the second after.
func (s *sea) under(f *bus.Sea, tick int64, ws []bus.Weather) {
	second := bus.SeaSecond(tick) * bus.SeaPeriod
	s.fill(f.Now, second, ws)
	s.fill(f.Next, second+bus.SeaPeriod, ws)
}

// fill sets every area's inputs to those its wave wind gives at a tick.
// Until land shelters the water, every area has the fetch of open water.
func (s *sea) fill(areas []physics.SeaInput, tick int64, ws []bus.Weather) {
	if s.waves == nil {
		clear(areas)
		return
	}
	if !s.hasInput || s.inputsAt != tick {
		s.make(tick, ws)
	}
	copy(areas, s.inputs)
}

// weatherAt is the weather at a tick.
func (s *sea) weatherAt(tick int64, ws []bus.Weather) *physics.WeatherTick {
	n := s.timeline.Spells(tick, ws, &s.spells)
	s.scratch.Set(s.spells[:n])
	physics.WeatherAt(&s.scratch, &s.at1, float64(tick))
	return &s.at1
}

// make computes every area's inputs at a tick from its wave wind.
func (s *sea) make(tick int64, ws []bus.Weather) {
	p := s.prepared
	k := p.WaveGridOf(tick)
	s.bring(k, ws)
	now := s.weatherAt(tick, ws)
	share := p.WaveDecay(float64(tick - k*p.WaveGrid()))
	for i := range s.inputs {
		c := &s.centres[i]
		speed, from := physics.WaveBlend(s.avg[i], physics.WaveSampleAt(now, c[0], c[1]), share)
		s.inputs[i] = s.waves.OpenSea(speed, from)
	}
	s.inputsAt, s.hasInput = tick, true
}

// bring makes the samples and averages up to grid point k: only the new
// ones if they follow on from those made, all of them otherwise.
func (s *sea) bring(k int64, ws []bus.Weather) {
	if s.made && s.newest == k {
		return
	}
	from := k - s.ring + 1
	if s.made && s.newest < k && s.newest >= from {
		from = s.newest + 1
	}
	for j := from; j <= k; j++ {
		at := s.weatherAt(s.prepared.WaveSampleTick(j), ws)
		slot := j % s.ring
		if slot < 0 {
			slot += s.ring
		}
		for i := range s.centres {
			c := &s.centres[i]
			s.samples[int64(i)*s.ring+slot] = physics.WaveSampleAt(at, c[0], c[1])
		}
	}
	for i := range s.avg {
		s.avg[i] = s.prepared.WaveAverage(s.samples[int64(i)*s.ring:int64(i+1)*s.ring], k)
	}
	s.newest, s.made = k, true
}

// roll sets dst to the sea at tick to, given src, the sea at tick from, and
// the developer's weathers as they stood at from. Within a second nothing
// changes. Into the next second, what was fixed for it comes into effect,
// and the wave wind fixes the second after: so a change of weather reaches
// the waves no sooner than the next second but one. Over more than a
// second, as when the world's time jumps, both are the wave wind's. dst may
// be src.
func (s *sea) roll(dst, src *bus.Sea, from, to int64, ws []bus.Weather) {
	switch bus.SeaSecond(to) - bus.SeaSecond(from) {
	case 0:
		copy(dst.Now, src.Now)
		copy(dst.Next, src.Next)
	case 1:
		copy(dst.Now, src.Next)
		s.fill(dst.Next, (bus.SeaSecond(to)+1)*bus.SeaPeriod, ws)
	default:
		s.under(dst, to, ws)
	}
}

// loaded says the latest frame was replaced: its sea is not the windows',
// and the wave wind's samples are made again, for the weathers they
// followed may differ.
func (s *sea) loaded() {
	s.fresh, s.made, s.hasInput = false, false, false
}

// tick brings the waves to f's tick: the window in effect holds f's sea,
// the other moves a share toward the next second's, and the time is f's.
func (s *sea) tick(f *bus.Frame) {
	if s.waves == nil {
		return
	}
	second := bus.SeaSecond(f.Tick)
	if !s.fresh || second != bus.SeaSecond(f.Tick-1-f.Skipped) {
		// A second begins, or the world was loaded. The window made ready
		// for this second comes into effect; whatever of it is not ready,
		// as after a jump in time, is made so now.
		next := &s.windows[1-s.now]
		s.bringAreas(next, f.Sea.Now, 0, seaAreas)
		next.Seal()
		s.now = 1 - s.now
		s.view.Window = next
		s.cursor = 0
		s.fresh = true
	}
	if s.cursor < seaAreas {
		end := min(s.cursor+seaShare, seaAreas)
		s.bringAreas(&s.windows[1-s.now], f.Sea.Next, s.cursor, end)
		s.cursor = end
	}
	physics.SeaAtTick(s.waves, &s.time, f.Tick)
}

// bringAreas sets the areas from lo up to hi of a window to their inputs.
func (s *sea) bringAreas(win *physics.SeaWindow, inputs []physics.SeaInput, lo, hi int32) {
	for i := lo; i < hi; i++ {
		physics.SeaArea(s.waves, win, i, inputs[i])
	}
}
