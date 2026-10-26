// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/view"
)

// What a machine sailor's lookout sees: of the other boats, those its
// phone would be sent (package view) whose masts stand over the horizon
// from the lookout's eye, through air that lets them be seen; of the
// world, what the sighting's own rule sees from the boat (package sight),
// charted or not, which is the game's own meaning of "seen": an agent sees
// what would chart.

// seenBoat is another boat in sight: its slot and its distance, m.
type seenBoat struct {
	slot int32
	d    float64
}

// eyeOf is the lookout's height of the boat in slot sl, m.
func eyeOf(s *Sea, f *bus.Frame, sl int32) float64 {
	return max(s.boat(f.Kind[sl]).Lookout, 1)
}

// mastOf is the height of a boat's masthead above the sea, m.
func mastOf(s *Sea, f *bus.Frame, sl int32) float64 {
	r := &s.boat(f.Kind[sl]).Physics.Rig
	return r.BoomHeight + r.Luff
}

// inSight are the other boats the lookout of the boat in slot sl sees,
// nearest first. With the helm's mu held.
func (h *helm) inSight(s *Sea, f *bus.Frame, sl int32) []seenBoat {
	st := &f.State[sl]
	var kept []uint8
	if len(h.contacts) > 0 {
		if len(h.kept) != f.Capacity() {
			h.kept = make([]uint8, f.Capacity())
		}
		kept = h.kept
		for _, o := range f.Live {
			if _, ok := h.contacts[f.Boat[o]]; ok {
				kept[o] = 1
			}
		}
	}
	cands := view.Candidates(f, sl, st.X, st.Y, kept, h.cands[:0])
	h.cands = cands
	if kept != nil {
		for _, o := range f.Live {
			kept[o] = 0
		}
	}
	wt := s.weatherAt(f)
	p := wt.Prepared()
	eye := eyeOf(s, f, sl)
	var table *sight.Table
	if s.Sight != nil {
		table = s.Sight.Table
	}
	out := make([]seenBoat, 0, len(cands))
	for _, c := range cands {
		o := &f.State[c.Slot]
		d := math.Sqrt(c.D2)
		top := mastOf(s, f, c.Slot)
		if table != nil && d > table.EyeReach(eye)+table.EyeReach(top) {
			continue
		}
		if p != nil && physics.OpticalDepth(wt, st.X, st.Y, eye, o.X, o.Y, top) > p.Contrast() {
			continue
		}
		out = append(out, seenBoat{slot: c.Slot, d: d})
	}
	slices.SortFunc(out, func(a, b seenBoat) int {
		switch {
		case a.d < b.d:
			return -1
		case a.d > b.d:
			return 1
		}
		return int(a.slot - b.slot)
	})
	return out
}

// subjectsInSight are the islands, places and features the boat's
// lookout sees now, charted or not, by their index in the sight table,
// with their squared distances.
func (h *helm) subjectsInSight(s *Sea, f *bus.Frame, sl int32) []int32 {
	seen := h.seenSubjects(s, f, sl)
	out := make([]int32, len(seen))
	for i, x := range seen {
		out[i] = x.Subject
	}
	return out
}

// seenSubjects is the sighting's look from the boat in slot sl, through
// the weather at the frame, charted and uncharted alike.
func (h *helm) seenSubjects(s *Sea, f *bus.Frame, sl int32) []sight.Seen {
	if s.Sight == nil || s.Sight.Table == nil {
		return nil
	}
	t := s.Sight.Table
	l := t.Lookout(eyeOf(s, f, sl))
	l.X, l.Y = f.State[sl].X, f.State[sl].Y
	lit, thr := s.lights(f)
	cond := sight.Conditions{Weather: s.weatherAt(f), Lit: lit, Threshold: thr}
	return t.Look(&l, nil, &cond, nil)
}

// lights are which of the world's lights are lit at f's tick, and the
// threshold each is seen against, ln lux: lit while the sun is below the
// horizon at it or the visibility at it is poor or worse, as the
// simulation's lookouts see them; worked out once a second.
func (s *Sea) lights(f *bus.Frame) ([]bool, []float64) {
	sg := s.Sight
	a := &s.air
	second := f.Tick / physics.StepsPerSecond
	a.mu.Lock()
	if a.lit != nil && a.litAt == second {
		lit, thr := a.lit, a.thr
		a.mu.Unlock()
		return lit, thr
	}
	a.mu.Unlock()
	wt := s.weatherAt(f)
	t := sg.Table
	n := t.Lights()
	lit := make([]bool, n)
	var thr []float64
	night, day := 0.0, 0.0
	if sg.Night > 0 && sg.Day > 0 {
		thr = make([]float64, n)
		night, day = physics.Log(sg.Night), physics.Log(sg.Day)
	}
	tm := 0.0
	if sg.Sky != nil {
		tm = sky.Time(sg.Sky, float64(sg.Epoch), float64(float64(f.Tick)*1e6)/physics.StepsPerSecond)
	}
	p := wt.Prepared()
	for i := range n {
		x, y, _ := t.LightAt(i)
		sun := -math.Pi / 2
		if sg.Sky != nil {
			sun = sky.SunAltitude(sg.Sky, tm, x, y)
		}
		lit[i] = sun < 0 || p != nil && p.VisibilityWord(physics.VisibilityAt(wt, x, y)) >= physics.VisibilityPoor
		if thr != nil {
			share := min(max((sun+math.Pi/180)/(math.Pi/180), 0), 1)
			thr[i] = night + share*(day-night)
		}
	}
	a.mu.Lock()
	a.lit, a.thr, a.litAt = lit, thr, second
	a.mu.Unlock()
	return lit, thr
}

// readoutTicks is how long the wind readout averages over: 3 s.
const readoutTicks = 3 * physics.StepsPerSecond

// readout is the wind readout's samples: the true wind the boat felt, in
// the shadow of the boats about it, and the mean wind's speed.
type readout struct {
	at          [32]int64
	speed, from [32]float64
	mean        [32]float64
	next, n     int
}

func (r *readout) add(tick int64, speed, from, mean float64) {
	r.at[r.next], r.speed[r.next], r.from[r.next], r.mean[r.next] = tick, speed, from, mean
	r.next = (r.next + 1) % len(r.at)
	r.n = min(r.n+1, len(r.at))
}

// read is the readout as the phone shows it: where the wind comes from,
// rad, and its speed, m/s, averaged over the last 3 s; and the mean wind's
// speed, which its force is read from. ok is false with no samples.
func (r *readout) read(now int64) (from, speed, mean float64, ok bool) {
	var east, north, sp, mn float64
	n := 0
	for i := range r.n {
		if now-r.at[i] > readoutTicks {
			continue
		}
		sn, cs := physics.SinCos(r.from[i])
		east += r.speed[i] * sn
		north += r.speed[i] * cs
		sp += r.speed[i]
		mn += r.mean[i]
		n++
	}
	if n == 0 {
		return 0, 0, 0, false
	}
	return physics.Atan2(east, north), sp / float64(n), mn / float64(n), true
}
