// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestLifecycleMigration migrates a database with worlds begun by hand, as
// the builds before a world's end was kept left them: the ended worlds end
// when the next began, the active one has no end until keel sets it, and
// every world has a beginning.
func TestLifecycleMigration(t *testing.T) {
	ctx := context.Background()
	u := storetest.Empty(t)
	if _, err := store.Migrate(ctx, u, 10); err != nil {
		t.Fatal(err)
	}
	pool := storetest.PoolOn(t, u)
	for n, at := range []string{"2026-10-01T00:00:00Z", "2026-10-10T00:00:00Z", "2026-10-15T12:00:00Z"} {
		state := "ended"
		if n == 2 {
			state = "active"
		}
		var id [16]byte
		if err := pool.QueryRow(ctx, "INSERT INTO world (number, epoch, state, created_at) VALUES ($1, $2, $3, $2) RETURNING id", n+1, at, state).Scan(&id); err != nil {
			t.Fatal(err)
		}
		must(t, pool, "SELECT create_world_partitions($1)", id)
	}
	if _, err := store.Migrate(ctx, u, 0); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, "SELECT number, state, begins_at, ends_at FROM world ORDER BY number")
	if err != nil {
		t.Fatal(err)
	}
	type row struct {
		n            int
		state        string
		begins, ends *time.Time
	}
	got, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		var x row
		return x, r.Scan(&x.n, &x.state, &x.begins, &x.ends)
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []struct{ begins, ends string }{
		{"2026-10-01T00:00:00Z", "2026-10-10T00:00:00Z"},
		{"2026-10-10T00:00:00Z", "2026-10-15T12:00:00Z"},
		{"2026-10-15T12:00:00Z", ""},
	}
	for i, r := range got {
		if r.begins == nil || r.begins.UTC().Format(time.RFC3339) != want[i].begins {
			t.Errorf("world %d begins %v", r.n, r.begins)
		}
		switch {
		case want[i].ends == "" && r.ends != nil:
			t.Errorf("the active world %d ends %v", r.n, r.ends)
		case want[i].ends != "" && (r.ends == nil || r.ends.UTC().Format(time.RFC3339) != want[i].ends):
			t.Errorf("world %d ends %v, want %s", r.n, r.ends, want[i].ends)
		}
	}
	refused(t, exec(t, pool, "UPDATE world SET state = 'gone' WHERE number = 1"), "23514")
	// One next world at most, as one active.
	var id [16]byte
	if err := pool.QueryRow(ctx, "INSERT INTO world (number, epoch, state) VALUES (4, now(), 'next') RETURNING id").Scan(&id); err != nil {
		t.Fatal(err)
	}
	refused(t, exec(t, pool, "INSERT INTO world (number, epoch, state) VALUES (5, now(), 'next')"), "23505")
	// A boat taken by the falls is where it was.
	must(t, pool, "SELECT create_world_partitions($1)", id)
	must(t, pool, "INSERT INTO event (world_id, tick, kind, account_id, boat, x, y) VALUES ($1, 1, 'taken', $2, 1, 3, 4)", id, [16]byte{1})
	refused(t, exec(t, pool, "INSERT INTO event (world_id, tick, kind, account_id, boat) VALUES ($1, 1, 'taken', $2, 1)", id, [16]byte{1}), "23514")
}

// lifecycleStore is a migrated database, with its lease's epoch.
func lifecycleStore(t *testing.T) (*store.Store, *pgxpool.Pool, int64) {
	t.Helper()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	var epoch int64
	if err := pool.QueryRow(context.Background(), "UPDATE sim_lease SET epoch = epoch + 1 RETURNING epoch").Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	return s, pool, epoch
}

