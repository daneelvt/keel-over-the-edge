// SPDX-License-Identifier: AGPL-3.0-only

// Package weather is the world's weather on the server: its week, made
// with the world from its seed and stored with it (week.go), and the
// timeline that answers from it which spells blow when and where its
// systems are. A developer's weather overrides it from a tick on, and a
// developer's systems join it.
//
// The spells and the systems' keyframes at a tick are a function of the
// tick, the week and the developer's weathers and systems alone, so a world
// restored or replayed has the same weather. The package keeps the
// simulation's rules (rules_test.go) and the physics package's arithmetic,
// so every machine makes the same.
//
// Only the server holds the week: a client is sent the spells in play about
// the present and the systems' keyframes ten and twenty seconds ahead,
// never what is to come beyond.
package weather

import (
	"errors"
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

const (
	hourTicks = 3600 * physics.StepsPerSecond
	turn      = physics.TurnSteps
	// Announce is how many ticks before a spell begins it is in play: a
	// client hears of it ten seconds before its change begins, and never
	// earlier.
	Announce = 10 * physics.StepsPerSecond
	// Grace is how many ticks a spell stays in play after the change to the
	// next has ended, so that a client replaying its last few ticks still
	// has it.
	Grace = 10 * physics.StepsPerSecond
	// heldKey is mixed into a held spell's number, so that its draws are
	// not those of the week's spell of the same number.
	heldKey = 0x5bd1e995
	// weekSlots is the slot the developer's systems begin at: the week's
	// fill those below.
	weekSlots = physics.WeekSystems
)

// Timeline answers which spells blow when, and where the systems are.
type Timeline struct {
	cfg      *Config
	prepared *physics.WeatherPrepared
	week     *Week
	origin   int64 // the tick the week's tick 0 falls on
	longest  int64 // the longest life of the week's systems, ticks
	linger   int64 // the longest their swell lingers after them, ticks

	// fixed, when set, is the world's own weather instead of its week.
	fixed *physics.Spell
}

// New is the timeline of a world's week.
func New(c *Config, w *Week) (*Timeline, error) {
	if c == nil || c.Prepared == nil || w == nil || len(w.Spells) == 0 {
		return nil, errors.New("weather: a timeline needs the weather's config and a week with a spell")
	}
	t := &Timeline{cfg: c, prepared: c.Prepared, week: w}
	for i := range w.Systems {
		t.longest = max(t.longest, int64(w.Systems[i].Gone-w.Systems[i].Born))
		t.linger = max(t.linger, int64(c.Prepared.SwellLinger(w.Systems[i].Kind)))
		if i > 0 && w.Systems[i].Born < w.Systems[i-1].Born {
			return nil, errors.New("weather: the week's systems are not in the order of their births")
		}
	}
	return t, nil
}

// Fixed is the timeline of a world whose own weather is one spell for ever,
// as a test's is. Its sea follows its wind at once: the wave wind is the
// mean wind as it stands, sampled every second.
func Fixed(s physics.Spell) *Timeline {
	var p physics.WeatherPrepared
	physics.PrepareWeather(&fixedParams, &p)
	return FixedIn(&p, s)
}

// FixedIn is the timeline of a world whose own weather is one spell for
// ever, computed with the wind's constants p.
func FixedIn(p *physics.WeatherPrepared, s physics.Spell) *Timeline {
	return &Timeline{fixed: &s, prepared: p, cfg: &Config{Prepared: p, Every: 10 * physics.StepsPerSecond}}
}

// fixedParams are the wind's numbers of a Fixed timeline: the wave wind is
// one sample a tick, with a time constant so short that the wind at each
// tick is the whole of it.
var fixedParams = physics.WeatherParams{
	Rim: 4.2, RefugeInner: 1, RefugeOuter: 1.4, RimGustsFrom: 3, Edge: 4.5, FallDraftFrom: 4.2,
	GustAlong: 300, GustAcross: 200, GustLife: 240,
	WaveTimeConstant: 1e-9, WaveSample: 1.0 / physics.StepsPerSecond, WaveSamples: 1,
	TroughAhead: 1.1, TroughBehind: 0.35, Blend: 0.12, GustsBehind: 1, InwardTo: 3, Cut: 4,
}

// SampleEpoch is the epoch of the world FromCatalog's week is made for, µs
// of UTC: Sunday 18 October 2026, 6 pm in New York.
const SampleEpoch int64 = 1_792_360_800_000_000

// SampleWeek is how long that world lasts, µs: a week.
const SampleWeek int64 = 7 * 24 * 3600 * 1_000_000

// FromCatalog is the timeline of a sample week of the catalog's weather:
// the week of a world of seed 1, a week long from SampleEpoch, with no
// islands. Tests and tools sail it where no world's own week is at hand.
func FromCatalog(c *catalog.Catalog) (*Timeline, error) {
	cfg, err := ConfigOf(c)
	if err != nil {
		return nil, err
	}
	return New(cfg, Generate(cfg, 1, SampleEpoch, SampleEpoch+SampleWeek, nil))
}

// Prepared is the wind's constants the timeline's spells are computed with.
func (t *Timeline) Prepared() *physics.WeatherPrepared { return t.prepared }

// Config is the weather's config the timeline was made with.
func (t *Timeline) Config() *Config { return t.cfg }

// Week is the week the timeline answers from, or nil for a fixed one.
func (t *Timeline) Week() *Week {
	if t.fixed != nil {
		return nil
	}
	return t.week
}

// Origin is the tick the week's tick 0 falls on.
func (t *Timeline) Origin() int64 { return t.origin }

// Every is how many ticks apart the systems' keyframes are.
func (t *Timeline) Every() int64 { return t.cfg.Every }

// From is the timeline with its week's tick 0 at a tick: a test's way to a
// world that starts shortly before a change of spell.
func (t *Timeline) From(tick int64) *Timeline {
	c := *t
	c.origin = tick
	return &c
}

// Fixed is the timeline with its own weather one spell for ever, in place
// of its week: as the sandbox's is, for a test that sails its recordings
// on the server. Its regimes are still a developer's to hold.
func (t *Timeline) Fixed(s physics.Spell) *Timeline {
	c := *t
	c.fixed = &s
	return &c
}

// Steady is a developer's steady weather of a wind m/s from a direction in
// radians, in the steps the wire carries.
func Steady(speed, from float64) bus.Weather {
	s := physics.SteadySpell(speed, from, 0)
	return bus.Weather{Mode: bus.WeatherSteady, Speed: uint32(s.Speed), Dir: uint32(s.From)}
}

// floorDiv is a / b rounded down, for b > 0.
func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b < 0 {
		q--
	}
	return q
}

