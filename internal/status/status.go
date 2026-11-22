// SPDX-License-Identifier: AGPL-3.0-only

// Package status is the game as the website shows it, GET /api/status:
// the sailors at sea and waiting, the world and when it ends, and the
// world's map as the game's chart draws it: the places charted, each
// charted island's coast, the whole disk's weather as every sailor's chart
// shows it, and a few of the boats anyone may watch.
//
// Nothing uncharted is in it, in any form: its places and coasts are the
// chart's (chart.Model's entries), never the world's subjects. The weather
// is the whole disk's, as it is on every sailor's chart, showers over
// uncharted land too. The boats are those the watch list shows anyone,
// unnamed, roughly where they are.
//
// It is built from the newest frame, never from the simulation, and kept
// Kept, as JSON and gzipped: a burst of calls costs one build. testdata/status.md describes it
// field by field, and testdata/seed1.json is one, of seed 1's world with
// the whole of it charted.
package status

import (
	"bytes"
	"cmp"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"slices"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/lookout"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/watch"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worlds"
)

// Kept is how long a status is kept before it is built again.
const Kept = 30 * time.Second

// GridSide is how many points a side the weather's grid has.
const GridSide = 32

// The boats' rounding: their places to BoatGrain m, their headings to
// HeadingStep degrees.
const (
	BoatGrain   = 100
	HeadingStep = 15
)

// middling is the worth from which an island is lettered from further
// off than the smallest, as the chart letters it: a medium island of the
// centre, or a small one further out.
const middling = 5

// Status is the game as the website shows it.
type Status struct {
	AtSea         int `json:"atSea"`
	MachinesAtSea int `json:"machinesAtSea"`
	Queued        int `json:"queued"`
	World         int `json:"world"`
	// EndsAt is when the world ends, RFC 3339 in UTC; none for no end
	// known.
	EndsAt  string `json:"endsAt,omitempty"`
	Closing bool   `json:"closing"`
	// Turn is when every world ends, as the schedule says it; none for a
	// schedule that is not weekly.
	Turn *Turn `json:"turn,omitempty"`
	// Charted is how many subjects the world's sailors have charted: not
	// what is known from its start.
	Charted int `json:"charted"`
	// Hour is the hour of the sky's day at the disk's centre, 0 to 24:
	// noon is 12.
	Hour float64 `json:"hour"`
	// At is when it was built, RFC 3339 in UTC.
	At  string `json:"at"`
	Map Map    `json:"map"`
}

// Turn is the schedule's weekday, its local time of day, 24-hour, and its
// zone's IANA name: Sunday, 18:00, America/New_York.
type Turn struct {
	Weekday string `json:"weekday"`
	Time    string `json:"time"`
	Zone    string `json:"zone"`
}

// Map is what the website's map draws: the disk, m from its centre east
// and north; the subjects charted, each kind in its own table, a column a
// field, every column in the same order: by rank, then worth, the order
// the chart letters them in (across the tables, by rank, islands first);
// the weather; the boats.
type Map struct {
	// Lip is the disk's radius, and Band the mist band's inner edge, m.
	Lip      int      `json:"lip"`
	Band     int      `json:"band"`
	Islands  Islands  `json:"islands"`
	Places   Places   `json:"places"`
	Features Features `json:"features"`
	Weather  *Weather `json:"weather,omitempty"`
	Boats    []Boat   `json:"boats"`
}

// Islands are the islands charted: each one's name; where it is, m east and north to Grain; its rank, how
// far in the chart must be for it to be lettered (4 the main port's
// island, lettered first, 3 a great island, 2, 1); and its coast, rings
// of its land (coastOf), none for an island too small for a model.
type Islands struct {
	Name  []string  `json:"name"`
	East  []int     `json:"east"`
	North []int     `json:"north"`
	Rank  []int     `json:"rank"`
	Coast [][][]int `json:"coast"`
}

// Places are the places charted: each one's name, its kind (the
// catalog's id), where it is, m east and north to Grain, and its rank, 2
// a place whose charting is news, 1 another, 0 one seen by looking into
// it, lettered only close in.
type Places struct {
	Name  []string `json:"name"`
	Kind  []string `json:"kind"`
	East  []int    `json:"east"`
	North []int    `json:"north"`
	Rank  []int    `json:"rank"`
}

// Features are the features charted, which the chart marks unlettered:
// each one's kind, the catalog's id, and where it is, m east and north to
// Grain. Their rank is 0.
type Features struct {
	Kind  []string `json:"kind"`
	East  []int    `json:"east"`
	North []int    `json:"north"`
}

// Boat is a boat anyone may watch: where it is, m, to BoatGrain; the way
// it heads, degrees clockwise from north, to HeadingStep; its kind, the
// catalog's id; and whether a machine sailor sails it.
type Boat struct {
	East    int    `json:"east"`
	North   int    `json:"north"`
	Heading int    `json:"heading"`
	Boat    string `json:"boat"`
	Machine bool   `json:"machine"`
}

