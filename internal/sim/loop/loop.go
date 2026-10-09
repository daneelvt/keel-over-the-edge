// SPDX-License-Identifier: AGPL-3.0-only

// Package loop runs a world's ticks on the clock: 30 a second, each on a
// deadline fixed by UTC, catching up a little when late and skipping when far
// behind. It times the ticks and their phases, updates the metrics and beats
// the heartbeat, all between ticks: the tick itself never reads the clock.
package loop

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

const (
	// TicksPerSecond is the world's rate: one tick is one physics step.
	TicksPerSecond = physics.StepsPerSecond
	// MaxCatchUp is the most ticks run late, back to back after the tick
	// that was due, when the loop falls behind. Further behind than that it
	// skips to the present rather than spiral: catching up costs ticks,
	// which make it later still.
	MaxCatchUp = 3
	// OverrunAfter is how long a tick may take before the flight recorder
	// is asked for its trace.
	OverrunAfter = 25 * time.Millisecond
)

// TimeOf is when tick happens: epoch plus tick / TicksPerSecond seconds,
// rounded down to the nanosecond. It is computed from the tick, never
// accumulated, so world time cannot drift; and in seconds and a remainder,
// so it cannot overflow.
func TimeOf(tick int64, epoch time.Time) time.Time {
	s := tick / TicksPerSecond
	r := tick % TicksPerSecond
	if r < 0 {
		s, r = s-1, r+TicksPerSecond
	}
	return time.Unix(epoch.Unix()+s, int64(epoch.Nanosecond())+r*int64(time.Second)/TicksPerSecond).UTC()
}

// TickAt is the latest tick whose time has come at t: the largest tick with
// TimeOf(tick) ≤ t.
func TickAt(t, epoch time.Time) int64 {
	s := t.Unix() - epoch.Unix()
	ns := int64(t.Nanosecond()) - int64(epoch.Nanosecond())
	if ns < 0 {
		s, ns = s-1, ns+int64(time.Second)
	}
	// TimeOf(k) ≤ t ⇔ ⌊k × 10⁹ / 30⌋ ≤ ns ⇔ k × 10⁹ < 30 × (ns + 1).
	return s*TicksPerSecond + (ns*TicksPerSecond+TicksPerSecond-1)/int64(time.Second)
}

// Config sets up a loop.
type Config struct {
	World   *sim.World
	Epoch   time.Time
	Log     *slog.Logger
	Metrics *obs.Metrics // may be nil
	Health  *obs.Health  // may be nil
	// Overrun, if not nil, is called after a tick that took longer than
	// OverrunAfter. It must not block.
	Overrun func(tick int64)
	// AfterTick, if not nil, runs after each tick, on the loop's goroutine,
	// and counts as part of the tick: for tests.
	AfterTick func(tick int64)
	// Wall, if not nil, replaces time.Now as the wall clock, which the loop
	// reads once, as it starts: for tests.
	Wall func() time.Time
}

// Loop runs a world's ticks on the clock.
type Loop struct {
	cfg   Config
	world *sim.World

	// When Run started, on the monotonic clock and on the wall clock; and
	// both again, published for WorldTime once Run has started.
	startMono, startWall time.Time
	anchor               atomic.Pointer[anchor]

	mark   time.Time // when the last phase ended
	phases [sim.Phases]time.Duration

	m        *obs.Metrics
	phaseObs [sim.Phases]prometheus.Observer
	commands [][]prometheus.Counter // by op, then result
	// graces started, ended by a join, and expired
	graceStarted, graceRejoined, graceExpired prometheus.Counter
}

// New makes a loop for cfg.World, which it observes from now on.
func New(cfg Config) *Loop {
	l := &Loop{cfg: cfg, world: cfg.World, m: cfg.Metrics}
	if l.m != nil {
		for p := range sim.Phases {
			l.phaseObs[p] = l.m.PhaseDuration.WithLabelValues(p.String())
		}
		l.commands = make([][]prometheus.Counter, len(bus.Ops)+1)
		for _, op := range bus.Ops {
			l.commands[op] = make([]prometheus.Counter, len(bus.Results)+1)
			for _, r := range bus.Results {
				l.commands[op][r] = l.m.Commands.WithLabelValues(op.String(), r.String())
			}
		}
		l.graceStarted = l.m.Grace.WithLabelValues("started")
		l.graceRejoined = l.m.Grace.WithLabelValues("rejoined")
		l.graceExpired = l.m.Grace.WithLabelValues("expired")
	}
	cfg.World.Observe(l)
	return l
}

// anchor ties the monotonic clock to world time: at mono, the wall clock read
// wall.
type anchor struct{ mono, wall time.Time }

// WorldTime is the world's time now, since its epoch, on the loop's own
// schedule: the wall clock as it read when the loop started, plus the time
// since on the monotonic clock. A step of the wall clock after the start
// cannot move it away from the ticks, which follow the same schedule: at
// each tick's deadline it is that tick's time. ok is false until Run has
// started.
func (l *Loop) WorldTime() (t time.Duration, ok bool) { return l.WorldTimeAt(time.Now()) }