func TestNextWorldAndSwitch(t *testing.T) {
	ctx := context.Background()
	s, pool, lease := lifecycleStore(t)
	first, err := s.ActiveOrFirstWorld(ctx, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if first.BeginsAt.IsZero() || !first.EndsAt.IsZero() {
		t.Fatalf("the first world: %+v", first)
	}
	end := time.Date(2026, 11, 1, 23, 0, 0, 0, time.UTC)
	if err := s.SetWorldEnd(ctx, lease+1, first.ID, end); !errors.Is(err, store.ErrFenced) {
		t.Fatalf("another epoch set the end: %v", err)
	}
	if err := s.SetWorldEnd(ctx, lease, first.ID, end); err != nil {
		t.Fatal(err)
	}
	if w, err := s.ActiveWorld(ctx); err != nil || !w.EndsAt.Equal(end) {
		t.Fatalf("the active world: %+v %v", w, err)
	}
	if _, err := s.NextWorld(ctx); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a next world before any: %v", err)
	}
	if _, err := s.CreateNextWorld(ctx, lease+1, 7, 4, end); !errors.Is(err, store.ErrFenced) {
		t.Fatalf("another epoch made a next world: %v", err)
	}
	next, err := s.CreateNextWorld(ctx, lease, 7, 4, end)
	if err != nil {
		t.Fatal(err)
	}
	if next.Number != 2 {
		t.Fatalf("next world %+v", next)
	}
	if _, err := s.CreateNextWorld(ctx, lease, 8, 4, end); !errors.Is(err, store.ErrNoNext) {
		t.Fatalf("a second next world: %v", err)
	}
	nw, err := s.NextWorld(ctx)
	if err != nil || nw.Number != 2 || nw.Seed != 7 || nw.Generator != 4 || nw.Stored {
		t.Fatalf("the next world: %+v %v", nw, err)
	}
	if seed, _, ok, err := s.WorldSeed(ctx, next.ID); err != nil || !ok || seed != 7 {
		t.Fatalf("the next world's seed %d %v %v", seed, ok, err)
	}
	b := testBundle(t)
	b.Seed = 7
	if err := s.StoreBundle(ctx, next.ID, lease, b); err != nil {
		t.Fatal(err)
	}
	if nw, err = s.NextWorld(ctx); err != nil || !nw.Stored || nw.Attempts != 2 || nw.GenerationMs != 3400 {
		t.Fatalf("the next world stored: %+v %v", nw, err)
	}

	// One active world at every instant: a reader polls through the
	// switch.
	var stop atomic.Bool
	var seen sync.Map
	var wg sync.WaitGroup
	wg.Go(func() {
		for !stop.Load() {
			var n int
			if err := pool.QueryRow(ctx, "SELECT count(*) FROM world WHERE state = 'active'").Scan(&n); err != nil {
				t.Error(err)
				return
			}
			seen.Store(n, true)
		}
	})
	time.Sleep(20 * time.Millisecond)
	if _, err := s.SwitchWorld(ctx, lease, 5, next.ID, end, end.Add(time.Hour)); !errors.Is(err, store.ErrNotActive) {
		t.Errorf("another world's number: %v", err)
	}
	if _, err := s.SwitchWorld(ctx, lease, 1, [16]byte{9}, end, end.Add(time.Hour)); !errors.Is(err, store.ErrNoNext) {
		t.Errorf("no such next world: %v", err)
	}
	if _, err := s.SwitchWorld(ctx, lease+1, 1, next.ID, end, end.Add(time.Hour)); !errors.Is(err, store.ErrFenced) {
		t.Errorf("another epoch's switch: %v", err)
	}
	ends := end.Add(7 * 24 * time.Hour)
	w, err := s.SwitchWorld(ctx, lease, 1, next.ID, end, ends)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	stop.Store(true)
	wg.Wait()
	seen.Range(func(k, _ any) bool {
		if k.(int) != 1 {
			t.Errorf("%d active worlds seen", k)
		}
		return true
	})
	if w.Number != 2 || !w.Epoch.Equal(end) || !w.BeginsAt.Equal(end) || !w.EndsAt.Equal(ends) {
		t.Fatalf("the new world %+v", w)
	}
	active, err := s.ActiveWorld(ctx)
	if err != nil || active.ID != next.ID || !active.Epoch.Equal(end) || !active.EndsAt.Equal(ends) {
		t.Fatalf("active %+v %v", active, err)
	}
	var state string
	var ended time.Time
	if err := pool.QueryRow(ctx, "SELECT state, ends_at FROM world WHERE number = 1").Scan(&state, &ended); err != nil || state != "ended" || !ended.Equal(end) {
		t.Fatalf("the old world %s %v %v", state, ended, err)
	}
	recent, err := s.RecentWorlds(ctx, 5)
	if err != nil || len(recent) != 2 || recent[0].Number != 2 || recent[0].State != store.WorldActive || recent[1].State != store.WorldEnded {
		t.Fatalf("recent worlds %+v %v", recent, err)
	}
}

