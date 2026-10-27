// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
)

// A world's week of weather is made with the world, from its seed, for its
// epoch and its end, and stored with it, so a restart or a new build never
// changes it. It is a chain of spells drawn from the regimes' transition
// table; a front crossing the disk at every change into or out of a frontal
// regime; and the systems born in each spell at its regime's rates, each
// with its life, its track and its wobble. The simulation reads the systems
// from it at keyframes (Timeline.Keyframe); no client is ever sent it.
//
// Every number drawn comes from the week's own stream, a PCG keyed by the
// world's seed and by the week, apart from the terrain's; only Uint64 and
// what is built on it exactly are used, and the arithmetic is the physics
// package's, so a seed, an epoch and an end make the same week on every
// machine.

// Version is the week's generator's version: raised whenever a change makes
// any seed's week differ. It is stored with each week. 2: the systems'
// wobble slowed to periods of hours. 3: storms in every spell but settled,
// lows, squall lines and troughs, warm fronts, more of everything.
const Version = 3

// streamWeek keys the week's stream, which the terrain's keys never are.
const streamWeek uint64 = 0x7765656b << 32

const (
	ticksPerMinute = 60 * physics.StepsPerSecond
	knot           = 1852.0 / 3600 // m/s
	nauticalMile   = 1852.0        // m
	speedSteps     = 1 / physics.SeaSpeedStep
	degree         = math.Pi / 180
	quarterMetres  = 4
	strengthOne    = 4096
	usPerTick      = 1e6 / physics.StepsPerSecond
)

// Island is an island the week's showers may form over by day: its centre,
// m east and north of the world's, its land's area, m², and its size
// across, m.
type Island struct {
	X, Y, Area, Across float64
}

// Next is a regime a spell may give way to, by its index, and the chance.
type Next struct {
	To     int
	Chance float64
}

// Rate is how many systems of a kind, by its index, are born in a spell:
// an hour over the disk, and at its start; the shares of the kind's range
// their peak wind is drawn from; and when, by its When.
type Rate struct {
	Kind    int
	PerHour float64
	AtStart int
	Peak    [2]float64
	When    int
}

// When a rate's systems are born.
const (
	whenAlways = iota
	whenDay
	whenNight
)

// Regime is a regime as the week draws it.
type Regime struct {
	Wind     physics.Regime
	Share    float64
	Frontal  bool
	Spell    [2]int64   // ticks
	Pressure [2]float64 // hPa
	Next     []Next
	Systems  []Rate
}

// The tracks a kind of system takes.
const (
	trackWind  = iota // born beyond the windward rim, across the disk with the wind
	trackOuter        // born on the windward side, round the outer waters
	trackDrift        // born inside, drifting with the wind
)

// Kind is a kind of system as the week draws it.
type Kind struct {
	Shape       float64 // physics.ShapeNone, ShapeDome, ShapeLow or ShapeLine
	Width       float64 // its shape's width, as a share of its size
	Ahead       float64 // a dome's steepness ahead
	Track       int
	SpeedOfWind bool       // Speed is a share of the base wind; otherwise m/s
	Size        [2]float64 // m
	Length      [2]float64 // m: a line's
	TurnsIn     float64    // the share of those on the outer waters that turn inward
	Speed       [2]float64
	Life        [2]int64   // ticks
	Wind        [2]float64 // m/s
	Factor      [2]float64
	Depth       [2]float64 // hPa
	Islands     float64
	Night       bool
	Dawn        int64    // ticks
	Lift        [2]int64 // ticks
	CalmBelow   float64  // m/s
	GoneAbove   float64  // m/s
}

// WeekParams are how a week is drawn and checked.
type WeekParams struct {
	Opening, Closing, Fair int64 // ticks
	ClosingRegime          int
	Shares                 float64
	SharesFrom             int64 // ticks
	Margin                 int64 // ticks
	Draws                  int
	Veer                   [2]int32 // in steps of a turn: a cold front's
	WarmVeer               [2]int32 // and a warm front's
	Swing                  int32
	FrontSpeed             [2]float64 // m/s
	FrontTrough            [2]float64 // hPa
	Spread                 int32      // in steps of a turn
	Wobble                 float64    // m
	WobblePeriod           [2]int64   // ticks
	StrengthWobble         float64
	SystemsMost            int
	// Storms is the kind of which at most StormsMost are on the disk at
	// once, and which turns inward in no spell of a regime of no front.
	Storms, StormsMost int
	// Quiet are the kinds not born in a world's first QuietTicks, nor in
	// its closing spell, by the kinds' indices.
	Quiet      []bool
	QuietTicks int64
	// A line of LineKind is born ahead of every cold front into a spell
	// of LineInto, LineAhead ahead of its line, m; LineKind −1 for none.
	LineKind, LineInto int
	LineAhead          [2]float64
	// Fill is the kind born wherever the disk would be empty.
	Fill  int
	Outer [2]float64 // m
}

// Config is what weeks and timelines are made with: the physics package's
// prepared wind, the regimes and kinds of system, how a week is drawn, the
// sky, the ticks between keyframes, and the seed of a developer's held
// spells.
type Config struct {
	Prepared *physics.WeatherPrepared
	Regimes  []Regime
	Kinds    []Kind
	Week     WeekParams
	Sky      *sky.Prepared
	Every    int64
	HeldSeed uint32
	// Ahead is how far beyond the disk's reach a front's line is when its
	// cirrus can first be seen from the disk, m.
	Ahead float64
}