// WorldTimeAt is WorldTime at now, a reading of the monotonic clock.
func (l *Loop) WorldTimeAt(now time.Time) (time.Duration, bool) {
	a := l.anchor.Load()
	if a == nil {
		return 0, false
	}
	return a.wall.Sub(l.cfg.Epoch) + now.Sub(a.mono), true
}

// PhaseDone times the phase of the tick that has just ended.
func (l *Loop) PhaseDone(p sim.Phase) {
	now := time.Now()
	l.phases[p] = now.Sub(l.mark)
	l.mark = now
}

// due is when tick's deadline falls on the monotonic clock: its time in
// UTC, relative to when Run started.
func (l *Loop) due(tick int64) time.Time {
	return l.startMono.Add(TimeOf(tick, l.cfg.Epoch).Sub(l.startWall))
}

// Run ticks the world until ctx ends; a tick under way finishes first.
//
// Each deadline is computed afresh from Run's start, so a timer that wakes
// late (Linux rounds its waits to whole milliseconds) adds jitter, never
// drift. A time.Ticker is not used: it drops ticks for a slow receiver,
// which would hide them.
func (l *Loop) Run(ctx context.Context) error {
	l.start(time.Now())
	w := l.world
	next := w.Now() + 1
	timer := time.NewTimer(time.Until(l.due(next)))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-timer.C:
		}
		for burst := 0; ; burst++ {
			now := time.Now()
			if l.due(next).After(now) {
				break
			}
			if burst > MaxCatchUp {
				l.skip(next, now)
				next = l.latest(now) + 1
				break
			}
			l.tick(next, burst > 0)
			next = w.Now() + 1
			if ctx.Err() != nil {
				return nil
			}
		}
		timer.Reset(time.Until(l.due(next)))
	}
}

// start sets when the loop started: now on the monotonic clock, and the wall
// clock's reading then.
func (l *Loop) start(now time.Time) {
	l.startMono = now
	l.startWall = now.Round(0)
	if l.cfg.Wall != nil {
		l.startWall = l.cfg.Wall().Round(0)
	}
	l.anchor.Store(&anchor{mono: l.startMono, wall: l.startWall})
}

// latest is the latest tick whose deadline has passed at now.
func (l *Loop) latest(now time.Time) int64 {
	return TickAt(l.startWall.Add(now.Sub(l.startMono)), l.cfg.Epoch)
}

// skip skips every tick due by now from next on: the world's time jumps and
// its boats do not move for them.
func (l *Loop) skip(next int64, now time.Time) {
	n := l.latest(now) - next + 1
	if n <= 0 {
		return
	}
	l.world.Skip(n)
	if l.m != nil {
		l.m.TicksSkipped.Add(float64(n))
	}
	l.cfg.Log.Warn("the tick loop fell behind; skipping ticks", "from", next, "ticks", n)
}

// tick runs tick and records it.
func (l *Loop) tick(tick int64, late bool) {
	start := time.Now()
	l.mark = start
	if l.m != nil && tick%TicksPerSecond == 0 {
		// The world's time against UTC: zero but for a late wake-up, unless
		// the monotonic clock and UTC have parted.
		l.m.ClockDrift.Set(TimeOf(tick, l.cfg.Epoch).Sub(start.Round(0)).Seconds())
	}
	l.world.Tick()
	tick = l.world.Now()
	if l.cfg.AfterTick != nil {
		l.cfg.AfterTick(tick)
	}
	d := time.Since(start)

	if h := l.cfg.Health; h != nil {
		h.Beat()
		h.Ticked()
	}
	if d > OverrunAfter && l.cfg.Overrun != nil {
		l.cfg.Overrun(tick)
	}
	if l.m == nil {
		return
	}
	f := l.world.Latest()
	l.m.Tick.Set(float64(tick))
	l.m.TickDuration.Observe(d.Seconds())
	for p, o := range l.phaseObs {
		o.Observe(l.phases[p].Seconds())
	}
	l.m.Ticks.Inc()
	if late {
		l.m.TicksLate.Inc()
	}
	l.m.Boats.Set(float64(len(f.Live)))
	l.m.Workers.Set(float64(l.world.Workers()))
	for i := range f.Events {
		ev := &f.Events[i]
		if int(ev.Op) < len(l.commands) && int(ev.Reply.Result) < len(l.commands[ev.Op]) {
			l.commands[ev.Op][ev.Reply.Result].Inc()
		}
		switch {
		case ev.Op == bus.Disconnect && ev.Reply.Result == bus.Done:
			l.graceStarted.Inc()
		case ev.Op == bus.Join && ev.Reply.Result == bus.Rejoined:
			l.graceRejoined.Inc()
		case ev.Reply.Result == bus.Expired:
			l.graceExpired.Inc()
		}
	}
}
