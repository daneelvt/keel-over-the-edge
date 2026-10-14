// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The wind at a point is a function of the place, the tick and the spells of
// weather in play, computed by the server for every boat and by a client
// before each step it predicts, from the same whole numbers, so both get the
// same bits.
//
// A spell's base wind comes from one direction, which drifts evenly over the
// spell and swings to and fro in two slow oscillating shifts of different
// periods, and which differs by a few degrees from one side of the disk to
// the other along an axis that slowly turns. Its speed is the spell's times
// a factor that rises from the centre to the rim. Over it lies a field of
// gusts and lulls carried downwind (gusts.go). Near the centre lies the
// refuge, where the mean wind is softly held to a fresh breeze and the wind
// with its gusts to a little more.
//
// One spell gives way to the next over a change: both are computed, and the
// later's share rises smoothly from nothing to all of it.

// WeatherSpells is the most spells a Weather holds: the spell in effect, the
// one it is giving way from, the next, and one more for a developer's
// changes in quick succession.
const WeatherSpells = 4

// Units of a Spell's whole numbers, and of the catalog's values.
const (
	// TurnSteps is the steps in a whole turn of a spell's directions, as
	// of a sea area's wind.
	TurnSteps   = SeaFromSteps
	turnStep    = seaFromStep
	degreeSteps = TurnSteps / 360.0
	knotSteps   = nauticalMile / 3600 / SeaSpeedStep // steps of SeaSpeedStep in a knot
	minuteTicks = 60 * StepsPerSecond
	hourTicks   = 3600 * StepsPerSecond
	knotSpeed   = nauticalMile / 3600 // m/s
	// shiftGap is the least difference between the periods of a spell's
	// two shifts, in ticks: a minute and a half.
	shiftGap = 90 * StepsPerSecond
	// MaxWaveSamples is the most samples of the wave wind's average.
	MaxWaveSamples = 64
)

// WeatherPrepared holds the constants the wind is computed with, derived from
// WeatherParams by PrepareWeather.
type WeatherPrepared struct {
	speedCentre, speedSpan float64 // the speed factor: centre + span × smooth(r / rim)
	rim, invRim            float64 // m, 1/m
	refugeOuter            float64 // m
	invRefugeBlend         float64 // 1/m
	meanKnee, meanSoft     float64 // m/s
	windKnee, windSoft     float64 // m/s
	rimGusts               float64
	rimGustsFrom           float64 // m
	invRimGustsSpan        float64 // 1/m
	gustSpeed              float64
	veer                   float64 // rad
	gustCells

	acrossTurn [2]int32 // ticks
	change     int32    // ticks

	waveGrid    int32   // ticks between samples
	waveSample  float64 // the same
	waveSamples int32
	waveWeights [MaxWaveSamples]float64 // newest first, adding up to 1
	invWaveTime float64                 // 1 / the time constant in ticks
}

// PrepareWeather derives the wind's constants from its parameters. It is
// called once, by the server at start and by the client after writing
// WeatherParams.
func PrepareWeather(p *WeatherParams, w *WeatherPrepared) {
	w.speedCentre = p.SpeedCentre
	w.speedSpan = p.SpeedRim - p.SpeedCentre
	w.rim = float64(p.Rim * nauticalMile)
	w.invRim = 1 / w.rim
	w.refugeOuter = float64(p.RefugeOuter * nauticalMile)
	w.invRefugeBlend = 1 / float64((p.RefugeOuter-p.RefugeInner)*nauticalMile)
	w.meanKnee = float64(p.RefugeMeanKnee * knotSpeed)
	w.meanSoft = float64((p.RefugeMean - p.RefugeMeanKnee) * knotSpeed)
	w.windKnee = float64(p.RefugeWindKnee * knotSpeed)
	w.windSoft = float64((p.RefugeWind - p.RefugeWindKnee) * knotSpeed)
	w.rimGusts = p.RimGusts
	w.rimGustsFrom = float64(p.RimGustsFrom * nauticalMile)
	w.invRimGustsSpan = 1 / float64((p.Rim-p.RimGustsFrom)*nauticalMile)
	w.gustSpeed = p.GustSpeed
	w.veer = float64(p.GustVeer * degree)
	w.gustCells.prepare(p)
	w.acrossTurn = [2]int32{steps(p.AcrossTurn[0], hourTicks), steps(p.AcrossTurn[1], hourTicks)}
	w.change = steps(p.Change, minuteTicks)

	w.waveGrid = max(steps(p.WaveSample, StepsPerSecond), 1)
	w.waveSample = float64(w.waveGrid)
	w.waveSamples = min(max(steps(p.WaveSamples, 1), 1), MaxWaveSamples)
	w.invWaveTime = 1 / float64(p.WaveTimeConstant*StepsPerSecond)
	// The exponential average of samples a grid step apart: each sample
	// weighs e^(−step/T) times the one after it, and the weights of those
	// kept are scaled to add up to 1.
	decay := Exp(-float64(w.waveSample * w.invWaveTime))
	sum, weight := 0.0, 1.0
	for i := range w.waveSamples {
		w.waveWeights[i] = weight
		sum += weight
		weight = float64(weight * decay)
	}
	for i := range w.waveSamples {
		w.waveWeights[i] /= sum
	}
}

