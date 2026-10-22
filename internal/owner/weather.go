// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"math"
	"net/http"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The world page is the one place the weather to come may be seen, on the
// internal listener alone: the world's week, its spells, fronts and storms,
// and at any tick of it, its systems where they are, with their true tracks
// for the hour after, the front's line, and the pressure for the isobars.

// weatherJSON's grids and tracks.
const (
	// pressureStep is the pressure grid's spacing, m.
	pressureStep = 463
	// trackStep and trackLength are a system's track's points' spacing and
	// how far ahead it reaches, s.
	trackStep   = 300
	trackLength = 3600
)

// weatherPage is weather.json.
type weatherPage struct {
	Now            int64               `json:"now"` // the world's tick now; 0 for a world not begun
	At             int64               `json:"at"`  // the tick shown
	TicksPerSecond int                 `json:"ticksPerSecond"`
	Epoch          int64               `json:"epoch"` // the world's tick 0, ms of UTC
	Until          int64               `json:"until"` // the tick the week reaches to
	Ends           int64               `json:"ends"`  // the tick the world ends at, as its week was made for
	Every          int64               `json:"every"` // ticks between keyframes
	Lip            float64             `json:"lip"`   // m
	MainPort       [2]float64          `json:"mainPort"`
	Regimes        []string            `json:"regimes"`
	Kinds          []weatherKind       `json:"kinds"`
	Spells         []weatherSpell      `json:"spells"`
	Storms         []int64             `json:"storms"` // the ticks the week's lows are born at
	Spell          *weatherSpell       `json:"spell"`  // in effect at the tick shown
	Next           *weatherSpell       `json:"next"`   // the next to begin after it
	Systems        []weatherSystemJSON `json:"systems"`
	Front          *weatherFront       `json:"front"`
	Pressure       weatherGrid         `json:"pressure"`
}

type weatherKind struct {
	ID    string `json:"id"`
	Shape string `json:"shape"` // dome, low or none
}

type weatherSpell struct {
	Begin    int64   `json:"begin"`
	End      int64   `json:"end"`
	Regime   int     `json:"regime"`
	From     float64 `json:"from"`  // degrees
	Knots    float64 `json:"knots"` // at mid-disk
	Pressure float64 `json:"pressure"`
	Front    bool    `json:"front"`
	Toward   float64 `json:"toward"` // degrees, a front's
	Cross    int64   `json:"cross"`  // ticks a front's line takes to cross the disk's reach
	Held     bool    `json:"held"`   // a developer's
}

type weatherSystemJSON struct {
	Slot      int          `json:"slot"`
	Kind      int          `json:"kind"`
	East      float64      `json:"east"`
	North     float64      `json:"north"`
	Size      float64      `json:"size"`     // m
	Strength  float64      `json:"strength"` // its life and throb, 1 at full
	Stage     int          `json:"stage"`    // growing, mature, decaying
	Heading   float64      `json:"heading"`  // degrees
	Knots     float64      `json:"knots"`
	Born      int64        `json:"born"`
	Gone      int64        `json:"gone"`
	Developer bool         `json:"developer"`
	Track     [][2]float64 `json:"track"` // where it truly is every trackStep s for the hour after, while it lives
	Swell     float64      `json:"swell"` // the significant height of its swell at its edge at full strength, m; 0 for none
}

type weatherFront struct {
	Toward    float64 `json:"toward"` // degrees: the way it moves
	Line      float64 `json:"line"`   // m from the centre along the way it moves
	Knots     float64 `json:"knots"`
	Depth     float64 `json:"depth"` // hPa
	Enters    int64   `json:"enters"`
	Leaves    int64   `json:"leaves"`
	PortRoyal int64   `json:"portRoyal"` // the tick its line passes the main port
}

type weatherGrid struct {
	Step   float64    `json:"step"`
	Side   int        `json:"side"`
	Values []*float64 `json:"values"` // hPa, row by row from the north-west; null beyond the lip
}

// weatherState is what the page's weather is computed from: the timeline,
// the tick now, and the developer's weathers and systems as they stand.
func (o *Owner) weatherState() (tl *weather.Timeline, now int64, ws []bus.Weather, ss []bus.System) {
	tl = o.cfg.Timeline
	if o.cfg.Frames == nil {
		return tl, 0, nil, nil
	}
	f := o.cfg.Frames.Acquire()
	now, ws, ss = f.Tick, append([]bus.Weather(nil), f.Weathers...), append([]bus.System(nil), f.Systems...)
	f.Release()
	return tl, now, ws, ss
}

// at is the tick a request asks about: its at, or now.
func at(r *http.Request, now int64) (int64, bool) {
	s := r.URL.Query().Get("at")
	if s == "" {
		return now, true
	}
	t, err := strconv.ParseInt(s, 10, 64)
	return t, err == nil
}