// ConfigOf is the catalog's weather as weeks and timelines are made with
// it.
func ConfigOf(c *catalog.Catalog) (*Config, error) {
	w := &c.Weather
	cfg := &Config{
		Prepared: c.PrepareWeather(),
		Sky:      c.PrepareSky(),
		Every:    int64(w.Keyframe.Every) * physics.StepsPerSecond,
		HeldSeed: uint32(w.Week.Seed),
	}
	cfg.Ahead = cfg.Prepared.ComingAhead(c.World.Handout.Dome)
	regimes := map[catalog.ID]int{}
	for i, r := range w.Regimes {
		regimes[r.ID] = i
	}
	kinds := map[catalog.ID]int{}
	for i, k := range w.Systems {
		kinds[k.ID] = i
	}
	pair := func(a []float64, unit float64) [2]float64 {
		if len(a) != 2 {
			return [2]float64{}
		}
		return [2]float64{a[0] * unit, a[1] * unit}
	}
	ticks := func(a []float64, unit float64) [2]int64 {
		p := pair(a, unit)
		return [2]int64{int64(math.Round(p[0])), int64(math.Round(p[1]))}
	}
	winds := catalog.Regimes(c)
	for i, r := range w.Regimes {
		g := Regime{
			Wind: winds[i], Share: r.Share, Frontal: r.Frontal,
			Spell: ticks(r.Spell, hourTicks), Pressure: pair(r.Pressure, 1),
		}
		for _, n := range r.Next {
			to, ok := regimes[n.To]
			if !ok {
				return nil, fmt.Errorf("weather: regime %s gives way to no regime %q", r.ID, n.To)
			}
			g.Next = append(g.Next, Next{To: to, Chance: n.Chance})
		}
		for _, s := range r.Systems {
			k, ok := kinds[s.Kind]
			if !ok {
				return nil, fmt.Errorf("weather: regime %s has no kind %q", r.ID, s.Kind)
			}
			when := map[catalog.When]int{catalog.WhenAlways: whenAlways, catalog.WhenDay: whenDay, catalog.WhenNight: whenNight}[s.When]
			g.Systems = append(g.Systems, Rate{Kind: k, PerHour: s.Rate, AtStart: s.AtStart, Peak: pair(s.Peak, 1), When: when})
		}
		cfg.Regimes = append(cfg.Regimes, g)
	}
	shapes := map[catalog.Shape]float64{catalog.ShapeNone: physics.ShapeNone, catalog.ShapeDome: physics.ShapeDome, catalog.ShapeLow: physics.ShapeLow, catalog.ShapeLine: physics.ShapeLine}
	tracks := map[catalog.Track]int{catalog.TrackWind: trackWind, catalog.TrackOuter: trackOuter, catalog.TrackDrift: trackDrift}
	for _, k := range w.Systems {
		g := Kind{
			Shape: shapes[k.Shape], Width: k.Width, Ahead: k.Ahead, Track: tracks[k.Track], SpeedOfWind: k.SpeedOf == catalog.SpeedOfWind,
			Size: pair(k.Size, nauticalMile), Length: pair(k.Length, nauticalMile), TurnsIn: k.TurnsIn,
			Speed: pair(k.Speed, 1), Life: ticks(k.Life, ticksPerMinute),
			Wind: pair(k.Wind, knot), Factor: pair(k.Factor, 1), Depth: pair(k.Depth, 1),
			Islands: k.Islands, Night: k.Night, Dawn: int64(math.Round(k.Dawn * ticksPerMinute)),
			Lift: ticks(k.Lift, ticksPerMinute), CalmBelow: k.CalmBelow * knot, GoneAbove: k.GoneAbove * knot,
		}
		if !g.SpeedOfWind {
			g.Speed = pair(k.Speed, knot)
		}
		cfg.Kinds = append(cfg.Kinds, g)
	}
	wk := &w.Week
	closing, ok := regimes[wk.ClosingRegime]
	if !ok {
		return nil, fmt.Errorf("weather: the week closes in no regime %q", wk.ClosingRegime)
	}
	deg := func(d float64) int32 { return int32(math.Round(d * physics.TurnSteps / 360)) }
	veer, warm := pair(wk.Veer, 1), pair(wk.WarmVeer, 1)
	cfg.Week = WeekParams{
		Opening: int64(math.Round(wk.Opening * hourTicks)), Closing: int64(math.Round(wk.Closing * hourTicks)),
		Fair: int64(math.Round(wk.Fair * hourTicks)), ClosingRegime: closing,
		Shares: wk.Shares, SharesFrom: int64(math.Round(wk.SharesFrom * 24 * hourTicks)),
		Margin: int64(math.Round(wk.Margin * hourTicks)), Draws: wk.Draws,
		Veer: [2]int32{deg(veer[0]), deg(veer[1])}, WarmVeer: [2]int32{deg(warm[0]), deg(warm[1])}, Swing: deg(wk.Swing),
		FrontSpeed: pair(wk.FrontSpeed, knot), FrontTrough: pair(wk.FrontTrough, 1), Spread: deg(wk.Spread),
		Wobble: wk.Wobble * nauticalMile, WobblePeriod: ticks(wk.WobblePeriod, ticksPerMinute),
		StrengthWobble: wk.StrengthWobble, SystemsMost: wk.SystemsMost,
		Outer: pair(wk.Outer, nauticalMile),
		StormsMost: wk.Storms.Most, QuietTicks: int64(math.Round(wk.Quiet.Hours * hourTicks)),
		LineAhead: pair(wk.LineAhead.Ahead, nauticalMile),
	}
	var known bool
	if cfg.Week.Storms, known = kinds[wk.Storms.Kind]; !known {
		return nil, fmt.Errorf("weather: the week's storms are of no kind %q", wk.Storms.Kind)
	}
	cfg.Week.Quiet = make([]bool, len(w.Systems))
	for _, id := range wk.Quiet.Kinds {
		k, ok := kinds[id]
		if !ok {
			return nil, fmt.Errorf("weather: the week keeps quiet no kind %q", id)
		}
		cfg.Week.Quiet[k] = true
	}
	if cfg.Week.LineKind, known = kinds[wk.LineAhead.Kind]; !known {
		return nil, fmt.Errorf("weather: the week's line ahead is of no kind %q", wk.LineAhead.Kind)
	}
	if cfg.Week.LineInto, known = regimes[wk.LineAhead.Into]; !known {
		return nil, fmt.Errorf("weather: the week's line ahead is into no regime %q", wk.LineAhead.Into)
	}
	if cfg.Week.Fill, known = kinds[wk.Fill]; !known {
		return nil, fmt.Errorf("weather: the week fills with no kind %q", wk.Fill)
	}
	if cfg.Every <= 0 {
		return nil, errors.New("weather: keyframes no time apart")
	}
	return cfg, nil
}

// Week is a world's weather: its spells, the fronts among them, and its
// systems, each in its slot.
type Week struct {
	Version int    `json:"version"`
	Seed    uint64 `json:"seed"`
	// Epoch and Ends are the world's epoch and end the week was made for,
	// µs of UTC since 1970.
	Epoch int64 `json:"epoch"`
	Ends  int64 `json:"ends"`
	// Until is the tick it reaches to: a margin past the world's end.
	Until   int64           `json:"until"`
	Spells  []physics.Spell `json:"spells"`
	Systems []System        `json:"systems"`
	Report  Report          `json:"report"`
}

// System is a system of the week: its slot, which it holds from its birth
// to its end, and its record.
type System struct {
	Slot int `json:"slot"`
	physics.SystemRecord
}

// Report is what the week's making found.
type Report struct {
	Draws   int       `json:"draws"`  // how many weeks were drawn
	Passed  bool      `json:"passed"` // whether the week kept passed every check
	Failed  []string  `json:"failed,omitempty"`
	Shares  []float64 `json:"shares"` // each regime's share of the world's time
	Spells  int       `json:"spells"`
	Fronts  int       `json:"fronts"`
	Storms  int       `json:"storms"` // systems of the week's storms' kind
	Systems int       `json:"systems"`
	Refused int       `json:"refused"` // systems not born: the disk held all it may
	Filled  int       `json:"filled"`  // systems born where the disk would have been empty
	Most    int       `json:"most"`    // the most systems on the disk at once
}