// mix mixes the bits of x (Wellons's lowbias32), as the physics package's
// draws do.
func mix(x uint32) uint32 {
	x ^= x >> 16
	x *= 0x7feb352d
	x ^= x >> 15
	x *= 0x846ca68b
	x ^= x >> 16
	return x
}

func wrap(d int32) int32 {
	d %= turn
	if d < 0 {
		d += turn
	}
	return d
}

// index is the week's spell in effect at a tick: the last to begin by it.
func (t *Timeline) index(tick int64) int {
	local := float64(tick - t.origin)
	i, _ := slices.BinarySearchFunc(t.week.Spells, local, func(s physics.Spell, at float64) int {
		if s.Begin <= at {
			return -1
		}
		return 1
	})
	return max(i-1, 0)
}

// shifted is the week's spell i, its ticks moved by the timeline's origin.
func (t *Timeline) shifted(i int) physics.Spell {
	s := t.week.Spells[i]
	s.Begin += float64(t.origin)
	s.Start += float64(t.origin)
	return s
}

// own is the world's own spell in effect at a tick.
func (t *Timeline) own(tick int64) physics.Spell {
	if t.fixed != nil {
		return *t.fixed
	}
	return t.shifted(t.index(tick))
}

// ownAfter is the first tick after tick at which the world's own weather
// begins a spell.
func (t *Timeline) ownAfter(tick int64) (int64, bool) {
	if t.fixed != nil {
		return 0, false
	}
	for j := t.index(tick) + 1; j < len(t.week.Spells); j++ {
		if b := int64(t.week.Spells[j].Begin) + t.origin; b > tick {
			return b, true
		}
	}
	return 0, false
}

// segment is the developer's weather in effect at a tick: its index in
// ws, or −1 for the world's own.
func segment(ws []bus.Weather, tick int64) int {
	j := -1
	for i := range ws {
		if ws[i].From <= tick {
			j = i
		}
	}
	return j
}

