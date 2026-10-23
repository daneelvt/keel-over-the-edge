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

// TestChartingsWritten: chartings and the news they make are written in
// the fenced batch; a subject charted twice keeps its first credit; a
// sailor's places about an island within the fold are folded into its
// item; the names are copies, kept when the sailor's changes; and a writer
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
	news := func(title, what string, island int32, fold bool) *store.NewsItem {
		return &store.NewsItem{Column: "discoveries", Title: title, What: what, Island: island, Fold: fold, X: 10, Y: 20}
	}
	b := store.Batch{World: world.ID, Epoch: epoch, FoldWithin: 10 * time.Minute, Charting: []store.Charting{
		// Known from the start, and charted with it.
		{Subject: "island", Number: 0, Tick: 1, Worth: 5},
		{Subject: "feature", Number: 3, Tick: 1, Worth: 2, WithSubject: "island", WithNumber: 0},
		// Ann's island, its cove folded into its item, and a lighthouse of
		// its own.
		{Subject: "island", Number: 7, Credited: true, Account: ann, Boat: 4, Tick: 90, X: 1, Y: 2, Worth: 24,
			News: news("Keyhole Rock", "an island of the rim", 7, false)},
		{Subject: "place", Number: 200, Credited: true, Account: ann, Boat: 4, Tick: 91, X: 1, Y: 2, Worth: 1,
			News: news("Pelican Cove", "a cove on Keyhole Rock", 7, true)},
		{Subject: "place", Number: 201, Credited: true, Account: ann, Boat: 4, Tick: 92, X: 1, Y: 2, Worth: 3,
			News: news("Keyhole Light", "a lighthouse on Keyhole Rock", 7, false)},
	}}
	if err := p.Write(ctx, b); err != nil {
		t.Fatal(err)
	}
	for i, c := range b.Charting {
		if !c.Written {
			t.Errorf("charting %d not written", i)
		}
	}
	if c := b.Charting[2]; c.Sailor != "Ann Bonny" || c.AccountKind != "human" || time.Since(c.At) > time.Minute {
		t.Errorf("the island's credit: %+v", c)
	}
	// Charted again: kept as it was.
	again := store.Batch{World: world.ID, Epoch: epoch, Charting: []store.Charting{{Subject: "island", Number: 7, Tick: 500, Worth: 24}}}
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
	if len(rows) != 5 || rows[2].Sailor != "Ann Bonny" || rows[2].Tick != 90 || rows[0].Credited || rows[0].WithSubject != "island" {
		t.Fatalf("rows %+v", rows)
	}
	items, err := s.News(ctx, world.ID, nil, 40)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("%d items: %+v", len(items), items)
	}
	island := items[1]
	if items[0].Title != "Keyhole Light" || island.Title != "Keyhole Rock" || island.Sailor != "Ann Bonny" ||
		len(island.Also) != 1 || island.Also[0].Title != "Pelican Cove" {
		t.Errorf("items %+v", items)
	}
	// Paged: before the newest, the other.
	older, err := s.News(ctx, world.ID, &items[0].ID, 40)
	if err != nil || len(older) != 1 || older[0].Title != "Keyhole Rock" {
		t.Errorf("before the newest: %+v, %v", older, err)
	}
	// Fenced out, the lease's epoch another's: nothing.
	err = p.Write(ctx, store.Batch{World: world.ID, Epoch: epoch + 1, Charting: []store.Charting{
		{Subject: "island", Number: 9, Credited: true, Account: ann, Boat: 4, Tick: 900, Worth: 1, News: news("Gull Rock", "an island", 9, false)},
	}})
	if !errors.Is(err, store.ErrFenced) {
		t.Fatalf("a fenced write: %v", err)
	}
	if rows, _ := s.Chartings(ctx, world.ID); len(rows) != 5 {
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
