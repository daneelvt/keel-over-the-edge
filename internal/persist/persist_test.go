// SPDX-License-Identifier: AGPL-3.0-only

package persist

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/replay"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The writer against a database in memory, in fake time: synctest's clock
// moves only when every goroutine waits, so seconds of ticks run at once.

// fakeDB is a database that can be stopped, and can fence.
type fakeDB struct {
	mu       sync.Mutex
	down     bool
	fenced   bool
	attempts int
	writes   []written
}

type written struct {
	at     time.Time
	events []store.Event
	cp     *store.Checkpoint
}

func (d *fakeDB) Write(_ context.Context, b store.Batch) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.attempts++
	switch {
	case d.fenced:
		return fmt.Errorf("%w: the epoch is %d", store.ErrFenced, b.Epoch+1)
	case d.down:
		return errors.New("dial tcp: connection refused")
	}
	w := written{at: time.Now(), events: slices.Clone(b.Events)}
	if b.Checkpoint != nil {
		cp := *b.Checkpoint
		cp.Data = slices.Clone(cp.Data)
		w.cp = &cp
	}
	d.writes = append(d.writes, w)
	return nil
}

func (d *fakeDB) set(down, fenced bool) {
	d.mu.Lock()
	d.down, d.fenced = down, fenced
	d.mu.Unlock()
}

func (d *fakeDB) all() (events []store.Event, cps []store.Checkpoint) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, w := range d.writes {
		events = append(events, w.events...)
		if w.cp != nil {
			cps = append(cps, *w.cp)
		}
	}
	return events, cps
}

func kinds(t testing.TB) []physics.Prepared {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	ks := make([]physics.Prepared, len(cat.Boats))
	for i := range cat.Boats {
		p := catalog.PhysicsParams(&cat.Boats[i])
		physics.Prepare(&p, &ks[i])
	}
	return ks
}

func acct(n uint64) bus.Account {
	var a bus.Account
	for k := range 8 {
		a[15-k] = byte(n >> (8 * k))
	}
	return a
}

// rig is a world recorded by a writer, ticked on the clock by the test.
type rig struct {
	w      *sim.World
	p      *Persist
	db     *fakeDB
	run    chan error
	ticked map[int64]time.Time // when each tick ran
	// lasting counts the lasting events the world decided.
	lasting []store.Event
}

func newRig(t *testing.T, hold bus.Sender, grace int64, limit int) *rig {
	t.Helper()
	w, err := sim.New(sim.Config{Capacity: 64, Kinds: kinds(t), Workers: 1, Tick: 1000, Grace: grace, Limit: limit})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	r := &rig{w: w, db: &fakeDB{}, run: make(chan error, 1), ticked: map[int64]time.Time{}}
	if hold == (bus.Sender{}) {
		hold = w.Bus().Commands.Server()
	}
	r.p = New(Config{
		Frames: w.Bus().Frames, Store: r.db, World: [16]byte{9}, Epoch: 3,
		Build: "test", Catalog: catalog.Version, Layout: physics.LayoutVersion,
		Hold: hold, Log: slog.New(slog.DiscardHandler),
	})
	go func() { r.run <- r.p.Run() }()
	return r
}

// tick runs one tick on the clock, with the commands given.
func (r *rig) tick(cs ...bus.Command) {
	time.Sleep(time.Second / 30)
	q := r.w.Bus().Commands.Developer()
	for _, c := range cs {
		q.TrySend(c)
	}
	r.w.Tick()
	f := r.w.Latest()
	r.ticked[f.Tick] = time.Now()
	r.lasting = appendEvents(r.lasting, f)
	r.p.Record(f)
}

func (r *rig) close(t *testing.T) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := r.p.Close(ctx, r.w.Bus().Frames.Acquire())
	if e := <-r.run; e != err {
		t.Fatalf("Run returned %v, Close %v", e, err)
	}
	return err
}

