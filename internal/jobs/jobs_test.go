// SPDX-License-Identifier: AGPL-3.0-only

package jobs

import (
	"context"
	"errors"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// memStore keeps runs as the store does: one for each job and due time,
// claimed again only once failed for its retry, or by a later epoch while
// unfinished; claimed only by the lease's epoch.
type memStore struct {
	mu    sync.Mutex
	epoch int64
	runs  map[string]*memRun
	ids   int
}

type memRun struct {
	outcome  string
	finished time.Time
	epoch    int64
	attempts int
	id       [16]byte
}

func newMemStore(epoch int64) *memStore { return &memStore{epoch: epoch, runs: map[string]*memRun{}} }

func key(job string, due time.Time) string { return job + " " + due.UTC().Format(time.RFC3339Nano) }

func (m *memStore) ClaimJob(_ context.Context, lease int64, job string, due time.Time, retry time.Duration) (store.JobClaim, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if lease != m.epoch {
		return store.JobClaim{}, false, nil
	}
	r := m.runs[key(job, due)]
	switch {
	case r == nil:
		r = &memRun{}
		m.runs[key(job, due)] = r
	case r.outcome == store.JobFailed && time.Since(r.finished) > retry:
	case r.outcome == "" && r.epoch < lease:
	default:
		return store.JobClaim{}, false, nil
	}
	m.ids++
	r.id = [16]byte{byte(m.ids)}
	r.outcome, r.epoch = "", lease
	r.attempts++
	return store.JobClaim{ID: r.id, Attempt: r.attempts, Job: job, Due: due}, true, nil
}

func (m *memStore) FinishJob(_ context.Context, c store.JobClaim, outcome, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.runs[key(c.Job, c.Due)]
	if r.id == c.ID && r.outcome == "" {
		r.outcome, r.finished = outcome, time.Now()
	}
	return nil
}

func (m *memStore) outcome(job string, due time.Time) (string, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.runs[key(job, due)]
	if r == nil {
		return "", 0
	}
	return r.outcome, r.attempts
}

// counter counts a job's runs by due time.
type counter struct {
	mu   sync.Mutex
	runs map[time.Time]int
	fail int // the first runs that fail
}

func (c *counter) run(_ context.Context, due time.Time) (Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.runs == nil {
		c.runs = map[time.Time]int{}
	}
	c.runs[due]++
	if c.fail > 0 {
		c.fail--
		return Result{}, errors.New("the database went away")
	}
	return Result{Detail: "done"}, nil
}

func (c *counter) count() (total int, dues int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, n := range c.runs {
		total += n
	}
	return total, len(c.runs)
}

// A week of a daily job runs once a day, and a run missed while keel was
// down runs once on start: the bubble's clock starts at midnight UTC, so
// the day before's 07:00 was missed.
func TestDailyWeek(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ms := newMemStore(3)
		var c counter
		r := New(Config{Store: ms, Lease: 3, Jobs: []Job{{Name: "sessions", Due: Daily(7, 0), Next: DailyNext(7, 0), Run: c.run}}})
		ctx, cancel := context.WithCancel(t.Context())
		start := time.Now()
		done := make(chan struct{})
		go func() {
			r.Run(ctx)
			close(done)
		}()
		time.Sleep(7*24*time.Hour - time.Second)
		cancel()
		<-done
		total, dues := c.count()
		// The day before's missed run, then one each day at 07:00.
		if total != 8 || dues != 8 {
			t.Fatalf("%d runs of %d due times in a week from %s", total, dues, start)
		}
	})
}

func TestFailedRunRetried(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ms := newMemStore(1)
		c := counter{fail: 2}
		due := time.Now().Add(-time.Hour)
		job := Job{Name: "next-world", Due: func(time.Time) (time.Time, bool) { return due, true }, Retry: 5 * time.Minute, Run: c.run}
		r := New(Config{Store: ms, Lease: 1, Jobs: []Job{job}})
		ctx, cancel := context.WithCancel(t.Context())
		go r.Run(ctx)
		synctest.Wait()
		if o, n := ms.outcome("next-world", due); o != store.JobFailed || n != 1 {
			t.Fatalf("after the first run: %q, %d attempts", o, n)
		}
		time.Sleep(4 * time.Minute)
		synctest.Wait()
		if _, n := ms.outcome("next-world", due); n != 1 {
			t.Fatalf("tried again before its retry: %d attempts", n)
		}
		time.Sleep(3 * time.Minute)
		synctest.Wait()
		if o, n := ms.outcome("next-world", due); o != store.JobFailed || n != 2 {
			t.Fatalf("after the retry: %q, %d attempts", o, n)
		}
		time.Sleep(10 * time.Minute)
		synctest.Wait()
		if o, n := ms.outcome("next-world", due); o != store.JobOK || n != 3 {
			t.Fatalf("after the second retry: %q, %d attempts", o, n)
		}
		time.Sleep(time.Hour)
		synctest.Wait()
		if total, _ := c.count(); total != 3 {
			t.Fatalf("%d runs", total)
		}
		cancel()
	})
}