// regime is the catalog's regime of an index, the last if there is none of
// it, and the index.
func (t *Timeline) regime(i uint16) (*Regime, int) {
	r := min(int(i), len(t.cfg.Regimes)-1)
	return &t.cfg.Regimes[r], r
}

// held is a developer's held regime from a tick: one endless spell of it,
// with no drift, from a direction of its own, its pressure the middle of
// its regime's.
func (t *Timeline) held(w bus.Weather) physics.Spell {
	from := float64(w.From)
	reg, r := t.regime(w.Regime)
	s := physics.Spell{Begin: from, Start: from, Regime: float64(r)}
	number := uint32(w.From) ^ heldKey
	physics.DrawSpell(t.prepared, &reg.Wind, number, t.cfg.HeldSeed, &s)
	s.Drift = 0
	s.From = float64(mix(number^t.cfg.HeldSeed) % turn)
	s.Pressure = math.Round(float64(50 * (reg.Pressure[0] + reg.Pressure[1])))
	s.Still = 1
	return s
}

// Effective is the spell in effect at a tick: the last to begin by then.
func (t *Timeline) Effective(tick int64, ws []bus.Weather) physics.Spell {
	j := segment(ws, tick)
	if j < 0 || ws[j].Mode == bus.WeatherAuto {
		s := t.own(tick)
		if j >= 0 && s.Begin < float64(ws[j].From) {
			// The world's own weather takes over from a developer's at once.
			s.Begin, s.Change = float64(ws[j].From), 0
		}
		return s
	}
	w := ws[j]
	from := float64(w.From)
	if w.Mode == bus.WeatherSteady {
		return physics.Spell{Begin: from, Start: from, Steady: 1, Speed: float64(w.Speed), From: float64(w.Dir % turn), Gust: 1000, Still: 1}
	}
	if len(t.cfg.Regimes) == 0 {
		// A world with no regimes holds its one spell.
		s := *t.fixed
		s.Begin, s.Start = from, from
		return s
	}
	s := t.held(w)
	if w.Mode == bus.WeatherFront {
		// A front now, as fast and as deep as a week's at the middle of
		// theirs, moving toward where the new spell's wind blows.
		wk := &t.cfg.Week
		v := (wk.FrontSpeed[0] + wk.FrontSpeed[1]) / 2
		s.Front = 1
		s.Change = float64(2 * int64(math.Round(t.prepared.FrontReach()/v*physics.StepsPerSecond)))
		s.Toward = float64(wrap(int32(s.From) + turn/2))
		s.Trough = math.Round(float64(50 * (wk.FrontTrough[0] + wk.FrontTrough[1])))
	}
	return s
}

// after is the first tick after tick at which a spell begins, if any is
// known: the world's own next, or a developer's weather taking over.
func (t *Timeline) after(tick int64, ws []bus.Weather) (int64, bool) {
	next, ok := int64(0), false
	for _, w := range ws {
		if w.From > tick {
			next, ok = w.From, true
			break
		}
	}
	j := segment(ws, tick)
	if j < 0 || ws[j].Mode == bus.WeatherAuto {
		if own, has := t.ownAfter(tick); has && (!ok || own < next) {
			next, ok = own, true
		}
	}
	return next, ok
}