// TestEventsAndCheckpoints: each lasting event reaches the database in
// order within 250 ms of its tick, with its sailor; a checkpoint every 10 s,
// and the last frame's as the writer closes.
func TestEventsAndCheckpoints(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := newRig(t, bus.Sender{}, 60, 0)
		for i := range 10 {
			r.tick(bus.Command{Op: bus.Join, Account: acct(uint64(i + 1)), Conn: uint64(i + 1)})
		}
		r.tick(bus.Command{Op: bus.Leave, Boat: 2}, bus.Command{Op: bus.Leave, Boat: 5})
		r.tick(bus.Command{Op: bus.Disconnect, Boat: 7, Conn: 7})
		for range 25 * 30 {
			r.tick()
		}
		last := r.w.Now()
		if err := r.close(t); err != nil {
			t.Fatal(err)
		}
		events, cps := r.db.all()
		if !slices.Equal(events, r.lasting) || len(events) != 13 {
			t.Fatalf("%d events written, the world decided %d:\n%v\n%v", len(events), len(r.lasting), events, r.lasting)
		}
		kinds := map[string]int{}
		for _, e := range events {
			kinds[e.Kind]++
		}
		if kinds[store.EventLaunched] != 10 || kinds[store.EventReturned] != 2 || kinds[store.EventExpired] != 1 {
			t.Fatalf("kinds %v", kinds)
		}
		if e := events[11]; e.Account != acct(5) || e.Boat != 5 {
			t.Fatalf("the second return: %+v", e)
		}
		if e := events[12]; e.Kind != store.EventExpired || e.Account != acct(7) || e.Boat != 7 {
			t.Fatalf("the grace that ended: %+v", e)
		}
		r.db.mu.Lock()
		for _, w := range r.db.writes {
			for _, e := range w.events {
				if d := w.at.Sub(r.ticked[e.Tick]); d > 250*time.Millisecond {
					t.Errorf("tick %d's event written %v after it", e.Tick, d)
				}
			}
		}
		r.db.mu.Unlock()
		var ticks []int64
		for _, c := range cps {
			ticks = append(ticks, c.Tick)
			if c.Format != sim.SnapshotVersion || c.Build != "test" || c.Catalog != catalog.Version || c.Layout != physics.LayoutVersion || c.Epoch != 3 {
				t.Fatalf("checkpoint %+v", c)
			}
		}
		if len(ticks) < 3 || ticks[0]%CheckpointEvery != 0 || ticks[len(ticks)-1] != last {
			t.Fatalf("checkpoints at %v; the last tick %d", ticks, last)
		}
		for i := 1; i < len(ticks)-1; i++ {
			if ticks[i]-ticks[i-1] != CheckpointEvery {
				t.Fatalf("checkpoints at %v", ticks)
			}
		}
		// The last checkpoint is the world as it stopped.
		g := bus.NewFrame(64)
		if err := sim.ReadSnapshot(cps[len(cps)-1].Data, g); err != nil {
			t.Fatal(err)
		}
		if f := r.w.Latest(); sim.Digest(g) != sim.Digest(f) || cps[len(cps)-1].Boats != len(f.Live) {
			t.Fatal("the last checkpoint is not the last frame")
		}
		if r.p.Checkpoints() != uint64(len(cps)) || r.p.Events() != 13 || r.p.Fill() != 0 {
			t.Fatalf("%d checkpoints, %d events, fill %v", r.p.Checkpoints(), r.p.Events(), r.p.Fill())
		}
	})
}

// TestDatabaseStopped: while the database is stopped, nothing is lost: the
// inbox fills, admission is held at half and let go below a quarter once
// the database is back, every event is then written in order, and of the
// checkpoints taken meanwhile only the newest. The input log, which holds
// the holds, replays the run.
func TestDatabaseStopped(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := newRig(t, bus.Sender{}, 0, 40)
		inputs := replay.New(replay.Config{
			Frames: r.w.Bus().Frames, Log: slog.New(slog.DiscardHandler),
			Header: replay.Header{Build: "test", Catalog: catalog.Version, Layout: physics.LayoutVersion, Capacity: 64, Epoch: time.Unix(0, 0), Grace: sim.GraceTicks, Limit: 40},
		})
		logged := make(chan error, 1)
		go func() { logged <- inputs.Run() }()
		r.w.Record(inputs)
		next := uint64(1)
		churn := func() {
			// A boat launched or returned every tick.
			if f := r.w.Latest(); f.Tick%2 == 0 || len(f.Live) == 0 {
				r.tick(bus.Command{Op: bus.Join, Account: acct(next), Conn: next})
				next++
			} else {
				r.tick(bus.Command{Op: bus.Leave, Boat: f.Boat[f.Live[0]]})
			}
		}
		for range 20 {
			r.tick(bus.Command{Op: bus.Join, Account: acct(next), Conn: next})
			next++
		}
		for range 60 {
			churn()
		}
		r.db.set(true, false)
		stopped := r.w.Now()
		heldAt := int64(0)
		for range 21 * 30 {
			churn()
			if heldAt == 0 && r.w.Latest().Held {
				heldAt = r.w.Now()
				if f := r.p.Fill(); f < 0.5 {
					t.Fatalf("held at a fill of %v", f)
				}
			}
		}
		if heldAt == 0 {
			t.Fatalf("admission was never held; fill %v", r.p.Fill())
		}
		if r.p.Oldest() < 10*time.Second {
			t.Fatalf("the oldest unwritten item is %v old", r.p.Oldest())
		}
		r.db.set(false, false)
		back := r.w.Now()
		letGo := int64(0)
		for range 10 * 30 {
			churn()
			if letGo == 0 && !r.w.Latest().Held {
				letGo = r.w.Now()
			}
		}
		if letGo == 0 || letGo-back > 7*30 {
			t.Fatalf("admission let go at tick %d, the database back at %d", letGo, back)
		}
		if err := r.close(t); err != nil {
			t.Fatal(err)
		}
		events, cps := r.db.all()
		if !slices.Equal(events, r.lasting) {
			t.Fatalf("%d events written, the world decided %d", len(events), len(r.lasting))
		}
		// The first checkpoint after the database came back is the newest
		// taken while it was away.
		var after []int64
		for _, c := range cps {
			if c.Tick > stopped {
				after = append(after, c.Tick)
			}
		}
		if back-stopped < 2*CheckpointEvery || len(after) == 0 || after[0] < back-back%CheckpointEvery {
			t.Fatalf("checkpoints after the stop %v; stopped at %d, back at %d", after, stopped, back)
		}

		inputs.Close()
		if err := <-logged; err != nil {
			t.Fatal(err)
		}
		f, err := replay.Read(inputs.Snapshot())
		if err != nil {
			t.Fatal(err)
		}
		holds := 0
		for _, seg := range f.Segments {
			for _, rec := range seg.Records {
				for _, e := range rec.Events {
					if e.Op == bus.Hold {
						holds++
					}
				}
			}
		}
		res, err := replay.Run(f, replay.Options{Kinds: kinds(t), Workers: 1})
		if err != nil {
			t.Fatal(err)
		}
		if holds != 2 || res.Diverged != nil || res.Digests == 0 {
			t.Fatalf("%d holds in the log; replay %+v, %v", holds, res, res.Diverged)
		}
	})
}

