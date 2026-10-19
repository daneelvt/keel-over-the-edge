// SPDX-License-Identifier: AGPL-3.0-only

// Package jobs runs keel's work that falls due at times: making the next
// world, its switch, the notice of a world's end, and the daily cleanup.
//
// Jobs run only in the process that holds the simulation's lease, after it
// has taken it, and what they write is fenced by its epoch, as the world's
// writes are: one process at a time, so no job takes a lock of its own. A
// session-level advisory lock taken on a pooled connection would be held,
// or released, on whichever connection the pool hands out next
// (PostgreSQL, Explicit Locking: Advisory Locks), and the lease already
// makes this process the only writer. A run is claimed by a row of the
// job's runs unique to the job and the time it fell due, so a job runs once
// for each due time however often keel starts; a run that fails is tried
// again in the same row after its retry, and one whose process stopped
// before it finished is the next process's.
package jobs

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A Job is work that falls due at times.
type Job struct {
	Name string
	// Due is the latest time at or before now the job fell due; ok is
	// false when none has.
	Due func(now time.Time) (due time.Time, ok bool)
	// Next, if not nil, is the next time after now it falls due, so the
	// runner wakes for it then rather than at its next look.
	Next func(now time.Time) time.Time
	// Retry is how long after a failed run it is tried again: DefaultRetry
	// if zero.
	Retry time.Duration
	// Run does the run that fell due at due. Its context ends when keel
	// stops: a run cut short is not recorded, and the next process does it.
	Run func(ctx context.Context, due time.Time) (Result, error)
}

// Result is what came of a run that did not fail: what it did, as
// recorded, and whether it found nothing to do.
type Result struct {
	Detail  string
	Skipped bool
}

// DefaultRetry is how long after a failed run it is tried again, unless
// the job sets its own.
const DefaultRetry = 5 * time.Minute

// Every is how often the runner looks for jobs that have fallen due, at
// most.
const Every = time.Minute

// Store keeps the runs: store.Store.
type Store interface {
	ClaimJob(ctx context.Context, lease int64, job string, due time.Time, retry time.Duration) (store.JobClaim, bool, error)
	FinishJob(ctx context.Context, c store.JobClaim, outcome, detail string) error
}

// Config sets up a runner.
type Config struct {
	Store Store
	// Lease is the simulation lease's epoch this process holds.
	Lease   int64
	Jobs    []Job
	Log     *slog.Logger
	Metrics *obs.Metrics // may be nil
	// Every, if not zero, replaces the package's Every: for tests.
	Every time.Duration
}

// Runner runs the jobs as they fall due.
type Runner struct {
	cfg  Config
	poke chan struct{}

	mu      sync.Mutex
	running map[string]bool
	wg      sync.WaitGroup
}

// New makes a runner.
func New(cfg Config) *Runner {
	if cfg.Every == 0 {
		cfg.Every = Every
	}
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	if m := cfg.Metrics; m != nil {
		for _, j := range cfg.Jobs {
			for _, o := range []string{store.JobOK, store.JobSkipped, store.JobFailed} {
				m.JobRuns.WithLabelValues(j.Name, o)
			}
			m.JobLastOK.WithLabelValues(j.Name)
		}
	}
	return &Runner{cfg: cfg, poke: make(chan struct{}, 1), running: map[string]bool{}}
}

// Poke makes the runner look at once: when a job's due times have changed.
func (r *Runner) Poke() {
	select {
	case r.poke <- struct{}{}:
	default:
	}
}

// Run runs the jobs until ctx ends, then waits for the runs under way,
// whose context ends with it.
func (r *Runner) Run(ctx context.Context) {
	defer r.wg.Wait()
	for {
		now := time.Now()
		r.look(ctx, now)
		wait := r.cfg.Every
		for _, j := range r.cfg.Jobs {
			if j.Next == nil {
				continue
			}
			if d := j.Next(now).Sub(now); d > 0 && d < wait {
				wait = d
			}
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-r.poke:
			t.Stop()
		case <-t.C:
		}
	}
}

// look starts every job that has fallen due and is not running, if its run
// can be claimed.
func (r *Runner) look(ctx context.Context, now time.Time) {
	for _, j := range r.cfg.Jobs {
		due, ok := j.Due(now)
		if !ok {
			continue
		}
		r.mu.Lock()
		busy := r.running[j.Name]
		r.mu.Unlock()
		if busy {
			continue
		}
		retry := j.Retry
		if retry == 0 {
			retry = DefaultRetry
		}
		c, ok, err := r.cfg.Store.ClaimJob(ctx, r.cfg.Lease, j.Name, due, retry)
		if err != nil {
			if ctx.Err() == nil {
				r.cfg.Log.Warn("a job's run could not be claimed", "job", j.Name, "due", due, "err", err)
			}
			continue
		}
		if !ok {
			continue
		}
		r.mu.Lock()
		r.running[j.Name] = true
		r.mu.Unlock()
		r.wg.Go(func() {
			defer func() {
				r.mu.Lock()
				delete(r.running, j.Name)
				r.mu.Unlock()
			}()
			r.run(ctx, j, c)
		})
	}
}

// run runs one claimed run and records how it ended.
func (r *Runner) run(ctx context.Context, j Job, c store.JobClaim) {
	start := time.Now()
	log := r.cfg.Log.With("job", j.Name, "due", c.Due, "attempt", c.Attempt)
	log.Info("a job's run begins")
	res, err := j.Run(ctx, c.Due)
	if ctx.Err() != nil && (err == nil || errors.Is(err, context.Canceled)) {
		// Stopped: the next process takes the run over.
		log.Info("a job's run was stopped with keel: the next start does it")
		return
	}
	outcome, detail := store.JobOK, res.Detail
	switch {
	case err != nil:
		outcome, detail = store.JobFailed, err.Error()
		log.Error("a job's run failed: it is tried again", "err", err, "took", time.Since(start).Round(time.Millisecond).String())
	case res.Skipped:
		outcome = store.JobSkipped
		log.Info("a job's run had nothing to do", "detail", detail)
	default:
		log.Info("a job's run is done", "detail", detail, "took", time.Since(start).Round(time.Millisecond).String())
	}
	fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := r.cfg.Store.FinishJob(fctx, c, outcome, detail); err != nil {
		log.Warn("a job's run's outcome was not recorded", "outcome", outcome, "err", err)
	}
	if m := r.cfg.Metrics; m != nil {
		m.JobRuns.WithLabelValues(j.Name, outcome).Inc()
		if outcome != store.JobFailed {
			m.JobLastOK.WithLabelValues(j.Name).Set(float64(time.Now().Unix()))
		}
	}
	if outcome == store.JobFailed {
		// Looked at again by its retry.
		r.Poke()
	}
}

// Daily is a job's Due for once a day at the time of day given in UTC.
func Daily(hour, minute int) func(now time.Time) (time.Time, bool) {
	return func(now time.Time) (time.Time, bool) {
		now = now.UTC()
		y, m, d := now.Date()
		t := time.Date(y, m, d, hour, minute, 0, 0, time.UTC)
		if t.After(now) {
			t = t.AddDate(0, 0, -1)
		}
		return t, true
	}
}

// DailyNext is Daily's Next.
func DailyNext(hour, minute int) func(now time.Time) time.Time {
	due := Daily(hour, minute)
	return func(now time.Time) time.Time {
		t, _ := due(now)
		return t.AddDate(0, 0, 1)
	}
}
