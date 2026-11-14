// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/jobs"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/news"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The news as a daily edition: the world's writer writes candidate
// stories by the catalog's rules; the game's route, the machine sailors'
// news and the world page read a day's edition; a job sets each day's
// edition once the day is over, and another writes a new world's arrival
// and the last world in review into its first.

// The news's jobs' names.
const (
	jobEditions = "editions"
	jobArrival  = "arrival"
)

// The editions' job's time of day in the schedule's zone: just after
// midnight, once the day is over.
const editionsHour, editionsMinute = 0, 5

// reviewFinds is how many of a world's greatest finds its review names.
const reviewFinds = 3

// newsDB is what the news asks of the store beyond what it reads.
type newsDB interface {
	news.Store
	WriteStories(ctx context.Context, lease int64, world [16]byte, rules store.NewsRules, stories []store.Story) error
	WorldReview(ctx context.Context, world [16]byte, number, finds int) (store.Review, error)
	StrikeStory(ctx context.Context, world, id [16]byte, struck bool) (store.Struck, error)
	Follows(ctx context.Context, follower store.AccountID) ([]store.Followed, error)
}

// newsRules are the catalog's rules the world's writer writes candidates
// by, the day kept in zone.
func newsRules(cat *catalog.Catalog, zone *time.Location) *store.NewsRules {
	if zone == nil {
		zone = time.UTC
	}
	m := &cat.News.Edition.Milestones
	r := &store.NewsRules{
		Zone: zone.String(), FirstScore: cat.StoryScore(catalog.NewsStoryOfFirst),
		MilestoneScore: cat.StoryScore(catalog.NewsStoryOfMilestone),
		Distance:       m.Distance * 1852, Worlds: m.Worlds, Places: m.Places,
	}
	for _, c := range cat.News.Columns {
		if c.Of == catalog.OfCharting && r.Column == "" {
			r.Column = string(c.ID)
		}
	}
	return r
}

// newsOf is the news of a world sailed.
func (p *process) newsOf(row store.World) *news.Service {
	cfg := news.Config{
		Store: p.db, Catalog: p.cat, Zone: p.cfg.Schedule.Zone, Key: moderation.Key,
		World: news.World{ID: row.ID, Number: row.Number, Begins: row.BeginsAt},
		Follows: func(ctx context.Context, a store.AccountID) ([]store.AccountID, error) {
			f, err := p.db.Follows(ctx, a)
			if err != nil {
				return nil, err
			}
			out := make([]store.AccountID, len(f))
			for i, x := range f {
				out[i] = x.ID
			}
			return out, nil
		},
	}
	if cfg.World.Begins.IsZero() {
		cfg.World.Begins = row.Epoch
	}
	if t := p.ties; t != nil {
		cfg.Blocks = func(a, b store.AccountID) bool { return t.Blocks(a, b) }
		cfg.Shipmates = func(a store.AccountID) []store.AccountID {
			var out []store.AccountID
			for _, m := range t.ShipmatesOf(a) {
				out = append(out, m)
			}
			return out
		}
	}
	return news.NewService(cfg)
}

// newsJobs are the news's jobs: each day's edition set once the day is
// over, and a world's arrival and the last world's review, once as it
// begins.
func (p *process) newsJobs() []jobs.Job {
	zone := p.cfg.Schedule.Zone
	if zone == nil {
		zone = time.UTC
	}
	return []jobs.Job{
		{
			Name: jobEditions, Due: jobs.DailyIn(zone, editionsHour, editionsMinute), Next: jobs.DailyNextIn(zone, editionsHour, editionsMinute),
			Retry: 10 * time.Minute,
			Run: func(ctx context.Context, _ time.Time) (jobs.Result, error) {
				h := p.current.Load()
				if h == nil || h.news == nil {
					return jobs.Result{Skipped: true, Detail: "no world is sailed"}, nil
				}
				n, err := h.news.Set(ctx, p.lease)
				if err != nil {
					return jobs.Result{}, err
				}
				return jobs.Result{Skipped: n == 0, Detail: fmt.Sprintf("world %d: %d editions set", h.row.Number, n)}, nil
			},
		},
		{
			Name: jobArrival,
			Due: func(time.Time) (time.Time, bool) {
				h := p.current.Load()
				if h == nil {
					return time.Time{}, false
				}
				return beganOf(h), true
			},
			Next: func(time.Time) time.Time {
				if h := p.current.Load(); h != nil {
					return beganOf(h)
				}
				return time.Time{}
			},
			Retry: 5 * time.Minute,
			Run: func(ctx context.Context, due time.Time) (jobs.Result, error) {
				h := p.current.Load()
				if h == nil || !beganOf(h).Equal(due) {
					return jobs.Result{Skipped: true, Detail: "the world has changed"}, nil
				}
				detail, err := p.writeArrival(ctx, h)
				return jobs.Result{Detail: detail}, err
			},
		},
	}
}

