// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/jobs"
	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// The sailors' log: the world's frames make its rows, written with the
// world's writes; the game's routes and the world page read it; and once,
// a job copies into it what the worlds still kept recorded before it was
// kept.

// logs is what the server asks of the store for the log.
type logs interface {
	logbook.Store
	logbook.BackfillStore
}

// bookOf is the logbook of a world sailed, which its writer asks for the
// rows of the log each frame tells of.
func bookOf(rw *readyWorld, cat *catalog.Catalog) *logbook.Book {
	cfg := logbook.Config{World: rw.row.Number, Epoch: rw.row.Epoch, Catalog: cat, Boats: boatIDs(cat)}
	if rw.charts != nil {
		cfg.Chart = rw.charts.model
	}
	return logbook.NewBook(cfg)
}

// logsOf are the sailors' logs as the world sailed, number, reads them.
func (p *process) logsOf(number int) *logbook.Service {
	cfg := logbook.ServiceConfig{
		Store: p.db, Catalog: p.cat, Looks: p.looks, Key: moderation.Key,
		World: func() int { return number },
		Zone:  p.cfg.Schedule.Zone,
	}
	if t := p.ties; t != nil {
		cfg.Blocks = func(a, b store.AccountID) bool { return t.Blocks(a, b) }
	}
	return logbook.NewService(cfg)
}

// The backfill's job: due once, at a time long past, so that it runs on
// the first start that has it, and never again once it has run.
const jobBackfill = "log-backfill"

var backfillDue = time.Date(2026, time.November, 1, 0, 0, 0, 0, time.UTC)

// backfillJob copies into the log what the worlds still kept recorded
// before it was kept: once.
func (p *process) backfillJob() jobs.Job {
	return jobs.Job{
		Name: jobBackfill,
		Due: func(now time.Time) (time.Time, bool) {
			return backfillDue, !now.Before(backfillDue)
		},
		Retry: 15 * time.Minute,
		Run: func(ctx context.Context, _ time.Time) (jobs.Result, error) {
			done, err := logbook.Backfill(ctx, logbook.BackfillConfig{
				Store: p.db, Lease: p.lease, Catalog: p.cat, Chart: p.keptChart, Fall: edgeOf(p.cat).Fall,
			})
			if err != nil {
				return jobs.Result{}, err
			}
			return jobs.Result{Skipped: done.Worlds == 0,
				Detail: fmt.Sprintf("%d voyages and %d entries of %d worlds copied into the log", done.Voyages, done.Entries, done.Worlds)}, nil
		},
	}
}

// keptChart is what can be charted in a kept world: the world sailed's
// chart, or one built from a world's bundle as stored; nil for a world
// with none.
func (p *process) keptChart(ctx context.Context, world [16]byte) (*chart.World, error) {
	if h := p.current.Load(); h != nil && h.row.ID == world && h.ready.charts != nil {
		return h.ready.charts.world, nil
	}
	stored, err := p.db.LoadBundle(ctx, world)
	if err != nil {
		if err == store.ErrNotFound {
			return nil, nil
		}
		return nil, err
	}
	b, err := worldgen.Load(stored.Records, stored.Report, stored.Chunks, world, stored.Digest)
	if err != nil {
		return nil, err
	}
	return chart.Build(b, p.cat), nil
}
