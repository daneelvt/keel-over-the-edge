// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestNewsStories: the log's frames' stories are written with its rows in
// the fenced batch, each once; a record at the falls only if it is nearer
// than any this world; the milestones a sailor's rows reach; a day's
// stories and figures read by the zone's day; an edition set once, its
// stories in their places, and never again; a story struck and put back;
// the stories naming a sailor; and a world in review.
func TestNewsStories(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	world, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ann, err := s.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", [32]byte{1}))
	if err != nil {
		t.Fatal(err)
	}
	tom, err := s.CreateAccount(ctx, storetest.NewAccount("Tom Bowline", "tornbowline", [32]byte{2}))
	if err != nil {
		t.Fatal(err)
	}
	epoch := take(t, newLease(t, u, "keel-a dev", store.LeaseOptions{}))
	p, err := store.OpenPersister(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	ny, _ := time.LoadLocation("America/New_York")
	rules := &store.NewsRules{Zone: "America/New_York", Column: "discoveries", FirstScore: 5, MilestoneScore: 4,
		Distance: 10 * 1852, Worlds: 1, Places: 2}
	// 23:30 in New York on the 11th is the 12th in UTC: the 11th's day.
	t0 := time.Date(2026, 11, 12, 4, 30, 0, 0, time.UTC)
	day := time.Date(2026, 11, 11, 0, 0, 0, 0, ny)
	record := func(source string, m float64, who store.AccountID) store.Story {
		return store.Story{Story: store.StoryRecord, Score: 8, At: t0, Account: who, Subject: store.SubjectSailor, Island: -1,
			Title: "The Skerries", X: 5, Y: 6, Amount: m, Record: true, Source: source,
			Facts: store.StoryFacts{Boat: "Gull", Place: "The Skerries", Spot: true}}
	}
	voyage := store.LogVoyage{Account: ann, Source: "v:1:4:30", World: world.Number, Boat: 4, BoatKind: "jolly-boat", BoatName: "Gull",
		Began: t0.Add(-time.Hour), Ended: t0, How: store.LogReturned, Run: 12 * 1852, Logged: true, Place: "Gull Reach"}
	charted := func(n int) store.LogEntry {
		return store.LogEntry{Account: ann, Source: "c:x:" + string(rune('a'+n)), World: world.Number, At: t0, Kind: store.LogCharted,
			Title: "Isle", X: 1, Y: 2}
	}
	crew := store.Story{Story: store.StoryCrew, Score: 5, At: t0, Account: ann, Named: []store.AccountID{tom}, Subject: store.SubjectSailor,
		Island: -1, Source: "crew:1", Facts: store.StoryFacts{Aboard: 4}}
	b := store.Batch{World: world.ID, Epoch: epoch, News: rules, Log: store.LogRows{
		Voyages: []store.LogVoyage{voyage},
		Entries: []store.LogEntry{charted(0), charted(1)},
		Stories: []store.Story{record("r:1", 40, ann), record("r:2", 50, tom), record("r:3", 12.5, tom), crew, crew},
	}}
	if err := p.Write(ctx, b); err != nil {
		t.Fatal(err)
	}
	// Written again, as a batch tried twice: nothing more.
	if err := p.Write(ctx, b); err != nil {
		t.Fatal(err)
	}
	stories, err := s.DayStories(ctx, world.ID, day)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	var milestones []string
	for _, st := range stories {
		kinds[st.Story]++
		if st.Story == store.StoryMilestone {
			milestones = append(milestones, st.Facts.Milestone)
		}
	}
	// The records: 40 m, then 12.5 m; 50 m was not one. Ann's 12 NM
	// passes 10; her first world; her second place charted.
	if kinds[store.StoryRecord] != 2 || kinds[store.StoryCrew] != 1 || kinds[store.StoryMilestone] != 3 || len(stories) != 6 {
		t.Fatalf("the stories: %v, milestones %v: %+v", kinds, milestones, stories)
	}
	c := stories[len(stories)-1]
	for _, st := range stories {
		if st.Story == store.StoryCrew {
			c = st
		}
	}
	if c.Sailor != "Ann Bonny" || len(c.Named) != 1 || c.Named[0] != tom || c.Facts.Aboard != 4 || !c.Day.Equal(time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("the crew: %+v", c)
	}
	if other, _ := s.DayStories(ctx, world.ID, day.AddDate(0, 0, 1)); len(other) != 0 {
		t.Errorf("the next day's: %+v", other)
	}
	f, err := s.DayFigures(ctx, world.ID, world.Number, day, day.AddDate(0, 0, 1))
	if err != nil || f.Boats != 1 || f.Run < 12*1852-1 || f.Over != 0 {
		t.Errorf("the day's figures %+v, %v", f, err)
	}
	// The edition, set once.
	ranks := map[[16]byte]int{c.ID: 1}
	e := store.Edition{Day: day, Number: 3, Figures: store.Figures{Boats: 1, Crews: 1}}
	if err := s.SetEdition(ctx, epoch+1, world.ID, "discoveries", e, ranks); !errors.Is(err, store.ErrFenced) {
		t.Fatalf("set fenced out: %v", err)
	}
	if err := s.SetEdition(ctx, epoch, world.ID, "discoveries", e, ranks); err != nil {
		t.Fatal(err)
	}
	if err := s.SetEdition(ctx, epoch, world.ID, "discoveries", store.Edition{Day: day, Number: 3}, nil); !errors.Is(err, store.ErrEditionSet) {
		t.Fatalf("set twice: %v", err)
	}
	eds, err := s.Editions(ctx, world.ID)
	if err != nil || len(eds) != 1 || eds[0].Number != 3 || eds[0].Figures.Crews != 1 || eds[0].Day.Day() != 11 {
		t.Fatalf("the editions %+v, %v", eds, err)
	}
	ranked, err := s.RankedStories(ctx, world.ID, []time.Time{day})
	if err != nil || len(ranked) != 1 || ranked[0].ID != c.ID || ranked[0].Rank != 1 {
		t.Fatalf("ranked %+v, %v", ranked, err)
	}
	about, err := s.StoriesAbout(ctx, world.ID, tom, 5)
	if err != nil || len(about) != 1 || about[0].ID != c.ID {
		t.Errorf("about Tom %+v, %v", about, err)
	}
	if _, err := s.StrikeStory(ctx, world.ID, c.ID, true); err != nil {
		t.Fatal(err)
	}
	if about, _ := s.StoriesAbout(ctx, world.ID, tom, 5); len(about) != 0 {
		t.Errorf("struck, about Tom: %+v", about)
	}
	st, _ := s.DayStories(ctx, world.ID, day)
	for _, x := range st {
		if (x.ID == c.ID) != x.Struck {
			t.Errorf("struck: %+v", x)
		}
	}
	if _, err := s.StrikeStory(ctx, world.ID, [16]byte{9}, true); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("no such story: %v", err)
	}
	// The world in review.
	rv, err := s.WorldReview(ctx, world.ID, world.Number, 3)
	if err != nil || rv.Sailors != 1 || rv.Run < 12*1852-1 {
		t.Errorf("the review %+v, %v", rv, err)
	}
}
