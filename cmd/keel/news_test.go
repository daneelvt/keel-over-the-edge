// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"slices"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The in-memory database keeps the news's stories as the world writes
// them, the chartings' and the log's, each once by its source, and the
// editions set; it reads a day's by the rules' zone.

// memNews is what the in-memory database keeps of the news.
type memNews struct {
	stories  []store.Story
	editions []store.Edition
	zone     *time.Location
}

// addStory keeps a story written, once by its source; a record only if
// it is one. With d.mu held.
func (d *memDB) addStory(rules *store.NewsRules, s store.Story) {
	if rules == nil {
		return
	}
	n := &d.newsKept
	if n.zone == nil {
		n.zone, _ = time.LoadLocation(rules.Zone)
		if n.zone == nil {
			n.zone = time.UTC
		}
	}
	for _, o := range n.stories {
		if s.Source != "" && o.Source == s.Source {
			return
		}
		if s.Record && o.Story == s.Story && o.Amount <= s.Amount {
			return
		}
	}
	_, _ = rand.Read(s.ID[:])
	if s.Account != (store.AccountID{}) {
		s.Sailor, s.AccountKind = "a sailor", string(store.Human)
	}
	t := s.At.In(n.zone)
	s.Day = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	n.stories = append(n.stories, s)
}

// writeNews keeps the stories a batch makes: its chartings' and its log's.
// With d.mu held.
func (d *memDB) writeNews(b *store.Batch) {
	for i := range b.Charting {
		c := &b.Charting[i]
		if !c.Written || !c.Credited || c.News == nil {
			continue
		}
		n := c.News
		d.addStory(b.News, store.Story{Story: n.Story, Score: n.Score, At: c.At, Account: c.Account, Subject: c.Subject, Number: c.Number,
			Title: n.Title, What: n.What, Island: n.Island, Worth: c.Worth, X: n.X, Y: n.Y,
			Facts: store.StoryFacts{Boat: n.Boat, BoatKind: n.BoatKind}, Source: fmt.Sprintf("c:%s:%d", c.Subject, c.Number)})
	}
	for _, s := range b.Log.Stories {
		d.addStory(b.News, s)
	}
}

// stories are the news's stories kept.
func (d *memDB) stories() []store.Story {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.newsKept.stories)
}

func sameDay(a, b time.Time) bool {
	return a.Year() == b.Year() && a.Month() == b.Month() && a.Day() == b.Day()
}

func (d *memDB) DayStories(_ context.Context, _ [16]byte, day time.Time) ([]store.Story, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []store.Story
	for _, s := range d.newsKept.stories {
		if sameDay(s.Day, day) {
			out = append(out, s)
		}
	}
	return out, nil
}

func (d *memDB) RankedStories(_ context.Context, _ [16]byte, days []time.Time) ([]store.Story, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []store.Story
	for _, s := range d.newsKept.stories {
		if s.Rank > 0 && slices.ContainsFunc(days, func(t time.Time) bool { return sameDay(s.Day, t) }) {
			out = append(out, s)
		}
	}
	return out, nil
}

func (d *memDB) StoriesAbout(_ context.Context, _ [16]byte, id store.AccountID, limit int) ([]store.Story, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []store.Story
	for _, s := range slices.Backward(d.newsKept.stories) {
		if s.Rank > 0 && !s.Struck && (s.Account == id || slices.Contains(s.Named, id)) && len(out) < limit {
			out = append(out, s)
		}
	}
	return out, nil
}

func (d *memDB) Editions(context.Context, [16]byte) ([]store.Edition, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.newsKept.editions), nil
}

func (d *memDB) SetEdition(_ context.Context, lease int64, _ [16]byte, _ string, e store.Edition, ranks map[[16]byte]int) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if lease != d.leaseEpoch {
		return store.ErrFenced
	}
	for _, o := range d.newsKept.editions {
		if sameDay(o.Day, e.Day) {
			return store.ErrEditionSet
		}
	}
	d.newsKept.editions = append(d.newsKept.editions, e)
	for i := range d.newsKept.stories {
		if r, ok := ranks[d.newsKept.stories[i].ID]; ok {
			d.newsKept.stories[i].Rank = r
		}
	}
	return nil
}

func (d *memDB) WorldNotices(context.Context, [16]byte) ([]store.WorldNotice, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []store.WorldNotice
	for _, n := range d.news {
		out = append(out, store.WorldNotice{Column: n.Column, Title: n.Title, What: n.What, X: n.X, Y: n.Y, EndsAt: n.EndsAt})
	}
	return out, nil
}

func (d *memDB) DayFigures(_ context.Context, _ [16]byte, number int, since, until time.Time) (store.Figures, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var f store.Figures
	boats := map[store.AccountID]bool{}
	for _, v := range d.log.Voyages {
		if v.Aboard || v.World != number || v.Ended.Before(since) || !v.Ended.Before(until) {
			continue
		}
		boats[v.Account] = true
		f.Run += v.Run
		if v.How == store.LogOver {
			f.Over++
		}
	}
	f.Boats = len(boats)
	for _, c := range d.chartings {
		if c.Credited && !c.At.Before(since) && c.At.Before(until) {
			f.Charted++
		}
	}
	return f, nil
}

func (d *memDB) WriteStories(_ context.Context, lease int64, _ [16]byte, rules store.NewsRules, stories []store.Story) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if lease != d.leaseEpoch {
		return store.ErrFenced
	}
	for _, s := range stories {
		d.addStory(&rules, s)
	}
	return nil
}

func (*memDB) WorldReview(context.Context, [16]byte, int, int) (store.Review, error) {
	return store.Review{}, nil
}

func (d *memDB) StrikeStory(_ context.Context, _, id [16]byte, struck bool) (store.Struck, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := range d.newsKept.stories {
		if s := &d.newsKept.stories[i]; s.ID == id {
			s.Struck = struck
			return store.Struck{Account: s.Account, Sailor: s.Sailor, Title: s.Title, Story: s.Story}, nil
		}
	}
	return store.Struck{}, store.ErrNotFound
}