// Spells writes to dst the spells in play about a tick, ascending by the
// tick each begins at, and returns how many: the one in effect; those
// before it whose change to the next ended less than Grace ago, or has not
// ended, as a front's has not while its line is on the disk, nor a plain
// change's while its pressure eases; and those to come that begin within
// Announce. If there are more than dst holds, the oldest are left out; the
// rest of dst is cleared.
func (t *Timeline) Spells(tick int64, ws []bus.Weather, dst *[physics.WeatherSpells]physics.Spell) int32 {
	var buf [2 * physics.WeatherSpells]physics.Spell
	n := 0
	cur := t.Effective(tick, ws)
	// Back from the one in effect.
	var back [physics.WeatherSpells]physics.Spell
	nb := 0
	first := cur
	for nb < physics.WeatherSpells-1 && float64(tick) < first.Begin+t.holds(&first)+Grace {
		prev := t.Effective(int64(first.Begin)-1, ws)
		if prev.Begin >= first.Begin {
			break
		}
		back[nb] = prev
		nb++
		first = prev
	}
	for i := nb - 1; i >= 0; i-- {
		buf[n] = back[i]
		n++
	}
	buf[n] = cur
	n++
	// On to those announced.
	at := int64(cur.Begin)
	if int64(cur.Begin) < tick {
		at = tick
	}
	for n < len(buf) {
		next, ok := t.after(at, ws)
		if !ok || next-Announce > tick {
			break
		}
		buf[n] = t.Effective(next, ws)
		n++
		at = next
	}
	skip := max(n-physics.WeatherSpells, 0)
	// The rest of dst is cleared, so that two frames with the same spells
	// in play hold the same array.
	*dst = [physics.WeatherSpells]physics.Spell{}
	copy(dst[:], buf[skip:n])
	return int32(n - skip)
}

// holds is how long after a spell begins the one before it is still needed:
// its change, or a change with no front's ease of the pressure's level if
// that is longer.
func (t *Timeline) holds(s *physics.Spell) float64 {
	if s.Front == 0 && s.Change > 0 {
		return max(s.Change, float64(t.prepared.EaseTicks()))
	}
	return s.Change
}

// Coming is the next front of the world's own weather before its spell is
// in play: its line alone, from when its cirrus can first be seen from the
// disk until its spell is announced; none while a developer's weather
// holds, or none is coming.
func (t *Timeline) Coming(tick int64, ws []bus.Weather) physics.ComingFront {
	if t.fixed != nil || t.week == nil {
		return physics.ComingFront{}
	}
	if j := segment(ws, tick); j >= 0 && ws[j].Mode != bus.WeatherAuto {
		return physics.ComingFront{}
	}
	reach := t.prepared.FrontReach()
	for j := t.index(tick) + 1; j < len(t.week.Spells); j++ {
		s := t.shifted(j)
		begin := int64(s.Begin)
		if begin-Announce <= tick {
			continue
		}
		if s.Front == 0 || !(s.Change > 0) || !(reach > 0) {
			if begin > tick+hourTicks {
				break
			}
			continue
		}
		// The line moves 2 reach in its change.
		lead := int64(math.Ceil(t.cfg.Ahead * s.Change / (2 * reach)))
		if tick < begin-lead {
			break
		}
		return physics.ComingFront{On: 1, Begin: s.Begin, Change: s.Change, Toward: s.Toward}
	}
	return physics.ComingFront{}
}

// Keep is how far back a developer's weather that has given way to another
// is kept, and a developer's system that has gone: as long as the wave
// wind's samples, and the spells in play at each of them, may still fall
// in it.
func (t *Timeline) Keep() int64 {
	return t.prepared.WaveGrid()*int64(t.prepared.WaveSamples()) + t.prepared.ChangeTicks() + Grace + physics.StepsPerSecond
}

// Set records a developer's weather w, set at tick, in the frame's
// weathers: it takes effect from the second after next, and replaces any
// set to take effect then or later. Weathers that gave way more than Keep
// ago are dropped, and the oldest beyond bus.WeatherHistory. A system is
// not a weather: Place places it.
func (t *Timeline) Set(ws []bus.Weather, w bus.Weather, tick int64) []bus.Weather {
	if w.Mode == bus.WeatherSystem {
		return ws
	}
	w.From = (floorDiv(tick, physics.StepsPerSecond) + 2) * physics.StepsPerSecond
	w.Kind, w.East, w.North, w.In = 0, 0, 0, 0
	kept := ws[:0]
	for _, x := range ws {
		if x.From < w.From {
			kept = append(kept, x)
		}
	}
	for len(kept) > 0 && (len(kept) >= bus.WeatherHistory || len(kept) > 1 && kept[1].From <= tick-t.Keep()) {
		kept = append(kept[:0], kept[1:]...)
	}
	return append(kept, w)
}

