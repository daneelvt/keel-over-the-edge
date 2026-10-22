// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/config"
	"github.com/daneelvt/keel-over-the-edge/internal/jobs"
	"github.com/daneelvt/keel-over-the-edge/internal/owner"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// A world's life in the running process. Its end is the schedule's, fixed
// as it begins. A day before (the schedule's ahead) the next world is made
// on one goroutine and stored; three days before (its notice) the news
// tells of the end; minutes before, the next world is loaded and the
// simulation told the tick it ends on; at that tick the falls take the
// world, and the switch begins the next. A world begun inside its last day
// or its last days, by hand, has its next world made, or the news told, as
// it begins. An end missed while keel was down is switched on start,
// before anyone is let in.

// The jobs' names, as their runs are recorded.
const (
	jobNextWorld = "next-world"
	jobClosing   = "closing"
	jobSwitch    = "switch"
	jobSessions  = "sessions"
	jobWorlds    = "worlds"
)

// The daily jobs' time of day, UTC: the US night, before the backups.
const (
	sessionsHour, sessionsMinute = 7, 0
	worldsHour, worldsMinute     = 7, 15
)

// sessionLife is how long a session can be presented after it was last
// used: its cookie's life, which is set again at most daily.
const sessionLife = 400 * 24 * time.Hour

// jobRunKeep is how long jobs' runs are kept.
const jobRunKeep = 90 * 24 * time.Hour

// nextSeeds is how many seeds the next world is tried with in one run
// before the run fails, to be tried again.
const nextSeeds = 5

// worldColumn is the news's column for the world's end: the catalog's
// column of items about the world.
func worldColumn(cat *catalog.Catalog) string {
	for _, c := range cat.News.Columns {
		if c.Of == catalog.OfWorld {
			return string(c.ID)
		}
	}
	return ""
}

// lead is how long before a world's end the next world is loaded and the
// simulation told its last tick: five minutes, or half the schedule's
// ahead if that is shorter.
func (p *process) lead() time.Duration { return min(5*time.Minute, p.cfg.Schedule.Ahead/2) }

// remakeCutoff is how long before a world's end the next world may no
// longer be made, or begun, by hand: the scheduled switch is loading it.
func (p *process) remakeCutoff() time.Duration { return 2 * p.lead() }

// dueOf is when a job of a world that falls d before its end falls due:
// then, or as the world began, or its end was last moved, if that is
// later. A run is done once for each due time, so a world begun after its
// predecessor's run gets a due time of its own, which no other world can
// have, and the run at once; and so does a world whose end is brought near.
func dueOf(h *worldHalf, d time.Duration) time.Time {
	due := h.ends().Add(-d)
	from := h.row.BeginsAt
	if n := h.movedAt.Load(); n != 0 && time.Unix(0, n).After(from) {
		from = time.Unix(0, n)
	}
	if b := from.UTC().Truncate(time.Microsecond); b.After(due) {
		return b
	}
	return due
}

// lockMaking takes the making of the next world, and gives the function
// that lets it go.
func (p *process) lockMaking() func() {
	p.making <- struct{}{}
	p.makingNow.Store(true)
	return func() {
		p.makingNow.Store(false)
		<-p.making
	}
}