// ChangeTicks is how many ticks one spell takes to give way to the next.
func (w *WeatherPrepared) ChangeTicks() int64 { return int64(w.change) }

// WaveGrid is how many ticks apart the wave wind's samples are, and
// WaveSamples how many it keeps.
func (w *WeatherPrepared) WaveGrid() int64    { return int64(w.waveGrid) }
func (w *WeatherPrepared) WaveSamples() int32 { return w.waveSamples }

// steps rounds x times unit to the nearest whole number.
func steps(x, unit float64) int32 {
	return toInt32(math.Floor(float64(x*unit) + 0.5))
}

// DrawSpell draws a spell of a regime from hashes of its number and a seed:
// its wind, gust factor, shifts, drift, difference across the disk and gust
// field, in whole numbers only, so that every machine draws the same. Its
// times, its direction, its regime's index and whether it is steady are the
// caller's, and are left as they are.
//
// The larger shift swings two thirds of the regime's amplitude and the
// smaller one third; their periods are drawn in the regime's range at least
// a minute and a half apart, so that together they swing irregularly.
func DrawSpell(p *WeatherPrepared, r *Regime, number, seed uint32, s *Spell) {
	draw := drawer(hash32(number ^ hash32(seed^0x9e3779b9)))
	s.Speed = float64(drawIn(draw.n(1), steps(r.Speed[0], knotSteps), steps(r.Speed[1], knotSteps)))
	s.Gust = float64(steps(r.GustFactor, 1000))
	a := steps(r.Shift, degreeSteps)
	big := (2*a + 1) / 3
	s.Shift = [2]float64{float64(big), float64(a - big)}
	lo, hi := steps(r.Period[0], minuteTicks), steps(r.Period[1], minuteTicks)
	first := drawIn(draw.n(2), lo, hi)
	s.Period = [2]float64{float64(first), float64(apart(draw.n(3), lo, hi, first))}
	s.Phase = [2]float64{float64(draw.n(4) % TurnSteps), float64(draw.n(5) % TurnSteps)}
	s.Across = float64(steps(r.Across, degreeSteps))
	s.Axis = float64(draw.n(6) % TurnSteps)
	s.AxisPeriod = float64(drawIn(draw.n(7), p.acrossTurn[0], p.acrossTurn[1]))
	d := steps(r.Drift, degreeSteps)
	s.Drift = float64(drawIn(draw.n(8), -d, d))
	s.Seed = float64(draw.n(9))
}

// drawer draws numbers from a spell's key.
type drawer uint32

// n is the key's i-th number.
func (k drawer) n(i uint32) uint32 { return hash32(uint32(k) ^ hash32(i)) }

// drawIn is lo + h modulo the whole numbers from lo to hi: as good as
// uniform when the range is far smaller than 2³².
func drawIn(h uint32, lo, hi int32) int32 {
	if hi <= lo {
		return lo
	}
	return lo + int32(h%uint32(hi-lo+1))
}

