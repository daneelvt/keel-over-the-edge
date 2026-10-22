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

	// The edge: the lip, its square, and the fall draft.
	edge, edge2      float64 // m, m²
	draftFrom, draft float64 // m, m/s at the lip
	draftFrom2       float64 // m²
	invDraftSpan     float64 // 1/m

	// The current.
	circulation, drain polyline
	stillWithin2       float64 // m²: the water is still within this of the centre, squared
	shallow            float64 // m
	invShallow         float64 // 1/m

	waveGrid    int32   // ticks between samples
	waveSample  float64 // the same
	waveSamples int32
	waveWeights [MaxWaveSamples]float64 // newest first, adding up to 1
	invWaveTime float64                 // 1 / the time constant in ticks

	// A front.
	troughAhead    float64 // m
	invTroughAhead float64 // 1/m
	taperFrom      float64 // m ahead of the line: the trough ahead tapers from here
	invTaper       float64 // to nothing over 1 / this, m
	troughBehind   float64 // m
	frontNorm      float64 // its wind per unit of the trough's slope, m/s
	frontSin       float64 // of its turning angle
	frontCos       float64
	blend          float64 // m
	invBlend2      float64 // 1 / (2 blend), 1/m
	frontGusts     float64
	gustsHalf      float64 // m: half the gusts' band behind the line
	frontReach     float64 // m: the line enters and leaves this far from the centre

	// The pressure.
	slope    float64 // hPa per m/s of the base wind per m
	rise     float64 // hPa a tick
	riseMost float64 // hPa

	// The systems.
	inwardFrom    float64 // m
	invInwardSpan float64 // 1/m
	inwardLeast   float64
	cut           float64
	kinds         [MaxKinds]systemKind
	nkinds        int32

	// Clouds and rain.
	clouds cloudsPrepared
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
	w.edge = float64(p.Edge * nauticalMile)
	w.edge2 = float64(w.edge * w.edge)
	w.draftFrom = float64(p.FallDraftFrom * nauticalMile)
	w.draftFrom2 = float64(w.draftFrom * w.draftFrom)
	w.draft = float64(p.FallDraft * knotSpeed)
	w.invDraftSpan = 0
	if span := w.edge - w.draftFrom; span > 0 {
		w.invDraftSpan = 1 / span
	}
	w.circulation.prepare(&p.CirculationAt, &p.Circulation)
	w.drain.prepare(&p.DrainAt, &p.Drain)
	w.stillWithin2 = 0
	if w.circulation.value[0] == 0 && w.drain.value[0] == 0 {
		still := min2(w.circulation.at[0], w.drain.at[0])
		w.stillWithin2 = float64(still * still)
	}
	w.shallow = p.Shallow
	w.invShallow = 0
	if p.Shallow > 0 {
		w.invShallow = 1 / p.Shallow
	}
	w.acrossTurn = [2]int32{steps(p.AcrossTurn[0], hourTicks), steps(p.AcrossTurn[1], hourTicks)}
	w.change = steps(p.Change, minuteTicks)

	w.waveGrid = max(steps(p.WaveSample, StepsPerSecond), 1)
	w.waveSample = float64(w.waveGrid)
	w.waveSamples = min(max(steps(p.WaveSamples, 1), 1), MaxWaveSamples)
	w.invWaveTime = 1 / float64(p.WaveTimeConstant*StepsPerSecond)

	w.troughAhead = max2(float64(p.TroughAhead*nauticalMile), 1)
	w.invTroughAhead = 1 / w.troughAhead
	w.taperFrom = float64(frontTaperFrom * w.troughAhead)
	w.invTaper = 1 / float64((frontTaperTo-frontTaperFrom)*w.troughAhead)
	w.troughBehind = max2(float64(p.TroughBehind*nauticalMile), 1)
	// The trough's steepest is behind the line, one width back:
	// e^(−½) / troughBehind of its depth a metre.
	w.frontNorm = float64(float64(p.FrontWind*knotSpeed)*w.troughBehind) * sqrtE
	w.frontSin, w.frontCos = SinCos(float64(p.FrontTurning * degree))
	w.blend = max2(float64(p.Blend*nauticalMile), 1)
	w.invBlend2 = 1 / float64(2*w.blend)
	w.frontGusts = p.FrontGusts
	w.gustsHalf = max2(float64(float64(0.5*p.GustsBehind)*nauticalMile), 1)
	w.frontReach = w.edge + float64(frontTaperTo*w.troughAhead)
	w.slope = float64(p.Slope/knotSpeed) / nauticalMile
	w.rise = float64(p.Rise / minuteTicks)
	w.riseMost = p.RiseMost
	w.inwardFrom = float64(p.InwardFrom * nauticalMile)
	w.invInwardSpan = 0
	if span := float64((p.InwardTo - p.InwardFrom) * nauticalMile); span > 0 {
		w.invInwardSpan = 1 / span
	}
	w.inwardLeast = p.InwardLeast
	w.cut = max2(p.Cut, 1)
	w.nkinds = 0
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

