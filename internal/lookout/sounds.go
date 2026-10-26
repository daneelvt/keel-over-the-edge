// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// What the phone plays of the world about the boat, and when. Held
// sounds: the falls, a line source heard within their reach of the lip
// and wherever the boat is as the world's end nears; the loudest
// waterfall's roar; the water lapping at a quay. Sounds played once: a
// blowhole's boom as its spout begins; a colony's calls by day; the
// harbour bell striking the watches by the world's clock, the gulls by
// day and the shipyard's mallets by day, all heard in port or near a
// town's buildings; a lighthouse's fog signal's blasts while the
// visibility at its light is under the catalog's limit as a blast begins,
// heard within the catalog's range the distance over the speed of sound
// after they sound; and the thunder after each flash within the catalog's
// reach, from its channel's nearest point, after the same delay. Each is
// fainter with distance, a point source's 6 dB each time the distance
// doubles, the falls' 3. When a boom, a call, a gull or a blow comes is
// drawn from world time and the source's own numbers, so every phone, and
// this, hears the islands alike. The surf on a shore, the wind, the
// rigging, the water on the hull, the sea and the rain are the boat's own
// or none: the phone plays no surf.
//
// The page's twins are client/src/audio/voices.ts (the falls),
// features.ts, harbour.ts, fogsignals.ts and thunder.ts; they are held to
// testdata/sounds.json. The recipes' numbers are art/sound's, which the
// tests check.

// A point source's recipe: whole within near m, heard within reach m, at
// level, a gain.
type pointRecipe struct{ near, reach, level float64 }

// The recipes' numbers, as art/sound's files give them.
var (
	waterfallRecipe = pointRecipe{near: 15, reach: 300, level: 0.45}
	blowholeRecipe  = pointRecipe{near: 20, reach: 300, level: 0.6}
	colonyRecipe    = pointRecipe{near: 20, reach: 300, level: 0.22}
	bellRecipe      = pointRecipe{near: 30, reach: 900, level: 0.5}
	gullsRecipe     = pointRecipe{near: 20, reach: 300, level: 0.18}
	malletsRecipe   = pointRecipe{near: 15, reach: 300, level: 0.35}
	lappingRecipe   = pointRecipe{near: 6, reach: 60}
	fallsRecipe     = struct{ near, reach, most, falling float64 }{near: 10, reach: 1000, most: 0.6, falling: 0.8}
	thunderRecipe   = struct{ stretch, near, level float64 }{stretch: 4000, near: 200, level: 0.7}
	// A waterfall roars whole from this drop, m; a blowhole booms whole
	// from this sea, m; a colony calls this often a minute, the gulls this
	// often.
	waterfallHeight  = 15.0
	blowholeSea      = 2.0
	colonyPerMinute  = 18.0
	gullsPerMinute   = 3.0
	bellStroke       = 0.55
	bellPair         = 1.5
	malletBeat       = 0.65
	malletRun        = [2]float64{3, 8}
	lappingLevel     = struct{ calm, most, seaHeight float64 }{calm: 0.05, most: 0.3, seaHeight: 1.5}
	lappingPeriod    = [2]float64{2.5, 6}
	fogDeviceRecipes = map[catalog.FogSignalDevice]pointRecipe{
		catalog.FogSignalDeviceTwotone:  {near: 30, level: 0.6},
		catalog.FogSignalDeviceDiaphone: {near: 30, level: 0.55},
		catalog.FogSignalDeviceSiren:    {near: 30, level: 0.45},
		catalog.FogSignalDeviceReedhorn: {near: 30, level: 0.4},
	}
)

// HarbourHeardWithin is how near a town's buildings the harbour is heard
// outside port, m.
const HarbourHeardWithin = 300

// harbourPeriod is the waves' period the lapping swells at, s: the page's.
const harbourPeriod = 4

// stepsPerSecond is the world's ticks a second.
const stepsPerSecond = 30

// Point is a place, m east and north of the world's centre.
type Point struct {
	East  float64 `json:"east"`
	North float64 `json:"north"`
}

// FeatureHeard is a feature that may sound: its site, where it is, how far
// a waterfall drops, m, its own number, and a colony's birds' call.
type FeatureHeard struct {
	Site  catalog.FeatureSite `json:"site"`
	East  float64             `json:"east"`
	North float64             `json:"north"`
	Drop  float64             `json:"drop"`
	Seed  float64             `json:"seed"`
	Call  catalog.Call        `json:"call"`
}