// Config is what a world's status is built from.
type Config struct {
	Frames  *bus.Frames
	Chart   *chart.Model
	Catalog *catalog.Catalog
	// Timeline is the world's weather; nil for none shown.
	Timeline *weather.Timeline
	// Sky and Epoch are the sky and the world's tick 0, for the hour; a
	// nil sky shows noon.
	Sky   *sky.Prepared
	Epoch time.Time
	// World is the world's number; Ends when it ends, zero for not known.
	World    int
	Ends     func() time.Time
	Schedule worlds.Schedule
	// Boats are at most n of the boats anyone may watch, the liveliest
	// first; nil for none. Limit is n.
	Boats func(ctx context.Context, n int) ([]watch.Seen, error)
	Limit int
	Log   *slog.Logger
	// Now is the time; time.Now if nil.
	Now func() time.Time
}

// Builder builds a world's status and keeps it Kept.
type Builder struct {
	cfg Config

	mu            sync.Mutex
	at            time.Time
	body, gzipped []byte
	// coasts are the islands' coasts, by their index in the chart's
	// subjects, worked out once.
	coasts map[int32][][]int
}

// New is the builder of a world's status.
func New(cfg Config) *Builder {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	return &Builder{cfg: cfg, coasts: map[int32][][]int{}}
}

// JSON is the status as JSON, and gzipped, built again once older than
// Kept.
func (b *Builder) JSON(ctx context.Context) (body, gzipped []byte, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.cfg.Now()
	if b.body != nil && now.Sub(b.at) < Kept {
		return b.body, b.gzipped, nil
	}
	st := b.build(ctx, now)
	body, err = json.Marshal(st)
	if err != nil {
		return nil, nil, err
	}
	var z bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&z, gzip.BestCompression)
	_, _ = zw.Write(body)
	if err := zw.Close(); err != nil {
		return nil, nil, err
	}
	b.body, b.gzipped, b.at = body, z.Bytes(), now
	return b.body, b.gzipped, nil
}

// Build builds the status now, keeping nothing but the islands' coasts.
func (b *Builder) Build(ctx context.Context) *Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.build(ctx, b.cfg.Now())
}

// frameCopy is what the status reads of a frame, copied so the frame is
// held only a moment.
type frameCopy struct {
	tick                   int64
	atSea, machines, queue int
	spells                 []physics.Spell
	coming                 physics.ComingFront
	keys                   [bus.KeyFrames]physics.Keyframe
	systems                []bus.System
	weathers               []bus.Weather
}

func (b *Builder) build(ctx context.Context, now time.Time) *Status {
	cfg := &b.cfg
	f := cfg.Frames.Acquire()
	// Every sailor at sea: each boat's skipper and everyone aboard a boat
	// not their own, who has none in the water.
	fc := frameCopy{tick: f.Tick, atSea: len(f.Live) + len(f.Crew), queue: len(f.Queue),
		spells: slices.Clone(f.SpellsInPlay()), coming: f.Coming, keys: f.Keys,
		systems: slices.Clone(f.Systems), weathers: slices.Clone(f.Weathers)}
	for _, s := range f.Live {
		if f.Machine[s] {
			fc.machines++
		}
	}
	for i := range f.Crew {
		if f.Crew[i].Machine {
			fc.machines++
		}
	}
	f.Release()

	st := &Status{AtSea: fc.atSea, MachinesAtSea: fc.machines, Queued: fc.queue, World: cfg.World,
		At: now.UTC().Format(time.RFC3339), Hour: 12}
	if cfg.Ends != nil {
		if end := cfg.Ends(); !end.IsZero() {
			st.EndsAt = end.UTC().Format(time.RFC3339)
			st.Closing = cfg.Schedule.Closing(end, now)
		}
	}
	if sc := cfg.Schedule; sc.Every == 0 && sc.Zone != nil {
		st.Turn = &Turn{Weekday: sc.Weekday.String(), Time: hhmm(sc.Hour, sc.Minute), Zone: sc.Zone.String()}
	}
	if cfg.Sky != nil {
		t := sky.Time(cfg.Sky, float64(cfg.Epoch.UnixMicro()), float64(fc.tick)*1e6/physics.StepsPerSecond)
		st.Hour = math.Round(lookout.HourAt(t, cfg.Sky.Day())*100) / 100
	}
	cat := cfg.Catalog
	st.Map = Map{Lip: int(math.Round(cat.World.Disk.Radius)), Band: int(math.Round(cat.World.Disk.Mist * nm)), Boats: []Boat{}}
	ch := cfg.Chart.Load()
	for _, r := range ch.Rows {
		if r.Credited {
			st.Charted++
		}
	}
	b.charted(ch, &st.Map)
	if cfg.Timeline != nil {
		st.Map.Weather = sampleWeather(cfg.Timeline, cat, &fc)
	}
	if cfg.Boats != nil && cfg.Limit > 0 {
		seen, err := cfg.Boats(ctx, cfg.Limit)
		if err != nil {
			// The rest stands without them.
			cfg.Log.Warn("the status's boats", "err", err)
		}
		for _, s := range seen[:min(len(seen), cfg.Limit)] {
			st.Map.Boats = append(st.Map.Boats, Boat{East: roundTo(s.East, BoatGrain), North: roundTo(s.North, BoatGrain),
				Heading: headingOf(s.Heading), Boat: s.Kind, Machine: s.Machine})
		}
	}
	return st
}

