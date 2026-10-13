// SPDX-License-Identifier: AGPL-3.0-only

// Package weather is the world's weather on the server: which spell blows
// when. Until the weather is generated with the world, its spells follow a
// fixed sequence of regimes from the catalog, over and over from the
// world's epoch, each spell's numbers drawn from its regime by the physics
// package. A developer's weather overrides it from a tick on.
//
// The spells at a tick are a function of the tick and the developer's
// weathers alone, so a world restored or replayed has the same weather. The
// package does only integer arithmetic, so every machine draws the same; it
// keeps the simulation's rules (rules_test.go).
//
// Only the server holds the sequence: a client is sent the spells in play
// about the present, never the ones to come.
package weather

import (
	"errors"
	"fmt"

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
	// not those of the sequence's spell of the same number.
	heldKey = 0x5bd1e995
)

// Spell is a spell of the sequence: a regime, by its index, and how long it
// lasts.
type Spell struct {
	Regime int
	Hours  int
}

// Config is what a Timeline is made from: the physics package's prepared
// wind, the catalog's regimes, which of them are frontal, and the sequence.
type Config struct {
	Prepared *physics.WeatherPrepared
	Regimes  []physics.Regime
	Frontal  []bool
	Spells   []Spell
	Seed     uint32
	// Veer is the least and the most a frontal spell's arrival or
	// departure veers the wind, and Swing the most the direction moves
	// either way between other spells, in degrees.
	Veer  [2]int32
	Swing int32
}

// Timeline answers which spells blow when.
type Timeline struct {
	prepared *physics.WeatherPrepared
	regimes  []physics.Regime
	frontal  []bool
	spells   []Spell
	begins   []int64 // each spell's first tick within the sequence
	cycle    int64   // the sequence's length in ticks
	origin   int64   // the tick the sequence first begins at
	seed     uint32
	veer     [2]int32 // in steps of a turn
	swing    int32
	change   int64

	// fixed, when set, is the world's own weather instead of a sequence.
	fixed *physics.Spell

	// The direction of the spell last asked about, to walk from: the
	// direction of spell n follows from that of spell n − 1. It changes no
	// answer, only how long one takes.
	memo    bool
	memoN   int64
	memoDir int32
}

