// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
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
// (internal/forecast) and sent to every connection. A gale warning is in
// the forecast and on the chart, told from the nearest charted island or
// place. The weather is never in the news, which tells what is charted
// and the world's own notices: the chart and the forecast tell of it.

// forecastsOf is a world's forecast issuer.
func (p *process) forecastsOf(rw *readyWorld, row store.World, tl *weather.Timeline) *forecast.Issuer {
	is := forecast.New(forecast.Config{
		Timeline: tl, Ground: landOf(rw.terrain),
		Nearest: func(east, north float64) forecast.Place {
			e := nearestCharted(rw.charts.model.Entries(), east, north)
			if e == nil {
				return forecast.Place{}
			}
			return forecast.Place{Subject: e.GetSubject(), Number: e.GetNumber()}
		},
		Log: p.log,
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
