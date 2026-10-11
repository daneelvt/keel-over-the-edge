// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
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
}

func (s *sea) init(waves *physics.Waves) {
	s.waves = waves
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
}

// under sets a sea, in effect and next, to what a wind raises over open
// water.
func (s *sea) under(f *bus.Sea, wind bus.Wind) {
	s.fill(f.Now, wind)
	s.fill(f.Next, wind)
}

// fill sets every area's inputs to the wind's. Until the wind varies from
// place to place and land shelters the water, every area has the world's one
// wind and the fetch of open water.
func (s *sea) fill(areas []physics.SeaInput, wind bus.Wind) {
	var in physics.SeaInput
	if s.waves != nil {
		in = s.waves.OpenSea(wind.Speed, wind.From)
	}
	for i := range areas {
		areas[i] = in
	}
}

// roll sets dst to the sea at tick to, given src, the sea at tick from, and
// the wind as it stood at from. Within a second nothing changes. Into the
// next second, what was fixed for it comes into effect, and the wind fixes
// the second after: so a change of wind reaches the waves no sooner than
// the next second but one. Over more than a second, as when the world's
// time jumps, the wind has had its second already. dst may be src.
func (s *sea) roll(dst, src *bus.Sea, from, to int64, wind bus.Wind) {
	switch bus.SeaSecond(to) - bus.SeaSecond(from) {
	case 0:
		copy(dst.Now, src.Now)
		copy(dst.Next, src.Next)
	case 1:
		copy(dst.Now, src.Next)
		s.fill(dst.Next, wind)
	default:
		s.under(dst, wind)
	}
}

// loaded says the latest frame was replaced: its sea is not the windows'.
func (s *sea) loaded() { s.fresh = false }

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
		s.bring(next, f.Sea.Now, 0, seaAreas)
		next.Seal()
		s.now = 1 - s.now
		s.view.Window = next
		s.cursor = 0
		s.fresh = true
	}
	if s.cursor < seaAreas {
		end := min(s.cursor+seaShare, seaAreas)
		s.bring(&s.windows[1-s.now], f.Sea.Next, s.cursor, end)
		s.cursor = end
	}
	physics.SeaAtTick(s.waves, &s.time, f.Tick)
}

// bring sets the areas from lo up to hi of a window to their inputs.
func (s *sea) bring(win *physics.SeaWindow, inputs []physics.SeaInput, lo, hi int32) {
	for i := lo; i < hi; i++ {
		physics.SeaArea(s.waves, win, i, inputs[i])
	}
}