// New makes the timeline of a sequence.
func New(c Config) (*Timeline, error) {
	if c.Prepared == nil || len(c.Spells) == 0 {
		return nil, errors.New("weather: a sequence needs the prepared wind and a spell")
	}
	if len(c.Frontal) != len(c.Regimes) {
		return nil, errors.New("weather: frontal must say of every regime")
	}
	t := &Timeline{
		prepared: c.Prepared,
		regimes:  c.Regimes,
		frontal:  c.Frontal,
		spells:   c.Spells,
		seed:     c.Seed,
		veer:     [2]int32{degrees(c.Veer[0]), degrees(c.Veer[1])},
		swing:    degrees(c.Swing),
		change:   c.Prepared.ChangeTicks(),
	}
	for _, s := range c.Spells {
		if s.Regime < 0 || s.Regime >= len(c.Regimes) || s.Hours < 1 {
			return nil, fmt.Errorf("weather: a spell of regime %d for %d hours", s.Regime, s.Hours)
		}
		t.begins = append(t.begins, t.cycle)
		t.cycle += int64(s.Hours) * hourTicks
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
// ever, computed with the wind's constants p: as the sandbox's is, for a
// test that sails its recordings on the server.
func FixedIn(p *physics.WeatherPrepared, s physics.Spell) *Timeline {
	return &Timeline{fixed: &s, prepared: p, change: p.ChangeTicks()}
}

// fixedParams are the wind's numbers of a Fixed timeline: the wave wind is
// one sample a tick, with a time constant so short that the wind at each
// tick is the whole of it.
var fixedParams = physics.WeatherParams{
	Rim: 4.2, RefugeInner: 1, RefugeOuter: 1.4, RimGustsFrom: 3,
	GustAlong: 300, GustAcross: 200, GustLife: 240,
	WaveTimeConstant: 1e-9, WaveSample: 1.0 / physics.StepsPerSecond, WaveSamples: 1,
}

// Prepared is the wind's constants the timeline's spells are computed with.
func (t *Timeline) Prepared() *physics.WeatherPrepared { return t.prepared }

// From is the timeline with its sequence first beginning at a tick, not at
// tick 0: a test's way to a world that starts shortly before a change of
// spell.
func (t *Timeline) From(tick int64) *Timeline {
	c := *t
	c.origin, c.memo = tick, false
	return &c
}

// degrees is a whole number of degrees in steps of a turn, rounded.
func degrees(d int32) int32 { return int32((int64(d)*turn + 180) / 360) }

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

// number is the sequence's spell in effect at tick t, counted from the
// first after the epoch.
func (t *Timeline) number(tick int64) int64 {
	tick -= t.origin
	c := floorDiv(tick, t.cycle)
	at := tick - c*t.cycle
	k := len(t.begins) - 1
	for k > 0 && t.begins[k] > at {
		k--
	}
	return c*int64(len(t.spells)) + int64(k)
}

// index is spell n's place in the sequence.
func (t *Timeline) index(n int64) int {
	k := n % int64(len(t.spells))
	if k < 0 {
		k += int64(len(t.spells))
	}
	return int(k)
}

// beginOf is the tick spell n begins at.
func (t *Timeline) beginOf(n int64) int64 {
	c := floorDiv(n, int64(len(t.spells)))
	return t.origin + c*t.cycle + t.begins[t.index(n)]
}

// draw is spell n of the sequence in full but for its direction.
func (t *Timeline) draw(n int64) physics.Spell {
	k := t.index(n)
	r := t.spells[k].Regime
	begin := t.beginOf(n)
	s := physics.Spell{
		Begin:  float64(begin),
		Change: float64(t.change),
		Start:  float64(begin),
		Length: float64(int64(t.spells[k].Hours) * hourTicks),
		Regime: float64(r),
	}
	physics.DrawSpell(t.prepared, &t.regimes[r], uint32(n), t.seed, &s)
	return s
}

// turnOf is how far the direction moves from the end of spell n − 1 to the
// start of spell n: a veer as a frontal spell arrives or leaves, a swing
// either way otherwise.
func (t *Timeline) turnOf(n int64) int32 {
	h := mix(uint32(n) ^ mix(t.seed^0x2545f491))
	from, to := t.spells[t.index(n-1)].Regime, t.spells[t.index(n)].Regime
	if t.frontal[from] || t.frontal[to] {
		return t.veer[0] + int32(h%uint32(t.veer[1]-t.veer[0]+1))
	}
	return int32(h%uint32(2*t.swing+1)) - t.swing
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

// dirOf is the direction spell n comes from at its start, in steps of a
// turn: the direction at the end of the spell before, turned. Spell 0's is
// drawn.
func (t *Timeline) dirOf(n int64) int32 {
	if !t.memo {
		t.memo, t.memoN, t.memoDir = true, 0, int32(mix(t.seed^0x68e31da4)%turn)
	}
	for t.memoN < n {
		prev := t.draw(t.memoN)
		t.memoN++
		t.memoDir = wrap(t.memoDir + int32(prev.Drift) + t.turnOf(t.memoN))
	}
	for t.memoN > n {
		t.memoN--
		prev := t.draw(t.memoN)
		t.memoDir = wrap(t.memoDir - t.turnOf(t.memoN+1) - int32(prev.Drift))
	}
	return t.memoDir
}

func wrap(d int32) int32 {
	d %= turn
	if d < 0 {
		d += turn
	}
	return d
}

// seqSpell is spell n of the sequence.
func (t *Timeline) seqSpell(n int64) physics.Spell {
	s := t.draw(n)
	s.From = float64(t.dirOf(n))
	return s
}

// own is the world's own spell in effect at a tick.
func (t *Timeline) own(tick int64) physics.Spell {
	if t.fixed != nil {
		return *t.fixed
	}
	return t.seqSpell(t.number(tick))
}

// ownAfter is the first tick after tick at which the world's own weather
// begins a spell.
func (t *Timeline) ownAfter(tick int64) (int64, bool) {
	if t.fixed != nil {
		return 0, false
	}
	return t.beginOf(t.number(tick) + 1), true
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
		return physics.Spell{Begin: from, Start: from, Steady: 1, Speed: float64(w.Speed), From: float64(w.Dir % turn), Gust: 1000}
	}
	if t.fixed != nil {
		// A world with no regimes holds its one spell.
		s := *t.fixed
		s.Begin, s.Start = from, from
		return s
	}
	// A held regime: one endless spell of it, with no drift, from a
	// direction of its own.
	r := min(int(w.Regime), len(t.regimes)-1)
	s := physics.Spell{Begin: from, Start: from, Regime: float64(r)}
	number := uint32(w.From) ^ heldKey
	physics.DrawSpell(t.prepared, &t.regimes[r], number, t.seed, &s)
	s.Drift = 0
	s.From = float64(mix(number^t.seed) % turn)
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
// ended; and those to come that begin within Announce. If there are more
// than dst holds, the oldest are left out; the rest of dst is cleared.
func (t *Timeline) Spells(tick int64, ws []bus.Weather, dst *[physics.WeatherSpells]physics.Spell) int32 {
	var buf [2 * physics.WeatherSpells]physics.Spell
	n := 0
	cur := t.Effective(tick, ws)
	// Back from the one in effect.
	var back [physics.WeatherSpells]physics.Spell
	nb := 0
	first := cur
	for nb < physics.WeatherSpells-1 && float64(tick) < first.Begin+first.Change+Grace {
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

// Keep is how far back a developer's weather that has given way to another
// is kept: as long as the wave wind's samples, and the spells in play at
// each of them, may still fall in it.
func (t *Timeline) Keep() int64 {
	return t.prepared.WaveGrid()*int64(t.prepared.WaveSamples()) + t.change + Grace + physics.StepsPerSecond
}

// Set records a developer's weather w, set at tick, in the frame's
// weathers: it takes effect from the second after next, and replaces any
// set to take effect then or later. Weathers that gave way more than Keep
// ago are dropped, and the oldest beyond bus.WeatherHistory.
func (t *Timeline) Set(ws []bus.Weather, w bus.Weather, tick int64) []bus.Weather {
	w.From = (floorDiv(tick, physics.StepsPerSecond) + 2) * physics.StepsPerSecond
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

// FromCatalog is the timeline of the catalog's sequence.
func FromCatalog(c *catalog.Catalog) (*Timeline, error) {
	cfg := Config{
		Prepared: c.PrepareWeather(),
		Regimes:  catalog.Regimes(c),
		Seed:     uint32(c.Weather.Sequence.Seed),
		Swing:    int32(c.Weather.Sequence.Swing),
	}
	if len(c.Weather.Sequence.Veer) != 2 {
		return nil, errors.New("weather: the sequence's veer is not a range")
	}
	cfg.Veer = [2]int32{int32(c.Weather.Sequence.Veer[0]), int32(c.Weather.Sequence.Veer[1])}
	index := map[catalog.ID]int{}
	for i, r := range c.Weather.Regimes {
		index[r.ID] = i
		cfg.Frontal = append(cfg.Frontal, r.Frontal)
	}
	for _, s := range c.Weather.Sequence.Spells {
		r, ok := index[s.Regime]
		if !ok {
			return nil, fmt.Errorf("weather: the sequence names no regime %q", s.Regime)
		}
		cfg.Spells = append(cfg.Spells, Spell{Regime: r, Hours: s.Hours})
	}
	return New(cfg)
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