// A week is stored as a header, JSON, and its records' numbers after it,
// each a little-endian float64 in the order of the names of its record's
// fields the header gives once, so that a field added later reads as 0 from
// a week stored before:
//
//	magic         "KEELWEEK"
//	header        uint32 length, then that many bytes of JSON (header)
//	spells        header.Spells × len(header.SpellFields) float64s
//	systems       header.Systems × len(header.SystemFields) float64s, the first of each its slot
const weekMagic = "KEELWEEK"

// header is a stored week's JSON part.
type header struct {
	Version      int      `json:"version"`
	Seed         uint64   `json:"seed"`
	Epoch        int64    `json:"epoch"`
	Ends         int64    `json:"ends"`
	Until        int64    `json:"until"`
	SpellFields  []string `json:"spellFields"`
	Spells       int      `json:"spells"`
	SystemFields []string `json:"systemFields"`
	Systems      int      `json:"systems"`
	Report       Report   `json:"report"`
}

// fieldsOf is the names of a record's numbers: each field's, an array's
// with its index.
func fieldsOf(t reflect.Type) []string {
	var out []string
	for i := range t.NumField() {
		f := t.Field(i)
		if f.Type.Kind() == reflect.Array {
			for j := range f.Type.Len() {
				out = append(out, fmt.Sprintf("%s.%d", storedName(f), j))
			}
			continue
		}
		out = append(out, storedName(f))
	}
	return out
}

// storedName is the name a stored week gives a field: its week tag, which
// keeps the name a field had before it was renamed, or else its own.
func storedName(f reflect.StructField) string {
	if name, ok := f.Tag.Lookup("week"); ok {
		return name
	}
	return f.Name
}

// fieldNamed is the field of t a stored week names name.
func fieldNamed(t reflect.Type, name string) (reflect.StructField, bool) {
	for i := range t.NumField() {
		if f := t.Field(i); storedName(f) == name {
			return f, true
		}
	}
	return reflect.StructField{}, false
}

// numbersOf is a record's numbers, in the order of fieldsOf.
func numbersOf(v reflect.Value) []float64 {
	var out []float64
	for i := range v.NumField() {
		f := v.Field(i)
		if f.Kind() == reflect.Array {
			for j := range f.Len() {
				out = append(out, f.Index(j).Float())
			}
			continue
		}
		out = append(out, f.Float())
	}
	return out
}

// place is where a named number lies in a record: its field, and its index
// in the field if it is an array, or −1.
type place struct{ field, index int }

// placesOf is where each of fields lies in a record of type t, or an error
// for a name it has not.
func placesOf(t reflect.Type, fields []string) ([]place, error) {
	out := make([]place, len(fields))
	for i, name := range fields {
		base, index, isArray := strings.Cut(name, ".")
		f, ok := fieldNamed(t, base)
		if !ok || len(f.Index) != 1 {
			return nil, fmt.Errorf("no field %s", name)
		}
		p := place{field: f.Index[0], index: -1}
		switch {
		case isArray:
			j, err := strconv.Atoi(index)
			if err != nil || f.Type.Kind() != reflect.Array || f.Type.Elem().Kind() != reflect.Float64 || j < 0 || j >= f.Type.Len() {
				return nil, fmt.Errorf("no field %s", name)
			}
			p.index = j
		case f.Type.Kind() != reflect.Float64:
			return nil, fmt.Errorf("field %s is not a number", name)
		}
		out[i] = p
	}
	return out, nil
}

// setNumbers sets a record's fields from numbers at their places; a field
// with none is left as it is.
func setNumbers(v reflect.Value, places []place, numbers []float64) error {
	if len(numbers) != len(places) {
		return fmt.Errorf("%d numbers for %d fields", len(numbers), len(places))
	}
	for i, p := range places {
		f := v.Field(p.field)
		if p.index >= 0 {
			f = f.Index(p.index)
		}
		f.SetFloat(numbers[i])
	}
	return nil
}

// wordsOf is how many numbers count records of fields numbers each hold,
// if that is no more than most: a header's counts are checked against the
// bytes after it before they are multiplied, so none can overflow.
func wordsOf(count, fields, most int) (int, bool) {
	if count < 0 || fields < 0 || (count > 0 && (fields == 0 || count > most/fields)) {
		return 0, false
	}
	return count * fields, true
}

// Encode is the week's bytes as stored, and their digest.
func (w *Week) Encode() ([]byte, [32]byte, error) {
	h := header{
		Version: w.Version, Seed: w.Seed, Epoch: w.Epoch, Ends: w.Ends, Until: w.Until, Report: w.Report,
		SpellFields:  fieldsOf(reflect.TypeFor[physics.Spell]()),
		Spells:       len(w.Spells),
		SystemFields: append([]string{"Slot"}, fieldsOf(reflect.TypeFor[physics.SystemRecord]())...),
		Systems:      len(w.Systems),
	}
	js, err := json.Marshal(h)
	if err != nil {
		return nil, [32]byte{}, err
	}
	b := append([]byte(nil), weekMagic...)
	b = binary.LittleEndian.AppendUint32(b, uint32(len(js)))
	b = append(b, js...)
	put := func(v float64) { b = binary.LittleEndian.AppendUint64(b, math.Float64bits(v)) }
	for i := range w.Spells {
		for _, v := range numbersOf(reflect.ValueOf(w.Spells[i])) {
			put(v)
		}
	}
	for i := range w.Systems {
		put(float64(w.Systems[i].Slot))
		for _, v := range numbersOf(reflect.ValueOf(w.Systems[i].SystemRecord)) {
			put(v)
		}
	}
	return b, sha256.Sum256(b), nil
}