// HarbourHeard is what the harbour sounds from: whether the boat is in
// port; whether a town's buildings are near, and how far the nearest is,
// m; the nearest bell, shipyard slip and quay's edge (nil for none); and
// the world's hour, 0 to 24, noon at 12.
type HarbourHeard struct {
	InPort   bool    `json:"inPort"`
	Town     bool    `json:"town"`
	NearTown float64 `json:"nearTown"`
	Bell     *Point  `json:"bell"`
	Yard     *Point  `json:"yard"`
	Quay     *Point  `json:"quay"`
	Hour     float64 `json:"hour"`
}

// FogLight is a lighthouse as its fog signal is heard: its number, where
// it is, its phase, µs, and its fog signal, by its index in the catalog's,
// −1 for none.
type FogLight struct {
	Number int     `json:"number"`
	East   float64 `json:"east"`
	North  float64 `json:"north"`
	Phase  int64   `json:"phase"`
	Signal int     `json:"signal"`
}

// Flash is a flash of lightning as its thunder is heard: when its first
// stroke strikes, ticks; where; whether it strikes the sea or stays in its
// cloud; its cloud's base, m; and its own number.
type Flash struct {
	Tick  float64 `json:"tick"`
	East  float64 `json:"east"`
	North float64 `json:"north"`
	Sea   bool    `json:"sea"`
	Base  float64 `json:"base"`
	Seed  float64 `json:"seed"`
}

// Heard is the world about a listener, now.
type Heard struct {
	// Seconds is world time, s; East and North the listener; Day whether
	// the sun is up there; SeaHeight the sea's significant height, m.
	Seconds     float64
	East, North float64
	Day         bool
	SeaHeight   float64
	// Lip is how far the lip is, m; Falling whether the boat is going over
	// it; EndNear how near the world's end is, 0 to 1 (EndRoar).
	Lip      float64
	Falling  bool
	EndNear  float64
	Features []FeatureHeard
	Harbour  HarbourHeard
	Lights   []FogLight
	// Visibility is the visibility at a place at a tick, m; nil with no
	// weather, when no fog signal sounds.
	Visibility func(east, north, tick float64) float64
	Flashes    []Flash
}

// SoundKind is what a sound is.
type SoundKind int

// The kinds of sound: the held ones first.
const (
	SoundFalls SoundKind = iota
	SoundWaterfall
	SoundLapping
	SoundBoom
	SoundCall
	SoundBell
	SoundGull
	SoundMallet
	SoundFogSignal
	SoundThunder
)

// String is a kind of sound in a sailor's words.
func (k SoundKind) String() string {
	switch k {
	case SoundFalls:
		return "the roar of the falls"
	case SoundWaterfall:
		return "a waterfall's roar"
	case SoundLapping:
		return "water lapping at a quay"
	case SoundBoom:
		return "a blowhole's boom"
	case SoundCall:
		return "seabirds calling"
	case SoundBell:
		return "the harbour bell"
	case SoundGull:
		return "a gull's call"
	case SoundMallet:
		return "a mallet's blow"
	case SoundFogSignal:
		return "a fog signal"
	case SoundThunder:
		return "thunder"
	}
	return "a sound"
}

// Held reports whether a kind of sound is held rather than played once.
func (k SoundKind) Held() bool { return k <= SoundLapping }

// Sound is a sound the phone plays.
type Sound struct {
	Kind SoundKind `json:"-"`
	// Call is a colony's call; Device and Light a fog signal's device and
	// its light's number.
	Call   catalog.Call            `json:"call,omitempty"`
	Device catalog.FogSignalDevice `json:"device,omitempty"`
	Light  int                     `json:"light,omitempty"`
	// Degrees is the true bearing it is heard from, 0 to 360, and Bearing
	// that to the nearest 5°; Distance how far its source is, m.
	Degrees  float64 `json:"degrees"`
	Bearing  int     `json:"bearing"`
	Distance float64 `json:"distance"`
	// At is when it is heard, world s, a held sound's now; Delay how long
	// after it sounded, s, its distance over the speed of sound for a fog
	// signal and thunder; Length how long a blast sounds or thunder rolls,
	// s. Crack is a near thunder's crack.
	At     float64 `json:"at"`
	Delay  float64 `json:"delay,omitempty"`
	Length float64 `json:"length,omitempty"`
	Crack  bool    `json:"crack,omitempty"`
	// Level is how loud, as the phone's gain; Seed its own number, as the
	// phone draws it.
	Level float64 `json:"level"`
	Seed  float64 `json:"seed"`
}