// worldToSail is the world to sail as keel starts: the active one, its end
// set by the schedule if it has none; or, if its end has passed while keel
// was down, the next, begun now, made first if it was not, the missed
// weeks one switch.
func (p *process) worldToSail(ctx context.Context) (store.World, error) {
	row, err := p.db.ActiveOrFirstWorld(ctx, firstEpoch)
	if err != nil {
		return store.World{}, err
	}
	now := time.Now()
	if row.EndsAt.IsZero() {
		end := p.cfg.Schedule.EndOf(now)
		if err := p.db.SetWorldEnd(ctx, p.lease, row.ID, end); err != nil {
			return store.World{}, fmt.Errorf("setting the world's end: %w", err)
		}
		row.EndsAt = end
		p.log.Info("the world had no end: the schedule gives it one", "world", row.Number, "ends", end, "schedule", p.cfg.Schedule.String())
	}
	if row.EndsAt.After(now) {
		return row, nil
	}
	p.health.Waiting("the next world")
	p.log.Warn("the world's end passed while keel was down: the next world begins now", "world", row.Number, "ended", row.EndsAt)
	nw, err := p.makeNext(ctx)
	if err != nil {
		return store.World{}, err
	}
	// No one chose this moment, and no one is watching it: the world lasts
	// at least the schedule's ahead.
	begins := time.Now()
	ends := p.cfg.Schedule.EndOf(begins)
	c, claimed, cerr := p.db.ClaimJob(ctx, p.lease, jobSwitch, row.EndsAt, 0)
	next, err := p.db.SwitchWorld(ctx, p.lease, row.Number, nw.ID, begins, ends)
	if err != nil {
		return store.World{}, fmt.Errorf("the late switch to world %d: %w", nw.Number, err)
	}
	if cerr == nil && claimed {
		_ = p.db.FinishJob(ctx, c, store.JobOK, fmt.Sprintf("late, on start: world %d begun", next.Number))
	}
	p.metrics.WorldSwitches.WithLabelValues("late").Inc()
	p.log.Info("a new world begins", "how", "late", "ended", row.Number, "begun", next.Number, "epoch", next.Epoch, "ends", next.EndsAt)
	return next, nil
}

// drawSeed is a new world's seed: KEEL_WORLD_SEED's, or one from
// crypto/rand.
func (p *process) drawSeed() (uint64, error) {
	if p.cfg.HasWorldSeed {
		return p.cfg.WorldSeed, nil
	}
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint64(b[:]), nil
}

// makeNext is the next world, made and stored first if it is not: its
// row, if there is none, with a new seed; then its terrain, made on this
// goroutine from the row's seed and stored, fenced by the lease. A world
// no attempt of which passes the generator's rules is not sailed: it is
// discarded and another seed drawn, nextSeeds times at most; unless the
// seed is KEEL_WORLD_SEED's, which is sailed as it was made, as a new
// world's first start does.
func (p *process) makeNext(ctx context.Context) (store.NextWorld, error) {
	// The next world's job, the switch and the owner may all want it at
	// once: one makes it, the others wait and find it made.
	defer p.lockMaking()()
	return p.makeNextLocked(ctx)
}

// makeNextLocked is makeNext with the making held.
func (p *process) makeNextLocked(ctx context.Context) (store.NextWorld, error) {
	for range nextSeeds {
		nw, err := p.db.NextWorld(ctx)
		if errors.Is(err, store.ErrNotFound) {
			seed, err := p.drawSeed()
			if err != nil {
				return store.NextWorld{}, err
			}
			placeholder := time.Now()
			if h := p.current.Load(); h != nil && !h.ends().IsZero() {
				placeholder = h.ends()
			}
			if _, err := p.db.CreateNextWorld(ctx, p.lease, seed, worldgen.Version, placeholder); err != nil {
				return store.NextWorld{}, fmt.Errorf("the next world's row: %w", err)
			}
			if nw, err = p.db.NextWorld(ctx); err != nil {
				return store.NextWorld{}, err
			}
			p.log.Info("the next world is begun: its terrain is made now", "world", nw.Number, "seed", nw.Seed)
		} else if err != nil {
			return store.NextWorld{}, err
		}
		if nw.Stored {
			return nw, nil
		}
		start := time.Now()
		b, genErr := p.opt.generate(nw.Seed)
		took := time.Since(start)
		switch {
		case errors.Is(genErr, worldgen.ErrInvalid) && !p.cfg.HasWorldSeed:
			p.log.Error("no attempt of the next world passed the world's rules: another seed is drawn", "world", nw.Number, "seed", nw.Seed,
				"attempts", b.Attempts, "took", took.Round(time.Millisecond).String())
			if err := p.db.DiscardNextWorld(ctx, p.lease, nw.Number); err != nil {
				return store.NextWorld{}, err
			}
			continue
		case errors.Is(genErr, worldgen.ErrInvalid):
			p.log.Error("no attempt passed the world's rules: it is sailed as the last was made", "seed", nw.Seed, "attempts", b.Attempts)
		case genErr != nil:
			return store.NextWorld{}, fmt.Errorf("making the next world's terrain: %w", genErr)
		}
		sb, err := storedBundle(b, nw.ID, took)
		if err != nil {
			return store.NextWorld{}, err
		}
		if err := p.db.StoreBundle(ctx, nw.ID, p.lease, sb); err != nil {
			return store.NextWorld{}, fmt.Errorf("storing the next world's terrain: %w", err)
		}
		// Its week, for when it is planned to begin: the world sailed's
		// end, or now.
		planned := time.Now().UTC().Truncate(time.Microsecond)
		if h := p.current.Load(); h != nil && !h.ends().IsZero() {
			planned = h.ends()
		}
		b.Seed = nw.Seed
		if _, err := p.makeWeek(ctx, nw.ID, nw.Number, b, planned, p.cfg.Schedule.EndOf(planned)); err != nil {
			return store.NextWorld{}, err
		}
		p.log.Info("the next world is made and stored", "world", nw.Number, "seed", nw.Seed, "made_from", b.Made, "attempts", b.Attempts,
			"islands", len(b.Islands), "digest", b.DigestHex(), "took", took.Round(time.Millisecond).String())
		p.metrics.WorldNextReady.Set(1)
		return p.db.NextWorld(ctx)
	}
	return store.NextWorld{}, fmt.Errorf("no next world passed the rules in %d seeds", nextSeeds)
}