// Decode reads a week stored as b, checked against its digest unless none
// is given.
func Decode(b []byte, digest []byte) (*Week, error) {
	if sum := sha256.Sum256(b); len(digest) != 0 && string(sum[:]) != string(digest) {
		return nil, errors.New("weather: the week does not match its digest")
	}
	if len(b) < len(weekMagic)+4 || string(b[:len(weekMagic)]) != weekMagic {
		return nil, errors.New("weather: not a week")
	}
	b = b[len(weekMagic):]
	n := int(binary.LittleEndian.Uint32(b))
	b = b[4:]
	if n > len(b) {
		return nil, errors.New("weather: the week's header is cut short")
	}
	var h header
	if err := json.Unmarshal(b[:n], &h); err != nil {
		return nil, fmt.Errorf("weather: the week's header: %w", err)
	}
	b = b[n:]
	if h.Spells <= 0 {
		return nil, errors.New("weather: a week with no spells")
	}
	if h.Systems > 0 && (len(h.SystemFields) == 0 || h.SystemFields[0] != "Slot") {
		return nil, errors.New("weather: the week's systems have no slots")
	}
	words := len(b) / 8
	spellWords, ok := wordsOf(h.Spells, len(h.SpellFields), words)
	systemWords, ok2 := wordsOf(h.Systems, len(h.SystemFields), words)
	if !ok || !ok2 || len(b)%8 != 0 || spellWords+systemWords != words {
		return nil, errors.New("weather: the week's records are not as long as its header says")
	}
	next := func() float64 {
		v := math.Float64frombits(binary.LittleEndian.Uint64(b))
		b = b[8:]
		return v
	}
	numbers := func(k int) []float64 {
		out := make([]float64, k)
		for i := range out {
			out[i] = next()
		}
		return out
	}
	w := &Week{Version: h.Version, Seed: h.Seed, Epoch: h.Epoch, Ends: h.Ends, Until: h.Until, Report: h.Report}
	spellPlaces, err := placesOf(reflect.TypeFor[physics.Spell](), h.SpellFields)
	if err != nil {
		return nil, fmt.Errorf("weather: the week's spells: %w", err)
	}
	w.Spells = make([]physics.Spell, h.Spells)
	for i := range w.Spells {
		if err := setNumbers(reflect.ValueOf(&w.Spells[i]).Elem(), spellPlaces, numbers(len(h.SpellFields))); err != nil {
			return nil, fmt.Errorf("weather: the week's spell %d: %w", i, err)
		}
	}
	var systemPlaces []place
	if h.Systems > 0 {
		if systemPlaces, err = placesOf(reflect.TypeFor[physics.SystemRecord](), h.SystemFields[1:]); err != nil {
			return nil, fmt.Errorf("weather: the week's systems: %w", err)
		}
	}
	w.Systems = make([]System, h.Systems)
	for i := range w.Systems {
		w.Systems[i].Slot = int(next())
		if err := setNumbers(reflect.ValueOf(&w.Systems[i].SystemRecord).Elem(), systemPlaces, numbers(len(h.SystemFields)-1)); err != nil {
			return nil, fmt.Errorf("weather: the week's system %d: %w", i, err)
		}
	}
	return w, nil
}

// TicksOf is the ticks from a world's epoch to a time, µs of UTC: whole
// ticks, rounded down.
func TicksOf(epoch, at int64) int64 { return floorDiv((at-epoch)*physics.StepsPerSecond, 1_000_000) }

// stream is the week's generator.
type stream struct{ r *rand.Rand }

func newStream(seed uint64) stream {
	return stream{rand.New(rand.NewPCG(mix64(seed), mix64(seed^mix64(streamWeek))))}
}

// mix64 scrambles x (Stafford's variant 13 of the SplitMix64 finaliser).
func mix64(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}

// float is a number in [0, 1), rounded as it is drawn so that Go fuses it
// into no sum it is part of.
func (s stream) float() float64            { return float64(s.r.Float64()) }
func (s stream) in(lo, hi float64) float64 { return lo + float64(s.float()*(hi-lo)) }
func (s stream) chance(p float64) bool     { return s.float() < p }
func (s stream) seed32() uint32            { return uint32(s.r.Uint64() >> 32) }
func (s stream) ticks(lo, hi int64) int64  { return lo + int64(s.r.Uint64()%uint64(hi-lo+1)) }
func (s stream) steps(lo, hi int32) int32  { return lo + int32(s.r.Uint64()%uint64(hi-lo+1)) }
func (s stream) turn() float64             { return float64(s.r.Uint64() % physics.TurnSteps) }
func (s stream) pick(weights []float64) int { // an index, by weight
	total := 0.0
	for _, w := range weights {
		total += w
	}
	u := float64(s.float() * total)
	for i, w := range weights {
		if u < w {
			return i
		}
		u -= w
	}
	return len(weights) - 1
}

// chain is a week's spells as first drawn: each one's regime and nominal
// change, the tick it begins at; and for those a front brings, the ticks its
// line takes to cross the disk's reach, centred on the change.
type chain struct {
	regime []int
	at     []int64
	cross  []int64 // 0: no front
}

// gen makes one week.
type gen struct {
	c       *Config
	s       stream
	ticks   int64 // the world's length
	until   int64
	epochUs float64
	reach   float64 // m: a front's
	islands []Island
	area    float64
}

// Generate makes the week of the world of a seed, its epoch and end µs of
// UTC: drawn again until it passes its checks, at most the catalog's draws,
// then the best drawn.
func Generate(c *Config, seed uint64, epoch, ends int64, islands []Island) *Week {
	g := &gen{c: c, s: newStream(seed), epochUs: float64(epoch), islands: islands, reach: c.Prepared.FrontReach()}
	g.ticks = max(TicksOf(epoch, ends), hourTicks)
	g.until = g.ticks + c.Week.Margin
	for _, is := range islands {
		g.area += is.Area
	}
	var best chain
	bestScore := math.Inf(1)
	var bestFailed []string
	draws := 0
	for draws < max(c.Week.Draws, 1) {
		draws++
		ch := g.chain()
		failed, dev := g.check(&ch)
		score := float64(100*len(failed)) + dev
		if score < bestScore {
			best, bestScore, bestFailed = ch, score, failed
		}
		if len(failed) == 0 {
			break
		}
	}
	w := &Week{Version: Version, Seed: seed, Epoch: epoch, Ends: ends, Until: g.until}
	w.Spells = g.spells(&best)
	w.Systems, w.Report = g.systems(&best, w.Spells)
	w.Report.Draws, w.Report.Passed, w.Report.Failed = draws, len(bestFailed) == 0, bestFailed
	w.Report.Shares = g.shares(&best)
	w.Report.Spells = len(best.regime)
	for _, c := range best.cross {
		if c > 0 {
			w.Report.Fronts++
		}
	}
	return w
}

// frontal reports whether the change into spell i is a front's.
func (g *gen) frontal(ch *chain, i int) bool {
	return i > 0 && (g.c.Regimes[ch.regime[i-1]].Frontal || g.c.Regimes[ch.regime[i]].Frontal)
}

// crossing is the ticks a front at speed v m/s takes to cross the disk's
// reach, rounded to an even number.
func (g *gen) crossing(v float64) int64 {
	t := math.Round(float64(2*g.reach) / v * physics.StepsPerSecond / 2)
	return 2 * int64(t)
}

