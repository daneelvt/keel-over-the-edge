// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"sync"
	"time"
)

// Each account's budget for saying lines, and its rests.
const (
	// Every is how often a line comes back to the budget.
	Every = 2 * time.Second
	// Burst is the most lines said at once, the budget full.
	Burst = 5
	// PerMinute is the most lines said in any minute.
	PerMinute = 30
	// RefusalsToRest lines refused by the filter within RefusalWindow
	// rest the sender's chat for RestFor.
	RefusalsToRest = 5
	RefusalWindow  = 10 * time.Minute
	RestFor        = 10 * time.Minute
)

// Limiter is each account's budget for saying lines: a line every Every,
// in bursts of up to Burst, and at most PerMinute in any minute. And
// resting: RefusalsToRest lines refused within RefusalWindow rest the
// sender's chat for RestFor. It is safe for concurrent use; an account
// with nothing left to remember is forgotten in Tidy.
type Limiter struct {
	now  func() time.Time
	base time.Time

	mu sync.Mutex
	by map[[16]byte]*budget
}

// budget is one account's, its times as durations since the limiter's
// base on its clock.
type budget struct {
	// full is when the budget is full again (the cell rate algorithm's
	// theoretical arrival time).
	full time.Duration
	// said are the latest lines' times, a ring: when it is full, said[at]
	// is the oldest.
	said     [PerMinute]time.Duration
	saidN    int
	saidAt   int
	refused  [RefusalsToRest]time.Duration
	refusedN int
	refuseAt int
	// rest is when a rest ends; zero for none.
	rest time.Duration
}

// NewLimiter is a limiter on the clock now, every account's budget full.
func NewLimiter(now func() time.Time) *Limiter {
	return &Limiter{now: now, base: now(), by: make(map[[16]byte]*budget)}
}

func (l *Limiter) clock() time.Duration { return l.now().Sub(l.base) }

// Allow takes one line from the account's budget and reports true, or
// reports false and takes nothing: the budget spent, PerMinute said in
// the last minute, or the account's chat resting.
func (l *Limiter) Allow(account [16]byte) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	d := l.clock()
	b := l.by[account]
	if b == nil {
		b = &budget{}
		l.by[account] = b
	}
	if b.rest > d {
		return false
	}
	t := max(b.full, d)
	if t-d > (Burst-1)*Every {
		return false
	}
	if b.saidN == PerMinute && d-b.said[b.saidAt] < time.Minute {
		return false
	}
	b.full = t + Every
	b.said[b.saidAt] = d
	b.saidAt = (b.saidAt + 1) % PerMinute
	b.saidN = min(b.saidN+1, PerMinute)
	return true
}

// Refused counts a line of the account's refused by the filter. When it
// is the RefusalsToRest-th within RefusalWindow, the account's chat rests
// and Refused reports until when; otherwise it reports the zero time. A
// refusal while resting is not counted.
func (l *Limiter) Refused(account [16]byte) (restingUntil time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	d := l.clock()
	b := l.by[account]
	if b == nil {
		b = &budget{}
		l.by[account] = b
	}
	if b.rest > d {
		return time.Time{}
	}
	b.refused[b.refuseAt] = d
	b.refuseAt = (b.refuseAt + 1) % RefusalsToRest
	b.refusedN = min(b.refusedN+1, RefusalsToRest)
	if b.refusedN < RefusalsToRest || d-b.refused[b.refuseAt] >= RefusalWindow {
		return time.Time{}
	}
	b.rest = d + RestFor
	b.refusedN, b.refuseAt = 0, 0
	return l.base.Add(b.rest)
}

// Resting reports whether the account's chat rests, and until when.
func (l *Limiter) Resting(account [16]byte) (until time.Time, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.by[account]
	if b == nil || b.rest <= l.clock() {
		return time.Time{}, false
	}
	return l.base.Add(b.rest), true
}

// Tidy forgets the accounts whose budgets are as a new one's: full, no
// line in the last minute, no refusal in the window and no rest.
func (l *Limiter) Tidy() {
	l.mu.Lock()
	defer l.mu.Unlock()
	d := l.clock()
	for a, b := range l.by {
		if b.full > d || b.rest > d {
			continue
		}
		if b.saidN > 0 && d-b.said[(b.saidAt+PerMinute-1)%PerMinute] < time.Minute {
			continue
		}
		if b.refusedN > 0 && d-b.refused[(b.refuseAt+RefusalsToRest-1)%RefusalsToRest] < RefusalWindow {
			continue
		}
		delete(l.by, a)
	}
}