// Hearing is the rule of what is heard, from the catalog.
type Hearing struct {
	signals []catalog.FogSignal
	// sounds is the visibility a blast sounds under, m; heard how far a
	// fog signal is heard, m.
	sounds, heard float64
	thunder       catalog.WeatherThunder
	// secondsPerHour is how long an hour of the world's day lasts, s.
	secondsPerHour float64
}

// NewHearing is the rule of what is heard, from the catalog.
func NewHearing(cat *catalog.Catalog) *Hearing {
	r := &cat.World.Lights.FogSignal
	return &Hearing{
		signals: cat.World.Lights.FogSignals,
		sounds:  r.Sounds * nauticalMile, heard: r.Heard * nauticalMile,
		thunder:        cat.Weather.Thunder,
		secondsPerHour: cat.Sky.Day * 60 / 24,
	}
}

// nauticalMile is a nautical mile, m.
const nauticalMile = 1852

// Sounds are the sounds the phone plays for the listener of in: the held
// sounds as they are now, then those played once that are heard from world
// s from up to to, in the order the phone finds them.
func (h *Hearing) Sounds(in *Heard, from, to float64) []Sound {
	var out []Sound
	add := func(s Sound) {
		if s.Level > 0 {
			s.Bearing = int(round(s.Degrees/5)) * 5 % 360
			out = append(out, s)
		}
	}
	h.held(in, add)
	if to > from {
		h.features(in, from, to, add)
		h.harbour(in, from, to, add)
		h.fogSignals(in, from, to, add)
		h.thunderAfter(in, from, to, add)
	}
	return out
}

// held adds the falls, the loudest waterfall's roar and the lapping.
func (h *Hearing) held(in *Heard, add func(Sound)) {
	d := math.Max(0, in.Lip)
	level := fallsLevel(d)
	if in.Falling {
		d, level = 0, fallsRecipe.falling
	}
	falls := Sound{Kind: SoundFalls, Distance: d, At: in.Seconds,
		Level: math.Max(level, float64(in.EndNear*fallsRecipe.falling))}
	// The lip lies straight out from the centre.
	falls.Degrees = degreesTo(in.East, in.North)
	add(falls)

	var roar Sound
	for _, f := range in.Features {
		if f.Site != catalog.FeatureSiteWaterfall {
			continue
		}
		dist := distance(in.East, in.North, f.East, f.North)
		l := waterfallRecipe.level * math.Min(f.Drop/waterfallHeight, 1) * pointLevel(dist, waterfallRecipe.near, waterfallRecipe.reach)
		if l > roar.Level {
			roar = Sound{Kind: SoundWaterfall, Degrees: degreesTo(f.East-in.East, f.North-in.North), Distance: dist, At: in.Seconds, Level: l}
		}
	}
	add(roar)

	if q := in.Harbour.Quay; harbourHeard(&in.Harbour) && q != nil {
		dist := distance(in.East, in.North, q.East, q.North)
		sea := math.Min(math.Max(in.SeaHeight/lappingLevel.seaHeight, 0), 1)
		base := lappingLevel.calm + float64((lappingLevel.most-lappingLevel.calm)*sea)
		period := math.Min(math.Max(harbourPeriod, lappingPeriod[0]), lappingPeriod[1])
		swell := 0.5 + float64(0.5*physics.Sin(2*math.Pi*in.Seconds/period))
		add(Sound{Kind: SoundLapping, Degrees: degreesTo(q.East-in.East, q.North-in.North), Distance: dist, At: in.Seconds,
			Level: base * swell * pointLevel(dist, lappingRecipe.near, lappingRecipe.reach)})
	}
}