// chain draws a chain of spells: the first of a regime with no front, by
// the regimes' shares; then by the table, each spell's length drawn in its
// regime's range, until the week is covered. Fronts are then spaced so
// that one is on the disk at a time and no other change comes while it
// crosses: a front faster up to the fastest, and failing that, the spell
// before it longer.
func (g *gen) chain() chain {
	c := g.c
	var ch chain
	var weights []float64
	for _, r := range c.Regimes {
		if r.Frontal {
			weights = append(weights, 0)
		} else {
			weights = append(weights, r.Share)
		}
	}
	r := g.s.pick(weights)
	at := int64(0)
	for at < g.until {
		ch.regime = append(ch.regime, r)
		ch.at = append(ch.at, at)
		ch.cross = append(ch.cross, 0)
		spell := c.Regimes[r].Spell
		// Whole minutes.
		at += g.s.ticks(spell[0]/ticksPerMinute, spell[1]/ticksPerMinute) * ticksPerMinute
		var chances []float64
		for _, n := range c.Regimes[r].Next {
			chances = append(chances, n.Chance)
		}
		r = c.Regimes[r].Next[g.s.pick(chances)].To
	}
	fastest := g.crossing(c.Week.FrontSpeed[1])
	busy := int64(0) // the tick the last change has finished with the disk
	change := int64(c.Prepared.ChangeTicks())
	for i := range ch.regime {
		if i == 0 {
			continue
		}
		if g.frontal(&ch, i) {
			cross := g.crossing(g.s.in(c.Week.FrontSpeed[0], c.Week.FrontSpeed[1]))
			if enter := ch.at[i] - cross/2; enter < busy {
				cross = max(2*((ch.at[i]-busy)/2), fastest)
				if late := busy + cross/2 - ch.at[i]; late > 0 {
					for j := i; j < len(ch.at); j++ {
						ch.at[j] += late
					}
				}
			}
			ch.cross[i] = cross
			busy = ch.at[i] + cross/2
			continue
		}
		if late := busy - ch.at[i]; late > 0 {
			for j := i; j < len(ch.at); j++ {
				ch.at[j] += late
			}
		}
		busy = ch.at[i] + change
	}
	// Spacing the fronts moves later spells on: any now beyond the week's
	// end is never reached.
	n := len(ch.at)
	for n > 1 && ch.at[n-1] >= g.until {
		n--
	}
	ch.regime, ch.at, ch.cross = ch.regime[:n], ch.at[:n], ch.cross[:n]
	return ch
}

// end is the tick spell i of a chain ends at: the next one's change.
func (ch *chain) end(i int, until int64) int64 {
	if i+1 < len(ch.at) {
		return ch.at[i+1]
	}
	return max(until, ch.at[i])
}

// shares is each regime's share of the world's time, from its epoch to its
// end.
func (g *gen) shares(ch *chain) []float64 {
	out := make([]float64, len(g.c.Regimes))
	for i, r := range ch.regime {
		from, to := ch.at[i], min(ch.end(i, g.until), g.ticks)
		if to > from {
			out[r] += float64(to-from) / float64(g.ticks)
		}
	}
	return out
}

// frontOn reports whether a front is on the disk at any tick from a to b.
func (ch *chain) frontOn(a, b int64) bool {
	for i, c := range ch.cross {
		if c > 0 && ch.at[i]-c/2 < b && ch.at[i]+c/2 > a {
			return true
		}
	}
	return false
}

// regimeAt is the spell of a chain whose time a tick is in.
func (ch *chain) spellAt(tick int64) int {
	i, _ := slices.BinarySearch(ch.at, tick+1)
	return max(i-1, 0)
}

// check lists the checks a chain fails, and how far its shares are from
// the catalog's.
func (g *gen) check(ch *chain) (failed []string, deviation float64) {
	c := g.c
	w := &c.Week
	shares := g.shares(ch)
	for i, r := range c.Regimes {
		deviation += math.Abs(shares[i] - r.Share)
	}
	if g.ticks >= w.SharesFrom {
		for i, r := range c.Regimes {
			if math.Abs(shares[i]-r.Share) > w.Shares {
				failed = append(failed, "shares")
				break
			}
		}
	}
	open := min(w.Opening, g.ticks)
	for i := 0; i < len(ch.at) && ch.at[i] < open; i++ {
		if c.Regimes[ch.regime[i]].Frontal {
			failed = append(failed, "opening")
			break
		}
	}
	if ch.frontOn(0, open) {
		failed = append(failed, "opening front")
	}
	from := max(g.ticks-w.Closing, 0)
	if i := ch.spellAt(from); ch.regime[i] != w.ClosingRegime || ch.end(i, g.until) < g.ticks || ch.at[i] > from {
		failed = append(failed, "closing")
	}
	if ch.frontOn(from, g.ticks) {
		failed = append(failed, "closing front")
	}
	fair := false
	for i, r := range ch.regime {
		if !c.Regimes[r].Frontal && min(ch.end(i, g.until), g.ticks)-ch.at[i] >= w.Fair {
			fair = true
		}
	}
	if !fair {
		failed = append(failed, "fair")
	}
	return failed, deviation
}

// spells makes the chain's spells: each one's numbers drawn from its
// regime, its pressure's level, its direction walking from the last's, a
// veer as a front passes and a swing either way otherwise; and for a front,
// whether it is warm, the way it moves, toward where the new spell's wind
// blows within the spread, and its trough.
func (g *gen) spells(ch *chain) []physics.Spell {
	c := g.c
	seed := g.s.seed32()
	dir := int32(g.s.turn())
	change := float64(c.Prepared.ChangeTicks())
	out := make([]physics.Spell, len(ch.regime))
	for i, r := range ch.regime {
		reg := &c.Regimes[r]
		s := physics.Spell{Regime: float64(r)}
		begin := float64(ch.at[i])
		if i > 0 {
			s.Change = change
			if ch.cross[i] > 0 {
				s.Change = float64(ch.cross[i])
				begin -= float64(ch.cross[i] / 2)
			}
		}
		// It drifts from its beginning to the next spell's change.
		s.Begin, s.Start, s.Length = begin, begin, float64(ch.end(i, g.until))-begin
		physics.DrawSpell(c.Prepared, &reg.Wind, uint32(i), seed, &s)
		if i > 0 {
			prev := &out[i-1]
			var t int32
			switch {
			case ch.cross[i] > 0 && g.warm(ch, i):
				t = g.s.steps(c.Week.WarmVeer[0], c.Week.WarmVeer[1])
			case ch.cross[i] > 0:
				t = g.s.steps(c.Week.Veer[0], c.Week.Veer[1])
			default:
				t = g.s.steps(-c.Week.Swing, c.Week.Swing)
			}
			dir = wrap(int32(prev.From) + int32(prev.Drift) + t)
		}
		s.From = float64(dir)
		s.Pressure = math.Round(float64(100 * g.s.in(reg.Pressure[0], reg.Pressure[1])))
		if ch.cross[i] > 0 {
			s.Front = 1
			s.Toward = float64(wrap(dir + turn/2 + g.s.steps(-c.Week.Spread, c.Week.Spread)))
			s.Trough = math.Round(float64(100 * g.s.in(c.Week.FrontTrough[0], c.Week.FrontTrough[1])))
			if g.warm(ch, i) {
				s.Warm = 1
			}
		}
		out[i] = s
	}
	return out
}