// Place places a developer's system, set at tick: born at the first
// keyframe from the second after next, of the kind w names, moving with
// the wind in effect then so as to reach w's point w.In ticks after tick,
// at its strongest, in the lowest of the developer's slots free, or the
// oldest's. Systems gone more than Keep ago are dropped.
func (t *Timeline) Place(ss []bus.System, w bus.Weather, tick int64, ws []bus.Weather) []bus.System {
	ss = t.Trim(ss, tick)
	if int(w.Kind) >= len(t.cfg.Kinds) {
		return ss
	}
	every := t.cfg.Every
	from := (floorDiv(tick, physics.StepsPerSecond) + 2) * physics.StepsPerSecond
	born := floorDiv(from+every-1, every) * every
	at := max(tick+int64(w.In), born+every)
	kind := &t.cfg.Kinds[w.Kind]
	spell := t.Effective(born, ws)
	speed := float64(spell.Speed * physics.SeaSpeedStep)
	move := (kind.Speed[0] + kind.Speed[1]) / 2
	if kind.SpeedOfWind {
		move = float64(move * speed)
	}
	s := bus.System{
		Born: born, At: at, Kind: w.Kind, East: w.East, North: w.North,
		Heading: uint32(wrap(int32(spell.From) + turn/2)), Speed: uint32(math.Round(move / physics.SeaSpeedStep)),
	}
	var used [bus.SystemSlots]bool
	oldest := -1
	for i := range ss {
		used[ss[i].Slot] = true
		if oldest < 0 || ss[i].Born < ss[oldest].Born {
			oldest = i
		}
	}
	for k := range used {
		if !used[k] {
			s.Slot = uint8(k)
			return append(ss, s)
		}
	}
	s.Slot = ss[oldest].Slot
	ss = append(ss[:oldest], ss[oldest+1:]...)
	return append(ss, s)
}

// Trim drops from the developer's systems those gone more than Keep ago.
func (t *Timeline) Trim(ss []bus.System, tick int64) []bus.System {
	kept := ss[:0]
	for _, s := range ss {
		if r := t.record(s); int64(r.Gone)+t.Keep() > tick {
			kept = append(kept, s)
		}
	}
	return kept
}

// record is a developer's system's record: its kind's middling size,
// strength and life, on a straight track to its point, with no wobble,
// strongest as it reaches it.
func (t *Timeline) record(s bus.System) physics.SystemRecord {
	if len(t.cfg.Kinds) == 0 {
		return physics.SystemRecord{}
	}
	kind := &t.cfg.Kinds[min(int(s.Kind), len(t.cfg.Kinds)-1)]
	life := (kind.Life[0] + kind.Life[1]) / 2
	r := physics.SystemRecord{
		Kind: float64(s.Kind), Seed: float64(mix(uint32(s.Born) ^ uint32(s.Kind)<<24 ^ uint32(s.Slot))),
		Born: float64(s.Born), Mature: float64(s.At), Decays: float64(s.At + life/4), Gone: float64(s.At + life/2),
		Track: physics.TrackLine, Heading: float64(s.Heading), Speed: float64(s.Speed),
		Size: math.Round((kind.Size[0] + kind.Size[1]) / 2),
	}
	if kind.Shape == physics.ShapeNone {
		r.Peak = math.Round(float64(500 * (kind.Factor[0] + kind.Factor[1])))
	} else {
		r.Peak = math.Round(float64(speedSteps*(kind.Wind[0]+kind.Wind[1])) / 2)
		r.Depth = math.Round(float64(50 * (kind.Depth[0] + kind.Depth[1])))
	}
	// Back along its track from its point by how far it goes by then: a
	// dome's gust front, where its outflow is steepest, ahead of its centre
	// by its width over its steepness ahead, reaches the point then.
	sin, cos := physics.SinCos(float64(float64(s.Heading) * (2 * math.Pi / turn)))
	d := float64(float64(float64(float64(s.Speed)*physics.SeaSpeedStep)*physics.Dt) * float64(s.At-s.Born))
	if kind.Shape == physics.ShapeDome && kind.Ahead > 0 {
		d += float64(kind.Width*r.Size) / kind.Ahead
	}
	r.East = float64(s.East) - math.Round(float64(quarterMetres*float64(d*sin)))
	r.North = float64(s.North) - math.Round(float64(quarterMetres*float64(d*cos)))
	return r
}

// DeveloperRecord is a developer's system's record, as its keyframes are
// made from.
func (t *Timeline) DeveloperRecord(s bus.System) physics.SystemRecord { return t.record(s) }