// apart draws a whole number from lo to hi at least shiftGap from first,
// or the end of the range furthest from it if none is.
func apart(h uint32, lo, hi, first int32) int32 {
	below := max(first-shiftGap-lo+1, 0)
	above := max(hi-(first+shiftGap)+1, 0)
	if below+above == 0 {
		if first-lo > hi-first {
			return lo
		}
		return hi
	}
	u := int32(h % uint32(below+above))
	if u < below {
		return lo + u
	}
	return first + shiftGap + (u - below)
}

// SteadySpell is a steady wind from begin on: speed m/s from from, in the
// steps a sea area's wind is rounded to, everywhere, with no shifts, gusts,
// rim or refuge.
func SteadySpell(speed, from, begin float64) Spell {
	in := SeaInputOf(speed, from, 0)
	return Spell{Begin: begin, Start: begin, Steady: 1, Speed: float64(in.Speed), From: float64(in.From), Gust: 1000}
}

// spell is a Spell as the wind is computed with it.
type spell struct {
	begin, change, invChange float64 // ticks
	start, invLength         float64 // ticks
	steady                   bool
	gusts                    bool    // it has a gust field: it is not steady, and its gust factor is over 1
	speed                    float64 // m/s
	from, drift              float64 // rad
	excess                   float64 // the gust factor less 1
	amp, turns, phase        [2]float64
	across, axis, axisTurns  float64
	fieldSpeed               float64 // m/s
	seeds                    [GustOctaves]uint32
}

// spellOf turns a spell's whole numbers into the values the wind is computed
// with. Numbers out of their range give a wind, never a NaN: a period of no
// ticks is no shift, a change of no ticks is at once.
func spellOf(p *WeatherPrepared, s *Spell) spell {
	var o spell
	o.begin, o.change, o.start = s.Begin, max2(s.Change, 0), s.Start
	if o.change > 0 {
		o.invChange = 1 / o.change
	}
	if s.Length > 0 {
		o.invLength = 1 / s.Length
	}
	o.steady = s.Steady != 0
	o.speed = max2(float64(s.Speed*SeaSpeedStep), 0)
	o.from = wrapAngle(float64(s.From * turnStep))
	o.drift = float64(s.Drift * turnStep)
	if !o.steady {
		o.excess = max2(float64(s.Gust*0.001)-1, 0)
	}
	o.gusts = o.excess > 0
	for i := range 2 {
		o.amp[i] = float64(s.Shift[i] * turnStep)
		if s.Period[i] > 0 {
			o.turns[i] = 1 / s.Period[i]
		}
		o.phase[i] = float64(s.Phase[i] * turnStep)
	}
	o.across = float64(s.Across * turnStep)
	o.axis = float64(s.Axis * turnStep)
	if s.AxisPeriod > 0 {
		o.axisTurns = 1 / s.AxisPeriod
	}
	o.fieldSpeed = float64(p.gustSpeed * o.speed)
	// A seed is a whole number below 2³², which an int32 cannot hold: its
	// two halves are converted apart.
	hi := toInt32(math.Floor(float64(s.Seed * (1.0 / 65536))))
	lo := toInt32(s.Seed - float64(float64(hi)*65536))
	seed := uint32(hi)<<16 | uint32(lo)&0xffff
	for k := range o.seeds {
		o.seeds[k] = hash32(seed + uint32(k)*0x9e3779b9)
	}
	return o
}

// Weather is the spells in play, ascending by the tick each begins at.
type Weather struct {
	Prepared *WeatherPrepared
	Spells   [WeatherSpells]Spell
	Count    int32
	spells   [WeatherSpells]spell
}

// SetSpell sets spell i, and makes it ready.
func (w *Weather) SetSpell(i int32, s *Spell) {
	if i < 0 || i >= WeatherSpells {
		return
	}
	w.Spells[i] = *s
	w.spells[i] = spellOf(w.Prepared, s)
}

// SetCount says how many spells are in play: the first n set.
func (w *Weather) SetCount(n int32) { w.Count = min(max(n, 0), WeatherSpells) }

// Set makes spells the spells in play.
func (w *Weather) Set(spells []Spell) {
	n := min(int32(len(spells)), WeatherSpells)
	for i := range n {
		w.SetSpell(i, &spells[i])
	}
	w.SetCount(n)
}