// warm reports whether the front into spell i is a warm front: from a
// regime of no front into a frontal one.
func (g *gen) warm(ch *chain, i int) bool {
	return i > 0 && !g.c.Regimes[ch.regime[i-1]].Frontal && g.c.Regimes[ch.regime[i]].Frontal
}

// candidate is a system drawn, before it is given a slot.
type candidate struct {
	r       physics.SystemRecord
	atStart bool
}

// systems draws each spell's systems at its regime's rates, gives each a
// slot, the lowest free from its birth to its end, and leaves out one that
// would be one more than the disk may hold.
func (g *gen) systems(ch *chain, spells []physics.Spell) ([]System, Report) {
	c := g.c
	var cands []candidate
	for i, r := range ch.regime {
		from, to := ch.at[i], ch.end(i, g.until)
		for j := range c.Regimes[r].Systems {
			rate := &c.Regimes[r].Systems[j]
			for range rate.AtStart {
				if s, ok := g.system(rate, from, i, ch, spells); ok {
					cands = append(cands, candidate{s, true})
				}
			}
			if !(rate.PerHour > 0) {
				continue
			}
			// A Poisson process: the gaps between births exponential.
			mean := float64(hourTicks) / rate.PerHour
			at := float64(from)
			for {
				at -= float64(mean * physics.Log(1-g.s.float()))
				if at >= float64(to) {
					break
				}
				if s, ok := g.system(rate, int64(at), i, ch, spells); ok {
					cands = append(cands, candidate{s, false})
				}
			}
		}
		if s, ok := g.lineAhead(i, ch, spells); ok {
			cands = append(cands, candidate{s, false})
		}
	}
	slices.SortStableFunc(cands, func(a, b candidate) int {
		switch {
		case a.r.Born < b.r.Born:
			return -1
		case a.r.Born > b.r.Born:
			return 1
		}
		return 0
	})
	var rep Report
	most := max(c.Week.SystemsMost, 0)
	free := make([]int64, most) // the tick each slot is free from
	for i := range free {
		free[i] = math.MinInt64
	}
	var out []System
	var storms []float64 // the ticks the storms on the disk are gone at
	for _, cd := range cands {
		storm := int(cd.r.Kind) == c.Week.Storms
		if storm {
			storms = slices.DeleteFunc(storms, func(gone float64) bool { return gone <= cd.r.Born })
			if len(storms) >= c.Week.StormsMost {
				rep.Refused++
				continue
			}
		}
		slot := -1
		for k, f := range free {
			if f <= int64(cd.r.Born) {
				slot = k
				break
			}
		}
		if slot < 0 {
			rep.Refused++
			continue
		}
		// A slot is free a keyframe after its system has gone, so that no
		// two systems share one between two keyframes.
		free[slot] = int64(cd.r.Gone) + 2*c.Every
		out = append(out, System{Slot: slot, SystemRecord: cd.r})
		if storm {
			storms = append(storms, cd.r.Gone)
			rep.Storms++
		}
	}
	out = g.fill(ch, spells, out, &rep)
	rep.Systems = len(out)
	rep.Most = mostAtOnce(out)
	return out, rep
}

// fill gives the disk weather wherever it would have none after the
// opening: at each minute with no system within the lip and no front
// crossing it, a system of the fill kind born ten minutes before, in a
// slot free from a keyframe before its birth to a keyframe after its end.
func (g *gen) fill(ch *chain, spells []physics.Spell, out []System, rep *Report) []System {
	c := g.c
	edge, reach := c.Prepared.Edge(), c.Prepared.FrontReach()
	rate := &Rate{Kind: c.Week.Fill, Peak: [2]float64{0, 1}}
	longest := int64(0)
	for _, k := range c.Kinds {
		longest = max(longest, k.Life[1])
	}
	first := 0
	for tick := c.Week.Opening; tick < g.ticks; tick += ticksPerMinute {
		for first < len(out) && int64(out[first].Born) < tick-longest {
			first++
		}
		if g.weatherAt(out[first:], spells, tick, edge, reach) {
			continue
		}
		born := max(tick-10*ticksPerMinute, c.Week.Opening)
		i := ch.spellAt(born)
		r, ok := g.system(rate, born, i, ch, spells)
		if !ok {
			continue
		}
		slot := freeSlot(out, c.Week.SystemsMost, r.Born-float64(2*c.Every), r.Gone+float64(2*c.Every))
		if slot < 0 {
			rep.Refused++
			continue
		}
		at, _ := slices.BinarySearchFunc(out, r.Born, func(s System, born float64) int {
			if s.Born <= born {
				return -1
			}
			return 1
		})
		out = slices.Insert(out, at, System{Slot: slot, SystemRecord: r})
		rep.Filled++
	}
	return out
}

// weatherAt reports whether there is weather on the disk at a tick: a
// system of ss within the lip, or a front of spells crossing it.
func (g *gen) weatherAt(ss []System, spells []physics.Spell, tick int64, edge, reach float64) bool {
	j, _ := slices.BinarySearchFunc(spells, float64(tick), func(s physics.Spell, at float64) int {
		if s.Begin <= at {
			return -1
		}
		return 1
	})
	for _, s := range spells[max(j-2, 0):max(j, 0)] {
		if s.Front != 0 && s.Change > 0 && float64(tick) >= s.Begin && float64(tick) <= s.Begin+s.Change {
			if line := float64(float64(2*reach)*float64(float64(tick)-s.Begin))/s.Change - reach; math.Abs(line) < edge {
				return true
			}
		}
	}
	for i := range ss {
		if ss[i].Born > float64(tick) {
			break
		}
		if k := physics.SystemAt(&ss[i].SystemRecord, float64(tick)); k.On != 0 && OnDisk(&k, edge) {
			return true
		}
	}
	return false
}

// freeSlot is the lowest of the first most slots no system of ss holds
// from one tick to another, or −1.
func freeSlot(ss []System, most int, from, to float64) int {
	used := make([]bool, most)
	for i := range ss {
		if s := &ss[i]; s.Slot < most && s.Born < to && s.Gone > from {
			used[s.Slot] = true
		}
	}
	return slices.Index(used, false)
}

