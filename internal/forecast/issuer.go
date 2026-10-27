// SPDX-License-Identifier: AGPL-3.0-only

// Package forecast issues the world's forecast: at each boundary of its
// every minutes of world time from the epoch, off the tick, from the
// world's timeline and the developer's weathers and systems as they stand
// (weather.Timeline.Forecast), with its gale scan over the water and the
// gale warning in force; and at each boundary of five minutes what has
// been, for a client just come. The edge sends both (edge.ForecastSource).
// Each of the week's storms is told once as it forms, for the news.
package forecast

import (
	"context"
	"log/slog"
	"math"
	"sync"
	"sync/atomic"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// keep is how many issues are kept: two hours and more, the past's issue
// among them.
const keep = 16

// lookBack is how many issues back a warning in force is followed to the
// issue it came into force at: a day.
const lookBack = 144

// Place is a charted island's or place's subject and number, for a gale
// warning's where; Subject unspecified for none.
type Place struct {
	Subject pb.ChartSubject
	Number  uint32
}

// Config is what an Issuer issues from.
type Config struct {
	Timeline *weather.Timeline
	// Ground, if not nil, is the world's land, which a gale warning's grid
	// leaves out.
	Ground *physics.Ground
	// Nearest, if not nil, is the nearest charted island or place to a
	// point, m east and north of the centre.
	Nearest func(east, north float64) Place
	// Formed, if not nil, is told of each of the week's storms as it
	// forms, once a storm in a process: the news tells of it once.
	Formed func(ctx context.Context, s Storm)
	Log    *slog.Logger
}

// Storm is a storm of the week as it forms: its slot and its seed, which
// name it; the tick it was born at; and at the tick it is told at, where
// it is, m east and north, and the direction it moves toward, rad, and how
// fast, m/s.
type Storm struct {
	Slot        int32
	Seed        uint32
	Born, At    int64
	East, North float64
	Heading     float64
	Speed       float64
}

// stormKey is a storm told.
type stormKey struct {
	slot int32
	seed uint32
}

// Issue is an issue of the forecast: its tick, the forecast, its gale scan
// and the gale warning in force, with the issue it came into force at, its
// key; and the issue as the wire carries it.
type Issue struct {
	Tick     int64
	Forecast physics.Forecast
	Gales    physics.Gales
	Gale     *weather.Gale
	Key      int64
	Place    Place
	Message  *pb.Forecast
}

// latest is the latest issue and what has been with it.
type latest struct {
	issue *Issue
	past  *pb.ForecastPast
	at    int64 // the boundary of five minutes the past reaches to
}

// request is a frame's tick and the developer's weathers and systems then.
type request struct {
	tick int64
	ws   []bus.Weather
	ss   []bus.System
}

// Issuer issues the forecast. Record is told of each frame; Run makes the
// issues on a goroutine of its own.
type Issuer struct {
	cfg   Config
	water []uint8
	on    []uint8
	work  chan request
	next  int64 // the next boundary of five minutes a frame must pass, in Record's goroutine

	mu     sync.Mutex
	issues map[int64]*Issue
	end    int64
	told   map[stormKey]bool

	now atomic.Pointer[latest]
	// scratch for the gale scan, the worker's
	w physics.Weather
	t physics.WeatherTick
}

// New makes an Issuer.
func New(cfg Config) *Issuer {
	p := cfg.Timeline.Prepared()
	n := int(p.GaleSide()) * int(p.GaleSide())
	is := &Issuer{
		cfg: cfg, water: make([]uint8, n), on: make([]uint8, n),
		work: make(chan request, 1), issues: map[int64]*Issue{}, told: map[stormKey]bool{},
	}
	physics.GaleWater(p, cfg.Ground, is.water)
	if is.cfg.Log == nil {
		is.cfg.Log = slog.Default()
	}
	return is
}

// SetEnd sets the world's last tick, after which the forecast has no
// steps; 0 for none.
func (is *Issuer) SetEnd(tick int64) {
	is.mu.Lock()
	defer is.mu.Unlock()
	if is.end != tick {
		is.end = tick
		clear(is.issues)
	}
}

// Record is told of each frame as the simulation publishes it: a
// sim.Recorder. At each boundary of five minutes it passes it asks for the
// issue in force and what has been; it never blocks.
func (is *Issuer) Record(f *bus.Frame) {
	if f.Tick < is.next {
		return
	}
	is.next = (f.Tick/weather.PastEvery + 1) * weather.PastEvery
	r := request{tick: f.Tick, ws: append([]bus.Weather(nil), f.Weathers...), ss: append([]bus.System(nil), f.Systems...)}
	select {
	case is.work <- r:
	default:
		// The worker is busy with the last: the next boundary asks again.
		is.next = f.Tick
	}
}

// Run makes the issues asked for until ctx ends.
func (is *Issuer) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case r := <-is.work:
			is.Update(ctx, r.tick, r.ws, r.ss)
		}
	}
}

// Forecast is the latest issue and what has been: an edge.ForecastSource.
func (is *Issuer) Forecast() (*pb.Forecast, *pb.ForecastPast) {
	l := is.now.Load()
	if l == nil {
		return nil, nil
	}
	return l.issue.Message, l.past
}