// features adds the blowholes' booms and, by day, the colonies' calls.
func (h *Hearing) features(in *Heard, from, to float64, add func(Sound)) {
	sea := math.Min(math.Max(in.SeaHeight/blowholeSea, 0.15), 1)
	period := WavePeriod(in.SeaHeight)
	for _, b := range in.Features {
		if b.Site != catalog.FeatureSiteBlowhole {
			continue
		}
		dist := distance(in.East, in.North, b.East, b.North)
		level := blowholeRecipe.level * sea * pointLevel(dist, blowholeRecipe.near, blowholeRecipe.reach)
		if !(level > 0) {
			continue
		}
		off := spoutOffset(b.Seed, b.East)
		// The spout begins where the cycle's phase passes nought.
		for k := math.Ceil(from/period + off); (k-off)*period < to; k++ {
			at := (k - off) * period
			add(Sound{Kind: SoundBoom, Degrees: degreesTo(b.East-in.East, b.North-in.North), Distance: dist, At: at, Level: level, Seed: k})
		}
	}
	if !in.Day {
		return
	}
	slot := 60 / math.Max(colonyPerMinute, 0.01)
	for _, c := range in.Features {
		if c.Site != catalog.FeatureSiteColony {
			continue
		}
		dist := distance(in.East, in.North, c.East, c.North)
		level := colonyRecipe.level * pointLevel(dist, colonyRecipe.near, colonyRecipe.reach)
		if !(level > 0) {
			continue
		}
		for n := math.Ceil(from / slot); n*slot < to; n++ {
			if draw(n, c.Seed+11) < 0.7 {
				at := float64(n*slot) + float64(float64(draw(n, c.Seed+12)*slot)*0.5)
				add(Sound{Kind: SoundCall, Call: c.Call, Degrees: degreesTo(c.East-in.East, c.North-in.North), Distance: dist, At: at, Level: level, Seed: n})
			}
		}
	}
}

// harbourHeard reports whether the harbour is heard at all: in port, or
// near a town.
func harbourHeard(x *HarbourHeard) bool {
	return x.InPort || x.Town && x.NearTown <= HarbourHeardWithin
}

// harbour adds the bell's strokes when a half hour of the world's day
// begins, and by day the gulls' calls and the mallets' blows.
func (h *Hearing) harbour(in *Heard, from, to float64, add func(Sound)) {
	x := &in.Harbour
	if !harbourHeard(x) {
		return
	}
	if b := x.Bell; b != nil {
		hourFrom := x.Hour - (to-from)/h.secondsPerHour
		if halfHour(hourFrom) != halfHour(x.Hour) {
			dist := distance(in.East, in.North, b.East, b.North)
			level := bellRecipe.level * pointLevel(dist, bellRecipe.near, bellRecipe.reach)
			if level > 0 {
				strokes := BellStrokes(x.Hour)
				for i := range strokes {
					t := float64(float64(i/2)*(bellStroke+bellPair)) + float64(float64(i%2)*bellStroke)
					add(Sound{Kind: SoundBell, Degrees: degreesTo(b.East-in.East, b.North-in.North), Distance: dist, At: to + t, Level: level, Seed: halfHour(x.Hour)})
				}
			}
		}
	}
	if !in.Day {
		return
	}
	slot := 60 / math.Max(gullsPerMinute, 0.01) / 2
	for n := math.Ceil(from / slot); n*slot < to; n++ {
		if draw(n, 1) < 0.5 {
			a := draw(n, 2) * 2 * math.Pi
			dist := 25 + float64(draw(n, 3)*120)
			s, c := physics.Sin(a), physics.Cos(a)
			e, nn := in.East+float64(dist*s), in.North+float64(dist*c)
			add(Sound{Kind: SoundGull, Degrees: degreesTo(e-in.East, nn-in.North), Distance: dist, At: n * slot,
				Level: gullsRecipe.level * pointLevel(dist, gullsRecipe.near, gullsRecipe.reach), Seed: n})
		}
	}
	if y := x.Yard; y != nil {
		dist := distance(in.East, in.North, y.East, y.North)
		level := malletsRecipe.level * pointLevel(dist, malletsRecipe.near, malletsRecipe.reach)
		for n := math.Ceil(from / malletBeat); n*malletBeat < to && level > 0; n++ {
			// Runs of blows a beat apart, rests between, drawn in cycles of
			// twelve beats.
			cycle := math.Floor(n / 12)
			run := round(malletRun[0] + float64(draw(cycle, 4)*(malletRun[1]-malletRun[0])))
			if math.Mod(n, 12) < run {
				add(Sound{Kind: SoundMallet, Degrees: degreesTo(y.East-in.East, y.North-in.North), Distance: dist, At: n * malletBeat, Level: level, Seed: n})
			}
		}
	}
}