// WeatherTick is the weather at a tick: what is the same at every point,
// computed once a tick by WeatherAt so that the wind at each boat costs
// little.
type WeatherTick struct {
	Tick   float64
	p      *WeatherPrepared
	n      int32      // spells in play at this tick: 0, 1 or 2
	weight [2]float64 // each one's share
	at     [2]spellTick
}

// spellTick is a spell at a tick.
type spellTick struct {
	s          *spell
	dir        float64 // the direction at the centre: drift and shifts, rad
	sinD, cosD float64 // the gust field's frame: the direction with its drift alone
	sinB, cosB float64 // the axis of the difference across the disk
	travel     float64 // how far the gust field has travelled downwind, m
	time       [GustOctaves]float64
}

// cycle returns 2π × the fraction of turns × tick, taken exactly (Dekker
// 1971) as the sea's phases are, so it is good for ticks up to 2⁵³.
func cycle(turns, tick float64) float64 {
	p, e := twoProd(turns, tick)
	return float64(((p - math.Floor(p)) + e) * (2 * math.Pi))
}

// WeatherAt sets t to the weather at a tick, which need not be whole: a
// client draws the gusts between ticks. The spell in play is the last to
// begin by the tick, or the first if none has; during its change the one
// before it is in play too.
func WeatherAt(w *Weather, t *WeatherTick, tick float64) {
	t.Tick, t.p, t.n = tick, w.Prepared, 0
	if w.Count == 0 {
		return
	}
	i := int32(0)
	for j := int32(1); j < w.Count; j++ {
		if w.spells[j].begin <= tick {
			i = j
		}
	}
	s := &w.spells[i]
	if i > 0 && s.change > 0 && tick < s.begin+s.change {
		later := smooth(float64((tick - s.begin) * s.invChange))
		t.n, t.weight = 2, [2]float64{1 - later, later}
		t.at[0].set(&w.spells[i-1], tick, &w.Prepared.gustCells)
		t.at[1].set(s, tick, &w.Prepared.gustCells)
		return
	}
	t.n, t.weight = 1, [2]float64{1, 0}
	t.at[0].set(s, tick, &w.Prepared.gustCells)
}

func (st *spellTick) set(s *spell, tick float64, g *gustCells) {
	st.s = s
	if s.steady {
		st.dir = s.from
		return
	}
	since := tick - s.start
	f := clamp(float64(since*s.invLength), 0, 1)
	base := s.from + float64(s.drift*f)
	st.sinD, st.cosD = SinCos(base)
	st.dir = base + float64(s.amp[0]*Sin(s.phase[0]+cycle(s.turns[0], tick))) +
		float64(s.amp[1]*Sin(s.phase[1]+cycle(s.turns[1], tick)))
	st.sinB, st.cosB = SinCos(s.axis + cycle(s.axisTurns, tick))
	seconds := float64(since * Dt)
	st.travel = float64(s.fieldSpeed * seconds)
	for k := range st.time {
		st.time[k] = float64(seconds * g.invLife[k])
	}
}

// How much of the wind at a point is computed.
const (
	pointMean = iota // the mean wind alone
	pointWind        // and the wind a step sails in
	pointFull        // and how fast the gust field drifts
)

// WindAt is the wind a step at (x, y), metres east and north of the centre,
// sails in, at the tick t was set to.
func WindAt(t *WeatherTick, x, y float64) Env {
	var p WindPoint
	t.point(x, y, &p, pointWind)
	return Env{WindSpeed: p.Speed, WindFrom: p.From}
}

// WindPointAt fills p with the wind at (x, y) in full.
func WindPointAt(t *WeatherTick, x, y float64, p *WindPoint) { t.point(x, y, p, pointFull) }

// MeanWindAt is the wind at (x, y) without its gusts: what the sea follows.
func MeanWindAt(t *WeatherTick, x, y float64) (speed, from float64) {
	var p WindPoint
	t.point(x, y, &p, pointMean)
	return p.MeanSpeed, p.MeanFrom
}