// physicsAt is the timeline's weather at a tick, ready for the wind and the
// pressure at points.
func physicsAt(tl *weather.Timeline, tick int64, ws []bus.Weather, ss []bus.System) *physics.WeatherTick {
	w := &physics.Weather{Prepared: tl.Prepared()}
	var sp [physics.WeatherSpells]physics.Spell
	w.Set(sp[:tl.Spells(tick, ws, &sp)])
	var keys [bus.KeyFrames]physics.Keyframe
	tl.Keyframes(tick, ss, &keys)
	w.SetKeys(keys[:2])
	var t physics.WeatherTick
	physics.WeatherAt(w, &t, float64(tick))
	return &t
}

// weather serves weather.json: the world's week, and its weather at a
// tick, ?at= or now.
func (o *Owner) weather(w http.ResponseWriter, r *http.Request) {
	tl, now, ws, ss := o.weatherState()
	if tl == nil || tl.Week() == nil {
		http.Error(w, "the world has no week of weather yet", http.StatusNotFound)
		return
	}
	tick, ok := at(r, now)
	if !ok {
		http.Error(w, "at is a tick", http.StatusBadRequest)
		return
	}
	writeJSON(w, o.weatherPage(tl, now, tick, ws, ss))
}

func (o *Owner) weatherPage(tl *weather.Timeline, now, tick int64, ws []bus.Weather, ss []bus.System) *weatherPage {
	week := tl.Week()
	cfg := tl.Config()
	origin := tl.Origin()
	p := &weatherPage{
		Now: now, At: tick, TicksPerSecond: physics.StepsPerSecond, Epoch: o.cfg.World.Epoch.UnixMilli(),
		Until: week.Until + origin, Ends: weather.TicksOf(week.Epoch, week.Ends) + origin, Every: tl.Every(),
		Lip: tl.Prepared().Edge(), Regimes: o.cfg.Regimes,
		// Lists as JSON's arrays, empty or not: the page reads them so.
		Kinds: []weatherKind{}, Spells: []weatherSpell{}, Storms: []int64{}, Systems: []weatherSystemJSON{},
	}
	if p.Regimes == nil {
		p.Regimes = []string{}
	}
	if b := o.cfg.Bundle; b != nil && len(b.Islands) > 0 {
		port := b.MainPort()
		p.MainPort = [2]float64{round2(port.X), round2(port.Y)}
	}
	shapes := map[float64]string{physics.ShapeNone: "none", physics.ShapeDome: "dome", physics.ShapeLow: "low"}
	for i, k := range cfg.Kinds {
		id := ""
		if i < len(o.cfg.SystemKinds) {
			id = o.cfg.SystemKinds[i]
		}
		p.Kinds = append(p.Kinds, weatherKind{ID: id, Shape: shapes[k.Shape]})
	}
	for i := range week.Spells {
		s := week.Spells[i]
		end := week.Until
		if i+1 < len(week.Spells) {
			end = int64(week.Spells[i+1].Begin)
		}
		p.Spells = append(p.Spells, spellJSON(&s, origin, end+origin, false))
	}
	for _, s := range week.Systems {
		if int(s.Kind) < len(cfg.Kinds) && cfg.Kinds[int(s.Kind)].Shape == physics.ShapeLow {
			p.Storms = append(p.Storms, int64(s.Born)+origin)
		}
	}
	// The spell in effect at the tick, a developer's if one is, and the
	// next.
	cur := tl.Effective(tick, ws)
	held := cur.Still != 0
	sj := spellJSON(&cur, 0, 0, held)
	p.Spell = &sj
	var sp [physics.WeatherSpells]physics.Spell
	n := tl.Spells(tick, ws, &sp)
	for _, s := range sp[:n] {
		if s.Begin > float64(tick) {
			nj := spellJSON(&s, 0, 0, s.Still != 0)
			p.Next = &nj
			break
		}
	}
	if p.Next == nil {
		for _, s := range p.Spells {
			if s.Begin > tick {
				nj := s
				p.Next = &nj
				break
			}
		}
	}
	// The systems alive at the tick, with their tracks.
	for _, s := range week.Systems {
		local := float64(tick - origin)
		if s.Born <= local && local < s.Gone {
			p.Systems = append(p.Systems, systemJSON(o.cfg.Weather, s.Slot, &s.SystemRecord, local, origin, false))
		}
	}
	for _, s := range ss {
		r := tl.DeveloperRecord(s)
		if r.Born <= float64(tick) && float64(tick) < r.Gone {
			p.Systems = append(p.Systems, systemJSON(o.cfg.Weather, physics.WeekSystems+int(s.Slot), &r, float64(tick), 0, true))
		}
	}
	// The front crossing at the tick.
	for i := n - 1; i >= 0; i-- {
		s := &sp[i]
		if s.Front == 0 || s.Begin > float64(tick) || float64(tick) >= s.Begin+s.Change {
			continue
		}
		reach := tl.Prepared().FrontReach()
		speed := 2 * reach / s.Change // m a tick
		toward := s.Toward * 2 * math.Pi / physics.TurnSteps
		fe, fn := math.Sin(toward), math.Cos(toward)
		f := &weatherFront{
			Toward: round2(s.Toward * 360 / physics.TurnSteps), Line: round2(speed*(float64(tick)-s.Begin) - reach),
			Knots: round2(speed * physics.StepsPerSecond / knot), Depth: s.Trough / 100,
			Enters: int64(s.Begin), Leaves: int64(s.Begin + s.Change),
		}
		f.PortRoyal = int64(s.Begin + (p.MainPort[0]*fe+p.MainPort[1]*fn+reach)/speed)
		p.Front = f
		break
	}
	// The pressure, for the isobars.
	t := physicsAt(tl, tick, ws, ss)
	lip := tl.Prepared().Edge()
	side := 2*int(math.Ceil(lip/pressureStep)) + 1
	half := float64(side-1) / 2 * pressureStep
	p.Pressure = weatherGrid{Step: pressureStep, Side: side, Values: make([]*float64, 0, side*side)}
	for j := range side {
		y := half - float64(j)*pressureStep
		for i := range side {
			x := -half + float64(i)*pressureStep
			if math.Hypot(x, y) > lip+pressureStep {
				p.Pressure.Values = append(p.Pressure.Values, nil)
				continue
			}
			v := round2(physics.PressureAt(t, x, y))
			p.Pressure.Values = append(p.Pressure.Values, &v)
		}
	}
	return p
}