// The trough ahead of a front's line tapers from frontTaperFrom of its
// e-folding distance to nothing at frontTaperTo, where it is a twentieth of
// its depth: so the line enters and leaves the disk's reach with nothing
// of it on the disk.
const (
	frontTaperFrom = 2
	frontTaperTo   = 3
)

// SpeedFactor is the share of a spell's wind at mid-disk that blows r m
// from the centre.
func (w *WeatherPrepared) SpeedFactor(r float64) float64 {
	return w.speedCentre + float64(w.speedSpan*smooth(float64(r*w.invRim)))
}

// ChangeTicks is how many ticks one spell takes to give way to the next.
func (w *WeatherPrepared) ChangeTicks() int64 { return int64(w.change) }

// FrontReach is how far from the centre a front's line enters the disk's
// reach and leaves it, m: the lip and the trough ahead of the line. A
// front's spell takes the ticks the line takes to go twice this.
func (w *WeatherPrepared) FrontReach() float64 { return w.frontReach }

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
	level                    float64 // its pressure's level, hPa
	// A front's: the direction it moves toward, its speed, m a tick, and
	// its trough's depth, hPa.
	front      bool
	fsin, fcos float64
	fspeed     float64
	trough     float64
	still      bool // the week's systems do not blow while it is in effect
	regime     float64
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
	seed := seedBits(s.Seed)
	for k := range o.seeds {
		o.seeds[k] = hash32(seed + uint32(k)*0x9e3779b9)
	}
	o.still = s.Still != 0
	o.regime = s.Regime
	o.level = standardPress
	if s.Pressure > 0 {
		o.level = float64(s.Pressure * hundredthHPa)
	}
	if s.Front != 0 && o.change > 0 && !o.steady {
		o.front = true
		o.fsin, o.fcos = SinCos(float64(s.Toward * turnStep))
		o.fspeed = float64(2*p.frontReach) * o.invChange
		o.trough = max2(float64(s.Trough*hundredthHPa), 0)
	}
	return o
}

// Weather is the spells in play, ascending by the tick each begins at, and
// the systems: keyframes about the tick, or, for a client with no server,
// the systems' records.
type Weather struct {
	Prepared *WeatherPrepared
	Spells   [WeatherSpells]Spell
	Count    int32
	spells   [WeatherSpells]spell
	Keys     [KeySets]Keyframe
	NKeys    int32
	Records  [MaxSystems]SystemRecord
	NRecords int32
	// Coming is the next front before its spell is in play: its line,
	// which its cirrus shows far ahead of it.
	Coming ComingFront
	coming spell
}

// SetSpell sets spell i, and makes it ready.
func (w *Weather) SetSpell(i int32, s *Spell) {
	if i < 0 || i >= WeatherSpells {
		return
	}
	w.Spells[i] = *s
	w.spells[i] = spellOf(w.Prepared, s)
}