// OnDisk reports whether any part of a system at a keyframe is within the
// lip, edge m from the centre: its spine within its size of it, a line's
// nearest point to the centre.
func OnDisk(s *physics.System, edge float64) bool {
	x, y := float64(s.East*0.25), float64(s.North*0.25)
	if s.Length > 0 {
		// Along its length, which runs across its motion, as far as it
		// reaches.
		ux, uy := physics.SinCos(float64(s.Heading * (2 * math.Pi / physics.TurnSteps)))
		half := float64(0.5 * s.Length)
		along := min(max(-(float64(x*uy) - float64(y*ux)), -half), half)
		x, y = x+float64(along*uy), y-float64(along*ux)
	}
	return math.Sqrt(float64(x*x)+float64(y*y))-s.Size < edge
}

// mostAtOnce is the most systems alive at once.
func mostAtOnce(ss []System) int {
	type edge struct {
		at    float64
		delta int
	}
	var es []edge
	for _, s := range ss {
		es = append(es, edge{s.Born, 1}, edge{s.Gone, -1})
	}
	slices.SortFunc(es, func(a, b edge) int {
		switch {
		case a.at < b.at:
			return -1
		case a.at > b.at:
			return 1
		}
		return a.delta - b.delta
	})
	n, most := 0, 0
	for _, e := range es {
		n += e.delta
		most = max(most, n)
	}
	return most
}

// MeanWind is the mean wind of a week's spells at (x, y) at a tick, m/s:
// the spell in effect and the one before it, as the physics package
// computes it, without the systems.
func MeanWind(p *physics.WeatherPrepared, spells []physics.Spell, tick int64, x, y float64) float64 {
	j, _ := slices.BinarySearchFunc(spells, float64(tick), func(s physics.Spell, at float64) int {
		if s.Begin <= at {
			return -1
		}
		return 1
	})
	j = max(j-1, 0)
	w := physics.Weather{Prepared: p}
	w.Set(spells[max(j-1, 0) : j+1])
	var at physics.WeatherTick
	physics.WeatherAt(&w, &at, float64(tick))
	speed, _ := physics.MeanWindAt(&at, x, y)
	return speed
}

// windOf is spell i's wind at mid-disk, m/s, and the direction it blows
// toward, rad.
func windOf(s *physics.Spell) (speed, toward float64) {
	return float64(s.Speed * physics.SeaSpeedStep), float64(s.From*(2*math.Pi/physics.TurnSteps)) + math.Pi
}

// sunAt is the sun's height at (x, y) at a tick, rad.
func (g *gen) sunAt(tick int64, x, y float64) float64 {
	t := sky.Time(g.c.Sky, g.epochUs, float64(float64(tick)*usPerTick))
	return sky.SunAltitude(g.c.Sky, t, x, y)
}

// sunrise is the first tick from a tick on that the sun is up at (x, y),
// minute by minute, or −1 if it is not up within a day and a bit.
func (g *gen) sunrise(tick int64, x, y float64) int64 {
	for m := range int64(36 * 60) {
		at := tick + m*ticksPerMinute
		if g.sunAt(at, x, y) >= 0 {
			return at
		}
	}
	return -1
}

// system draws a system of a rate's kind born at a tick in spell i, or
// reports it is not born: a kind of the night by day, or of light winds in
// a strong one, a rate's of the day at night or of the night by day, or a
// kind kept quiet in the world's first hours or its closing spell.
func (g *gen) system(rate *Rate, born int64, i int, ch *chain, spells []physics.Spell) (physics.SystemRecord, bool) {
	c := g.c
	k := rate.Kind
	kind := &c.Kinds[k]
	sp := &spells[i]
	speed, toward := windOf(sp)
	edge := c.Prepared.Edge()
	life := g.s.ticks(kind.Life[0], kind.Life[1])
	r := g.draw(k, rate.Peak)
	move := g.s.in(kind.Speed[0], kind.Speed[1])
	if kind.SpeedOfWind {
		move = float64(move * speed)
	}
	r.Speed = math.Round(float64(speedSteps * move))
	heading := toward + float64(g.s.in(-10, 10)*degree)
	w := &c.Week

	gone := born + life
	ux, uy := physics.SinCos(heading)
	var x, y float64 // where it is born
	switch kind.Track {
	case trackWind:
		// Across the disk on a chord, entering at the lip as it matures.
		q := float64(edge * g.s.in(-0.85, 0.85))
		half := math.Sqrt(float64(edge*edge) - float64(q*q))
		ex := -float64(ux*half) + float64(uy*q)
		ey := -float64(uy*half) - float64(ux*q)
		lead := float64(float64(move*physics.Dt) * float64(life/4))
		x, y = ex-float64(ux*lead), ey-float64(uy*lead)
	case trackOuter:
		// On the windward side, round the outer waters the way the wind
		// carries it there.
		rad := g.s.in(w.Outer[0], w.Outer[1])
		a := toward + math.Pi + float64(g.s.in(-40, 40)*degree)
		sa, ca := physics.SinCos(a)
		// The way round: the wind's part along the clockwise tangent.
		sw, cw := physics.SinCos(toward)
		sense := 1.0
		if float64(sw*ca)-float64(cw*sa) < 0 {
			sense = -1
		}
		r.Track, r.Radius, r.Angle, r.Sense = physics.TrackArc, math.Round(float64(quarterMetres*rad)), math.Round(float64(a/(2*math.Pi)*physics.TurnSteps)), sense
		if g.s.chance(kind.TurnsIn) && !(k == w.Storms && g.fair(ch, born, gone)) {
			// It closes on the centre, to within a mile of it by its end.
			in := (rad - nauticalMile) / (float64(life) * physics.Dt)
			r.Inward = math.Round(float64(speedSteps * max(in, 0)))
		}
		x, y = float64(rad*sa), float64(rad*ca)
	default:
		// Inside the disk, evenly over it; by day some over an island's
		// land, by its area.
		rad := float64(0.95*edge) * math.Sqrt(g.s.float())
		a := float64(g.s.float() * 2 * math.Pi)
		sa, ca := physics.SinCos(a)
		x, y = float64(rad*sa), float64(rad*ca)
		if kind.Islands > 0 && g.area > 0 && g.sunAt(born, x, y) > 0 && g.s.chance(kind.Islands) {
			u := float64(g.s.float() * g.area)
			for j := range g.islands {
				is := &g.islands[j]
				if u < is.Area || j == len(g.islands)-1 {
					d := float64(float64(0.25*is.Across) * math.Sqrt(g.s.float()))
					b := float64(g.s.float() * 2 * math.Pi)
					sb, cb := physics.SinCos(b)
					x, y = is.X+float64(d*sb), is.Y+float64(d*cb)
					break
				}
				u -= is.Area
			}
		}
	}
	switch rate.When {
	case whenDay:
		if g.sunAt(born, x, y) < 0 {
			return r, false
		}
	case whenNight:
		if g.sunAt(born, x, y) >= 0 {
			return r, false
		}
	}
	// Light winds only: the spells' mean wind there.
	if kind.CalmBelow > 0 && !(MeanWind(c.Prepared, spells, born, x, y) < kind.CalmBelow) {
		return r, false
	}
	if kind.Night {
		if g.sunAt(born, x, y) >= 0 {
			// By day only within the dawn's minutes after sunrise.
			if g.sunAt(born-kind.Dawn, x, y) >= 0 {
				return r, false
			}
		}
		if up := g.sunrise(born, x, y); up >= 0 {
			if g.sunAt(born, x, y) >= 0 {
				up = born
				for g.sunAt(up-ticksPerMinute, x, y) >= 0 {
					up -= ticksPerMinute
				}
			}
			gone = min(gone, up+g.s.ticks(kind.Lift[0], kind.Lift[1]))
		}
	}
	if kind.GoneAbove > 0 && i+1 < len(spells) {
		// Lifting once the next spell blows too strong there.
		if next := int64(spells[i+1].Begin + spells[i+1].Change); next < gone && MeanWind(c.Prepared, spells, next, x, y) > kind.GoneAbove {
			gone = max(int64(spells[i+1].Begin), born)
		}
	}
	return g.lived(r, k, born, gone, ch, x, y, heading)
}

