// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// The simulation's lease, against the test database: two leases in one
// process stand for two servers. Advisory locks belong to a database, so
// each test's database is a server's of its own.

func newLease(t *testing.T, u, holder string, opt store.LeaseOptions) *store.Lease {
	t.Helper()
	opt.Holder = holder
	l, err := store.NewLease(u, opt)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Release(context.Background()) })
	return l
}

func take(t *testing.T, l *store.Lease) int64 {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	epoch, err := l.Take(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return epoch
}

// leasePID is the backend of the lease's connection.
func leasePID(t *testing.T, pool *pgxpool.Pool) int32 {
	t.Helper()
	var pid int32
	err := pool.QueryRow(context.Background(), `SELECT pid FROM pg_stat_activity
		WHERE datname = current_database() AND application_name = 'keel sim lease'`).Scan(&pid)
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

// terminate ends a backend's session, as the server does when it restarts
// or its keepalives give up, and waits until it has gone.
func terminate(t *testing.T, pool *pgxpool.Pool, pid int32) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "SELECT pg_terminate_backend($1)", pid); err != nil {
		t.Fatal(err)
	}
	for range 200 {
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE pid = $1", pid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("backend %d is still there", pid)
}

// TestLeaseHandover: a second process waits, told who holds the lease,
// while the first holds it; it takes the lease within a poll of the
// first's release, with the epoch one higher.
func TestLeaseHandover(t *testing.T) {
	s, u := storetest.Store(t, store.Options{})
	first := newLease(t, u, "keel-a dev", store.LeaseOptions{})
	if epoch := take(t, first); epoch != 1 {
		t.Fatalf("the first epoch is %d", epoch)
	}
	var told atomic.Value
	var beats atomic.Int64
	second := newLease(t, u, "keel-b dev", store.LeaseOptions{
		Waiting: func(holder string) { told.Store(holder) },
		Beat:    func() { beats.Add(1) },
	})
	took := make(chan int64, 1)
	go func() {
		epoch, err := second.Take(context.Background())
		if err != nil {
			t.Error(err)
		}
		took <- epoch
	}()
	time.Sleep(1500 * time.Millisecond)
	select {
	case <-took:
		t.Fatal("the second took the lease while the first held it")
	default:
	}
	if told.Load() != "keel-a dev" || beats.Load() < 2 {
		t.Fatalf("while waiting: told %v, %d beats", told.Load(), beats.Load())
	}
	released := time.Now()
	first.Release(context.Background())
	if epoch := <-took; epoch != 2 {
		t.Fatalf("the second's epoch is %d", epoch)
	}
	if d := time.Since(released); d > store.LeasePoll+250*time.Millisecond {
		t.Fatalf("taken %v after the release", d)
	}
	st, err := s.Lease(context.Background())
	if err != nil || st.Epoch != 2 || st.Holder != "keel-b dev" || time.Since(st.Since) > time.Minute {
		t.Fatalf("the lease's row: %+v, %v", st, err)
	}
	// Giving up the wait is at once.
	third := newLease(t, u, "keel-c dev", store.LeaseOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(200 * time.Millisecond); cancel() }()
	start := time.Now()
	if _, err := third.Take(ctx); !errors.Is(err, context.Canceled) || time.Since(start) > time.Second {
		t.Fatalf("a wait cancelled: %v after %v", err, time.Since(start))
	}
}

// TestLeaseRetaken: the lease's session ended by the server is seen within
// a few seconds, and taken back with the epoch unchanged; the holder
// carries on.
func TestLeaseRetaken(t *testing.T) {
	_, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	outcomes := make(chan string, 4)
	l := newLease(t, u, "keel-a dev", store.LeaseOptions{Lost: func(o string) { outcomes <- o }})
	epoch := take(t, l)
	ctx, cancel := context.WithCancel(context.Background())
	watched := make(chan error, 1)
	go func() { watched <- l.Watch(ctx) }()
	time.Sleep(1200 * time.Millisecond)
	pid := leasePID(t, pool)
	killed := time.Now()
	terminate(t, pool, pid)
	select {
	case o := <-outcomes:
		if o != "retaken" {
			t.Fatalf("outcome %q", o)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the lost connection was not seen")
	}
	if d := time.Since(killed); d > 4*time.Second {
		t.Fatalf("seen and taken back %v after the session ended", d)
	}
	if l.Epoch() != epoch || leasePID(t, pool) == pid {
		t.Fatalf("epoch %d, was %d", l.Epoch(), epoch)
	}
	cancel()
	if err := <-watched; err != nil {
		t.Fatal(err)
	}
}

// TestLeaseLostToAnother: while the holder's session is gone another
// process takes the lease: the holder, back, finds the epoch moved and
// stops; and a batch it writes under its old epoch is refused, nothing of
// it written.
func TestLeaseLostToAnother(t *testing.T) {
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	world, err := s.ActiveOrFirstWorld(context.Background(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// A long ping: the other process takes and gives the lease up before the
	// holder looks again.
	l := newLease(t, u, "keel-a dev", store.LeaseOptions{Ping: 2 * time.Second, Retake: 2 * time.Second})
	epoch := take(t, l)
	watched := make(chan error, 1)
	go func() { watched <- l.Watch(context.Background()) }()
	terminate(t, pool, leasePID(t, pool))
	other := newLease(t, u, "keel-b dev", store.LeaseOptions{})
	if e := take(t, other); e != epoch+1 {
		t.Fatalf("the other's epoch %d", e)
	}
	other.Release(context.Background())
	select {
	case err := <-watched:
		if !errors.Is(err, store.ErrLeaseLost) {
			t.Fatalf("watch: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the holder carried on")
	}

	p, err := store.OpenPersister(context.Background(), u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	err = p.Write(context.Background(), store.Batch{
		World: world.ID, Epoch: epoch,
		Events:     []store.Event{{Tick: 5, Kind: store.EventLaunched, Account: [16]byte{1}, Boat: 1}},
		Checkpoint: &store.Checkpoint{Tick: 5, Format: 4, Build: "dev", Catalog: "c", Layout: 1, Boats: 1, Data: []byte{1}},
	})
	if !errors.Is(err, store.ErrFenced) {
		t.Fatalf("a write under the old epoch: %v", err)
	}
	if _, err := s.LatestCheckpoint(context.Background(), world.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a checkpoint was written: %v", err)
	}
	var n int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM event").Scan(&n); err != nil || n != 0 {
		t.Fatalf("%d events written, %v", n, err)
	}

	// Taken back by another process while the holder is still away: the
	// holder never gets the lock and gives up when its time is up.
	third := newLease(t, u, "keel-c dev", store.LeaseOptions{Retake: time.Second})
	take(t, third)
	go func() { watched <- third.Watch(context.Background()) }()
	time.Sleep(1200 * time.Millisecond)
	fourth := newLease(t, u, "keel-d dev", store.LeaseOptions{})
	terminate(t, pool, leasePID(t, pool))
	take(t, fourth)
	select {
	case err := <-watched:
		if !errors.Is(err, store.ErrLeaseLost) {
			t.Fatalf("watch: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the holder carried on")
	}
}

// TestRaiseWaitsForTheFence: a new holder's raise of the epoch waits for
// a transaction of the old holder's that has read the epoch FOR SHARE, so
// nothing the old one writes lands after the new one has taken over.
func TestRaiseWaitsForTheFence(t *testing.T) {
	_, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var epoch int64
	if err := tx.QueryRow(context.Background(), "SELECT epoch FROM sim_lease FOR SHARE").Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	l := newLease(t, u, "keel-b dev", store.LeaseOptions{})
	took := make(chan int64, 1)
	go func() {
		e, err := l.Take(context.Background())
		if err != nil {
			t.Error(err)
		}
		took <- e
	}()
	select {
	case <-took:
		t.Fatal("the epoch was raised under an open fenced transaction")
	case <-time.After(time.Second):
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-took:
		if e != epoch+1 {
			t.Fatalf("epoch %d", e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the raise never came")
	}
}

// TestPersisterWrites: events in order and the checkpoint, replaced each
// time, in one transaction under the holder's epoch.
func TestPersisterWrites(t *testing.T) {
	s, u := storetest.Store(t, store.Options{})
	world, err := s.ActiveOrFirstWorld(context.Background(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.LatestCheckpoint(context.Background(), world.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a checkpoint before any: %v", err)
	}
	epoch := take(t, newLease(t, u, "keel-a dev", store.LeaseOptions{}))
	p, err := store.OpenPersister(context.Background(), u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	for i, tick := range []int64{100, 250} {
		b := store.Batch{World: world.ID, Epoch: epoch, Checkpoint: &store.Checkpoint{
			Tick: tick, Format: 4, Build: "dev", Catalog: "abc", Layout: 7, Boats: i + 1, Data: []byte{byte(i), 2, 3},
		}}
		for k := range 3 {
			b.Events = append(b.Events, store.Event{Tick: tick + int64(k), Kind: store.EventExpired, Account: [16]byte{byte(k)}, Boat: uint64(k)})
		}
		if err := p.Write(context.Background(), b); err != nil {
			t.Fatal(err)
		}
	}
	c, err := s.LatestCheckpoint(context.Background(), world.ID)
	if err != nil {
		t.Fatal(err)
	}
	if c.Tick != 250 || c.Format != 4 || c.Build != "dev" || c.Catalog != "abc" || c.Layout != 7 || c.Epoch != epoch || c.Boats != 2 ||
		string(c.Data) != "\x01\x02\x03" || time.Since(c.WrittenAt) > time.Minute {
		t.Fatalf("checkpoint %+v", c)
	}
	pool := storetest.PoolOn(t, u)
	rows, err := pool.Query(context.Background(), "SELECT tick FROM event ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	ticks, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil || len(ticks) != 6 || ticks[0] != 100 || ticks[5] != 252 {
		t.Fatalf("events %v, %v", ticks, err)
	}
}
