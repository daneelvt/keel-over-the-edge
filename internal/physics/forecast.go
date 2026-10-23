// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The forecast: issued at each of its boundaries of world time for the
// steps of its horizon, from the week's plan, the same on the server and in
// the module, so a sandbox with no server makes the server's forecast from
// the same records.
//
// It knows what a real forecast eighteen hours ahead knows, the game's
// ninety minutes at the sky's pace: the systems alive at the issue, where
// they are then, moved on by their planned tracks without the wobble a
// forecast cannot know, as the National Hurricane Center moves a storm on
// from its present place; the lows to be born within the horizon, by their
// plan, forming, as an ensemble foresees a coming extratropical cyclone
// days ahead (Froude, Bengtsson and Hodges 2007); the spells, without their
// shifts; and the fronts. A spell not yet begun carries an error of the
// forecast's own, and each front's line moves on at its speed times one
// plus an error, each drawn from the spell's seed, so successive issues
// agree and the error shrinks as the front nears. Of the squalls, showers,
// fog banks and patches of light air born after the issue it knows nothing
// but their risk, which the words and the chart give from the regime.
//
// Each system's cone is a circle about each step's forecast position,
// growing with the lead from nothing, a forming low's a constant one; a
// front's is a band about its forecast line, wide enough by construction to
// hold the truth four times in five. The cones are tested at each step, as
// the National Hurricane Center sizes its circles from the share of errors
// within each at each lead, not over the whole track.

// The forecast's most steps, spells and systems.
const (
	MaxForecastSteps   = 13 // the issue's own and twelve ahead
	MaxForecastSpells  = 6
	MaxForecastSystems = 24
	// MaxGaleSide is the most points on a side of a gale warning's grid.
	MaxGaleSide = 64
)

// frontBandZ is the standard normal's 90th percentile: a front's line lies
// within ±1.2816 standard deviations of its forecast four times in five.
const frontBandZ = 1.2815515655446004

// ForecastParams describe the forecast: the catalog's weather.forecast
// values it is made with, in the order of its schema. PrepareForecast
// derives the constants it is computed with.
type ForecastParams struct {
	Every     float64 // it is issued every this many minutes of world time from the epoch
	Horizon   float64 // and runs this far ahead, minutes
	Step      float64 // in steps of this, minutes
	PerHour   float64 // a cone grows by this an hour of lead, nautical miles
	Forming   float64 // a forming low's cone, nautical miles
	Front     float64 // the standard deviation of a front's speed, a share of it
	Direction float64 // and of a spell not yet begun's direction, degrees
	Speed     float64 // and of its speed, a share of it
	GaleMean  float64 // a gale where the mean wind reaches this, knots
	GaleGust  float64 // or the typical strongest gust reaches this, knots
	Quantile  float64 // the typical strongest gust's quantile of the gust field
	Grid      float64 // the gale grid's spacing, nautical miles
	Within    float64 // and its reach from the centre, nautical miles
}

