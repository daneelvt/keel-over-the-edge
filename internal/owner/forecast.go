// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"encoding/base64"
	"net/http"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The forecast on the world page, set beside the truth for the owner, who
// alone may see both: the issue in force at the tick shown, each system it
// knows with its track over the forecast's reach, made from its records as
// a phone makes it, each front's line with whether it is warm or cold, the
// spells, and the gale warning with the water it covers at each step; and
// every gale warning the world has had. The forecast is the truth, so its
// tracks lie on the truth's own. The issue in force is the issuer's, as the
// players were sent it, while it is near the latest; one further off,
// dragged to on the week's strip, is made here from the week, so the strip
// never sets the issuer remaking what it sends.

// Forecasts are the world's forecast as issued (internal/forecast's
// Issuer): the latest issue, and the issue at any boundary of its every,
// with the developer's weathers and systems, made if it is not kept.
type Forecasts interface {
	Latest() *forecast.Issue
	Issue(tick int64, ws []bus.Weather, ss []bus.System) *forecast.Issue
}

// issuerReach is how many issues either side of the latest the issuer is
// asked for, an hour's: well within those it keeps, so that asking never
// sets it dropping the latest's neighbours.
const issuerReach = 6

// trackEvery is how many ticks apart a forecast system's track's points
// are: a minute.
const trackEvery = 60 * physics.StepsPerSecond

// forecastPage is forecast.json.
type forecastPage struct {
	At    int64 `json:"at"`    // the tick shown
	Issue int64 `json:"issue"` // the issue in force at it
	// Issued says the issue is the issuer's, as the players were sent it;
	// otherwise it was made here from the week.
	Issued bool    `json:"issued"`
	Step   int64   `json:"step"`  // ticks between steps
	Steps  int     `json:"steps"` // the issue's own first
	Until  int64   `json:"until"` // the last tick it knows the systems to
	Every  int64   `json:"every"` // ticks between a track's points
	Lip    float64 `json:"lip"`
	// Reach is how far either side of the centre a front's line crosses, m.
	Reach   float64              `json:"reach"`
	Systems []forecastSystemJSON `json:"systems"`
	Fronts  []forecastFrontJSON  `json:"fronts"`
	Spells  []forecastSpellJSON  `json:"spells"`
	Gale    *forecastGaleJSON    `json:"gale"` // null for none in force
	// The gale grid: GaleSide points a side, GaleGrid m apart, about the
	// centre; point (i, j) is at ((i − c) GaleGrid, (j − c) GaleGrid), c =
	// (GaleSide − 1) / 2, i east and j north.
	GaleGrid float64 `json:"galeGrid"`
	GaleSide int     `json:"galeSide"`
}

// forecastSystemJSON is a system as the forecast knows it, from its record.
type forecastSystemJSON struct {
	Slot int    `json:"slot"`
	Kind int    `json:"kind"`
	ID   string `json:"id"`
	Seed uint32 `json:"seed"`
	// Born and Gone are the ticks it is born and gone at.
	Born int64 `json:"born"`
	Gone int64 `json:"gone"`
	// Size is its radius, a line's half its depth along its motion, and
	// Length a line's length across it, 0 for any other shape, m.
	Size   float64 `json:"size"`
	Length float64 `json:"length"`
	// From is the tick of its track's first point; Track where it is at it
	// and each Every ticks after while it lives within the forecast's
	// reach: m east and north, its strength, 0 to 1, and the degrees it
	// moves toward.
	From  int64        `json:"from"`
	Track [][4]float64 `json:"track"`
}

// forecastFrontJSON is a front the forecast knows: the way it moves, the
// tick its line enters the disk's reach and the ticks it takes to cross
// it, and whether it is a warm front.
type forecastFrontJSON struct {
	Toward float64 `json:"toward"` // degrees
	Begin  int64   `json:"begin"`
	Cross  int64   `json:"cross"`
	Warm   bool    `json:"warm"`
}

