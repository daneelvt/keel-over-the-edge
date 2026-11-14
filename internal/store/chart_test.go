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

// TestChartingsWritten: chartings and the stories they make are written
// in the fenced batch: a great discovery's, a sailor's first charting
// ever, and any other; a subject charted twice keeps its first credit;
// the names are copies, kept when the sailor's changes; and a writer
// fenced out writes none of it.
func TestChartingsWritten(t *testing.T) {
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
	epoch := take(t, newLease(t, u, "keel-a dev", store.LeaseOptions{}))
	p, err := store.OpenPersister(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	news := func(story string, score int, title, what string, island int32) *store.NewsItem {
		return &store.NewsItem{Story: story, Score: score, Title: title, What: what, Island: island, X: 10, Y: 20, Boat: "Gull", BoatKind: "skiff"}
	}
	rules := &store.NewsRules{Zone: "America/New_York", Column: "discoveries", FirstScore: 5}
	b := store.Batch{World: world.ID, Epoch: epoch, News: rules, Charting: []store.Charting{
		// Known from the start, and charted with it.
		{Subject: "island", Number: 0, Tick: 1, Worth: 5},
		{Subject: "feature", Number: 3, Tick: 1, Worth: 2, WithSubject: "island", WithNumber: 0},
		// Ann's cove, her first charting ever; her island, a great
		// discovery; and a lighthouse.
		{Subject: "place", Number: 200, Credited: true, Account: ann, Boat: 4, Tick: 89, X: 1, Y: 2, Worth: 1,
			News: news(store.StoryCharting, 1, "Pelican Cove", "a cove on Keyhole Rock", 7)},
		{Subject: "island", Number: 7, Credited: true, Account: ann, Boat: 4, Tick: 90, X: 1, Y: 2, Worth: 24,
			News: news(store.StoryGreat, 10, "Keyhole Rock", "an island of the rim", 7)},
		{Subject: "place", Number: 201, Credited: true, Account: ann, Boat: 4, Tick: 92, X: 1, Y: 2, Worth: 3,
			News: news(store.StoryCharting, 1, "Keyhole Light", "a lighthouse on Keyhole Rock", 7)},
	}}
	if err := p.Write(ctx, b); err != nil {
		t.Fatal(err)
	}
	for i, c := range b.Charting {
		if !c.Written {
			t.Errorf("charting %d not written", i)
		}
	}
	if c := b.Charting[3]; c.Sailor != "Ann Bonny" || c.AccountKind != "human" || time.Since(c.At) > time.Minute {
		t.Errorf("the island's credit: %+v", c)
	}
	// Charted again: kept as it was.
	again := store.Batch{World: world.ID, Epoch: epoch, News: rules, Charting: []store.Charting{{Subject: "island", Number: 7, Tick: 500, Worth: 24,
		Credited: true, Account: ann, News: news(store.StoryGreat, 10, "Keyhole Rock", "an island of the rim", 7)}}}
	if err := p.Write(ctx, again); err != nil {
		t.Fatal(err)
	}
	if again.Charting[0].Written {
		t.Error("a subject charted twice")
	}
	// The sailor's name changes; the credit keeps what it showed.
	if _, err := storetest.PoolOn(t, u).Exec(ctx, "UPDATE sailor SET name = 'Mary Read', name_key = 'maryread'"); err != nil {
		t.Fatal(err)
	}
	rows, err := s.Chartings(ctx, world.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 5 || rows[3].Sailor != "Ann Bonny" || rows[3].Tick != 90 || rows[0].Credited || rows[0].WithSubject != "island" {
		t.Fatalf("rows %+v", rows)
	}
	ny, _ := time.LoadLocation("America/New_York")
	stories, err := s.DayStories(ctx, world.ID, b.Charting[2].At.In(ny))
	if err != nil {
		t.Fatal(err)
	}
	if len(stories) != 3 {
		t.Fatalf("%d stories: %+v", len(stories), stories)
	}
	for i, want := range []struct {
		story string
		score int
		title string
	}{{store.StoryFirst, 5, "Pelican Cove"}, {store.StoryGreat, 10, "Keyhole Rock"}, {store.StoryCharting, 1, "Keyhole Light"}} {
		st := stories[i]
		if st.Story != want.story || st.Score != want.score || st.Title != want.title || st.Account != ann || st.Sailor != "Ann Bonny" ||
			st.Facts.Boat != "Gull" || st.Facts.BoatKind != "skiff" || st.Rank != 0 || st.Struck {
			t.Errorf("story %d: %+v", i, st)
		}
	}
	// Without the news's rules, a charting makes no story.
	quiet := store.Batch{World: world.ID, Epoch: epoch, Charting: []store.Charting{{Subject: "island", Number: 8, Credited: true, Account: ann, Boat: 4,
		Tick: 600, Worth: 1, News: news(store.StoryCharting, 1, "Gannet Holm", "an island", 8)}}}
	if err := p.Write(ctx, quiet); err != nil {
		t.Fatal(err)
	}
	if again, _ := s.DayStories(ctx, world.ID, b.Charting[2].At.In(ny)); len(again) != 3 {
		t.Errorf("%d stories after a write without the rules", len(again))
	}
	// Fenced out, the lease's epoch another's: nothing.
	err = p.Write(ctx, store.Batch{World: world.ID, Epoch: epoch + 1, Charting: []store.Charting{
		{Subject: "island", Number: 9, Credited: true, Account: ann, Boat: 4, Tick: 900, Worth: 1, News: news(store.StoryCharting, 1, "Gull Rock", "an island", 9)},
	}})
	if !errors.Is(err, store.ErrFenced) {
		t.Fatalf("a fenced write: %v", err)
	}
	if rows, _ := s.Chartings(ctx, world.ID); len(rows) != 6 {
		t.Errorf("%d rows after a fenced write", len(rows))
	}
}

// TestNoticesOff: the kinds switched off are kept on the account and read
// with its session.
func TestNoticesOff(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	hash := [32]byte{2}
	id, err := s.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", hash))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetNoticesOff(ctx, id, []string{"charted-great"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.Session(ctx, hash)
	if err != nil || len(got.Account.NoticesOff) != 1 || got.Account.NoticesOff[0] != "charted-great" {
		t.Fatalf("session %+v, %v", got.Account, err)
	}
	if err := s.SetNoticesOff(ctx, store.AccountID{9}, nil); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("no such account: %v", err)
	}
}