// A process that no longer holds the lease claims nothing, so runs
// nothing.
func TestLostLeaseRunsNothing(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ms := newMemStore(5)
		var c counter
		r := New(Config{Store: ms, Lease: 4, Jobs: []Job{{Name: "worlds", Due: Daily(7, 0), Run: c.run}}})
		ctx, cancel := context.WithCancel(t.Context())
		go r.Run(ctx)
		time.Sleep(3 * 24 * time.Hour)
		cancel()
		if total, _ := c.count(); total != 0 {
			t.Fatalf("%d runs", total)
		}
	})
}

// A run cut short by keel stopping is not recorded, and the next process,
// with the next epoch, does it.
func TestStoppedRunTakenOver(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ms := newMemStore(1)
		due := time.Now().Add(-time.Minute)
		started := make(chan struct{})
		var once sync.Once
		slow := Job{Name: "switch", Due: func(time.Time) (time.Time, bool) { return due, true }, Run: func(ctx context.Context, _ time.Time) (Result, error) {
			once.Do(func() { close(started) })
			<-ctx.Done()
			return Result{}, ctx.Err()
		}}
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan struct{})
		go func() {
			New(Config{Store: ms, Lease: 1, Jobs: []Job{slow}}).Run(ctx)
			close(done)
		}()
		<-started
		cancel()
		<-done
		if o, n := ms.outcome("switch", due); o != "" || n != 1 {
			t.Fatalf("stopped: %q, %d attempts", o, n)
		}
		ms.mu.Lock()
		ms.epoch = 2
		ms.mu.Unlock()
		var c counter
		quick := Job{Name: "switch", Due: slow.Due, Run: c.run}
		ctx, cancel = context.WithCancel(t.Context())
		go New(Config{Store: ms, Lease: 2, Jobs: []Job{quick}}).Run(ctx)
		synctest.Wait()
		if o, n := ms.outcome("switch", due); o != store.JobOK || n != 2 {
			t.Fatalf("taken over: %q, %d attempts", o, n)
		}
		cancel()
	})
}

// A job with a Next is run at that time, not at the runner's next look.
func TestRunAtNext(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ms := newMemStore(1)
		at := time.Now().Add(90 * time.Second)
		var ran time.Time
		job := Job{
			Name: "switch",
			Due:  func(now time.Time) (time.Time, bool) { return at, !now.Before(at) },
			Next: func(time.Time) time.Time { return at },
			Run: func(context.Context, time.Time) (Result, error) {
				ran = time.Now()
				return Result{}, nil
			},
		}
		ctx, cancel := context.WithCancel(t.Context())
		go New(Config{Store: ms, Lease: 1, Jobs: []Job{job}, Every: time.Hour}).Run(ctx)
		time.Sleep(2 * time.Minute)
		synctest.Wait()
		if !ran.Equal(at) {
			t.Fatalf("ran at %v, due at %v", ran, at)
		}
		cancel()
	})
}

func TestDaily(t *testing.T) {
	due := Daily(7, 0)
	for at, want := range map[string]string{
		"2026-11-01T06:59:59Z": "2026-10-31T07:00:00Z",
		"2026-11-01T07:00:00Z": "2026-11-01T07:00:00Z",
		"2026-11-01T23:00:00Z": "2026-11-01T07:00:00Z",
	} {
		now, _ := time.Parse(time.RFC3339, at)
		if got, ok := due(now); !ok || got.Format(time.RFC3339) != want {
			t.Errorf("at %s: %s", at, got.Format(time.RFC3339))
		}
	}
	now, _ := time.Parse(time.RFC3339, "2026-11-01T23:00:00Z")
	if got := DailyNext(7, 0)(now); got.Format(time.RFC3339) != "2026-11-02T07:00:00Z" {
		t.Errorf("next %s", got)
	}
}