// forecastSpellJSON is a spell as the forecast names it.
type forecastSpellJSON struct {
	Begin  int64   `json:"begin"`
	Regime int     `json:"regime"`
	ID     string  `json:"id"`
	From   float64 `json:"from"`  // degrees
	Knots  float64 `json:"knots"` // at mid-disk
	Front  bool    `json:"front"`
	Warm   bool    `json:"warm"`
	Shifts float64 `json:"shifts"` // degrees its shifts turn its wind either way together
}

// forecastGaleJSON is the gale warning in force.
type forecastGaleJSON struct {
	Key   int64  `json:"key"` // the issue it came into force at
	Force int    `json:"force"`
	Words string `json:"words"`
	Place string `json:"place"` // the charted island or place it is told from; "" for none
	First int    `json:"first"` // its first step
	// Where it blows strongest over the steps, its mean wind and typical
	// strongest gust there, knots, and the degrees it first blows from.
	East  float64 `json:"east"`
	North float64 `json:"north"`
	Mean  float64 `json:"mean"`
	Gust  float64 `json:"gust"`
	From  float64 `json:"from"`
	// Areas are each step's points of the grid in a gale, a bit a point,
	// point n the bit n mod 8 of byte n / 8, in base64; "" for none.
	Areas []string `json:"areas"`
}

// forecastCache is what the forecast's routes keep for the world: the gale
// grid's water, the gale warnings worked out once for its past and
// carried forward as the world sails on, and the busy weather's tally of
// its week.
type forecastCache struct {
	waterOnce sync.Once
	water     []uint8
	gales     galeLog
	busy      busyCache
}

// galeWater is the gale grid's water, from the land sailed: all water with
// none.
func (o *Owner) galeWater(p *physics.WeatherPrepared) []uint8 {
	c := &o.fc
	c.waterOnce.Do(func() {
		c.water = make([]uint8, int(p.GaleSide())*int(p.GaleSide()))
		physics.GaleWater(p, o.cfg.Ground, c.water)
	})
	return c.water
}

// worldEnd is the world's last tick as its week was made for, 0 for none:
// a forecast made here stops there, as the issuer's does.
func worldEnd(tl *weather.Timeline) int64 {
	w := tl.Week()
	if w == nil || w.Ends == 0 {
		return 0
	}
	return weather.TicksOf(w.Epoch, w.Ends) + tl.Origin()
}

// shownIssue is the issue in force at a tick: the issuer's near the
// latest, otherwise made here from the timeline with the developer's
// weathers and systems, its gale scan left to the caller.
func (o *Owner) shownIssue(tl *weather.Timeline, tick int64, ws []bus.Weather, ss []bus.System) (x *forecast.Issue, issued bool) {
	issue := tl.IssueAt(tick)
	if fs := o.cfg.Forecasts; fs != nil {
		if l := fs.Latest(); l != nil {
			if l.Tick == issue {
				return l, true
			}
			if d := issue - l.Tick; max(d, -d) <= issuerReach*tl.Prepared().ForecastEvery() {
				return fs.Issue(issue, ws, ss), true
			}
		}
	}
	x = &forecast.Issue{Tick: issue, Key: issue}
	tl.Forecast(issue, ws, ss, worldEnd(tl), &x.Forecast)
	return x, false
}

// galeAreas is a forecast's gale scan, as physics.GaleScan makes it, with
// each step's points in a gale kept: a bit a point, point n the bit n mod
// 8 of byte n / 8.
func (o *Owner) galeAreas(p *physics.WeatherPrepared, f *physics.Forecast) (physics.Gales, [][]byte) {
	water := o.galeWater(p)
	on := make([]uint8, len(water))
	w := &physics.Weather{Prepared: p, Synoptic: true}
	t := new(physics.WeatherTick)
	var g physics.Gales
	areas := make([][]byte, int(f.Head.Steps))
	for k := range areas {
		// As the scan writes it, the product apart from the sum: Go would
		// fuse them otherwise, and the tick be another.
		tick := f.Head.Issue + float64(float64(k)*f.Head.Step)
		physics.ForecastAt(w, f, tick)
		physics.WeatherAt(w, t, tick)
		g.Steps[k] = physics.GaleGrid(p, t, water, on)
		if g.Steps[k].Points > 0 {
			bits := make([]byte, (len(on)+7)/8)
			for n, v := range on {
				if v != 0 {
					bits[n/8] |= 1 << (n % 8)
				}
			}
			areas[k] = bits
		}
	}
	return g, areas
}