// partitionsOf lists the tables named for world n.
func partitionsOf(t *testing.T, pool *pgxpool.Pool, n int) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), "SELECT relname::text FROM pg_class WHERE relname ~ ('_w' || $1::integer || '$') AND relkind IN ('r', 'p') ORDER BY 1", n)
	if err != nil {
		t.Fatal(err)
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	return names
}

func TestDiscardNextWorld(t *testing.T) {
	ctx := context.Background()
	s, pool, lease := lifecycleStore(t)
	if _, err := s.ActiveOrFirstWorld(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	next, err := s.CreateNextWorld(ctx, lease, 7, 4, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.StoreBundle(ctx, next.ID, lease, testBundle(t)); err != nil {
		t.Fatal(err)
	}
	if got := partitionsOf(t, pool, 2); len(got) != 9 {
		t.Fatalf("the next world's partitions: %v", got)
	}
	if err := s.DiscardNextWorld(ctx, lease, 3); !errors.Is(err, store.ErrNoNext) {
		t.Fatalf("another number: %v", err)
	}
	if err := s.DiscardNextWorld(ctx, lease, 2); err != nil {
		t.Fatal(err)
	}
	if got := partitionsOf(t, pool, 2); len(got) != 0 {
		t.Fatalf("partitions left: %v", got)
	}
	if _, err := s.NextWorld(ctx); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the next world after: %v", err)
	}
	// Its number is the next world's again.
	again, err := s.CreateNextWorld(ctx, lease, 8, 4, time.Now())
	if err != nil || again.Number != 2 {
		t.Fatalf("again: %+v %v", again, err)
	}
	if err := s.StoreBundle(ctx, again.ID, lease, testBundle(t)); err != nil {
		t.Fatal(err)
	}
}

// TestDropWorld drops an ended world's partitions while another world's
// events are written, none waiting long; and finishes a detach that was
// interrupted.
func TestDropWorld(t *testing.T) {
	ctx := context.Background()
	s, pool, lease := lifecycleStore(t)
	old, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.StoreBundle(ctx, old.ID, lease, testBundle(t)); err != nil {
		t.Fatal(err)
	}
	for i := range 200 {
		must(t, pool, "INSERT INTO event (world_id, tick, kind, account_id, boat) VALUES ($1, $2, 'launched', $3, 1)", old.ID, i, [16]byte{1})
	}
	next, err := s.CreateNextWorld(ctx, lease, 7, 4, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, err := s.SwitchWorld(ctx, lease, 1, next.ID, now.Add(-time.Hour), now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got, err := s.WorldsToDrop(ctx, now.Add(-2*time.Hour)); err != nil || len(got) != 0 {
		t.Fatalf("worlds to drop before the end: %+v %v", got, err)
	}
	drop, err := s.WorldsToDrop(ctx, now)
	if err != nil || len(drop) != 1 || drop[0].Number != 1 {
		t.Fatalf("worlds to drop: %+v %v", drop, err)
	}

	// An interrupted detach: a reader's open transaction keeps the detach
	// waiting, and its statement timeout cancels it, the partition left
	// pending.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM event").Scan(&n); err != nil {
		t.Fatal(err)
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	must(t, pool, "SELECT 1")
	if _, err := conn.Exec(ctx, "SET statement_timeout = 300"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, "ALTER TABLE event DETACH PARTITION event_w1 CONCURRENTLY"); err == nil {
		t.Fatal("the detach was not interrupted")
	}
	_, _ = conn.Exec(ctx, "RESET statement_timeout")
	conn.Release()
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var pending bool
	if err := pool.QueryRow(ctx, "SELECT inhdetachpending FROM pg_inherits WHERE inhrelid = 'event_w1'::regclass").Scan(&pending); err != nil || !pending {
		t.Fatalf("the detach is not pending: %v %v", pending, err)
	}

	// The new world's writes go on while the old one is dropped.
	var worst atomic.Int64
	var stop atomic.Bool
	var wg sync.WaitGroup
	wg.Go(func() {
		for i := 0; !stop.Load(); i++ {
			start := time.Now()
			if _, err := pool.Exec(ctx, "INSERT INTO event (world_id, tick, kind, account_id, boat) VALUES ($1, $2, 'launched', $3, 1)", next.ID, i, [16]byte{2}); err != nil {
				t.Error(err)
				return
			}
			if d := time.Since(start); d.Nanoseconds() > worst.Load() {
				worst.Store(d.Nanoseconds())
			}
			time.Sleep(2 * time.Millisecond)
		}
	})
	if err := s.DropWorld(ctx, lease, drop[0]); err != nil {
		t.Fatal(err)
	}
	stop.Store(true)
	wg.Wait()
	if d := time.Duration(worst.Load()); d > 100*time.Millisecond {
		t.Errorf("a write waited %v while the world was dropped", d)
	}
	if got := partitionsOf(t, pool, 1); len(got) != 0 {
		t.Fatalf("partitions left: %v", got)
	}
	var state string
	if err := pool.QueryRow(ctx, "SELECT state FROM world WHERE number = 1").Scan(&state); err != nil || state != store.WorldDropped {
		t.Fatalf("the dropped world's row: %q %v", state, err)
	}
	if got, err := s.WorldsToDrop(ctx, time.Now()); err != nil || len(got) != 0 {
		t.Fatalf("worlds to drop after: %+v %v", got, err)
	}
	// Again changes nothing.
	if err := s.DropPartitions(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if got := partitionsOf(t, pool, 2); len(got) != 9 {
		t.Fatalf("the active world's partitions: %v", got)
	}
}

func TestJobClaims(t *testing.T) {
	ctx := context.Background()
	s, pool, lease := lifecycleStore(t)
	due := time.Date(2026, 11, 1, 7, 0, 0, 0, time.UTC)
	c, ok, err := s.ClaimJob(ctx, lease, "sessions", due, time.Minute)
	if err != nil || !ok || c.Attempt != 1 {
		t.Fatalf("claim: %+v %v %v", c, ok, err)
	}
	if _, ok, err := s.ClaimJob(ctx, lease, "sessions", due, time.Minute); ok || err != nil {
		t.Fatalf("a second claim of one due time: %v %v", ok, err)
	}
	if _, ok, err := s.ClaimJob(ctx, lease+1, "sessions", due.Add(24*time.Hour), time.Minute); ok || err != nil {
		t.Fatalf("a claim by another epoch: %v %v", ok, err)
	}
	if err := s.FinishJob(ctx, c, store.JobFailed, "the database went away"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.ClaimJob(ctx, lease, "sessions", due, time.Hour); ok {
		t.Fatal("a failed run claimed again before its retry")
	}
	c, ok, err = s.ClaimJob(ctx, lease, "sessions", due, 0)
	if err != nil || !ok || c.Attempt != 2 {
		t.Fatalf("the retry: %+v %v %v", c, ok, err)
	}
	if err := s.FinishJob(ctx, c, store.JobOK, "3 deleted"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.ClaimJob(ctx, lease, "sessions", due, 0); ok {
		t.Fatal("a run done claimed again")
	}
	r, err := s.JobRunOf(ctx, "sessions", due)
	if err != nil || r.Outcome != store.JobOK || r.Detail != "3 deleted" || r.Attempts != 2 || r.Finished.IsZero() {
		t.Fatalf("the run: %+v %v", r, err)
	}
	// A run whose process stopped is the next lease holder's.
	stale, ok, err := s.ClaimJob(ctx, lease, "worlds", due, 0)
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	if _, ok, _ := s.ClaimJob(ctx, lease, "worlds", due, 0); ok {
		t.Fatal("a run under way claimed by its own process")
	}
	must(t, pool, "UPDATE sim_lease SET epoch = epoch + 1")
	taken, ok, err := s.ClaimJob(ctx, lease+1, "worlds", due, 0)
	if err != nil || !ok || taken.Attempt != 2 {
		t.Fatalf("taken over: %+v %v %v", taken, ok, err)
	}
	// The stopped process's finish changes nothing now.
	if err := s.FinishJob(ctx, stale, store.JobFailed, "late"); err != nil {
		t.Fatal(err)
	}
	if err := s.FinishJob(ctx, taken, store.JobSkipped, "none"); err != nil {
		t.Fatal(err)
	}
	runs, err := s.JobRuns(ctx, 10)
	if err != nil || len(runs) != 2 || runs[0].Job != "worlds" || runs[0].Outcome != store.JobSkipped {
		t.Fatalf("runs %+v %v", runs, err)
	}
	outcomes, err := s.JobOutcomes(ctx)
	if err != nil || len(outcomes) != 2 {
		t.Fatalf("outcomes %+v %v", outcomes, err)
	}
	for _, o := range outcomes {
		switch o.Job {
		case "sessions":
			if o.Outcome != store.JobOK || o.LastOK.IsZero() {
				t.Errorf("%+v", o)
			}
		case "worlds":
			if o.Outcome != store.JobSkipped || !o.LastOK.IsZero() {
				t.Errorf("%+v", o)
			}
		}
	}
	if n, err := s.DeleteJobRuns(ctx, time.Now().Add(time.Minute)); err != nil || n != 2 {
		t.Fatalf("deleted %d runs (%v)", n, err)
	}
}

func TestDeleteSessions(t *testing.T) {
	ctx := context.Background()
	s, pool, _ := lifecycleStore(t)
	acc := uuidOf(t, pool, "INSERT INTO account (kind, saved_at) VALUES ('human', now()) RETURNING id")
	for i := range 2500 {
		at := "now() - interval '500 days'"
		if i%5 == 0 {
			at = "now() - interval '10 days'"
		}
		must(t, pool, "INSERT INTO session (account_id, token_hash, last_seen_at) VALUES ($1, sha256($2::text::bytea), "+at+")", acc, strings.Repeat("x", i+1))
	}
	n, err := s.DeleteSessions(ctx, time.Now().Add(-400*24*time.Hour))
	if err != nil || n != 2000 {
		t.Fatalf("deleted %d (%v)", n, err)
	}
	var left int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM session").Scan(&left); err != nil || left != 500 {
		t.Fatalf("%d left (%v)", left, err)
	}
}

func TestWorldNews(t *testing.T) {
	ctx := context.Background()
	s, _, lease := lifecycleStore(t)
	w, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	end := time.Date(2026, 11, 1, 23, 0, 0, 0, time.UTC)
	n := store.WorldNews{Column: "notices", Number: 1, Title: "PORT ROYAL", What: "falls", X: -36, Y: 71, EndsAt: end}
	if err := s.WriteWorldNews(ctx, lease+1, w.ID, n); !errors.Is(err, store.ErrFenced) {
		t.Fatalf("another epoch wrote: %v", err)
	}
	if err := s.WriteWorldNews(ctx, lease, w.ID, n); err != nil {
		t.Fatal(err)
	}
	items, err := s.News(ctx, w.ID, nil, 10)
	if err != nil || len(items) != 1 {
		t.Fatal(items, err)
	}
	if it := items[0]; it.Subject != store.SubjectWorld || it.Column != "notices" || !it.EndsAt.Equal(end) || it.Title != "PORT ROYAL" {
		t.Fatalf("%+v", it)
	}
}

// A gale warning is in the news once, however often it is written: after
// a restart, the process writes it again and nothing changes.
func TestGaleNews(t *testing.T) {
	ctx := context.Background()
	s, _, lease := lifecycleStore(t)
	w, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	n := store.GaleNews{Column: "notices", Number: 41, Title: "GALE WARNING", What: "Southwesterly gale 8 expected soon, south-west of Gannet Holm", X: -3000, Y: -2500}
	if _, err := s.WriteGaleNews(ctx, lease+1, w.ID, n); !errors.Is(err, store.ErrFenced) {
		t.Fatalf("another epoch wrote: %v", err)
	}
	for i, want := range []bool{true, false, false} {
		if written, err := s.WriteGaleNews(ctx, lease, w.ID, n); err != nil || written != want {
			t.Fatalf("write %d: written %v, %v", i, written, err)
		}
	}
	n.Number = 42
	if written, err := s.WriteGaleNews(ctx, lease, w.ID, n); err != nil || !written {
		t.Fatalf("another warning: written %v, %v", written, err)
	}
	items, err := s.News(ctx, w.ID, nil, 10)
	if err != nil || len(items) != 2 {
		t.Fatal(items, err)
	}
	if it := items[1]; it.Subject != store.SubjectGale || it.Number != 41 || it.What != n.What {
		t.Fatalf("%+v", it)
	}
}
