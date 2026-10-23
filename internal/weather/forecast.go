// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The forecast is issued at each boundary of its every minutes of world
// time from the world's epoch, for its horizon: from the week's plan, the
// developer's weathers and systems and the tick alone (physics.MakeForecast),
// so a restart issues the same forecast and a test can ask for any. The
// truth of the past, the keyframes at each five minutes and the spells in
// play, goes with an issue of ninety minutes before to a phone just come,
// which keeps its own from then: the past is everyone's, the future only
// the forecast.

// PastEvery is how many ticks apart the truth of the past is kept: five
// minutes, half the forecast's step.
const PastEvery = 5 * 60 * physics.StepsPerSecond

// IssueAt is the forecast's issue in force at a tick: the last boundary of
// its every at or before it.
func (t *Timeline) IssueAt(tick int64) int64 {
	every := max(t.prepared.ForecastEvery(), 1)
	return floorDiv(tick, every) * every
}

// Forecast makes into f the forecast issued at a tick, with the developer's
// weathers ws and systems ss as they stand, for a world whose last tick is
// end, 0 for none.
func (t *Timeline) Forecast(issue int64, ws []bus.Weather, ss []bus.System, end int64, f *physics.Forecast) {
	p := t.prepared
	horizon := issue + p.ForecastHorizon()
	// In the week's own time, which its records' wobbles keep.
	o := float64(t.origin)
	in := physics.ForecastInput{Issue: float64(issue) - o}
	if end > 0 {
		in.End = float64(end) - o
	}
	for _, s := range t.SpellsOver(issue, horizon, ws) {
		s.Begin -= o
		s.Start -= o
		in.Spells = append(in.Spells, s)
	}
	if w := t.Week(); w != nil {
		local, until := float64(issue)-o, float64(horizon)-o
		sys := w.Systems
		i, _ := slices.BinarySearchFunc(sys, until, func(s System, at float64) int {
			if s.Born <= at {
				return -1
			}
			return 1
		})
		for i--; i >= 0 && sys[i].Born > local-float64(t.longest)-1; i-- {
			s := &sys[i]
			if s.Slot >= 0 && s.Slot < weekSlots && s.Gone > local {
				in.Records = append(in.Records, s.SystemRecord)
				in.Slots = append(in.Slots, int32(s.Slot))
			}
		}
	}
	for _, s := range ss {
		if int(s.Slot) < bus.SystemSlots && len(t.cfg.Kinds) > 0 {
			r := t.record(s)
			for _, at := range []*float64{&r.Born, &r.Mature, &r.Decays, &r.Gone} {
				*at -= o
			}
			in.Records = append(in.Records, r)
			in.Slots = append(in.Slots, int32(weekSlots)+int32(s.Slot))
		}
	}
	physics.MakeForecast(p, &in, f)
	// Back to the world's ticks.
	f.Head.Issue += o
	for i := range int(f.Head.NSpells) {
		f.Spells[i].Begin += o
		f.Spells[i].Start += o
	}
	for i := range int(f.Head.NSystems) {
		if s := &f.Systems[i]; s.Crosses != 0 {
			s.Crosses += o
		}
	}
}

// SpellsOver is the spells that blow from one tick to another, ascending by
// the tick each begins at: those in play at the first, and each that begins
// by the last.
func (t *Timeline) SpellsOver(from, to int64, ws []bus.Weather) []physics.Spell {
	var dst [physics.WeatherSpells]physics.Spell
	n := t.Spells(from, ws, &dst)
	var out []physics.Spell
	for i := range n {
		// Not those only announced: they come again below, by their own
		// beginning.
		if int64(dst[i].Begin) <= from {
			out = append(out, dst[i])
		}
	}
	at := from
	for {
		next, ok := t.after(at, ws)
		if !ok || next > to {
			break
		}
		out = append(out, t.Effective(next, ws))
		at = next
	}
	return out
}

// Past is the truth of the past: the systems' keyframes at each PastEvery
// boundary from one tick to another, both included, and the spells in play
// over them.
type Past struct {
	Keyframes []physics.Keyframe
	Spells    []physics.Spell
}

// PastOf is the truth from one tick to another, at each PastEvery boundary
// within them, with the developer's weathers ws and systems ss as they
// stand.
func (t *Timeline) PastOf(from, to int64, ws []bus.Weather, ss []bus.System) Past {
	var p Past
	first := floorDiv(from+PastEvery-1, PastEvery) * PastEvery
	for at := first; at <= to; at += PastEvery {
		var k physics.Keyframe
		t.Keyframe(at, ss, &k)
		p.Keyframes = append(p.Keyframes, k)
	}
	p.Spells = t.SpellsOver(from, to, ws)
	return p
}

// Gale is a forecast's gale warning, from its gale scan: the steps it
// blows at, a bit for each, the issue's the lowest, and the first of
// them; its force, the most of any step's; the direction its wind first
// blows from, rad; and its strongest point over the steps, m east and
// north, with its mean wind and typical gust there, m/s.
type Gale struct {
	Steps       uint32
	First       int32
	Force       int32
	From        float64
	East, North float64
	Mean, Gust  float64
}

// GaleOf is the gale warning of a forecast's gale scan, if any step has a
// gale.
func GaleOf(f *physics.Forecast, g *physics.Gales) (Gale, bool) {
	var out Gale
	out.First = -1
	best := 0.0
	for k := range int(f.Head.Steps) {
		s := &g.Steps[k]
		if !(s.Points > 0) {
			continue
		}
		out.Steps |= 1 << k
		if out.First < 0 {
			out.First = int32(k)
			out.From = s.From
		}
		out.Force = max(out.Force, int32(s.Force))
		if score := s.Mean + s.Gust; score > best {
			best = score
			out.East, out.North, out.Mean, out.Gust = s.East, s.North, s.Mean, s.Gust
		}
	}
	return out, out.Steps != 0
}