// loadNext is the next world loaded, ahead of its switch: the one loaded
// already, or loaded now; and its view on the world page.
func (p *process) loadNext(ctx context.Context, nw store.NextWorld) (*readyWorld, error) {
	if rw := p.ahead.Load(); rw != nil && rw.row.ID == nw.ID {
		return rw, nil
	}
	start := time.Now()
	rw, err := p.loadWorld(ctx, nw.World)
	if err != nil {
		return nil, err
	}
	p.ahead.Store(rw)
	p.nextView.Store(ownerTools(ownerConfig{
		cat: p.cat, bundle: rw.bundle, made: rw.held.made, sailed: rw.row, wcfg: p.wcfg, timeline: rw.timeline, terrain: rw.terrain,
		db: p.db, charts: rw.charts, page: p.ownPage, log: p.log, metrics: p.metrics,
	}))
	p.log.Info("the next world is loaded", "world", nw.Number, "took", time.Since(start).Round(time.Millisecond).String())
	return rw, nil
}

// endAt tells the world half's simulation the tick it ends on, and waits
// for it.
func (p *process) endAt(ctx context.Context, h *worldHalf, tick int64) error {
	sender := h.bus.Commands.Server()
	for {
		err := sender.TrySend(bus.Command{Op: bus.End, At: tick})
		if err == nil {
			break
		}
		if !errors.Is(err, bus.ErrBusy) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	p.log.Info("the world ends at its tick", "world", h.row.Number, "tick", tick, "at", loop.TimeOf(tick, h.row.Epoch))
	select {
	case <-h.loop.Ended():
		return nil
	case <-h.loopDone:
		// The loop stopped before the end: keel is stopping.
		select {
		case <-h.loop.Ended():
			return nil
		default:
			return errStopping
		}
	case <-ctx.Done():
		return ctx.Err()
	}
}

// switchAt loads the next world, made first if it was not, ends the world
// sailed at the tick given, and switches to the next, beginning at that
// tick's time and ending at ends.
func (p *process) switchAt(ctx context.Context, h *worldHalf, tick int64, ends time.Time, how string) (string, error) {
	nw, err := p.makeNext(ctx)
	if err != nil {
		return "", err
	}
	rw, err := p.loadNext(ctx, nw)
	if err != nil {
		return "", err
	}
	if err := p.endAt(ctx, h, tick); err != nil {
		return "", err
	}
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if err := p.switchTo(sctx, rw, loop.TimeOf(tick, h.row.Epoch), ends, how); err != nil {
		return "", err
	}
	return fmt.Sprintf("world %d ended at tick %d; world %d begun, to end at %s", h.row.Number, tick, nw.Number, ends.Format(time.RFC3339)), nil
}

// lifecycleJobs are the jobs of a world's life, and the daily cleanup.
func (p *process) lifecycleJobs() []jobs.Job {
	sc := p.cfg.Schedule
	// end is the world sailed's end, and whether there is one.
	end := func() (time.Time, bool) {
		h := p.current.Load()
		if h == nil || h.ends().IsZero() {
			return time.Time{}, false
		}
		return h.ends(), true
	}
	// before is a job of the world sailed's, due d before its end, or as it
	// began.
	before := func(d time.Duration) (func(time.Time) (time.Time, bool), func(time.Time) time.Time) {
		dueNow := func() (time.Time, bool) {
			h := p.current.Load()
			if h == nil || h.ends().IsZero() {
				return time.Time{}, false
			}
			return dueOf(h, d), true
		}
		return func(now time.Time) (time.Time, bool) {
				due, ok := dueNow()
				return due, ok && !now.Before(due)
			}, func(time.Time) time.Time {
				due, _ := dueNow()
				return due
			}
	}
	nextDue, nextNext := before(sc.Ahead)
	closingDue, closingNext := before(sc.Notice)
	_, switchNext := before(p.lead())
	return []jobs.Job{
		{
			Name: jobNextWorld, Due: nextDue, Next: nextNext, Retry: 5 * time.Minute,
			Run: func(ctx context.Context, _ time.Time) (jobs.Result, error) {
				if nw, err := p.db.NextWorld(ctx); err == nil && nw.Stored {
					p.metrics.WorldNextReady.Set(1)
					return jobs.Result{Skipped: true, Detail: fmt.Sprintf("world %d is made already", nw.Number)}, nil
				}
				start := time.Now()
				nw, err := p.makeNext(ctx)
				if err != nil {
					return jobs.Result{}, err
				}
				return jobs.Result{Detail: fmt.Sprintf("world %d made from seed %d in %d attempts, %v", nw.Number, nw.Seed, nw.Attempts,
					time.Since(start).Round(time.Millisecond))}, nil
			},
		},
		{
			Name: jobClosing, Due: closingDue, Next: closingNext,
			Run: func(ctx context.Context, due time.Time) (jobs.Result, error) {
				h := p.current.Load()
				if h == nil || h.ends().IsZero() || !dueOf(h, sc.Notice).Equal(due) {
					return jobs.Result{Skipped: true, Detail: "the world's end has moved"}, nil
				}
				column := worldColumn(p.cat)
				if column == "" {
					return jobs.Result{Skipped: true, Detail: "the news has no column for the world"}, nil
				}
				n := store.WorldNews{Column: column, Number: h.row.Number, Title: "THE WORLD", What: "falls", EndsAt: h.ends()}
				if b := h.ready.bundle; len(b.Islands) > 0 {
					port := b.MainPort()
					n.Title, n.X, n.Y = strings.ToUpper(port.Name), port.X, port.Y
				}
				if err := p.db.WriteWorldNews(ctx, p.lease, h.row.ID, n); err != nil {
					return jobs.Result{}, err
				}
				return jobs.Result{Detail: fmt.Sprintf("world %d ends at %s: told in the news", h.row.Number, h.ends().Format(time.RFC3339))}, nil
			},
		},
		{
			Name: jobSwitch,
			Due: func(now time.Time) (time.Time, bool) {
				w, ok := end()
				if !ok {
					return time.Time{}, false
				}
				return w, !now.Before(w.Add(-p.lead()))
			},
			Next: switchNext, Retry: time.Minute,
			Run: func(ctx context.Context, due time.Time) (jobs.Result, error) {
				h := p.current.Load()
				if h == nil || !h.ends().Equal(due) {
					return jobs.Result{Skipped: true, Detail: "the world's end has moved"}, nil
				}
				if !p.switching.CompareAndSwap(false, true) {
					return jobs.Result{}, errSwitching
				}
				defer p.switching.Store(false)
				detail, err := p.switchAt(ctx, h, loop.TickAt(due, h.row.Epoch), sc.EndOf(due), "scheduled")
				return jobs.Result{Detail: detail}, err
			},
		},
		{
			Name: jobSessions, Due: jobs.Daily(sessionsHour, sessionsMinute), Next: jobs.DailyNext(sessionsHour, sessionsMinute),
			Run: func(ctx context.Context, due time.Time) (jobs.Result, error) {
				n, err := p.db.DeleteSessions(ctx, due.Add(-sessionLife))
				if err != nil {
					return jobs.Result{}, err
				}
				return jobs.Result{Detail: fmt.Sprintf("%d sessions deleted", n), Skipped: n == 0}, nil
			},
		},
		{
			Name: jobWorlds, Due: jobs.Daily(worldsHour, worldsMinute), Next: jobs.DailyNext(worldsHour, worldsMinute),
			Run: func(ctx context.Context, due time.Time) (jobs.Result, error) {
				runs, err := p.db.DeleteJobRuns(ctx, due.Add(-jobRunKeep))
				if err != nil {
					return jobs.Result{}, err
				}
				old, err := p.db.WorldsToDrop(ctx, due.Add(-p.cfg.WorldKeep))
				if err != nil {
					return jobs.Result{}, err
				}
				var dropped []string
				for _, w := range old {
					start := time.Now()
					if err := p.db.DropWorld(ctx, p.lease, w); err != nil {
						return jobs.Result{}, fmt.Errorf("dropping world %d: %w", w.Number, err)
					}
					p.log.Info("an ended world's data is dropped", "world", w.Number, "took", time.Since(start).Round(time.Millisecond).String())
					dropped = append(dropped, fmt.Sprint(w.Number))
				}
				if len(dropped) == 0 && runs == 0 {
					return jobs.Result{Skipped: true, Detail: "no world past its keep"}, nil
				}
				return jobs.Result{Detail: fmt.Sprintf("worlds dropped: [%s]; %d jobs' runs deleted", strings.Join(dropped, " "), runs)}, nil
			},
		},
	}
}

// The owner's hand on a world's life, from the world page.

// errTooLate is the next world asked to be made, or begun, by hand in the
// world's last minutes, as the scheduled switch loads it.
var errTooLate = errors.New("too near the world's end: the scheduled switch is loading the next world")

// errMaking is the next world asked to be begun while the owner's making
// of it is under way.
var errMaking = errors.New("the next world is being made by hand")

// tooLate reports whether the world is in its last minutes, when nothing
// is made or begun by hand.
func (p *process) tooLate(h *worldHalf) bool {
	return !h.ends().IsZero() && !time.Now().Before(h.ends().Add(-p.remakeCutoff()))
}

// BeginNext ends the world sailed, whose number must be the number given,
// a second from now, and begins the next: made first if it was not. The
// new world keeps the schedule: it ends when the old one would have,
// however near that is. It answers at once, with the new world's number
// and end; the switch follows.
func (p *process) BeginNext(ctx context.Context, number int) (int, time.Time, error) {
	h := p.current.Load()
	if h == nil || h.row.Number != number {
		return 0, time.Time{}, store.ErrNotActive
	}
	if p.tooLate(h) {
		return 0, time.Time{}, errTooLate
	}
	if !p.switching.CompareAndSwap(false, true) {
		return 0, time.Time{}, errSwitching
	}
	if p.remaking.Load() {
		p.switching.Store(false)
		return 0, time.Time{}, errMaking
	}
	begins := time.Now().Add(time.Second)
	tick := loop.TickAt(begins, h.row.Epoch)
	ends := h.ends()
	if ends.IsZero() {
		ends = p.cfg.Schedule.EndOf(begins)
	}
	go func() {
		defer p.switching.Store(false)
		detail, err := p.switchAt(context.Background(), h, tick, ends, "by_hand")
		if err != nil {
			p.log.Error("the next world was not begun", "err", err)
			return
		}
		p.log.Warn("owner: the next world begun by hand", "action", "world", "detail", detail)
	}()
	return number + 1, ends, nil
}

// MakeNext makes a new next world, of the number given: the active
// world's next. With none, one is made now; with one, stored or being
// made, it is discarded once made and another made from a new seed. It is
// recorded as a run of the next world's job, due now, and answers at once,
// saying whether a next world is to be discarded; the making follows.
func (p *process) MakeNext(ctx context.Context, number int) (bool, error) {
	h := p.current.Load()
	if h == nil || h.row.Number+1 != number {
		return false, store.ErrNoNext
	}
	if p.tooLate(h) {
		return false, errTooLate
	}
	if !p.remaking.CompareAndSwap(false, true) {
		return false, errMaking
	}
	if p.switching.Load() {
		p.remaking.Store(false)
		return false, errSwitching
	}
	_, err := p.db.NextWorld(ctx)
	discarding := err == nil
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		p.remaking.Store(false)
		return false, err
	}
	go func() {
		defer p.remaking.Store(false)
		p.makeByHand(context.Background(), number)
	}()
	return discarding, nil
}