// beganOf is when the world sailed began, as its arrival's job falls due:
// a time no other world has.
func beganOf(h *worldHalf) time.Time {
	t := h.row.BeginsAt
	if t.IsZero() {
		t = h.row.Epoch
	}
	return t.UTC().Truncate(time.Microsecond)
}

// writeArrival writes a world's arrival, how many islands wait to be
// found, and the last world in review, into its first edition: once each.
func (p *process) writeArrival(ctx context.Context, h *worldHalf) (string, error) {
	db := p.db
	rules := *newsRules(p.cat, p.cfg.Schedule.Zone)
	at := beganOf(h)
	islands := 0
	if c := h.ready.charts; c != nil {
		for i := range c.world.Subjects {
			if c.world.Subjects[i].Kind == sight.Island {
				islands++
			}
		}
	}
	// The main port's island is known from the world's start.
	arrival := store.Story{
		Story: store.StoryArrival, At: at, Subject: store.SubjectWorld, Number: int32(h.row.Number), Island: -1,
		Facts:  store.StoryFacts{Islands: max(islands-1, 0), Of: islands, World: h.row.Number},
		Source: store.StoryArrival,
	}
	stories := []store.Story{arrival}
	detail := fmt.Sprintf("world %d: %d islands to find", h.row.Number, arrival.Facts.Islands)
	if prev, ok, err := p.previousWorld(ctx, h.row.Number); err != nil {
		return "", err
	} else if ok {
		rv, err := db.WorldReview(ctx, prev.ID, prev.Number, reviewFinds)
		if err != nil {
			return "", err
		}
		if rv.Sailors > 0 || len(rv.Finds) > 0 {
			stories = append(stories, reviewOf(prev.Number, at, &rv))
			detail += fmt.Sprintf("; world %d in review", prev.Number)
		}
	}
	if err := db.WriteStories(ctx, p.lease, h.row.ID, rules, stories); err != nil {
		return "", err
	}
	return detail, nil
}

// previousWorld is the kept world before the world of a number.
func (p *process) previousWorld(ctx context.Context, number int) (store.KeptWorld, bool, error) {
	kept, err := p.db.KeptWorlds(ctx)
	if err != nil {
		return store.KeptWorld{}, false, err
	}
	for _, w := range kept {
		if w.Number == number-1 {
			return w, true, nil
		}
	}
	return store.KeptWorld{}, false, nil
}

// reviewOf is the last world's review, as the next world's first edition
// opens with it.
func reviewOf(number int, at time.Time, rv *store.Review) store.Story {
	s := store.Story{
		Story: store.StoryReview, At: at, Subject: store.SubjectWorld, Number: int32(number), Island: -1,
		Facts:  store.StoryFacts{World: number, Sailors: rv.Sailors, Run: rv.Run, Islands: rv.Islands},
		Source: store.StoryReview,
	}
	if rv.Arrival != nil {
		s.Facts.Of = rv.Arrival.Of
	}
	for _, f := range rv.Finds {
		s.Facts.Finds = append(s.Facts.Finds, store.ReviewFind{Title: f.Title, What: f.What, Worth: f.Worth})
		s.Named = append(s.Named, f.Account)
	}
	if rv.Nearest != (store.AccountID{}) {
		s.Facts.Nearest = &store.Nearest{Least: rv.NearestLeast, Boat: rv.NearestBoat, BoatKind: rv.NearestKind}
		s.Named = append(s.Named, rv.Nearest)
	}
	return s
}
