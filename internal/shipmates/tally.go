// SPDX-License-Identifier: AGPL-3.0-only

package shipmates

import (
	"bytes"
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The tally: who is aboard the same boat together, read from the world's
// frames every so often, and recorded in the store as each pair is first
// seen, as they reach five minutes together, and every half hour after.
// Only people: a machine sailor is never anyone's shipmate. A stretch
// together is held in memory and lost harmlessly at a restart: it begins
// again.

// Tally's numbers.
const (
	// Together is how long two people must have been aboard together, in
	// one stretch, to offer to be shipmates.
	Together = 5 * time.Minute
	// Every is how often the frames are read.
	Every = 15 * time.Second
	// Rewrite is how often a stretch still going is written again.
	Rewrite = 30 * time.Minute
)

// Recorder is the store's side of the tally.
type Recorder interface {
	SawTogether(ctx context.Context, a, b store.AccountID, at time.Time, boat uint64, sailed bool) error
}

// pairKey is two accounts, the lesser first.
type pairKey [2]bus.Account

func keyOf(a, b bus.Account) pairKey {
	if bytes.Compare(a[:], b[:]) > 0 {
		a, b = b, a
	}
	return pairKey{a, b}
}

// stretch is two people aboard together without a break.
type stretch struct {
	since   time.Time
	boat    uint64
	written time.Time
	sailed  bool
}

// Tally finds who sails together. Safe for concurrent use.
type Tally struct {
	frames  *bus.Frames
	store   Recorder
	now     func() time.Time
	log     *slog.Logger
	metrics *obs.Metrics

	mu    sync.Mutex
	pairs map[pairKey]*stretch
}

// NewTally is a tally over a world's frames, recording to store.
func NewTally(frames *bus.Frames, rec Recorder, now func() time.Time, log *slog.Logger, m *obs.Metrics) *Tally {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if now == nil {
		now = time.Now
	}
	return &Tally{frames: frames, store: rec, now: now, log: log, metrics: m, pairs: map[pairKey]*stretch{}}
}

// Run reads the frames every Every until ctx ends.
func (t *Tally) Run(ctx context.Context) {
	tk := time.NewTicker(Every)
	defer tk.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
			t.Sweep(ctx)
		}
	}
}

// aboardNow are the pairs of people aboard the same boat together in the
// latest frame, and their boats.
func (t *Tally) aboardNow() map[pairKey]uint64 {
	f := t.frames.Acquire()
	defer f.Release()
	out := map[pairKey]uint64{}
	var people []bus.Account
	for _, s := range f.Live {
		lo, hi := f.CrewOf(s)
		if lo == hi {
			continue
		}
		people = people[:0]
		if !f.Machine[s] {
			people = append(people, f.Owner[s])
		}
		for _, a := range f.Crew[lo:hi] {
			if !a.Machine {
				people = append(people, a.Account)
			}
		}
		for i := range people {
			for j := i + 1; j < len(people); j++ {
				out[keyOf(people[i], people[j])] = f.Boat[s]
			}
		}
	}
	return out
}

// write is a record the sweep makes.
type write struct {
	key    pairKey
	boat   uint64
	sailed bool
}

// Sweep reads the latest frame once and records what has changed.
func (t *Tally) Sweep(ctx context.Context) {
	now := t.now()
	seen := t.aboardNow()
	var writes []write
	t.mu.Lock()
	for k := range t.pairs {
		if _, ok := seen[k]; !ok {
			delete(t.pairs, k)
		}
	}
	for k, boat := range seen {
		st := t.pairs[k]
		if st == nil || st.boat != boat {
			st = &stretch{since: now, boat: boat}
			t.pairs[k] = st
		}
		long := now.Sub(st.since) >= Together
		switch {
		case st.written.IsZero(), long && !st.sailed, now.Sub(st.written) >= Rewrite:
			writes = append(writes, write{key: k, boat: boat, sailed: long})
			if long && !st.sailed && t.metrics != nil {
				t.metrics.Shipmates.WithLabelValues("sailed").Inc()
			}
			st.written, st.sailed = now, long
		}
	}
	t.mu.Unlock()
	for _, w := range writes {
		wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := t.store.SawTogether(wctx, store.AccountID(w.key[0]), store.AccountID(w.key[1]), now, w.boat, w.sailed)
		cancel()
		if err != nil {
			t.log.Warn("recording two people aboard together", "err", err)
			t.mu.Lock()
			if st := t.pairs[w.key]; st != nil {
				// Tried again at the next sweep.
				st.written, st.sailed = time.Time{}, false
			}
			t.mu.Unlock()
		}
	}
}

// Forget ends the stretch of a and b together: two who are shipmates no
// longer begin again, to offer again.
func (t *Tally) Forget(a, b bus.Account) {
	t.mu.Lock()
	delete(t.pairs, keyOf(a, b))
	t.mu.Unlock()
}

// Hurry counts every pair aboard together now as having been for
// Together already, and records them at once: the developer's command,
// so that a trial need not wait five minutes. It reports how many pairs.
func (t *Tally) Hurry(ctx context.Context) int {
	seen := t.aboardNow()
	before := t.now().Add(-Together)
	t.mu.Lock()
	for k, boat := range seen {
		st := t.pairs[k]
		if st == nil || st.boat != boat {
			st = &stretch{boat: boat}
			t.pairs[k] = st
		}
		st.since, st.sailed = before, false
	}
	t.mu.Unlock()
	t.Sweep(ctx)
	return len(seen)
}
