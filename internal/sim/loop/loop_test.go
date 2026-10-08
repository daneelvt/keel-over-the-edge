// SPDX-License-Identifier: AGPL-3.0-only

package loop

import (
	"bytes"
	"context"
	"log/slog"
	"math/big"
	"math/rand/v2"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// bubbleEpoch is when a synctest bubble's clock starts, so tick 0 falls on
// the bubble's first instant.
var bubbleEpoch = time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)

func kinds(t testing.TB) []physics.Prepared {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	p := catalog.PhysicsParams(&cat.Boats[0])
	var b physics.Prepared
	physics.Prepare(&p, &b)
	return []physics.Prepared{b}
}

type harness struct {
	world   *sim.World
	loop    *Loop
	metrics *obs.Metrics
	health  *obs.Health
	logs    *bytes.Buffer
	cancel  context.CancelFunc
	done    chan error
	// Each tick's tick number and when it started, by AfterTick.
	started  map[int64]time.Time
	overruns []int64
}

// start runs a loop over an empty world from now; slow, if not nil, runs in
// every tick.
func start(t *testing.T, slow func(h *harness, tick int64)) *harness {
	t.Helper()
	w, err := sim.New(sim.Config{Capacity: 8, Kinds: kinds(t), Workers: 2, Tick: TickAt(time.Now(), bubbleEpoch)})
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{
		world:   w,
		metrics: obs.NewMetrics("b", "c"),
		health:  obs.NewHealth(),
		logs:    &bytes.Buffer{},
		done:    make(chan error, 1),
		started: map[int64]time.Time{},
	}
	h.loop = New(Config{
		World:   w,
		Epoch:   bubbleEpoch,
		Log:     slog.New(slog.NewJSONHandler(h.logs, nil)),
		Metrics: h.metrics,
		Health:  h.health,
		Overrun: func(tick int64) { h.overruns = append(h.overruns, tick) },
		AfterTick: func(tick int64) {
			h.started[tick] = time.Now() // a tick takes no time in a bubble
			if slow != nil {
				slow(h, tick)
			}
		},
	})
	ctx, cancel := context.WithCancel(t.Context())
	h.cancel = cancel
	go func() { h.done <- h.loop.Run(ctx) }()
	return h
}

// stop stops the loop and the world's workers, leaving no goroutine.
func (h *harness) stop(t *testing.T) {
	t.Helper()
	h.cancel()
	if err := <-h.done; err != nil {
		t.Fatal(err)
	}
	h.world.Close()
}

func TestTenMinutes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := start(t, nil)
		time.Sleep(10 * time.Minute)
		synctest.Wait()
		if got := h.world.Now(); got != 18000 {
			t.Errorf("the world is at tick %d after 10 minutes, not 18000", got)
		}
		if got := testutil.ToFloat64(h.metrics.Ticks); got != 18000 {
			t.Errorf("%v ticks counted", got)
		}
		for tick := int64(1); tick <= 18000; tick++ {
			if at, ok := h.started[tick]; !ok || !at.Equal(TimeOf(tick, bubbleEpoch)) {
				t.Fatalf("tick %d ran at %v, its deadline is %v", tick, at, TimeOf(tick, bubbleEpoch))
			}
		}
		if late, skipped := testutil.ToFloat64(h.metrics.TicksLate), testutil.ToFloat64(h.metrics.TicksSkipped); late != 0 || skipped != 0 {
			t.Errorf("%v late, %v skipped", late, skipped)
		}
		if d := testutil.ToFloat64(h.metrics.ClockDrift); d != 0 {
			t.Errorf("the clock drifted %v s", d)
		}
		if ok, why := h.health.Live(); !ok {
			t.Errorf("not live: %s", why)
		}
		h.stop(t)
	})
}

func TestSlowTickRunsTheNextLate(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := start(t, func(_ *harness, tick int64) {
			if tick == 10 {
				time.Sleep(50 * time.Millisecond)
			}
		})
		time.Sleep(time.Second)
		synctest.Wait()
		h.stop(t)
		// Tick 10 ends at 383 ms, after tick 11's deadline (367 ms) and
		// before tick 12's (400 ms).
		if want := TimeOf(10, bubbleEpoch).Add(50 * time.Millisecond); !h.started[11].Equal(want) {
			t.Errorf("tick 11 ran at %v, want %v", h.started[11], want)
		}
		if !h.started[12].Equal(TimeOf(12, bubbleEpoch)) {
			t.Errorf("tick 12 ran at %v, not on its deadline", h.started[12])
		}
		if late := testutil.ToFloat64(h.metrics.TicksLate); late != 1 {
			t.Errorf("%v late ticks", late)
		}
		if len(h.overruns) != 1 || h.overruns[0] != 10 {
			t.Errorf("overruns %v", h.overruns)
		}
	})
}

func TestAtMostThreeBackToBack(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// Every tick from 10 to 40 takes 40 ms, more than a tick's 33 ms.
		h := start(t, func(_ *harness, tick int64) {
			if tick >= 10 && tick <= 40 {
				time.Sleep(40 * time.Millisecond)
			}
		})
		time.Sleep(3 * time.Second)
		synctest.Wait()
		h.stop(t)
		run, longest := 0, 0
		for tick := int64(1); tick <= h.world.Now(); tick++ {
			at, ok := h.started[tick]
			switch {
			case !ok: // skipped
				run = 0
			case at.Equal(TimeOf(tick, bubbleEpoch)):
				run = 0
			default:
				run++
				longest = max(longest, run)
			}
		}
		if longest != MaxCatchUp {
			t.Errorf("at most %d ticks ran late back to back, want %d", longest, MaxCatchUp)
		}
		if testutil.ToFloat64(h.metrics.TicksSkipped) == 0 {
			t.Error("nothing was skipped")
		}
	})
}