// Keyframe sets dst to the systems' keyframe at a tick: the week's systems
// alive then, each in its slot, and the developer's systems in theirs. A
// developer's weather does not change it: its spell, still, stills the
// week's systems from the tick it blows.
func (t *Timeline) Keyframe(at int64, ss []bus.System, dst *physics.Keyframe) {
	*dst = physics.Keyframe{Tick: float64(at)}
	if w := t.Week(); w != nil {
		local := float64(at - t.origin)
		sys := w.Systems
		i, _ := slices.BinarySearchFunc(sys, local, func(s System, at float64) int {
			if s.Born <= at {
				return -1
			}
			return 1
		})
		for i--; i >= 0 && sys[i].Born > local-float64(t.longest)-1; i-- {
			if s := &sys[i]; local < s.Gone && s.Slot >= 0 && s.Slot < weekSlots {
				dst.Systems[s.Slot] = physics.SystemAt(&s.SystemRecord, local)
			}
		}
	}
	for _, s := range ss {
		if int(s.Slot) < bus.SystemSlots && len(t.cfg.Kinds) > 0 {
			r := t.record(s)
			dst.Systems[weekSlots+int(s.Slot)] = physics.SystemAt(&r, float64(at))
		}
	}
}

// SwellSource is a system whose swell may be on the disk at a tick: its
// record, and the tick in its record's time.
type SwellSource struct {
	Record physics.SystemRecord
	Tick   float64
}

// SwellSources appends to dst the systems whose swell may be on the disk at
// a tick: those of kinds that raise it, born by then and gone less than
// their swell's crossing of the disk before; the week's, unless the spell
// in effect is a developer's still weather, and the developer's ss.
func (t *Timeline) SwellSources(at int64, ws []bus.Weather, ss []bus.System, dst []SwellSource) []SwellSource {
	p := t.prepared
	if w := t.Week(); w != nil && t.Effective(at, ws).Still == 0 {
		local := float64(at - t.origin)
		sys := w.Systems
		i, _ := slices.BinarySearchFunc(sys, local, func(s System, at float64) int {
			if s.Born <= at {
				return -1
			}
			return 1
		})
		for i--; i >= 0 && sys[i].Born > local-float64(t.longest)-float64(t.linger)-1; i-- {
			r := &sys[i].SystemRecord
			if p.RaisesSwell(r.Kind) && local < r.Gone+p.SwellLinger(r.Kind) {
				dst = append(dst, SwellSource{Record: *r, Tick: local})
			}
		}
	}
	for _, s := range ss {
		if len(t.cfg.Kinds) == 0 || !p.RaisesSwell(float64(s.Kind)) {
			continue
		}
		r := t.record(s)
		if float64(at) >= r.Born && float64(at) < r.Gone+p.SwellLinger(r.Kind) {
			dst = append(dst, SwellSource{Record: r, Tick: float64(at)})
		}
	}
	return dst
}

// Keyframes sets dst to the keyframes about a tick: at the last keyframe
// at or before it, and the two after.
func (t *Timeline) Keyframes(tick int64, ss []bus.System, dst *[bus.KeyFrames]physics.Keyframe) {
	every := t.cfg.Every
	b := floorDiv(tick, every) * every
	for k := range dst {
		t.Keyframe(b+int64(k)*every, ss, &dst[k])
	}
}

// KeyframePair sets dst to the two keyframes about a tick: at the last
// keyframe at or before it, and the next; what the wind at the tick is
// interpolated between.
func (t *Timeline) KeyframePair(tick int64, ss []bus.System, dst *[2]physics.Keyframe) {
	every := t.cfg.Every
	b := floorDiv(tick, every) * every
	t.Keyframe(b, ss, &dst[0])
	t.Keyframe(b+every, ss, &dst[1])
}

// RegimeIndex is the index of the catalog's regime of an id, or −1.
func RegimeIndex(c *catalog.Catalog, id string) int {
	for i, r := range c.Weather.Regimes {
		if string(r.ID) == id {
			return i
		}
	}
	return -1
}

// KindIndex is the index of the catalog's kind of system of an id, or −1.
func KindIndex(c *catalog.Catalog, id string) int {
	for i, k := range c.Weather.Systems {
		if string(k.ID) == id {
			return i
		}
	}
	return -1
}