// fogSignals adds the blasts heard: each light's within the catalog's
// range whose blast began while the visibility at its light was under the
// catalog's limit.
func (h *Hearing) fogSignals(in *Heard, from, to float64, add func(Sound)) {
	if in.Visibility == nil {
		return
	}
	for _, l := range in.Lights {
		if l.Signal < 0 || l.Signal >= len(h.signals) {
			continue
		}
		s := &h.signals[l.Signal]
		r, ok := fogDeviceRecipes[s.Device]
		if !ok {
			continue
		}
		dist := distance(in.East, in.North, l.East, l.North)
		level := r.level * pointLevel(dist, r.near, h.heard)
		if !(level > 0) {
			continue
		}
		// The blasts whose sound arrives in the interval began the sound's
		// travel earlier.
		delay := dist / h.thunder.Speed
		fromUs := int64(math.Floor((from - delay) * 1e6))
		toUs := int64(math.Floor((to - delay) * 1e6))
		for _, b := range BlastsBetween(s.Steps, l.Phase, fromUs, toUs) {
			tick := math.Floor(float64(b[0]*stepsPerSecond) / 1e6)
			if !(in.Visibility(l.East, l.North, tick) < h.sounds) {
				continue
			}
			start := float64(b[0]) / 1e6
			add(Sound{Kind: SoundFogSignal, Device: s.Device, Light: l.Number, Degrees: degreesTo(l.East-in.East, l.North-in.North),
				Distance: dist, At: start + delay, Delay: delay, Length: float64(b[1]-b[0]) / 1e6, Level: level})
		}
	}
}

// BlastsBetween are the blasts of a fog signal of the steps given, its
// blasts and silences in turn, ms, and its light's phase, µs, that begin
// from world time from up to to, µs: each one's start and end.
func BlastsBetween(steps []int, phase, from, to int64) [][2]int64 {
	var p int64
	for _, s := range steps {
		p += int64(s) * 1000
	}
	var out [][2]int64
	if p <= 0 || !(to > from) {
		return out
	}
	// The start of the period that from lies in.
	base := from - ((from+phase)%p+p)%p
	for ; base < to; base += p {
		at := base
		for i, s := range steps {
			d := int64(s) * 1000
			if i%2 == 0 && at >= from && at < to {
				out = append(out, [2]int64{at, at + d})
			}
			at += d
		}
	}
	return out
}

// thunderAfter adds the thunders first heard in the interval.
func (h *Hearing) thunderAfter(in *Heard, from, to float64, add func(Sound)) {
	c := &h.thunder
	reach := c.Heard * nauticalMile
	for _, f := range in.Flashes {
		near, far, ae, an := channelReach(&f, in.East, in.North, thunderRecipe.stretch)
		if near > reach {
			continue
		}
		delay := near / c.Speed
		at := f.Tick/stepsPerSecond + delay
		if !(at >= from && at < to) {
			continue
		}
		add(Sound{Kind: SoundThunder, Degrees: degreesTo(ae-in.East, an-in.North), Distance: near, At: at, Delay: delay,
			Length: math.Min((far-near)/c.Speed, c.Longest), Crack: near <= c.Crack,
			Level: thunderRecipe.level * pointLevel(near, thunderRecipe.near, reach), Seed: f.Seed})
	}
}

// channelReach is how near and far a flash's channel is from a listener
// at (east, north) on the sea, and where its nearest point lies: one to the
// sea stands from the sea to its cloud's base; one in the cloud is a
// stretch of length m along its base, centred on its place, its way drawn
// from the flash's own number.
func channelReach(f *Flash, east, north, length float64) (near, far, atEast, atNorth float64) {
	dx, dy := f.East-east, f.North-north
	h := hypot(dx, dy)
	if f.Sea {
		return h, hypot(h, f.Base), f.East, f.North
	}
	ue, un := physics.SinCos(stretchWay(f.Seed))
	half := length / 2
	s := math.Min(math.Max(-(float64(dx*ue)+float64(dy*un)), -half), half)
	ne, nn := dx+float64(s*ue), dy+float64(s*un)
	ends := math.Max(hypot(dx+float64(half*ue), dy+float64(half*un)), hypot(dx-float64(half*ue), dy-float64(half*un)))
	return hypot(hypot(ne, nn), f.Base), hypot(ends, f.Base), east + ne, north + nn
}