func TestStallSkips(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := start(t, func(_ *harness, tick int64) {
			if tick == 30 {
				time.Sleep(2 * time.Second)
			}
		})
		time.Sleep(4 * time.Second)
		synctest.Wait()
		h.stop(t)
		// Tick 30 runs at 1 s and ends at 3 s, when ticks 31 to 90 are due:
		// 31 to 33 run back to back, 34 to 90 are skipped, and 91 runs on
		// its deadline.
		if late, skipped := testutil.ToFloat64(h.metrics.TicksLate), testutil.ToFloat64(h.metrics.TicksSkipped); late != 3 || skipped != 57 {
			t.Errorf("%v late, %v skipped; want 3 and 57", late, skipped)
		}
		for tick := int64(34); tick <= 90; tick++ {
			if _, ok := h.started[tick]; ok {
				t.Fatalf("tick %d ran", tick)
			}
		}
		if !h.started[91].Equal(TimeOf(91, bubbleEpoch)) {
			t.Errorf("tick 91 ran at %v", h.started[91])
		}
		if n := strings.Count(h.logs.String(), "skipping"); n != 1 {
			t.Errorf("%d skips logged: %s", n, h.logs.String())
		}
		if got := testutil.ToFloat64(h.metrics.Ticks); got != 120-57 {
			t.Errorf("%v ticks", got)
		}
	})
}

func TestStopFinishesTheTick(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := start(t, func(h *harness, tick int64) {
			if tick == 5 {
				h.cancel()
				time.Sleep(10 * time.Millisecond) // the tick goes on
			}
		})
		if err := <-h.done; err != nil {
			t.Fatal(err)
		}
		if h.world.Now() != 5 {
			t.Fatalf("stopped at tick %d", h.world.Now())
		}
		h.world.Close()
		// synctest.Test fails if any goroutine is left.
	})
}

func TestHeartbeat(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		stall := make(chan struct{})
		h := start(t, func(_ *harness, tick int64) {
			if tick == 3 {
				<-stall
			}
		})
		time.Sleep(time.Second)
		if ok, _ := h.health.Ready(); ok {
			t.Fatal("ready without listeners")
		}
		h.health.Listening(true)
		if ok, why := h.health.Ready(); !ok {
			t.Fatalf("not ready after ticking: %s", why)
		}
		// A stuck tick stops the heartbeat; liveness notices after 10 s.
		time.Sleep(obs.StaleAfter)
		if ok, _ := h.health.Live(); ok {
			t.Fatal("live while stuck")
		}
		close(stall)
		synctest.Wait()
		if ok, why := h.health.Live(); !ok {
			t.Fatalf("not live after the tick ended: %s", why)
		}
		h.stop(t)
	})
}

func TestTickAtAndTimeOf(t *testing.T) {
	epoch := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		t    time.Time
		tick int64
	}{
		{epoch, 0},
		{epoch.Add(time.Second), 30},
		{epoch.Add(time.Second - time.Nanosecond), 29},
		{epoch.Add(33333333 * time.Nanosecond), 1},
		{epoch.Add(33333332 * time.Nanosecond), 0},
		{epoch.Add(-time.Nanosecond), -1},
		{epoch.Add(-time.Second), -30},
		{time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC), 86400 * 30},
	}
	for _, c := range cases {
		if got := TickAt(c.t, epoch); got != c.tick {
			t.Errorf("TickAt(%v) = %d, want %d", c.t, got, c.tick)
		}
	}

	// Far past 2035, where the tick times 10⁹ no longer fits in an int64,
	// against arithmetic that cannot overflow.
	for _, at := range []time.Time{
		time.Date(2036, 3, 1, 12, 0, 0, 0, time.UTC),
		time.Date(2290, 7, 4, 1, 2, 3, 456789012, time.UTC),
		time.Date(1990, 7, 4, 1, 2, 3, 456789012, time.UTC),
	} {
		ns := new(big.Int).Sub(big.NewInt(at.Unix()), big.NewInt(epoch.Unix()))
		ns.Mul(ns, big.NewInt(1e9)).Add(ns, big.NewInt(int64(at.Nanosecond())))
		// The largest k with ⌊k × 10⁹ / 30⌋ ≤ ns: ⌊(30 ns + 29) / 10⁹⌋.
		want := new(big.Int).Mul(ns, big.NewInt(30))
		want.Add(want, big.NewInt(29))
		want.Div(want, big.NewInt(1e9)) // Euclidean, so it floors
		if got := TickAt(at, epoch); got != want.Int64() {
			t.Errorf("TickAt(%v) = %d, want %d", at, got, want)
		}
	}

	rng := rand.New(rand.NewPCG(1, 1))
	for range 100000 {
		const years = 365 * 86400
		at := time.Unix(epoch.Unix()+rng.Int64N(400*years)-200*years, rng.Int64N(1e9))
		k := TickAt(at, epoch)
		if TimeOf(k, epoch).After(at) || !TimeOf(k+1, epoch).After(at) {
			t.Fatalf("TickAt(%v) = %d, but TimeOf gives %v and %v", at, k, TimeOf(k, epoch), TimeOf(k+1, epoch))
		}
	}
	if TimeOf(30, epoch) != epoch.Add(time.Second) || TimeOf(-1, epoch) != epoch.Add(-33333334*time.Nanosecond) {
		t.Error("TimeOf is wrong at a second's edge")
	}
}