// makeByHand discards the next world, if there is one, and makes another,
// with the making held throughout: a making under way, the job's, finishes
// first, and what it made is then discarded. A switch begun meanwhile
// keeps the next world it is loading.
func (p *process) makeByHand(ctx context.Context, number int) {
	due := time.Now().UTC().Truncate(time.Second)
	c, claimed, cerr := p.db.ClaimJob(ctx, p.lease, jobNextWorld, due, 0)
	finish := func(outcome, detail string) {
		if claimed && cerr == nil {
			_ = p.db.FinishJob(ctx, c, outcome, detail)
		}
	}
	fail := func(what string, err error) {
		p.log.Error(what, "world", number, "err", err)
		finish(store.JobFailed, err.Error())
	}
	defer p.lockMaking()()
	if p.switching.Load() {
		fail("the next world was not made by hand", errSwitching)
		return
	}
	action, was := "make", ""
	switch nw, err := p.db.NextWorld(ctx); {
	case err == nil:
		p.ahead.Store(nil)
		p.nextView.Store(nil)
		p.metrics.WorldNextReady.Set(0)
		if err := p.db.DiscardNextWorld(ctx, p.lease, nw.Number); err != nil {
			fail("the next world was not discarded", err)
			return
		}
		action, was = "remake", fmt.Sprintf(" (seed %d discarded)", nw.Seed)
		p.log.Warn("owner: the next world discarded, another to be made", "action", action, "world", nw.Number, "seed", nw.Seed)
	case !errors.Is(err, store.ErrNotFound):
		fail("the next world was not read", err)
		return
	}
	start := time.Now()
	made, err := p.makeNextLocked(ctx)
	if err != nil {
		fail("the next world was not made by hand", err)
		return
	}
	took := time.Since(start).Round(time.Millisecond)
	p.log.Warn("owner: the next world made by hand", "action", action, "world", made.Number, "seed", made.Seed, "took", took.String())
	finish(store.JobOK, fmt.Sprintf("by hand: world %d made from seed %d in %d attempts, %v%s", made.Number, made.Seed, made.Attempts, took, was))
}

