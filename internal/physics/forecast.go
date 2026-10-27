// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The forecast: issued at each of its boundaries of world time for the
// steps of its horizon, from the week itself, the same on the server and in
// the module, so a sandbox with no server makes the server's forecast from
// the same records.
//
// It is the truth: the records of every system alive at the issue or born
// within its horizon and one issue more, with their wobble and their
// throb, so the keyframes made from it at any tick are the server's own,
// bit for bit, and every shower is placed where it will be; and the
// spells, the fronts where they will be, without the shifts, which the
// forecast names and does not place, as it leaves out the gusts. A sailor
// planning a route to a storm knows where the storm will be.

// The forecast's most steps, spells and systems.
const (
	MaxForecastSteps   = 13 // the issue's own and twelve ahead
	MaxForecastSpells  = 6
	MaxForecastSystems = 128
	// MaxGaleSide is the most points on a side of a gale warning's grid.
	MaxGaleSide = 64
)

// ForecastParams describe the forecast: the catalog's weather.forecast
// values it is made with, in the order of its schema. PrepareForecast
// derives the constants it is computed with.
type ForecastParams struct {
	Every    float64 // it is issued every this many minutes of world time from the epoch
	Horizon  float64 // and runs this far ahead, minutes
	Step     float64 // in steps of this, minutes
	GaleMean float64 // a gale where the mean wind reaches this, knots
	GaleGust float64 // or the typical strongest gust reaches this, knots
	Quantile float64 // the typical strongest gust's quantile of the gust field
	Grid     float64 // the gale grid's spacing, nautical miles
	Within   float64 // and its reach from the centre, nautical miles
}

// forecastPrepared holds the constants the forecast is computed with.
type forecastPrepared struct {
	every, step float64 // ticks
	steps       int32   // steps from the issue, the issue's own included
	galeMean    float64 // m/s
	galeGust    float64 // m/s
	quantile    float64 // the gust field's h′ at the quantile, less its mean
	grid        float64 // m
	within2     float64 // m²
	side        int32   // the gale grid's points a side
}

// PrepareForecast derives the forecast's constants from its parameters. It
// is called after PrepareWeather, by the server at start and by the client
// after writing ForecastParams.
func (w *WeatherPrepared) PrepareForecast(p *ForecastParams) {
	f := &w.forecast
	f.every = float64(steps(p.Every, minuteTicks))
	f.step = max2(float64(steps(p.Step, minuteTicks)), 1)
	f.steps = min(max(toInt32(math.Floor(float64(steps(p.Horizon, minuteTicks))/f.step))+1, 1), MaxForecastSteps)
	f.galeMean = float64(p.GaleMean * knotSpeed)
	f.galeGust = float64(p.GaleGust * knotSpeed)
	f.quantile = p.Quantile - gustMeanH
	f.grid = max2(float64(p.Grid*nauticalMile), 1)
	within := float64(p.Within * nauticalMile)
	f.within2 = float64(within * within)
	f.side = min(2*toInt32(math.Ceil(within/f.grid))+1, MaxGaleSide)
}

// ForecastEvery is how many ticks apart the forecast is issued.
func (w *WeatherPrepared) ForecastEvery() int64 { return int64(toInt32(w.forecast.every)) }

// ForecastStep is how many ticks apart its steps are, and ForecastSteps how
// many it has, the issue's own included.
func (w *WeatherPrepared) ForecastStep() int64  { return int64(toInt32(w.forecast.step)) }
func (w *WeatherPrepared) ForecastSteps() int32 { return w.forecast.steps }

// ForecastHorizon is how many ticks its last step is from the issue.
func (w *WeatherPrepared) ForecastHorizon() int64 {
	return w.ForecastStep() * int64(w.forecast.steps-1)
}

// ForecastReach is how many ticks after the issue a forecast knows the
// systems to: its horizon and one issue more, so the latest issue covers
// the whole horizon from any tick before the next.
func (w *WeatherPrepared) ForecastReach() int64 {
	return w.ForecastHorizon() + w.ForecastEvery()
}

// GaleSide is how many points a side the gale grid has, and GaleGrid their
// spacing, m: point (i, j) is at ((i − c) g, (j − c) g), c = (side − 1) / 2,
// i east and j north, its index j side + i.
func (w *WeatherPrepared) GaleSide() int32   { return w.forecast.side }
func (w *WeatherPrepared) GaleGrid() float64 { return w.forecast.grid }

// ForecastHead is what a forecast is of: its issue, how many steps it has,
// the issue's own first, how many ticks apart; the last tick it knows the
// systems to; how many ticks apart the systems' keyframes are, and the
// tick its records' tick 0 falls on; how many spells and systems it holds;
// each spell's shifts' swing, which the forecast names, not places; and
// each system's slot, as its keyframes'.
type ForecastHead struct {
	Issue    float64 // the tick it was issued at
	Steps    float64 // steps from the issue, the issue's own first: fewer at the world's end
	Step     float64 // ticks between steps
	Until    float64 // the last tick it knows the systems to
	Every    float64 // ticks between the systems' keyframes
	Origin   float64 // the tick its records' tick 0 falls on
	NSpells  float64
	NSystems float64
	// Shifts are each spell's shifts' swing, how far they turn its wind
	// either way together, in 65536ths of a turn.
	Shifts [MaxForecastSpells]float64
	// Slots are each system's slot.
	Slots [MaxForecastSystems]float64
}