// forecastJSON serves forecast.json: the issue in force at a tick, ?at= or
// now.
func (o *Owner) forecastJSON(w http.ResponseWriter, r *http.Request) {
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
	p := tl.Prepared()
	x, issued := o.shownIssue(tl, tick, ws, ss)
	var areas [][]byte
	if issued {
		if x.Gale != nil {
			_, areas = o.galeAreas(p, &x.Forecast)
		}
	} else {
		x.Gales, areas = o.galeAreas(p, &x.Forecast)
		if g, ok := weather.GaleOf(&x.Forecast, &x.Gales); ok {
			x.Gale = &g
			x.Key = o.fc.gales.keyOf(o, tl, x.Tick)
		}
	}
	writeJSON(w, o.forecastPage(tl, tick, x, issued, areas))
}

func (o *Owner) forecastPage(tl *weather.Timeline, tick int64, x *forecast.Issue, issued bool, areas [][]byte) *forecastPage {
	p := tl.Prepared()
	f := &x.Forecast
	n := int(f.Head.Steps)
	page := &forecastPage{
		At: tick, Issue: x.Tick, Issued: issued, Step: int64(f.Head.Step), Steps: n, Until: int64(f.Head.Until), Every: trackEvery,
		Lip: round2(p.Edge()), Reach: round2(p.FrontReach()), GaleGrid: round2(p.GaleGrid()), GaleSide: int(p.GaleSide()),
		Systems: []forecastSystemJSON{}, Fronts: []forecastFrontJSON{}, Spells: []forecastSpellJSON{},
	}
	origin := f.Head.Origin
	for i := range int(f.Head.NSystems) {
		r := &f.Systems[i]
		j := forecastSystemJSON{
			Slot: int(f.Head.Slots[i]), Kind: int(r.Kind), Seed: uint32(r.Seed), Born: int64(r.Born + origin), Gone: int64(r.Gone + origin),
			Size: r.Size, Length: r.Length, Track: [][4]float64{},
		}
		if k := int(r.Kind); k >= 0 && k < len(o.cfg.SystemKinds) {
			j.ID = o.cfg.SystemKinds[k]
		}
		// From the first minute after the issue it lives at to the last
		// the forecast knows.
		first := x.Tick
		if born := j.Born; born > first {
			first += (born - first + trackEvery - 1) / trackEvery * trackEvery
		}
		for at := first; at <= page.Until && at < j.Gone; at += trackEvery {
			s := physics.SystemAt(r, float64(at)-origin)
			if s.On == 0 {
				continue
			}
			if len(j.Track) == 0 {
				j.From = at
			}
			j.Track = append(j.Track, [4]float64{s.East / 4, s.North / 4, round3(s.Strength / 4096), round2(s.Heading * 360 / physics.TurnSteps)})
		}
		if len(j.Track) > 0 {
			page.Systems = append(page.Systems, j)
		}
	}
	for i := range int(f.Head.NSpells) {
		s := &f.Spells[i]
		page.Spells = append(page.Spells, o.forecastSpell(s, f.Head.Shifts[i]))
		if s.Front == 0 || !(s.Change > 0) {
			continue
		}
		page.Fronts = append(page.Fronts, forecastFrontJSON{
			Toward: round2(s.Toward * 360 / physics.TurnSteps), Begin: int64(s.Begin), Cross: int64(s.Change), Warm: s.Warm != 0,
		})
	}
	if g := x.Gale; g != nil {
		warn := o.warningOf(tl, x, issued, nil)
		gj := &forecastGaleJSON{
			Key: x.Key, Force: int(g.Force), Words: weather.WarningText(&warn, &o.cfg.Words), Place: warn.Place, First: int(g.First),
			East: round2(g.East), North: round2(g.North), Mean: round2(g.Mean / knot), Gust: round2(g.Gust / knot), From: round2(degrees(g.From)),
			Areas: make([]string, n),
		}
		for k := range min(n, len(areas)) {
			if areas[k] != nil {
				gj.Areas[k] = base64.StdEncoding.EncodeToString(areas[k])
			}
		}
		page.Gale = gj
	}
	return page
}