// SetComing sets the coming front, and makes it ready.
func (w *Weather) SetComing(c *ComingFront) {
	w.Coming = *c
	w.coming = spell{}
	if c.On != 0 {
		w.coming = spellOf(w.Prepared, &Spell{Begin: c.Begin, Start: c.Begin, Change: c.Change, Front: 1, Toward: c.Toward})
	}
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
	weight [2]float64 // each one's share; across a front, the share crossed
	at     [2]spellTick
	// front: a front is crossing, and the spells' shares at a point are by
	// which side of its line the point is: the line lies line from the
	// centre along (fe, fn), the way it moves.
	front  bool
	fe, fn float64
	line   float64
	trough float64 // hPa
	sys    [2 * MaxSystems]systemTick
	ns     int32
	// The fronts whose sheets may be in sight: the latest in play, and the
	// one coming.
	fronts [maxFrontLines]frontLine
	nf     int32
}

// spellTick is a spell at a tick.
type spellTick struct {
	s          *spell
	dir        float64 // the direction at the centre: drift and shifts, rad
	sinD, cosD float64 // the gust field's frame: the direction with its drift alone
	sinB, cosB float64 // the axis of the difference across the disk
	travel     float64 // how far the gust field has travelled downwind, m
	time       [GustOctaves]float64
	seconds    float64 // since its start
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
	t.Tick, t.p, t.n, t.front, t.ns = tick, w.Prepared, 0, false, 0
	t.setFronts(w, tick)
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
	systemsAt(w, t, tick, s.still)
	if i > 0 && s.change > 0 && tick < s.begin+s.change {
		later := smooth(float64((tick - s.begin) * s.invChange))
		t.n, t.weight = 2, [2]float64{1 - later, later}
		t.at[0].set(&w.spells[i-1], tick, &w.Prepared.gustCells)
		t.at[1].set(s, tick, &w.Prepared.gustCells)
		if s.front {
			t.front = true
			t.fe, t.fn = s.fsin, s.fcos
			t.line = float64(s.fspeed*(tick-s.begin)) - w.Prepared.frontReach
			t.trough = s.trough
		}
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
	st.seconds = seconds
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
// sails in, at the tick t was set to, in the shelter of the land sh; nil is
// open water everywhere.
func WindAt(t *WeatherTick, x, y float64, sh *Shelter) Env {
	var p WindPoint
	t.point(x, y, &p, pointWind, sh)
	return Env{WindSpeed: p.Speed, WindFrom: p.From, MeanFrom: p.MeanFrom}
}

// WindPointAt fills p with the wind at (x, y) in full, in the shelter sh.
func WindPointAt(t *WeatherTick, x, y float64, p *WindPoint, sh *Shelter) {
	t.point(x, y, p, pointFull, sh)
}

// MeanWindAt is the wind at (x, y) without its gusts or any shelter: what
// the sea follows.
func MeanWindAt(t *WeatherTick, x, y float64) (speed, from float64) {
	var p WindPoint
	t.point(x, y, &p, pointMean, nil)
	return p.MeanSpeed, p.MeanFrom
}

// point computes the wind at (x, y) into p, as much of it as what asks.
// The spells' mean wind, mixed, with the front's and the systems' added
// and the patches' taken away, is held by the refuge; then come the gusts,
// the land's shelter, the refuge's hold on the gusty wind, the veer and
// the fall draft.
func (t *WeatherTick) point(x, y float64, p *WindPoint, what int32, sh *Shelter) {
	*p = WindPoint{Factor: 1}
	if t.n == 0 {
		return
	}
	a := &t.at[0]
	if t.n == 1 && a.s.steady {
		speed, from := a.s.speed, a.s.from
		if sh != nil {
			f, turn := sh.At(x, y, from)
			speed, from = float64(speed*f), wrapAngle(from+turn)
		}
		p.Speed, p.From, p.MeanSpeed, p.MeanFrom = speed, from, speed, from
		if what != pointMean {
			t.p.fallDraft(x, y, p)
		}
		return
	}
	w := t.p
	r := math.Sqrt(float64(x*x) + float64(y*y))
	refuge := smooth(float64((w.refugeOuter - r) * w.invRefugeBlend))
	b := t.base(x, y, r, what)
	dir, speed, excess, gust, gusty, limited := b.dir, b.speed, b.excess, b.gust, b.gusty, b.limited
	p.DriftEast, p.DriftNorth = b.driftEast, b.driftNorth

	// The front's wind and the systems': air velocities added to the mean
	// wind's, and the patches' factors on the sum.
	if t.front || t.ns > 0 {
		sin, cos := SinCos(dir)
		// The air moves the other way from where the wind comes from.
		ve, vn := -float64(speed*sin), -float64(speed*cos)
		in := w.inwardAt(r)
		if t.front {
			excess += t.frontWind(b.s, in.weak, &ve, &vn)
		}
		f := 1.0
		for i := range t.ns {
			st := &t.sys[i]
			if st.k.shape == ShapeNone {
				f = float64(f * st.factor(x, y))
				continue
			}
			excess += st.wind(x, y, in, &ve, &vn)
		}
		ve, vn = float64(ve*f), float64(vn*f)
		v := math.Sqrt(float64(ve*ve) + float64(vn*vn))
		if v > 1e-9 {
			dir = Atan2(-ve, -vn)
		}
		speed = v
	}
	if refuge > 0 && limited > 0 {
		speed += float64(float64(refuge*limited) * (soften(speed, w.meanKnee, w.meanSoft) - speed))
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
	if sh != nil {
		f, turn := sh.At(x, y, dir)
		v = float64(v * f)
		dir += turn
		p.MeanSpeed = float64(p.MeanSpeed * f)
		p.MeanFrom = wrapAngle(dir)
	}
	p.Speed = v
	if refuge > 0 {
		p.Speed += float64(float64(refuge*limited) * (soften(v, w.windKnee, w.windSoft) - v))
	}
	p.From = wrapAngle(dir + float64(float64(w.veer*gust)*gusty))
	w.fallDraft(x, y, p)
}

// baseWind is the spells' wind at a point, mixed, before the front's and
// the systems' are added.
type baseWind struct {
	dir, speed, excess float64 // rad, m/s
	gust, gusty        float64 // the gust field, and the share of the spells with gusts
	limited            float64 // the share of the spells the refuge holds
	driftEast          float64 // how fast the gust field travels, m/s
	driftNorth         float64
	shares             [2]float64 // each spell's share
	s                  float64    // the point's distance ahead of a front's line, m
}

// base is the spells' wind at (x, y), r from the centre: each spell's mean
// wind and gust field, then the two mixed, by their shares at the point:
// the direction along the shorter arc, the speed and the gust factor as
// they stand, and the fields so that their spread is kept.
func (t *WeatherTick) base(x, y, r float64, what int32) baseWind {
	w := t.p
	var b baseWind
	factor := w.speedCentre + float64(w.speedSpan*smooth(float64(r*w.invRim)))
	b.shares, b.s = t.shares(x, y)
	var field2 float64
	for i := range t.n {
		st, share := &t.at[i], b.shares[i]
		d, v, e, n := st.mean(w, x, y, factor, what != pointMean)
		if i == 0 {
			b.dir, b.speed, b.excess = d, v, e
		} else {
			b.dir += float64(share * wrapAngle(d-b.dir))
			b.speed += float64(share * (v - b.speed))
			b.excess += float64(share * (e - b.excess))
		}
		if !st.s.steady {
			b.limited += share
		}
		if st.s.gusts {
			b.gust += float64(share * n)
			b.gusty += share
			field2 += float64(share * share)
			if what == pointFull {
				b.driftEast -= float64(float64(share*st.s.fieldSpeed) * st.sinD)
				b.driftNorth -= float64(float64(share*st.s.fieldSpeed) * st.cosD)
			}
		}
	}
	if field2 > 0 {
		b.gust = clamp(b.gust/math.Sqrt(field2), -1, 1)
	}
	return b
}

// shares is each spell's share of the wind at (x, y): across a front by
// which side of the line the point lies, the old spell ahead and the new
// behind, blended near it; otherwise the same everywhere. s is the point's
// distance ahead of the line, m.
func (t *WeatherTick) shares(x, y float64) (shares [2]float64, s float64) {
	if !t.front {
		return t.weight, 0
	}
	s = float64(x*t.fe) + float64(y*t.fn) - t.line
	behind := smooth(float64((t.p.blend - s) * t.p.invBlend2))
	return [2]float64{1 - behind, behind}, s
}

// trough is the shape of a front's trough s m ahead of its line, from −1
// at the line to 0 far from it, and its slope a metre along the way the
// front moves: falling as e^(−s / ahead) toward the line, tapering to
// nothing far ahead, and filling within a Gaussian's width behind.
func (w *WeatherPrepared) trough(s float64) (f, slope float64) {
	if s >= 0 {
		u := float64((s - w.taperFrom) * w.invTaper)
		taper := 1 - smooth(u)
		if !(taper > 0) {
			return 0, 0
		}
		e := Exp(-float64(s * w.invTroughAhead))
		f = -float64(e * taper)
		slope = float64(float64(e*w.invTroughAhead) * taper)
		if u > 0 {
			// The taper's own slope: smooth'(u) = 6u(1 − u).
			slope += float64(float64(e*float64(6*float64(u*(1-u)))) * w.invTaper)
		}
		return f, slope
	}
	q := float64(s / w.troughBehind)
	e := Exp(-float64(0.5 * float64(q*q)))
	return -e, float64(float64(q*e) / w.troughBehind)
}

// frontWind adds to (ve, vn), the air's velocity s ahead of the line, the
// front's own wind: its trough's slope downhill, turned clockwise by its
// angle, times weak, how much a squall keeps of itself there; and returns
// the gust factor's excess it adds behind the line.
func (t *WeatherTick) frontWind(s, weak float64, ve, vn *float64) float64 {
	w := t.p
	_, slope := w.trough(s)
	k := -float64(float64(slope*w.frontNorm) * weak)
	ge, gn := float64(k*t.fe), float64(k*t.fn)
	*ve += float64(ge*w.frontCos) + float64(gn*w.frontSin)
	*vn += float64(gn*w.frontCos) - float64(ge*w.frontSin)
	q := float64((s + w.gustsHalf) / w.gustsHalf)
	return float64(w.frontGusts * Exp(-float64(q*q)))
}

// fallDraft adds to the wind at (x, y), with and without its gusts, the
// air the falls draw toward the lip: nothing inside the draft's start,
// rising linearly to its strength at the lip, and no more beyond it. The
// wind that raises the sea leaves it out.
func (w *WeatherPrepared) fallDraft(x, y float64, p *WindPoint) {
	r2 := float64(x*x) + float64(y*y)
	if !(r2 > w.draftFrom2) || !(w.draft > 0) {
		return
	}
	r := math.Sqrt(r2)
	d := float64(w.draft * min2(float64((r-w.draftFrom)*w.invDraftSpan), 1))
	// The draft's velocity, outward, per metre of (x, y).
	k := d / r
	ox, oy := float64(k*x), float64(k*y)
	p.Speed, p.From = addWind(p.Speed, p.From, ox, oy)
	p.MeanSpeed, p.MeanFrom = addWind(p.MeanSpeed, p.MeanFrom, ox, oy)
}

// addWind is a wind of speed coming from from with the air's velocity
// (east, north) added to it: its speed and the direction it comes from.
func addWind(speed, from, east, north float64) (float64, float64) {
	sin, cos := SinCos(from)
	// The air moves the other way from where the wind comes from.
	ve := east - float64(speed*sin)
	vn := north - float64(speed*cos)
	return math.Sqrt(float64(ve*ve) + float64(vn*vn)), Atan2(-ve, -vn)
}

// mean is a spell's mean wind at (x, y): its direction, its speed, its gust
// factor's excess, and, if gusts, its gust field.
func (st *spellTick) mean(w *WeatherPrepared, x, y, factor float64, gusts bool) (dir, speed, excess, n float64) {
	s := st.s
	if s.steady {
		return s.from, s.speed, 0, 0
	}
	along := clamp(float64(x*st.sinB)+float64(y*st.cosB), -w.rim, w.rim)
	dir = st.dir + float64(float64(s.across*along)*w.invRim)
	speed = float64(s.speed * factor)
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

// seedBits is a seed held as a float, a whole number below 2³², which an
// int32 cannot hold: its two halves are converted apart.
func seedBits(s float64) uint32 {
	hi := toInt32(math.Floor(float64(s * (1.0 / 65536))))
	lo := toInt32(s - float64(float64(hi)*65536))
	return uint32(hi)<<16 | uint32(lo)&0xffff
}
