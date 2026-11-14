// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/jobs"
	"github.com/daneelvt/keel-over-the-edge/internal/race"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// Races: the world's races are made, opened by their links, entered and
// run by their owners through the game's routes; the harbour races are
// made by a job, every hour, for the hours ahead. The races' clerk hands
// each to the world's committee at its warning signal, and writes what it
// came to.

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

// raceStage is what a world's races are run on: its racing areas, its
// island courses, and the catalog's boats as races know them; nil for a
// world with no bundle.
func raceStage(cat *catalog.Catalog, b *worldgen.Bundle) *committee.Stage {
	if b == nil {
		return nil
	}
	st := &committee.Stage{}
	for i := range cat.Boats {
		st.Kinds = append(st.Kinds, committee.Kind{Polar: cat.Polar(i), Length: cat.Boats[i].LengthOverall})
	}
	for _, a := range b.Records.Areas {
		st.Areas = append(st.Areas, committee.Area{Number: a.Number, X: a.X, Y: a.Y, Radius: a.Radius})
	}
	for i := range b.Records.Courses {
		wc := &b.Records.Courses[i]
		ic := committee.Course{Number: wc.Number, Way: wc.Way, Length: wc.Length,
			Start:  committee.Site{X: wc.Start.X, Y: wc.Start.Y, Room: wc.Start.Room},
			Finish: committee.Site{X: wc.Finish.X, Y: wc.Finish.Y, Room: wc.Finish.Room}}
		for _, r := range wc.Rays {
			ic.Rays = append(ic.Rays, committee.Ray{X: r.X, Y: r.Y, Bearing: r.Bearing, Crossings: int8(r.Crossings), Along: r.Along,
				Mark: int16(r.Round + 1)})
		}
		st.Courses = append(st.Courses, ic)
	}
	return st
}

// clerkOf is the races' clerk of a world half: it hands the world's
// committee its races and writes what they came to.
func (p *process) clerkOf(h *worldHalf) *race.Clerk {
	epoch := h.row.Epoch
	return h.races.Clerk(race.ClerkConfig{
		Bus: h.bus, Lease: p.lease,
		TickAt: func(t time.Time) int64 { return loop.TickAt(t, epoch) },
		TimeOf: func(tick int64) time.Time { return loop.TimeOf(tick, epoch) },
		Fleet: func(ctx context.Context, id store.AccountID, kind int) (uint32, string) {
			if p.fleet == nil {
				return 0, ""
			}
			return p.fleet.Racing(ctx, id, kind)
		},
		Rules: *newsRules(p.cat, p.cfg.Schedule.Zone),
		Log:   p.log,
	})
}

// raceNames names a race's boats as a reader may be told them, for the
// game connection.
func (p *process) raceNames(h *worldHalf) edge.RaceNamer {
	return func(ctx context.Context, reader bus.Account, racers []bus.Account) ([]string, error) {
		if h.races == nil {
			return nil, nil
		}
		ids := make([]store.AccountID, len(racers))
		for i, a := range racers {
			ids[i] = store.AccountID(a)
		}
		return h.races.Names(ctx, store.AccountID(reader), ids)
	}
}