// Switching reports whether a switch is under way.
func (p *process) Switching() bool { return p.switching.Load() }

// Lifecycle is the world's life as the world page shows it.
func (p *process) Lifecycle(ctx context.Context) (owner.Lifecycle, error) {
	h := p.current.Load()
	now := time.Now()
	lc := owner.Lifecycle{Now: now.UnixMilli(), Schedule: p.cfg.Schedule.String(), Switching: p.switching.Load(),
		Making: p.makingNow.Load() || p.remaking.Load(), Generator: worldgen.Version}
	if sc := p.cfg.Schedule; sc.Zone != nil {
		lc.Zone = sc.Zone.String()
	}
	if h != nil {
		lc.World = h.row.Number
		if !h.ends().IsZero() {
			lc.Ends = h.ends().UnixMilli()
			lc.Closing = p.cfg.Schedule.Closing(h.ends(), now)
			lc.ClosingFrom = h.ends().Add(-p.cfg.Schedule.Notice).UnixMilli()
			lc.NextMadeAt = dueOf(h, p.cfg.Schedule.Ahead).UnixMilli()
			lc.RemakeUntil = h.ends().Add(-p.remakeCutoff()).UnixMilli()
		}
		if !h.row.BeginsAt.IsZero() {
			lc.Began = h.row.BeginsAt.UnixMilli()
		}
	}
	nw, err := p.db.NextWorld(ctx)
	switch {
	case err == nil:
		lc.Next = &owner.NextWorld{Number: nw.Number, Seed: fmt.Sprint(nw.Seed), Generator: nw.Generator, Created: nw.Created.UnixMilli(),
			Stored: nw.Stored, Attempts: nw.Attempts, GenerationMs: nw.GenerationMs}
		if nw.Stored {
			lc.Next.StoredAt = nw.StoredAt.UnixMilli()
		}
	case !errors.Is(err, store.ErrNotFound):
		return lc, err
	}
	runs, err := p.db.JobRuns(ctx, 20)
	if err != nil {
		return lc, err
	}
	for _, r := range runs {
		jr := owner.JobRun{Job: r.Job, Due: r.Due.UnixMilli(), Started: r.Started.UnixMilli(), Outcome: r.Outcome, Detail: r.Detail, Attempts: r.Attempts}
		if !r.Finished.IsZero() {
			jr.Finished = r.Finished.UnixMilli()
		}
		lc.Runs = append(lc.Runs, jr)
	}
	return lc, nil
}