// forecastSpell is a spell of the forecast as the page shows it.
func (o *Owner) forecastSpell(s *physics.Spell, shifts float64) forecastSpellJSON {
	j := forecastSpellJSON{
		Begin: int64(s.Begin), Regime: int(s.Regime), From: round2(s.From * 360 / physics.TurnSteps),
		Knots: round2(s.Speed * physics.SeaSpeedStep / knot), Front: s.Front != 0, Warm: s.Warm != 0,
		Shifts: round2(shifts * 360 / physics.TurnSteps),
	}
	if r := j.Regime; r >= 0 && r < len(o.cfg.Regimes) {
		j.ID = o.cfg.Regimes[r]
	}
	return j
}

// warningOf is an issue's gale warning in the words' terms: told from the
// charted island or place the issuer named, for one it issued; for one
// made here, from the nearest charted now, found by nearest if not nil.
func (o *Owner) warningOf(tl *weather.Timeline, x *forecast.Issue, issued bool, nearest func(east, north float64) chartedPoint) weather.Warning {
	g := x.Gale
	w := weather.Warning{
		From: g.From, Force: int(g.Force), East: g.East, North: g.North,
		First: float64(int64(g.First)*tl.Prepared().ForecastStep()) / (60 * physics.StepsPerSecond),
	}
	var c chartedPoint
	switch {
	case issued:
		c = o.chartedPointOf(x.Place)
	case nearest != nil:
		c = nearest(g.East, g.North)
	default:
		c = nearestOf(o.chartedPoints())(g.East, g.North)
	}
	w.Place, w.PlaceEast, w.PlaceNorth = c.name, c.east, c.north
	return w
}

// chartedPoint is a charted island or place a gale warning is told from:
// its name and where it is; no name for none.
type chartedPoint struct {
	name        string
	east, north float64
}

// chartedPointOf is the island or place the issuer named.
func (o *Owner) chartedPointOf(p forecast.Place) chartedPoint {
	b := o.cfg.Bundle
	if b == nil {
		return chartedPoint{}
	}
	switch p.Subject {
	case pb.ChartSubject_CHART_SUBJECT_ISLAND:
		for i := range b.Islands {
			if is := &b.Islands[i]; uint32(is.Number) == p.Number {
				return chartedPoint{is.Name, is.X, is.Y}
			}
		}
	case pb.ChartSubject_CHART_SUBJECT_PLACE:
		for i := range b.Places {
			if pl := &b.Places[i]; uint32(pl.Number) == p.Number {
				return chartedPoint{pl.Name, pl.X, pl.Y}
			}
		}
	}
	return chartedPoint{}
}

// chartedPoints are the islands and places charted now, named: those a
// gale warning may be told from.
func (o *Owner) chartedPoints() []chartedPoint {
	b := o.cfg.Bundle
	if b == nil || o.cfg.Charted == nil {
		return nil
	}
	var out []chartedPoint
	for _, c := range o.cfg.Charted() {
		var p chartedPoint
		switch c.Subject {
		case "island":
			for i := range b.Islands {
				if is := &b.Islands[i]; is.Number == c.Number {
					p = chartedPoint{is.Name, is.X, is.Y}
				}
			}
		case "place":
			for i := range b.Places {
				if pl := &b.Places[i]; pl.Number == c.Number {
					p = chartedPoint{pl.Name, pl.X, pl.Y}
				}
			}
		}
		if p.name != "" {
			out = append(out, p)
		}
	}
	return out
}

// nearestOf finds, of points, the nearest to a point, as the issuer does;
// none of none.
func nearestOf(points []chartedPoint) func(east, north float64) chartedPoint {
	return func(east, north float64) chartedPoint {
		var best chartedPoint
		d := -1.0
		for _, p := range points {
			dx, dy := p.east-east, p.north-north
			if x := dx*dx + dy*dy; d < 0 || x < d {
				best, d = p, x
			}
		}
		return best
	}
}