// Latest is the latest issue made, or nil.
func (is *Issuer) Latest() *Issue {
	if l := is.now.Load(); l != nil {
		return l.issue
	}
	return nil
}

// Update makes the issue in force at a tick, with the developer's
// weathers ws and systems ss then, if it is not made, and what has been,
// and makes them the latest.
func (is *Issuer) Update(ctx context.Context, tick int64, ws []bus.Weather, ss []bus.System) {
	tl := is.cfg.Timeline
	issue := is.Issue(tl.IssueAt(tick), ws, ss)
	at := tick / weather.PastEvery * weather.PastEvery
	if l := is.now.Load(); l != nil && l.issue == issue && l.at == at {
		return
	}
	from := issue.Tick - tl.Prepared().ForecastHorizon()
	old := is.Issue(from, ws, ss)
	p := tl.PastOf(from, at, ws, ss)
	is.now.Store(&latest{issue: issue, past: protocol.ForecastPast(old.Message, p.Keyframes, p.Spells), at: at})
	if is.cfg.Formed != nil {
		for _, s := range is.formed(issue, tick) {
			is.cfg.Formed(ctx, s)
		}
	}
}

// formed are the week's storms of an issue's that have formed by a tick
// and are not yet told in this process: born no longer before it than the
// forecast's horizon, so a process begun again tells again those it may
// not have told, and the news, which keeps each storm's item once, tells
// each once.
func (is *Issuer) formed(x *Issue, tick int64) []Storm {
	tl := is.cfg.Timeline
	kind := float64(tl.Config().Week.Storms)
	within := float64(tl.Prepared().ForecastHorizon())
	f := &x.Forecast
	origin := f.Head.Origin
	local := float64(tick) - origin
	var out []Storm
	is.mu.Lock()
	defer is.mu.Unlock()
	for i := range int(f.Head.NSystems) {
		r := &f.Systems[i]
		slot := int32(f.Head.Slots[i])
		if r.Kind != kind || slot >= physics.WeekSystems || !(r.Born <= local && local < r.Gone && r.Born > local-within) {
			continue
		}
		k := stormKey{slot, uint32(r.Seed)}
		if is.told[k] {
			continue
		}
		is.told[k] = true
		s := physics.SystemAt(r, local)
		out = append(out, Storm{
			Slot: slot, Seed: k.seed, Born: int64(r.Born + origin), At: tick,
			East: s.East / 4, North: s.North / 4,
			Heading: s.Heading * 2 * math.Pi / physics.TurnSteps, Speed: s.Speed * physics.SeaSpeedStep,
		})
	}
	return out
}

// Issue is the issue at a tick, a boundary of the forecast's every, with
// the developer's weathers ws and systems ss: made if it is not kept.
func (is *Issuer) Issue(tick int64, ws []bus.Weather, ss []bus.System) *Issue {
	is.mu.Lock()
	defer is.mu.Unlock()
	return is.issueLocked(tick, ws, ss, 0)
}

func (is *Issuer) issueLocked(tick int64, ws []bus.Weather, ss []bus.System, depth int) *Issue {
	if x, ok := is.issues[tick]; ok {
		return x
	}
	tl := is.cfg.Timeline
	p := tl.Prepared()
	x := &Issue{Tick: tick, Key: tick}
	tl.Forecast(tick, ws, ss, is.end, &x.Forecast)
	physics.GaleScan(p, &x.Forecast, &is.w, &is.t, is.water, is.on, &x.Gales)
	var gale *pb.GaleWarning
	if g, ok := weather.GaleOf(&x.Forecast, &x.Gales); ok {
		x.Gale = &g
		// In force since the issue before, if it had one.
		if depth < lookBack {
			if prev := is.issueLocked(tick-p.ForecastEvery(), ws, ss, depth+1); prev.Gale != nil {
				x.Key = prev.Key
			}
		}
		if is.cfg.Nearest != nil {
			x.Place = is.cfg.Nearest(g.East, g.North)
		}
		gale = &pb.GaleWarning{
			Key: x.Key, Steps: g.Steps, First: uint32(g.First), Force: uint32(g.Force),
			From: turnSteps(g.From), East: int32(roundM(g.East)), North: int32(roundM(g.North)),
			Subject: x.Place.Subject, Number: x.Place.Number,
		}
	}
	x.Message = protocol.Forecast(&x.Forecast, gale)
	is.issues[tick] = x
	if depth == 0 {
		// Only the recent are kept.
		for t := range is.issues {
			if t < tick-int64(keep)*p.ForecastEvery() || t > tick+int64(keep)*p.ForecastEvery() {
				delete(is.issues, t)
			}
		}
	}
	return x
}

// turnSteps is a direction in rad as 65536ths of a turn, 0 to 65535.
func turnSteps(rad float64) uint32 {
	s := int64(roundM(rad/(2*math.Pi)*physics.TurnSteps)) % physics.TurnSteps
	if s < 0 {
		s += physics.TurnSteps
	}
	return uint32(s)
}

// roundM is a distance rounded to the metre.
func roundM(x float64) float64 {
	if x < 0 {
		return -float64(int64(-x + 0.5))
	}
	return float64(int64(x + 0.5))
}