// NextView is the next world's view on the world page, loaded on the first
// request once its terrain is stored; nil before.
func (p *process) NextView(ctx context.Context) (*owner.Owner, error) {
	if v := p.nextView.Load(); v != nil {
		return v, nil
	}
	nw, err := p.db.NextWorld(ctx)
	if err != nil || !nw.Stored {
		return nil, err
	}
	if _, err := p.loadNext(ctx, nw); err != nil {
		return nil, err
	}
	return p.nextView.Load(), nil
}

// ownerHandler is the world page's routes for a world half.
func (p *process) ownerHandler(h *worldHalf) http.Handler { return h.tools.Handler() }

// statusNow is the status as last published, for GET /api/status.
func (p *process) statusNow() *api.Status { return p.status.Load() }

// publishStatus publishes the status once a second until ctx ends: the
// boats at sea and waiting, the world and its end.
func (p *process) publishStatus(ctx context.Context, h *worldHalf) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		f := h.bus.Frames.Acquire()
		st := &api.Status{AtSea: len(f.Live), Queued: len(f.Queue), World: h.row.Number}
		f.Release()
		if !h.ends().IsZero() {
			st.EndsAt = h.ends().UTC().Format(time.RFC3339)
			st.Closing = p.cfg.Schedule.Closing(h.ends(), time.Now())
		}
		p.status.Store(st)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// websiteOf is the website's origin, which may read the status: the