// point computes the wind at (x, y) into p, as much of it as what asks.
func (t *WeatherTick) point(x, y float64, p *WindPoint, what int32) {
	*p = WindPoint{Factor: 1}
	if t.n == 0 {
		return
	}
	a := &t.at[0]
	if t.n == 1 && a.s.steady {
		p.Speed, p.From, p.MeanSpeed, p.MeanFrom = a.s.speed, a.s.from, a.s.speed, a.s.from
		return
	}
	w := t.p
	r := math.Sqrt(float64(x*x) + float64(y*y))
	factor := w.speedCentre + float64(w.speedSpan*smooth(float64(r*w.invRim)))
	refuge := smooth(float64((w.refugeOuter - r) * w.invRefugeBlend))

	// Each spell's mean wind and gust field, then the two mixed: the
	// direction along the shorter arc, the speed and the gust factor as they
	// stand, and the fields so that their spread is kept.
	var dir, speed, excess, gust, gusty, limited, field2 float64
	for i := range t.n {
		st, share := &t.at[i], t.weight[i]
		d, v, e, n := st.mean(w, x, y, factor, refuge, what != pointMean)
		if i == 0 {
			dir, speed, excess = d, v, e
		} else {
			dir += float64(share * wrapAngle(d-dir))
			speed += float64(share * (v - speed))
			excess += float64(share * (e - excess))
		}
		if !st.s.steady {
			limited += share
		}
		if st.s.gusts {
			gust += float64(share * n)
			gusty += share
			field2 += float64(share * share)
			if what == pointFull {
				p.DriftEast -= float64(float64(share*st.s.fieldSpeed) * st.sinD)
				p.DriftNorth -= float64(float64(share*st.s.fieldSpeed) * st.cosD)
			}
		}
	}
	if field2 > 0 {
		gust = clamp(gust/math.Sqrt(field2), -1, 1)
	}
	p.MeanSpeed, p.MeanFrom, p.Gust = speed, wrapAngle(dir), gust
	if what == pointMean {
		return
	}

	// Gusts and lulls about the mean, stronger toward the rim; gusts veer
	// and lulls back, by as much of the veer as the spells in play have
	// gusts: a spell with a gust factor of 1 has none.
	rim := 1 + float64(w.rimGusts*smooth(float64((r-w.rimGustsFrom)*w.invRimGustsSpan)))
	h := gust
	if h < 0 {
		h = float64(0.5 * h)
	}
	p.Factor = 1 + float64(float64(excess*rim)*(h-gustMeanH))
	v := float64(speed * p.Factor)
	p.Speed = v
	if refuge > 0 {
		p.Speed += float64(float64(refuge*limited) * (soften(v, w.windKnee, w.windSoft) - v))
	}
	p.From = wrapAngle(dir + float64(float64(w.veer*gust)*gusty))
}

// mean is a spell's mean wind at (x, y): its direction, its speed with the
// refuge's limit on it, its gust factor's excess, and, if gusts, its gust
// field.
func (st *spellTick) mean(w *WeatherPrepared, x, y, factor, refuge float64, gusts bool) (dir, speed, excess, n float64) {
	s := st.s
	if s.steady {
		return s.from, s.speed, 0, 0
	}
	along := clamp(float64(x*st.sinB)+float64(y*st.cosB), -w.rim, w.rim)
	dir = st.dir + float64(float64(s.across*along)*w.invRim)
	speed = float64(s.speed * factor)
	if refuge > 0 {
		speed += float64(refuge * (soften(speed, w.meanKnee, w.meanSoft) - speed))
	}
	if gusts && s.gusts {
		n = st.field(&w.gustCells, x, y)
	}
	return dir, speed, s.excess, n
}

// soften passes a speed above knee through knee + soft × tanh((v − knee) /
// soft): unchanged below the knee, with no step in its slope there, and
// never above knee + soft.
func soften(v, knee, soft float64) float64 {
	if !(v > knee) || !(soft > 0) {
		return v
	}
	// tanh(x) = 1 − 2 / (e^(2x) + 1), for x ≥ 0.
	e := Exp(float64(2*(v-knee)) / soft)
	return knee + float64(soft*(1-2/(e+1)))
}
