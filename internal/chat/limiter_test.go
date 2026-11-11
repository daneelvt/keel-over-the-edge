// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"sync"
	"testing"
	"time"
)

// allowed counts the lines Allow takes for a, trying n times at once.
func allowed(l *Limiter, a [16]byte, n int) int {
	k := 0
	for range n {
		if l.Allow(a) {
			k++
		}
	}
	return k
}

func TestBurstAndRefill(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.now)
	a, b := account(1), account(2)
	if n := allowed(l, a, 10); n != Burst {
		t.Fatalf("a burst of %d", n)
	}
	if !l.Allow(b) {
		t.Fatal("another account refused for the first's burst")
	}
	c.add(Every - time.Nanosecond)
	if l.Allow(a) {
		t.Fatal("a line back before Every")
	}
	c.add(time.Nanosecond)
	if n := allowed(l, a, 3); n != 1 {
		t.Fatalf("%d lines back after Every", n)
	}
	c.add(3 * Every)
	if n := allowed(l, a, 10); n != 3 {
		t.Fatalf("%d lines back after 3 × Every", n)
	}
	c.add(time.Hour)
	if n := allowed(l, a, 10); n != Burst {
		t.Fatalf("a burst of %d after an hour's quiet", n)
	}
}

func TestPerMinute(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.now)
	a := account(1)
	// Saying as fast as the budget allows: the burst, then a line every
	// Every, which would be 35 in the first minute.
	var times []time.Duration
	for d := time.Duration(0); d < 3*time.Minute; d += Every / 4 {
		if l.Allow(a) {
			times = append(times, d)
		}
		c.add(Every / 4)
	}
	for i := range times {
		n := 0
		for j := i; j < len(times) && times[j]-times[i] < time.Minute; j++ {
			n++
		}
		if n > PerMinute {
			t.Fatalf("%d lines in the minute from %v", n, times[i])
		}
	}
	first := 0
	for _, d := range times {
		if d < time.Minute {
			first++
		}
	}
	if first != PerMinute {
		t.Fatalf("%d lines in the first minute", first)
	}
	// After the first minute the budget gives a line every Every, 30 a
	// minute: so 30 in each of three minutes.
	if len(times) != 3*PerMinute {
		t.Fatalf("%d lines in three minutes", len(times))
	}
}

func TestRest(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.now)
	a, b := account(1), account(2)
	for i := range RefusalsToRest - 1 {
		if until := l.Refused(a); !until.IsZero() {
			t.Fatalf("resting after %d refusals", i+1)
		}
		c.add(2 * time.Minute)
	}
	if _, ok := l.Resting(a); ok {
		t.Fatal("resting before the fifth refusal")
	}
	c.add(RefusalWindow - 8*time.Minute - time.Nanosecond)
	until := l.Refused(a)
	if !until.Equal(c.now().Add(RestFor)) {
		t.Fatalf("the fifth refusal within the window: resting until %v", until)
	}
	if u, ok := l.Resting(a); !ok || !u.Equal(until) {
		t.Fatalf("Resting: %v %v", u, ok)
	}
	if l.Allow(a) {
		t.Fatal("a resting account allowed a line")
	}
	if _, ok := l.Resting(b); ok || !l.Allow(b) {
		t.Fatal("another account resting")
	}
	if u := l.Refused(a); !u.IsZero() {
		t.Fatal("a refusal while resting began another rest")
	}
	c.add(RestFor - time.Nanosecond)
	if _, ok := l.Resting(a); ok == false {
		t.Fatal("the rest ended early")
	}
	c.add(time.Nanosecond)
	if _, ok := l.Resting(a); ok {
		t.Fatal("the rest did not end")
	}
	if !l.Allow(a) {
		t.Fatal("a line refused after the rest")
	}
	// The rest began a fresh count.
	for range RefusalsToRest - 1 {
		if !l.Refused(a).IsZero() {
			t.Fatal("resting again too soon")
		}
	}
	if l.Refused(a).IsZero() {
		t.Fatal("not resting after five more")
	}
}

func TestRefusalsOutsideTheWindow(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.now)
	a := account(1)
	for range 20 {
		if !l.Refused(a).IsZero() {
			t.Fatal("resting on refusals spread wider than the window")
		}
		c.add(RefusalWindow / (RefusalsToRest - 1))
	}
}

func TestLimiterTidy(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.now)
	quiet, chatty, refused, resting := account(1), account(2), account(3), account(4)
	l.Allow(quiet)
	l.Refused(refused)
	for range RefusalsToRest {
		l.Refused(resting)
	}
	c.add(time.Minute)
	l.Allow(chatty)
	l.Tidy()
	if len(l.by) != 3 {
		t.Fatalf("%d accounts remembered", len(l.by))
	}
	if _, ok := l.by[quiet]; ok {
		t.Fatal("a quiet account remembered")
	}
	c.add(RefusalWindow)
	l.Tidy()
	if len(l.by) != 0 {
		t.Fatalf("%d accounts remembered", len(l.by))
	}
}

func TestLimiterConcurrent(t *testing.T) {
	c := newClock()
	l := NewLimiter(c.now)
	var wg sync.WaitGroup
	var mu sync.Mutex
	total := 0
	for g := range 8 {
		wg.Go(func() {
			n := 0
			for i := range 1000 {
				if l.Allow(account(i % 3)) {
					n++
				}
				if i%50 == 0 {
					l.Refused(account(100 + g))
					l.Resting(account(100 + g))
					l.Tidy()
				}
			}
			mu.Lock()
			total += n
			mu.Unlock()
		})
	}
	wg.Wait()
	if total != 3*Burst {
		t.Fatalf("%d lines allowed to three accounts at one instant", total)
	}
}
