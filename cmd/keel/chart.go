// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/owner"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// The world's chart: what can be charted in it, built from its bundle as
// it is loaded; its islands' models, served as its chunks are; and the
// chart itself, restored from what the database holds.

// worldChart is a world's chart and what it is made of.
type worldChart struct {
	world  *chart.World
	model  *chart.Model
	models *api.Models
}

// newWorldChart builds the chart of the world b, sailed as world id, its
// models' addresses signed with the world's chunk key.
func newWorldChart(b *worldgen.Bundle, cat *catalog.Catalog, id [16]byte, key []byte) *worldChart {
	w := chart.Build(b, cat)
	payloads := make([][]byte, len(w.Models))
	for i, m := range w.Models {
		payloads[i] = m.Payload
	}
	models := api.NewModels(id, key, payloads)
	return &worldChart{world: w, model: chart.NewModel(w, cat, models.Paths()), models: models}
}

// sight is what the world's lookouts see by, the world's epoch telling
// when the sun is down at a light.
func (c *worldChart) sight(cat *catalog.Catalog, epoch time.Time) *sim.Sight {
	return &sim.Sight{
		Table: c.world.Table, Every: int64(cat.World.Chart.Sight.Every), Lookouts: c.world.Lookouts,
		Sky: cat.PrepareSky(), Epoch: epoch.UnixMicro(),
		Night: cat.World.Lights.Threshold, Day: cat.World.Lights.DayThreshold,
	}
}

// restore puts what the database holds of the world's chart on the chart
// and marks it charted in the simulation, before the first tick; and has
// the first tick chart what is known from the world's start and not yet
// charted: in a world new, or sailed before the chart was kept.
func (c *worldChart) restore(ctx context.Context, db database, world [16]byte, w *sim.World, log *slog.Logger) error {
	rows, err := db.Chartings(ctx, world)
	if err != nil {
		return err
	}
	c.model.Add(rows)
	charted := c.model.Charted()
	w.SetCharted(charted)
	known := 0
	server := w.Bus().Commands.Server()
	for _, k := range c.world.Known {
		if w.IsCharted(k) {
			continue
		}
		if err := server.TrySend(bus.Command{Op: bus.Chart, Subject: k}); err != nil {
			return err
		}
		known++
	}
	log.Info("the world's chart is restored", "charted", len(charted), "of", len(c.world.Subjects), "known", known)
	return nil
}

// news is the news of the world sailed: an api.NewsSource.
type news struct {
	db    database
	world [16]byte
}

func (n news) News(ctx context.Context, before *[16]byte, limit int) ([]store.News, error) {
	return n.db.News(ctx, n.world, before, limit)
}

// noticeKinds are the kinds of notice a sailor may switch off, by id.
func noticeKinds(cat *catalog.Catalog) []string {
	var out []string
	for _, k := range cat.Notices.Kinds {
		if k.Switchable {
			out = append(out, string(k.ID))
		}
	}
	return out
}

// modelsOf is the chart's islands' models, nil for a world sailed as open
// sea.
func modelsOf(c *worldChart) *api.Models {
	if c == nil {
		return nil
	}
	return c.models
}

// chartRoute charts by hand, on the internal listener only, with
// KEEL_DEV_COMMANDS=1: a subject, or every one, credited to no one, at the
// next tick, as a world's start charts what is known. For tests; the world
// page has no such control.
//
//	POST /debug/chart?all
//	POST /debug/chart?subject=island:12|place:200|feature:7
func chartRoute(b *bus.Bus, charts *worldChart, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		if charts == nil {
			http.Error(w, "the world is sailed as open sea: nothing to chart", http.StatusConflict)
			return
		}
		q := r.URL.Query()
		cmd := bus.Command{Op: bus.Chart, Subject: -1, On: q.Has("all")}
		if !cmd.On {
			kind, number, ok := strings.Cut(q.Get("subject"), ":")
			n, err := strconv.ParseInt(number, 10, 32)
			cmd.Subject = charts.world.Index(chart.KindOf(kind), int32(n))
			if !ok || err != nil || cmd.Subject < 0 {
				http.Error(w, "all, or subject=island:…, place:… or feature:…, one of the world's, is required", http.StatusBadRequest)
				return
			}
		}
		if err := b.Commands.Developer().TrySend(cmd); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		log.Info("charted by hand", "all", cmd.On, "subject", cmd.Subject)
		w.WriteHeader(http.StatusNoContent)
	})
}

// chartedList is the world's chart as the world page lists it.
func (c *worldChart) chartedList() []owner.Charted {
	rows := c.model.Load().Rows
	out := make([]owner.Charted, len(rows))
	for i, r := range rows {
		out[i] = owner.Charted{Subject: r.Subject, Number: r.Number, By: r.Sailor, AI: r.AccountKind == string(store.AI),
			At: r.At.UnixMilli(), Worth: r.Worth}
		if r.Credited && r.Sailor == "" {
			out[i].By = "a sailor"
		}
	}
	return out
}