// draw draws a system of kind k's own numbers: its seed, its size, a
// line's length, its peak wind from between the shares peak of its kind's
// range, its depth, its wobble and its throb.
func (g *gen) draw(k int, peak [2]float64) physics.SystemRecord {
	kind := &g.c.Kinds[k]
	size := g.s.in(kind.Size[0], kind.Size[1])
	r := physics.SystemRecord{Kind: float64(k), Seed: float64(g.s.seed32()), Size: math.Round(size)}
	if kind.Shape == physics.ShapeLine {
		r.Length = math.Round(g.s.in(kind.Length[0], kind.Length[1]))
	}
	switch kind.Shape {
	case physics.ShapeNone:
		r.Peak = math.Round(float64(1000 * g.s.in(kind.Factor[0], kind.Factor[1])))
	default:
		span := kind.Wind[1] - kind.Wind[0]
		lo, hi := kind.Wind[0]+float64(peak[0]*span), kind.Wind[0]+float64(peak[1]*span)
		r.Peak = math.Round(float64(speedSteps * g.s.in(lo, hi)))
		depth := g.s.in(kind.Depth[0], kind.Depth[1])
		r.Depth = math.Round(float64(100 * depth))
	}
	w := &g.c.Week
	r.Wobble = math.Round(float64(quarterMetres * float64(w.Wobble*g.s.in(0.5, 1))))
	for j := range 2 {
		r.WobblePeriod[j] = float64(g.s.ticks(w.WobblePeriod[0], w.WobblePeriod[1]))
		r.WobblePhase[j] = g.s.turn()
	}
	r.Throb = math.Round(float64(strengthOne * float64(w.StrengthWobble*g.s.in(0.5, 1))))
	r.ThrobPeriod = float64(g.s.ticks(w.WobblePeriod[0], w.WobblePeriod[1]))
	r.ThrobPhase = g.s.turn()
	return r
}

// lived gives a system drawn its life, from born to gone, and on a line
// its place then, (x, y), and its heading, rad; or reports it is not born:
// too short a life, or a kind kept quiet then.
func (g *gen) lived(r physics.SystemRecord, k int, born, gone int64, ch *chain, x, y, heading float64) (physics.SystemRecord, bool) {
	if gone-born < 4*ticksPerMinute || g.quiet(k, born, gone, ch) {
		return r, false
	}
	r.Born, r.Gone = float64(born), float64(gone)
	quarter := (gone - born) / 4
	r.Mature, r.Decays = float64(born+quarter), float64(gone-quarter)
	if r.Track == physics.TrackLine {
		r.East, r.North = math.Round(float64(quarterMetres*x)), math.Round(float64(quarterMetres*y))
		r.Heading = float64(wrap(int32(math.Round(float64(heading / (2 * math.Pi) * physics.TurnSteps)))))
	}
	return r, true
}

// quiet reports whether a system of kind k alive from born to gone would
// break the quiet of the world's first hours or of its closing spell.
func (g *gen) quiet(k int, born, gone int64, ch *chain) bool {
	w := &g.c.Week
	if k >= len(w.Quiet) || !w.Quiet[k] {
		return false
	}
	closing := ch.at[ch.spellAt(max(g.ticks-w.Closing, 0))]
	return born < w.QuietTicks || gone > closing
}

// fair reports whether a spell of a regime of no front blows at any time
// from one tick to another.
func (g *gen) fair(ch *chain, from, to int64) bool {
	for i := ch.spellAt(from); i < len(ch.at) && ch.at[i] < to; i++ {
		if !g.c.Regimes[ch.regime[i]].Frontal {
			return true
		}
	}
	return false
}

// lineAhead is the line born ahead of the cold front into spell i, if the
// front is one into the week's regime for it: born as the front nears the
// centre, its lineAhead ahead of its line, anywhere along it within the
// disk, and moving with it.
func (g *gen) lineAhead(i int, ch *chain, spells []physics.Spell) (physics.SystemRecord, bool) {
	c := g.c
	w := &c.Week
	sp := &spells[i]
	if ch.cross[i] == 0 || g.warm(ch, i) || ch.regime[i] != w.LineInto || w.LineKind < 0 || !(sp.Change > 0) {
		return physics.SystemRecord{}, false
	}
	kind := &c.Kinds[w.LineKind]
	life := g.s.ticks(kind.Life[0], kind.Life[1])
	r := g.draw(w.LineKind, [2]float64{0, 1})
	perTick := float64(2*g.reach) / sp.Change // m a tick
	born := int64(sp.Begin) + int64(float64(g.s.in(0.25, 0.5)*sp.Change))
	toward := float64(sp.Toward * (2 * math.Pi / physics.TurnSteps))
	ux, uy := physics.SinCos(toward)
	line := float64(perTick*float64(born-int64(sp.Begin))) - g.reach
	ahead := g.s.in(w.LineAhead[0], w.LineAhead[1])
	along := float64(c.Prepared.Edge() * g.s.in(-0.5, 0.5))
	d := line + ahead
	x, y := float64(d*ux)+float64(along*uy), float64(d*uy)-float64(along*ux)
	r.Speed = math.Round(float64(speedSteps * float64(perTick*physics.StepsPerSecond)))
	return g.lived(r, w.LineKind, born, born+life, ch, x, y, toward)
}