// Forecast is a forecast as issued: its head, its spells, without their
// shifts, and its systems' records, in the order of their births.
type Forecast struct {
	Head    ForecastHead
	Spells  [MaxForecastSpells]Spell
	Systems [MaxForecastSystems]SystemRecord
}

// ForecastInput is what a forecast is made from: the tick it is issued at;
// the world's last tick, after which it has no steps, 0 for none; how many
// ticks apart the systems' keyframes are; the tick the records' tick 0
// falls on; the true spells over its reach, ascending by the tick each
// begins at, the one in play at the issue and the one before if it is
// still giving way; and the systems' records, each with its slot, in the
// order of their births. Records not alive within its reach are passed
// over, and the latest born if there are more than it holds.
type ForecastInput struct {
	Issue   float64
	End     float64
	Every   float64
	Origin  float64
	Spells  []Spell
	Records []SystemRecord
	Slots   []int32
}

// MakeForecast makes the forecast of in into f.
func MakeForecast(p *WeatherPrepared, in *ForecastInput, f *Forecast) {
	fp := &p.forecast
	h := &f.Head
	// Field by field: a composite literal of this size would be a
	// temporary, which TinyGo puts on the heap.
	h.Issue, h.Step, h.Every, h.Origin = in.Issue, fp.step, max2(in.Every, 1), in.Origin
	h.NSpells, h.NSystems = 0, 0
	for i := range h.Shifts {
		h.Shifts[i] = 0
	}
	for i := range h.Slots {
		h.Slots[i] = 0
	}
	issue := in.Issue
	n := fp.steps
	for n > 1 && in.End > 0 && issue+float64(float64(n-1)*fp.step) > in.End {
		n--
	}
	h.Steps = float64(n)
	h.Until = issue + float64(p.ForecastReach())
	if in.End > 0 {
		h.Until = max2(min2(h.Until, in.End), issue)
	}
	ns := 0
	for i := range in.Spells {
		if ns == MaxForecastSpells {
			break
		}
		s := in.Spells[i]
		h.Shifts[ns] = s.Shift[0] + s.Shift[1]
		s.Shift = [2]float64{}
		f.Spells[ns] = s
		ns++
	}
	h.NSpells = float64(ns)
	// The records' own time.
	from, until := issue-in.Origin, h.Until-in.Origin
	k := 0
	for i := range in.Records {
		if k == MaxForecastSystems {
			break
		}
		r := &in.Records[i]
		if !(r.Gone > from) || !(r.Born <= until) {
			continue
		}
		slot := int32(i)
		if i < len(in.Slots) {
			slot = in.Slots[i]
		}
		f.Systems[k] = *r
		h.Slots[k] = float64(slot)
		k++
	}
	h.NSystems = float64(k)
}

// ForecastAt sets w's spells and keyframes to the forecast's at a tick:
// the spells about it, and the two keyframes about it made from its
// records, which the systems are interpolated between as the server's
// are. A tick before the issue is the issue's, one after the last it
// knows its last.
func ForecastAt(w *Weather, f *Forecast, tick float64) {
	h := &f.Head
	tick = clamp(tick, h.Issue, max2(h.Until, h.Issue))
	ns := toInt32(h.NSpells)
	i := int32(0)
	for j := int32(1); j < ns; j++ {
		if f.Spells[j].Begin <= tick {
			i = j
		}
	}
	// The one in effect, the one before it, and the one after.
	from := max(i-1, 0)
	to := min(i+2, ns)
	w.Count = 0
	for j := from; j < to && w.Count < WeatherSpells; j++ {
		w.SetSpell(w.Count, &f.Spells[j])
		w.Count++
	}
	w.Coming = ComingFront{}
	w.coming = spell{}
	w.NRecords = 0
	every := max2(h.Every, 1)
	at := float64(math.Floor(tick/every) * every)
	ForecastKeyframe(f, at, &w.Keys[0])
	ForecastKeyframe(f, at+every, &w.Keys[1])
	w.NKeys = 2
}

// ForecastKeyframe sets dst to the forecast's systems at a tick, as the
// server's keyframe of it: each alive then in its slot.
func ForecastKeyframe(f *Forecast, tick float64, dst *Keyframe) {
	dst.Tick = tick
	for i := range dst.Systems {
		dst.Systems[i] = System{}
	}
	local := tick - f.Head.Origin
	for i := range toInt32(f.Head.NSystems) {
		slot := toInt32(f.Head.Slots[i])
		if slot < 0 || slot >= MaxSystems {
			continue
		}
		if s := SystemAt(&f.Systems[i], local); s.On != 0 {
			dst.Systems[slot] = s
		}
	}
}
