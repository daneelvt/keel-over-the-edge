// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"math"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// A world's forecast is issued off the tick at each boundary of its every
// (internal/forecast), sent to every connection, and each new gale warning
// told once in the news's notices to mariners, where it blows from the
// nearest charted island or place: the chart is shared, so the place is
// everyone's, and the news may name it.

// forecastsOf is a world's forecast issuer.
func (p *process) forecastsOf(rw *readyWorld, row store.World, tl *weather.Timeline) *forecast.Issuer {
	words := weather.WordsOf(p.cat)
	is := forecast.New(forecast.Config{
		Timeline: tl, Ground: landOf(rw.terrain),
		Nearest: func(east, north float64) forecast.Place {
			e := nearestCharted(rw.charts.model.Entries(), east, north)
			if e == nil {
				return forecast.Place{}
			}
			return forecast.Place{Subject: e.GetSubject(), Number: e.GetNumber()}
		},
		Warned: func(ctx context.Context, x *forecast.Issue) { p.galeNews(ctx, row, rw, tl, x, &words) },
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

// warningOf is an issue's gale warning in words' terms, with its place's
// name from the chart.
func warningOf(x *forecast.Issue, tl *weather.Timeline, entries []*pb.ChartEntry) weather.Warning {
	g := x.Gale
	w := weather.Warning{
		From: g.From, Force: int(g.Force), East: g.East, North: g.North,
		First: float64(int64(g.First)*tl.Prepared().ForecastStep()) / (60 * physics.StepsPerSecond),
	}
	for _, e := range entries {
		if e.GetSubject() == x.Place.Subject && e.GetNumber() == x.Place.Number {
			w.Place, w.PlaceEast, w.PlaceNorth = e.GetName(), float64(e.GetEast())/100, float64(e.GetNorth())/100
			break
		}
	}
	return w
}

// galeNews tells the news of a gale warning, once: its item's number is
// the issue it came into force at, counted from the world's epoch.
func (p *process) galeNews(ctx context.Context, row store.World, rw *readyWorld, tl *weather.Timeline, x *forecast.Issue, words *weather.Words) {
	column := worldColumn(p.cat)
	if column == "" {
		return
	}
	w := warningOf(x, tl, rw.charts.model.Entries())
	n := store.GaleNews{
		Column: column, Number: int32(x.Key / max(tl.Prepared().ForecastEvery(), 1)), Title: "GALE WARNING",
		What: weather.WarningText(&w, words), X: x.Gale.East, Y: x.Gale.North,
	}
	written, err := p.db.WriteGaleNews(ctx, p.lease, row.ID, n)
	if err != nil {
		p.log.Warn("the gale warning cannot be written to the news", "world", row.Number, "warning", n.Number, "err", err)
		return
	}
	if written {
		p.log.Info("a gale warning is in the news", "world", row.Number, "warning", n.Number, "what", n.What)
	}
}
