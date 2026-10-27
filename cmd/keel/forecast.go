// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"math"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// A world's forecast is issued off the tick at each boundary of its every
// (internal/forecast), sent to every connection, and each of the week's
// storms told once in the news's notices to mariners as it forms: where it
// is and which way it moves, in the general situation's words. A gale
// warning stays in the forecast and on the chart, told from the nearest
// charted island or place, but not in the news: with a storm alive about
// half the time it would never be lifted.

// forecastsOf is a world's forecast issuer.
func (p *process) forecastsOf(rw *readyWorld, row store.World, tl *weather.Timeline) *forecast.Issuer {
	sit := situationOf(p.cat, rw.bundle)
	is := forecast.New(forecast.Config{
		Timeline: tl, Ground: landOf(rw.terrain),
		Nearest: func(east, north float64) forecast.Place {
			e := nearestCharted(rw.charts.model.Entries(), east, north)
			if e == nil {
				return forecast.Place{}
			}
			return forecast.Place{Subject: e.GetSubject(), Number: e.GetNumber()}
		},
		Formed: func(ctx context.Context, s forecast.Storm) { p.stormNews(ctx, row, s, &sit) },
		Log:    p.log,
	})
	is.SetEnd(lastTick(row.EndsAt, row.Epoch))
	return is
}

// lastTick is a world's last tick for an end, 0 for none.
func lastTick(end, epoch time.Time) int64 {
	if end.IsZero() {
		return 0
	}
	return loop.TickAt(end, epoch)
}

// landOf is a world's land, or nil for open sea.
func landOf(t *sim.Terrain) *physics.Ground {
	if t == nil {
		return nil
	}
	return t.Ground
}

// nearestCharted is the charted island or place nearest a point, m east and
// north of the centre, or nil: a feature is named by its island, which is
// charted with it.
func nearestCharted(entries []*pb.ChartEntry, east, north float64) *pb.ChartEntry {
	var best *pb.ChartEntry
	d := math.Inf(1)
	for _, e := range entries {
		if e.GetSubject() != pb.ChartSubject_CHART_SUBJECT_ISLAND && e.GetSubject() != pb.ChartSubject_CHART_SUBJECT_PLACE || e.GetName() == "" {
			continue
		}
		if x := math.Hypot(float64(e.GetEast())/100-east, float64(e.GetNorth())/100-north); x < d {
			best, d = e, x
		}
	}
	return best
}

// situationOf is the general situation a storm's forming is told in: the
// main port's name and the zones about it, with no lows or fronts.
func situationOf(cat *catalog.Catalog, b *worldgen.Bundle) weather.Situation {
	s := weather.Situation{Port: cat.World.MainPort.Name, Centre: cat.World.Zones.Centre * 1852, Middle: cat.World.Zones.Middle * 1852}
	if b != nil && len(b.Islands) > 0 {
		s.Port = b.MainPort().Name
	}
	return s
}

// stormKind is the week's storms' kind as the news names it, with its
// article: "a storm".
func stormKind(cat *catalog.Catalog) string {
	if i := cat.Weather.Week.Storms.Kind; i != "" {
		for _, k := range cat.Weather.Systems {
			if k.ID == i {
				return "a " + strings.ToLower(k.Name)
			}
		}
	}
	return "a storm"
}

// stormNumber is a storm's item's number, the same however often it is
// told: the minute of world time it was born at, counted from the epoch,
// and its slot, two storms never born in the same slot in the same minute.
func stormNumber(s forecast.Storm) int32 {
	return int32(s.Born/(60*physics.StepsPerSecond))*physics.MaxSystems + s.Slot
}

// stormNews tells the news of a storm formed, once: its item's number is
// the storm's own, so a second telling, after a restart, writes nothing.
func (p *process) stormNews(ctx context.Context, row store.World, s forecast.Storm, sit *weather.Situation) {
	column := worldColumn(p.cat)
	if column == "" {
		return
	}
	kind := stormKind(p.cat)
	n := store.GaleNews{
		Column: column, Number: stormNumber(s), Title: strings.ToUpper(strings.TrimPrefix(kind, "a ")),
		What: sit.FormedText(kind, s.East, s.North, s.Heading, s.Speed), X: s.East, Y: s.North,
	}
	written, err := p.db.WriteGaleNews(ctx, p.lease, row.ID, n)
	if err != nil {
		p.log.Warn("the storm's forming cannot be written to the news", "world", row.Number, "storm", n.Number, "err", err)
		return
	}
	if written {
		p.log.Info("a storm's forming is in the news", "world", row.Number, "storm", n.Number, "what", n.What)
	}
}