// nm is a nautical mile, m.
const nm = 1852

// hhmm is a time of day as 18:00.
func hhmm(h, m int) string { return fmt.Sprintf("%02d:%02d", h, m) }

// headingOf is a heading, rad clockwise from north, in whole degrees from
// 0 to 359 rounded to HeadingStep.
func headingOf(rad float64) int {
	d := roundTo(rad*180/math.Pi, HeadingStep)
	return ((d % 360) + 360) % 360
}

// charted fills the map's tables from the chart's entries, the way the
// chart letters them: by rank, then worth.
func (b *Builder) charted(ch *chart.Chart, m *Map) {
	cat := b.cfg.Catalog
	w := b.cfg.Chart.World()
	great := cat.World.Chart.Worth.Great
	order := make([]int, len(ch.Entries))
	rank := make([]int, len(ch.Entries))
	for i, e := range ch.Entries {
		order[i] = i
		sub := &w.Subjects[ch.Subjects[i]]
		switch e.Subject {
		case pb.ChartSubject_CHART_SUBJECT_ISLAND:
			switch {
			case e.Number == 0:
				rank[i] = 4
			case sub.Worth >= great:
				rank[i] = 3
			case sub.Worth >= middling:
				rank[i] = 2
			default:
				rank[i] = 1
			}
		case pb.ChartSubject_CHART_SUBJECT_PLACE:
			rank[i] = 1
			if s := int(e.Sort); s < len(cat.World.Places.Kinds) {
				k := &cat.World.Places.Kinds[s]
				switch {
				case k.Water != nil && *k.Water:
					rank[i] = 0
				case k.News != nil && *k.News:
					rank[i] = 2
				}
			}
		}
	}
	worth := func(i int) float64 { return w.Subjects[ch.Subjects[i]].Worth }
	slices.SortStableFunc(order, func(x, y int) int {
		if rank[x] != rank[y] {
			return rank[y] - rank[x]
		}
		return cmp.Compare(worth(y), worth(x))
	})
	m.Islands = Islands{Name: []string{}, East: []int{}, North: []int{}, Rank: []int{}, Coast: [][][]int{}}
	m.Places = Places{Name: []string{}, Kind: []string{}, East: []int{}, North: []int{}, Rank: []int{}}
	m.Features = Features{Kind: []string{}, East: []int{}, North: []int{}}
	for _, i := range order {
		e := ch.Entries[i]
		east, north := roundTo(float64(e.East)/100, Grain), roundTo(float64(e.North)/100, Grain)
		sort := int(e.Sort)
		switch e.Subject {
		case pb.ChartSubject_CHART_SUBJECT_ISLAND:
			is := &m.Islands
			coast := b.coast(ch.Subjects[i], &w.Subjects[ch.Subjects[i]])
			if coast == nil {
				coast = [][]int{}
			}
			is.Name, is.Rank = append(is.Name, e.Name), append(is.Rank, rank[i])
			is.East, is.North, is.Coast = append(is.East, east), append(is.North, north), append(is.Coast, coast)
		case pb.ChartSubject_CHART_SUBJECT_PLACE:
			ps := &m.Places
			kind := ""
			if sort < len(cat.World.Places.Kinds) {
				kind = string(cat.World.Places.Kinds[sort].ID)
			}
			ps.Name, ps.Kind, ps.Rank = append(ps.Name, e.Name), append(ps.Kind, kind), append(ps.Rank, rank[i])
			ps.East, ps.North = append(ps.East, east), append(ps.North, north)
		default:
			fs := &m.Features
			kind := ""
			if sort < len(cat.World.Features.Kinds) {
				kind = string(cat.World.Features.Kinds[sort].ID)
			}
			fs.Kind, fs.East, fs.North = append(fs.Kind, kind), append(fs.East, east), append(fs.North, north)
		}
	}
}

// coast is island subject i's coast, worked out once.
func (b *Builder) coast(i int32, sub *chart.Subject) [][]int {
	if c, ok := b.coasts[i]; ok {
		return c
	}
	var c [][]int
	if models := b.cfg.Chart.World().Models; sub.Model >= 0 && sub.Model < len(models) {
		var err error
		if c, err = coastOf(models[sub.Model].Payload); err != nil {
			b.cfg.Log.Warn("an island's coast", "island", sub.Number, "err", err)
		}
	}
	b.coasts[i] = c
	return c
}