// stretchWay is the way a cloud's channel lies, rad from north, drawn
// from its flash's own number.
func stretchWay(seed float64) float64 {
	v := float64(physics.Sin(float64(seed*12.9898)+4.1414) * 43758.5453)
	return (v - math.Floor(v)) * math.Pi
}

// fallsLevel is the falls' level at d m from the lip: most at near, 3 dB
// less each doubling beyond, silent past reach, tapering over its last
// tenth.
func fallsLevel(d float64) float64 {
	r := &fallsRecipe
	at := math.Max(d, r.near)
	spread := r.most * math.Sqrt(r.near/at)
	return spread * (1 - ramp(0.9*r.reach, r.reach, d))
}

// ramp is 0 below from, rising smoothly to 1 at full.
func ramp(from, full, x float64) float64 {
	t := math.Min(1, math.Max(0, (x-from)/(full-from)))
	return float64(t * t * (3 - float64(2*t)))
}

// pointLevel is a point source's level at d m: whole within near, falling
// as near / d (6 dB a doubling), nothing beyond reach.
func pointLevel(d, near, reach float64) float64 {
	if d > reach {
		return 0
	}
	return math.Min(1, near/math.Max(d, 1e-6))
}

// draw is a number in [0, 1) of slot n of a voice, the same on every phone.
func draw(n, voice float64) float64 {
	v := float64(physics.Sin(float64(n*12.9898)+float64(voice*78.233)) * 43758.5453)
	return v - math.Floor(v)
}

// spoutOffset is where in its cycle a blowhole's spout begins, a share of
// the waves' period, from its own numbers, as the page draws it.
func spoutOffset(seed, east float64) float64 {
	v := float64(physics.Sin(float64(seed*12.9898)+78.233+float64(east*0.01)) * 43758.5453)
	return v - math.Floor(v)
}

// WavePeriod is the waves' period the blowholes spout at, s, for a sea of
// significant height h, m.
func WavePeriod(h float64) float64 {
	return math.Min(math.Max(5.26*math.Sqrt(math.Max(h, 0)), 3), 14)
}

// halfHour is the half hour of the world's day an hour is in, from
// midnight: 0 to 47.
func halfHour(hour float64) float64 {
	return math.Floor(math.Mod(math.Mod(hour, 24)+24, 24) * 2)
}

// BellStrokes is how many strokes the bell strikes at the half hour an
// hour of the world's day is in: one to eight, eight at a watch's end.
func BellStrokes(hour float64) int {
	n := int(halfHour(hour)) % 8
	if n == 0 {
		return 8
	}
	return n
}

// HourAt is the hour of the day at the centre of the disk at sky time t,
// µs, the sky's day being day µs: 0 to 24, noon at 12.
func HourAt(t, day float64) float64 {
	frac := math.Mod(math.Mod(t, day)+day, day) / day
	return math.Mod(float64(frac*24)+12, 24)
}

// EndRoar is how near the world's end is for the falls' roar, 0 to 1,
// with left s to go: the falls rise wherever the boat is over the end's
// last sound seconds.
func EndRoar(left float64, end *catalog.EdgeEnd) float64 {
	if math.IsNaN(left) || math.IsInf(left, 0) || left > max(end.Sound, end.Mist, end.Tiles) {
		return 0
	}
	t := math.Min(1, math.Max(0, 1-left/end.Sound))
	return float64(t * t * (3 - float64(2*t)))
}

// degreesTo is the true bearing of a point dx east and dy north, degrees
// 0 to 360.
func degreesTo(dx, dy float64) float64 {
	b := physics.Atan2(dx, dy) * 180 / math.Pi
	if b < 0 {
		b += 360
	}
	return b
}

// hypot is the length of (x, y), as the page's Math.hypot gives it within
// its last bit.
func hypot(x, y float64) float64 { return math.Sqrt(float64(x*x) + float64(y*y)) }

// distance is how far (x1, y1) is from (x0, y0), m.
func distance(x0, y0, x1, y1 float64) float64 { return hypot(x1-x0, y1-y0) }
