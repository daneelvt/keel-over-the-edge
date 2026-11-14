// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/jobs"
	"github.com/daneelvt/keel-over-the-edge/internal/race"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Races ashore: the world's races are made, opened by their links,
// entered and run by their owners through the game's routes; the harbour
// races are made by a job, every hour, for the hours ahead.

// jobHarbour is the harbour races' job's name.
const jobHarbour = "harbour-races"

// racesOf are the races of a world sailed.
func (p *process) racesOf(h *worldHalf) *race.Service {
	row := h.row
	cfg := race.Config{
		Store: p.db, Catalog: p.cat, Origin: p.cfg.PlayOrigin, Zone: p.cfg.Schedule.Zone,
		World: race.World{ID: row.ID, Number: row.Number, Seed: h.ready.bundle.Seed, Begins: row.BeginsAt},
		Ends:  h.ends,
	}
	if cfg.World.Begins.IsZero() {
		cfg.World.Begins = row.Epoch
	}
	if c := h.ready.charts; c != nil {
		cfg.Courses = func() race.Courses { return coursesOf(c) }
	}
	if t := p.ties; t != nil {
		cfg.Blocks = func(a, b store.AccountID) bool { return t.Blocks(a, b) }
	}
	ids := boatIDs(p.cat)
	cfg.BoatOf = func(id store.AccountID) string {
		f := h.bus.Frames.Acquire()
		defer f.Release()
		for _, s := range f.Live {
			if store.AccountID(f.Owner[s]) == id && int(f.Kind[s]) < len(ids) {
				return ids[f.Kind[s]]
			}
		}
		return ""
	}
	return race.New(cfg)
}

// coursesOf are the racing areas and the island courses open on a
// world's chart now.
func coursesOf(c *worldChart) race.Courses {
	var out race.Courses
	for _, a := range c.world.Areas {
		out.Areas = append(out.Areas, race.Area{Number: int(a.Number), X: a.X, Y: a.Y})
	}
	for _, k := range c.model.OpenCourses() {
		wc := &c.world.Courses[k]
		ic := race.Course{Number: int(wc.Number), Kind: wc.Kind, Name: wc.Name, Length: wc.Length, Way: wc.Way,
			Boats: map[string]float64{}}
		for _, b := range wc.Boats {
			ic.Boats[b.Boat] = b.Expected
		}
		out.Island = append(out.Island, ic)
	}
	return out
}

// harbourJob makes the harbour races for the hours ahead, each hour on
// the hour: idempotent, each race made once for its start.
func (p *process) harbourJob() jobs.Job {
	return jobs.Job{
		Name: jobHarbour,
		Due: func(now time.Time) (time.Time, bool) {
			return now.Truncate(time.Hour), true
		},
		Next:  func(now time.Time) time.Time { return now.Truncate(time.Hour).Add(time.Hour) },
		Retry: 10 * time.Minute,
		Run: func(ctx context.Context, _ time.Time) (jobs.Result, error) {
			h := p.current.Load()
			if h == nil || h.races == nil {
				return jobs.Result{Skipped: true, Detail: "no world is sailed"}, nil
			}
			made, detail, err := h.races.Harbour(ctx, p.lease, time.Now())
			if err != nil {
				return jobs.Result{}, err
			}
			return jobs.Result{Skipped: made == 0, Detail: detail}, nil
		},
	}
}

// raceBoats are the catalog's boats' ids, the harbour rotation's choices.
func raceBoats(cat *catalog.Catalog) []string { return boatIDs(cat) }