// forecastPrepared holds the constants the forecast is computed with.
type forecastPrepared struct {
	every, step float64 // ticks
	steps       int32   // steps from the issue, the issue's own included
	perTick     float64 // m of cone a tick of lead
	forming     float64 // m
	front       float64
	direction   float64 // steps of a turn
	speed       float64
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
	f.perTick = float64(float64(p.PerHour*nauticalMile) / hourTicks)
	f.forming = float64(p.Forming * nauticalMile)
	f.front = p.Front
	f.direction = float64(p.Direction * degreeSteps)
	f.speed = p.Speed
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

// GaleSide is how many points a side the gale grid has, and GaleGrid their
// spacing, m: point (i, j) is at ((i − c) g, (j − c) g), c = (side − 1) / 2,
// i east and j north, its index j side + i.
func (w *WeatherPrepared) GaleSide() int32   { return w.forecast.side }
func (w *WeatherPrepared) GaleGrid() float64 { return w.forecast.grid }

// ForecastHead is what a forecast is of: its issue, how many steps it has,
// the issue's own first, how many ticks apart, and how many spells and
// systems it holds; with each spell's shifts' swing, which the forecast
// names, not places.
type ForecastHead struct {
	Issue    float64 // the tick it was issued at
	Steps    float64 // steps from the issue, the issue's own first: fewer at the world's end
	Step     float64 // ticks between steps
	NSpells  float64
	NSystems float64
	// Shifts are each spell's shifts' swing, how far they turn its wind
	// either way together, in 65536ths of a turn.
	Shifts [MaxForecastSpells]float64
}

// ForecastSystem is a system as a forecast gives it: what it is, and at
// each step where it will be, how it moves and how strong it is, in whole
// numbers, as a keyframe's (its strength in 256ths); a step it is not alive
// at has no strength.
type ForecastSystem struct {
	Slot  float64 // its slot, as its keyframes'
	Kind  float64 // the catalog's index of its kind
	Seed  float64 // its keyframes' seed; 0 for a low forming, which has none yet
	Size  float64 // m
	Peak  float64 // as a keyframe's
	Depth float64 // as a keyframe's
	// Forming is 1 for a low not yet born at the issue, forecast by its
	// plan alone.
	Forming float64
	// Crosses is the tick it is forecast to cross the lip onto the disk,
	// and where, m east and north; 0 for one on the disk.
	Crosses    float64
	CrossEast  float64
	CrossNorth float64
	East       [MaxForecastSteps]float64 // m
	North      [MaxForecastSteps]float64 // m
	Heading    [MaxForecastSteps]float64 // the direction it moves toward, in 65536ths of a turn
	Speed      [MaxForecastSteps]float64 // in steps of SeaSpeedStep
	Strength   [MaxForecastSteps]float64 // in 256ths
}

// Forecast is a forecast as issued: its head, its spells, planned, without
// their shifts, and its systems.
type Forecast struct {
	Head    ForecastHead
	Spells  [MaxForecastSpells]Spell
	Systems [MaxForecastSystems]ForecastSystem
}

// ForecastInput is what a forecast is made from: the tick it is issued at;
// the world's last tick, after which it has no steps, 0 for none; the true
// spells over its horizon, ascending by the tick each begins at, the one in
// play at the issue and the one before if it is still giving way; and the
// systems' records, each with its slot: those alive at the issue and the
// lows to be born within the horizon. Records of others are passed over.
type ForecastInput struct {
	Issue   float64
	End     float64
	Spells  []Spell
	Records []SystemRecord
	Slots   []int32
}

// strength256 is a strength's 256ths, and keyframe256 those a keyframe's
// 4096ths.
const (
	strength256 = 256
	keyframe256 = strengthSteps / strength256
)

// MakeForecast makes the forecast of in into f.
func MakeForecast(p *WeatherPrepared, in *ForecastInput, f *Forecast) {
	fp := &p.forecast
	h := &f.Head
	*h = ForecastHead{Issue: in.Issue, Step: fp.step}
	issue := in.Issue
	n := fp.steps
	for n > 1 && in.End > 0 && issue+float64(float64(n-1)*fp.step) > in.End {
		n--
	}
	h.Steps = float64(n)
	ns := 0
	for i := range in.Spells {
		if ns == MaxForecastSpells {
			break
		}
		s := in.Spells[i]
		h.Shifts[ns] = s.Shift[0] + s.Shift[1]
		forecastSpell(fp, &s, issue)
		f.Spells[ns] = s
		ns++
	}
	h.NSpells = float64(ns)
	horizon := issue + float64(float64(n-1)*fp.step)
	k := 0
	for i := range in.Records {
		if k == MaxForecastSystems {
			break
		}
		r := &in.Records[i]
		alive := r.Born <= issue && issue < r.Gone
		forming := !alive && r.Born > issue && r.Born <= horizon && p.isLow(r.Kind)
		if !alive && !forming {
			continue
		}
		slot := int32(i)
		if i < len(in.Slots) {
			slot = in.Slots[i]
		}
		forecastSystem(fp, r, slot, issue, n, alive, p.Edge(), &f.Systems[k])
		k++
	}
	h.NSystems = float64(k)
}

// isLow reports whether a system of kind i is a low: a storm, which a
// forecast foresees before it is born.
func (w *WeatherPrepared) isLow(i float64) bool {
	k := w.kindOf(i)
	return k != nil && k.shape == ShapeLow
}

// forecastSpell makes a true spell the forecast's: its shifts named, not
// placed; a spell not yet begun at the issue with the forecast's own error
// in its wind; and a front's line moved on from where it is at the issue
// at its speed times 1 + σz.
func forecastSpell(fp *forecastPrepared, s *Spell, issue float64) {
	s.Shift = [2]float64{}
	if s.Steady != 0 || s.Still != 0 {
		return
	}
	seed := seedBits(s.Seed)
	if s.Begin > issue {
		d := normalOf(seed, 1)
		v := normalOf(seed, 2)
		s.From = float64(wrapSteps(steps(s.From+float64(d*fp.direction), 1)))
		s.Speed = max2(float64(steps(float64(s.Speed*(1+float64(v*fp.speed))), 1)), 0)
	}
	if s.Front != 0 && s.Change > 0 {
		k := max2(1+float64(fp.front*normalOf(seed, 3)), 0.25)
		// The line lies where it does at the issue: fspeed (issue − begin)
		// from its entry, and moves on at k fspeed.
		s.Change = max2(float64(steps(s.Change/k, 1)), 1)
		s.Begin = issue - float64(steps((issue-s.Begin)/k, 1))
	}
}

// normalOf is a standard normal deviate drawn from a seed and an index, by
// Box and Muller's transform of two uniform deviates from hashes.
func normalOf(seed, i uint32) float64 {
	a := hash32(seed ^ hash32(i^0x6a09e667))
	b := hash32(a ^ 0xbb67ae85)
	u := float64(float64(a>>8)+0.5) * (1.0 / (1 << 24))
	v := float64(float64(b>>8)+0.5) * (1.0 / (1 << 24))
	_, cos := SinCos(float64(v * (2 * math.Pi)))
	return float64(math.Sqrt(-float64(2*Log(u))) * cos)
}

// forecastSystem makes a system's forecast from its record: alive at the
// issue, from its true place then, moved on by its planned track, its
// strength its planned life times its true strength's share of it at the
// issue; forming, by its plan alone.
func forecastSystem(fp *forecastPrepared, r *SystemRecord, slot int32, issue float64, n int32, alive bool, edge float64, o *ForecastSystem) {
	// Field by field: a composite literal of this size would be a
	// temporary, which TinyGo puts on the heap.
	o.Slot, o.Kind, o.Seed, o.Size, o.Peak, o.Depth = float64(slot), r.Kind, 0, r.Size, r.Peak, r.Depth
	o.Forming, o.Crosses, o.CrossEast, o.CrossNorth = 0, 0, 0, 0
	for k := range MaxForecastSteps {
		o.East[k], o.North[k], o.Heading[k], o.Speed[k], o.Strength[k] = 0, 0, 0, 0, 0
	}
	var ox, oy float64
	ratio := 1.0
	if alive {
		o.Seed = r.Seed
		v, _ := recordAt(r, issue)
		te, tn, _, _ := trackAt(r, issue)
		ox, oy = v.east-te, v.north-tn
		if l := lifeOf(r, issue); l > 0 {
			ratio = v.strength / l
		}
	} else {
		o.Forming = 1
	}
	for k := range n {
		t := issue + float64(float64(k)*fp.step)
		if t < r.Born || t >= r.Gone {
			continue
		}
		e, nn, heading, speed := trackAt(r, t)
		o.East[k] = float64(steps(e+ox, 1))
		o.North[k] = float64(steps(nn+oy, 1))
		o.Heading[k] = float64(wrapSteps(steps(heading, 1/turnStep)))
		o.Speed[k] = float64(steps(speed, 1/SeaSpeedStep))
		if l := float64(lifeOf(r, t) * ratio); l > 0 {
			o.Strength[k] = float64(max(steps(l, strength256), 1))
		}
	}
	if !alive || r.Track != TrackLine {
		return
	}
	// Beyond the lip, the tick its forecast track crosses it: the root of
	// |P + s u|² = R² nearer P, s the distance along its heading u.
	e, nn, heading, _ := trackAt(r, issue)
	px, py := e+ox, nn+oy
	if float64(px*px)+float64(py*py) <= float64(edge*edge) {
		return
	}
	ux, uy := SinCos(heading)
	b := float64(px*ux) + float64(py*uy)
	c := float64(px*px) + float64(py*py) - float64(edge*edge)
	disc := float64(b*b) - c
	perTick := float64(float64(r.Speed*SeaSpeedStep) * Dt)
	if !(disc >= 0) || !(perTick > 0) {
		return
	}
	s := -b - math.Sqrt(disc)
	if !(s > 0) {
		return
	}
	at := issue + float64(steps(s/perTick, 1))
	if at >= r.Gone {
		return
	}
	o.Crosses = at
	o.CrossEast = float64(steps(px+float64(s*ux), 1))
	o.CrossNorth = float64(steps(py+float64(s*uy), 1))
}

// ForecastCone is the radius of a forecast system's cone at step k, m: its
// lead's share of the cone an hour, or a forming low's.
func ForecastCone(p *WeatherPrepared, f *Forecast, s *ForecastSystem, k int32) float64 {
	if s.Forming != 0 {
		return p.forecast.forming
	}
	return float64(float64(float64(k)*f.Head.Step) * p.forecast.perTick)
}

// FrontBand is how far either side of its forecast line a front's band
// reaches at a lead, ticks after the issue, m: the line moves at its
// forecast speed, and its error is σ of that speed times the lead.
func FrontBand(p *WeatherPrepared, s *Spell, lead float64) float64 {
	if s.Front == 0 || !(s.Change > 0) {
		return 0
	}
	speed := float64(2*p.frontReach) / s.Change // m a tick
	return float64(float64(float64(frontBandZ*p.forecast.front)*speed) * max2(lead, 0))
}

// ForecastAt sets w's spells and keyframes to the forecast's at a tick:
// the spells about it and the steps about it as two keyframes, which the
// systems are interpolated between, as a keyframe's are. A tick before the
// issue or after its last step is the nearest step's.
func ForecastAt(w *Weather, f *Forecast, tick float64) {
	h := &f.Head
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
	last := max(toInt32(h.Steps)-1, 0)
	k := clampSteps(math.Floor((tick-h.Issue)/max2(h.Step, 1)), last)
	ForecastKeyframe(f, k, &w.Keys[0])
	w.NKeys = 1
	if k < last {
		ForecastKeyframe(f, k+1, &w.Keys[1])
		w.NKeys = 2
	}
}

// clampSteps is k as a step from 0 to last.
func clampSteps(k float64, last int32) int32 {
	if !(k > 0) {
		return 0
	}
	return min(toInt32(k), last)
}

// ForecastKeyframe sets dst to the forecast's systems at step k, as a
// keyframe: each in its slot, at the step's tick.
func ForecastKeyframe(f *Forecast, k int32, dst *Keyframe) {
	dst.Tick = f.Head.Issue + float64(float64(k)*f.Head.Step)
	for i := range dst.Systems {
		dst.Systems[i] = System{}
	}
	if k < 0 || k >= MaxForecastSteps {
		return
	}
	for i := range toInt32(f.Head.NSystems) {
		s := &f.Systems[i]
		slot := toInt32(s.Slot)
		if !(s.Strength[k] > 0) || slot < 0 || slot >= MaxSystems {
			continue
		}
		dst.Systems[slot] = System{
			On: 1, Kind: s.Kind, Seed: s.Seed,
			East: float64(s.East[k] * (1 / quarterMetre)), North: float64(s.North[k] * (1 / quarterMetre)),
			Heading: s.Heading[k], Speed: s.Speed[k], Strength: float64(s.Strength[k] * keyframe256),
			Size: s.Size, Peak: s.Peak, Depth: s.Depth,
		}
	}
}