// spellJSON is a spell as the page shows it, its ticks moved by origin.
func spellJSON(s *physics.Spell, origin, end int64, held bool) weatherSpell {
	return weatherSpell{
		Begin: int64(s.Begin) + origin, End: end, Regime: int(s.Regime), From: round2(s.From * 360 / physics.TurnSteps),
		Knots: round2(s.Speed * physics.SeaSpeedStep / knot), Pressure: s.Pressure / 100, Front: s.Front != 0,
		Toward: round2(s.Toward * 360 / physics.TurnSteps), Cross: int64(s.Change), Held: held,
	}
}

// systemJSON is a system as the page shows it at a tick of its record's,
// local, its ticks moved by origin, with its true track for the hour after.
func systemJSON(p *physics.WeatherPrepared, slot int, r *physics.SystemRecord, local float64, origin int64, developer bool) weatherSystemJSON {
	k := physics.SystemAt(r, local)
	s := weatherSystemJSON{
		Slot: slot, Kind: int(k.Kind), East: k.East / 4, North: k.North / 4, Size: k.Size, Strength: round2(k.Strength / 4096),
		Stage: int(k.Stage), Heading: round2(k.Heading * 360 / physics.TurnSteps), Knots: round2(k.Speed * physics.SeaSpeedStep / knot),
		Born: int64(r.Born) + origin, Gone: int64(r.Gone) + origin, Developer: developer, Track: [][2]float64{},
	}
	if p != nil {
		s.Swell = round2(physics.SwellHeight(p, r))
	}
	for dt := 0.0; dt <= trackLength; dt += trackStep {
		at := local + dt*physics.StepsPerSecond
		if at >= r.Gone {
			break
		}
		t := physics.SystemAt(r, at)
		s.Track = append(s.Track, [2]float64{t.East / 4, t.North / 4})
	}
	return s
}

// pressurePage is pressure.json.
type pressurePage struct {
	At       int64   `json:"at"`
	HPa      float64 `json:"hPa"`
	Change   float64 `json:"change"`   // hPa over the quarter of an hour before
	Tendency string  `json:"tendency"` // the barometer's words
}

// pressure serves pressure.json: the pressure at a point, ?east= and
// ?north= in m, at a tick, ?at= or now, and the barometer's tendency there.
func (o *Owner) pressure(w http.ResponseWriter, r *http.Request) {
	tl, now, ws, ss := o.weatherState()
	if tl == nil {
		http.Error(w, "the world has no weather yet", http.StatusNotFound)
		return
	}
	tick, ok := at(r, now)
	east, err1 := strconv.ParseFloat(r.URL.Query().Get("east"), 64)
	north, err2 := strconv.ParseFloat(r.URL.Query().Get("north"), 64)
	if !ok || err1 != nil || err2 != nil || math.IsNaN(east) || math.IsNaN(north) {
		http.Error(w, "east and north are metres, at a tick", http.StatusBadRequest)
		return
	}
	minute := int64(60 * physics.StepsPerSecond)
	p := func(t int64) float64 { return physics.PressureAt(physicsAt(tl, t, ws, ss), east, north) }
	nowP, before, quarter := p(tick), p(tick-5*minute), p(tick-15*minute)
	words, turned := physics.Tendency(nowP, before, quarter)
	writeJSON(w, pressurePage{At: tick, HPa: round2(nowP), Change: round2(nowP - quarter), Tendency: weather.TendencyWords(words, turned)})
}