// players' origin's host without its first label, play, over HTTPS; none
// for an origin with no such label.
func websiteOf(playOrigin string) string {
	u, err := url.Parse(playOrigin)
	if err != nil {
		return ""
	}
	rest, ok := strings.CutPrefix(u.Host, "play.")
	if !ok || rest == "" {
		return ""
	}
	return "https://" + rest
}

// closingOf is when a world's last days begin, zero for a world with no
// end known.
func closingOf(row store.World, cfg config.Config) time.Time {
	if row.EndsAt.IsZero() {
		return time.Time{}
	}
	return row.EndsAt.Add(-cfg.Schedule.Notice)
}

// zoneOf is the time zone the schedule's ends are published in, "" for a
// schedule of periods.
func zoneOf(cfg config.Config) string {
	if cfg.Schedule.Zone == nil {
		return ""
	}
	return cfg.Schedule.Zone.String()
}

// endRoute brings the world's end near, on the internal listener only,
// with KEEL_DEV_COMMANDS=1: for the browser tests of a world's end, and to
// see one by hand. The end is stored, Welcomes tell it from now on, and the
// jobs look again: the next world is made, the news told, the switch
// prepared, as their times have come.
//
//	POST /debug/end?in=90s
func endRoute(p *process, h *worldHalf) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		in, err := time.ParseDuration(r.URL.Query().Get("in"))
		if err != nil || in < 10*time.Second || in > 24*time.Hour {
			http.Error(w, "in, a duration from 10s to 24h, is required", http.StatusBadRequest)
			return
		}
		if p.current.Load() != h || p.switching.Load() {
			http.Error(w, "the world is changing", http.StatusConflict)
			return
		}
		end := time.Now().Add(in).Truncate(time.Second).UTC()
		if err := p.db.SetWorldEnd(r.Context(), p.lease, h.row.ID, end); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		h.movedAt.Store(time.Now().UnixNano())
		h.endsAt.Store(end.UnixNano())
		h.game.SetEnds(end, end.Add(-p.cfg.Schedule.Notice))
		p.metrics.WorldEnds.Set(float64(end.Unix()))
		if p.jobs != nil {
			p.jobs.Poke()
		}
		p.log.Warn("the world's end brought near by hand", "world", h.row.Number, "ends", end)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"world": h.row.Number, "ends": end.UnixMilli()})
	})
}