// TestInboxFull: a world that takes on more than can be written, with the
// database stopped: once the inbox is full the writer fails, and says why.
func TestInboxFull(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// The holds go nowhere, so the world keeps taking boats on.
		r := newRig(t, bus.NewQueue().Server(), 0, 0)
		r.db.set(true, false)
		next := uint64(1)
		for range Inbox + 10 {
			if f := r.w.Latest(); len(f.Live) < 30 {
				r.tick(bus.Command{Op: bus.Join, Account: acct(next), Conn: next})
				next++
			} else {
				r.tick(bus.Command{Op: bus.Leave, Boat: f.Boat[f.Live[0]]})
			}
		}
		select {
		case <-r.p.Failed():
		default:
			t.Fatalf("not failed at a fill of %v", r.p.Fill())
		}
		if !errors.Is(r.p.Err(), ErrOverflow) || r.p.Overflows() == 0 {
			t.Fatalf("err %v, %d overflows", r.p.Err(), r.p.Overflows())
		}
		r.db.set(false, false)
		if err := r.close(t); err != nil {
			t.Fatal(err)
		}
		// What was in the inbox is written, the final checkpoint too.
		events, cps := r.db.all()
		if len(events) < Inbox-10 || len(cps) == 0 || cps[len(cps)-1].Tick != r.w.Now() {
			t.Fatalf("%d events and %d checkpoints written", len(events), len(cps))
		}
	})
}

// TestFenced: a batch refused because another process holds the lease
// stops the writing for good.
func TestFenced(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := newRig(t, bus.Sender{}, 0, 0)
		r.db.set(false, true)
		r.tick(bus.Command{Op: bus.Join, Account: acct(1), Conn: 1})
		for range 30 {
			r.tick()
		}
		select {
		case <-r.p.Failed():
		default:
			t.Fatal("not failed")
		}
		if !errors.Is(r.p.Err(), store.ErrFenced) {
			t.Fatalf("err %v", r.p.Err())
		}
		attempts := r.db.attempts
		r.db.set(false, false)
		for range 300 {
			r.tick(bus.Command{Op: bus.Join, Account: acct(uint64(r.w.Now())), Conn: 1})
		}
		if err := r.close(t); !errors.Is(err, store.ErrFenced) {
			t.Fatalf("close: %v", err)
		}
		if events, cps := r.db.all(); len(events) != 0 || len(cps) != 0 || r.db.attempts != attempts {
			t.Fatalf("written after the fence: %d events, %d checkpoints, %d attempts", len(events), len(cps), r.db.attempts-attempts)
		}
	})
}

// TestCloseBounded: with the database stopped, closing gives up when its
// time is up, saying what was not written.
func TestCloseBounded(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		r := newRig(t, bus.Sender{}, 0, 0)
		r.db.set(true, false)
		r.tick(bus.Command{Op: bus.Join, Account: acct(1), Conn: 1})
		start := time.Now()
		err := r.close(t)
		if err == nil || time.Since(start) > 5*time.Second+100*time.Millisecond {
			t.Fatalf("closed after %v: %v", time.Since(start), err)
		}
	})
}
