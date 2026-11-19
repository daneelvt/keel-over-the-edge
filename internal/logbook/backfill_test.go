// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"context"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// The backfill copies a kept world's chartings, voyages, closest
// approaches and bumps from before the log into it, as the live log
// writes them; run twice, it writes once; and what was recorded after the
// log began is left to the live log.
func TestBackfill(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	world, err := s.ActiveOrFirstWorld(ctx, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.CreateAccount(ctx, storetest.NewAccount("Ann Bonny", "annbonny", [32]byte{1}))
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateAccount(ctx, storetest.NewAccount("Tom Bowline", "tornbowline", [32]byte{2}))
	if err != nil {
		t.Fatal(err)
	}
	l, err := store.NewLease(u, store.LeaseOptions{Holder: "keel-a dev"})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Release(ctx)
	lease, err := l.Take(ctx)
	if err != nil {
		t.Fatal(err)
	}
	p, err := store.OpenPersister(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	// Ann launches, bumps Tom (her fault), and goes over 12 m from the
	// lip's closest; Tom launches and returns. Ann charts an island.
	err = p.Write(ctx, store.Batch{World: world.ID, Epoch: lease, Events: []store.Event{
		{Tick: 30, Kind: store.EventLaunched, Account: a, Boat: 4},
		{Tick: 40, Kind: store.EventLaunched, Account: b, Boat: 5},
		{Tick: 300, Kind: store.EventBump, Account: a, Boat: 4, Other: b, OtherBoat: 5, Article: "10", Fault: store.FaultAccount, X: 1, Y: 2},
		{Tick: 900, Kind: store.EventOver, Account: a, Boat: 4, X: 8334, Y: 0},
		{Tick: 900, Kind: store.EventApproach, Account: a, Boat: 4, X: 8320, Y: 0, Distance: 12},
		{Tick: 1200, Kind: store.EventReturned, Account: b, Boat: 5},
	}, Charting: []store.Charting{{Subject: "island", Number: 7, Credited: true, Account: a, Boat: 4, Tick: 600, Worth: 24}}})
	if err != nil {
		t.Fatal(err)
	}
	pool := storetest.PoolOn(t, u)
	// The log began after all this.
	if _, err := pool.Exec(ctx, "UPDATE setting SET log_from = now() + interval '1 minute'"); err != nil {
		t.Fatal(err)
	}
	count := func() (v, e int) {
		t.Helper()
		if err := pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM log_voyage), (SELECT count(*) FROM log_entry)").Scan(&v, &e); err != nil {
			t.Fatal(err)
		}
		return v, e
	}
	cfg := BackfillConfig{Store: s, Lease: lease, Catalog: testCatalog(t), Fall: 150}
	done, err := Backfill(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if done.Worlds != 1 || done.Voyages != 2 || done.Entries != 3 {
		t.Errorf("the backfill: %+v", done)
	}
	v1, e1 := count()
	if _, err := Backfill(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	if v2, e2 := count(); v2 != v1 || e2 != e1 || v1 != 2 {
		t.Errorf("run twice: %d voyages and %d entries, then %d and %d", v1, e1, v2, e2)
	}
	vs, err := s.LogVoyages(ctx, a, world.Number)
	if err != nil {
		t.Fatal(err)
	}
	if len(vs) != 1 || vs[0].How != store.LogOver || !vs[0].Survived || vs[0].Least != 12 || vs[0].BumpsAt != 1 || vs[0].Logged ||
		!vs[0].Began.Equal(world.Epoch.Add(time.Second)) {
		t.Errorf("Ann's voyage: %+v", vs)
	}
	es, err := s.LogEntries(ctx, b, world.Number)
	if err != nil {
		t.Fatal(err)
	}
	if len(es) != 1 || es[0].Kind != store.LogBump || es[0].Fault != store.FaultTheirs || es[0].Other != a || es[0].OtherName != "Ann Bonny" {
		t.Errorf("Tom's entries: %+v", es)
	}
	tot, err := s.LogTotals(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	if tot.Charted != 1 || tot.Falls != 1 || !tot.LoggedFrom.IsZero() {
		t.Errorf("Ann's totals: %+v", tot)
	}

	// Recorded after the log began: the live log's, not the backfill's.
	if _, err := pool.Exec(ctx, "UPDATE setting SET log_from = now() - interval '1 hour'"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "DELETE FROM log_voyage; DELETE FROM log_entry"); err != nil {
		t.Fatal(err)
	}
	done, err = Backfill(ctx, cfg)
	if err != nil || done.Worlds != 0 {
		t.Errorf("after the log began: %+v, %v", done, err)
	}
}
