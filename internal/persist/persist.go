// SPDX-License-Identifier: AGPL-3.0-only

// Package persist writes the world's lasting state to the database behind
// the simulation, never making the tick wait: what the simulation decided
// that lasts (a boat launched, returned, expired), within a fraction of a
// second, and a checkpoint of the whole world every few seconds, from which
// the next process restores it.
//
// It is a recorder (sim.Recorder): on the tick, a frame's lasting events
// are copied into a recycled buffer and, every CheckpointEvery ticks, the
// frame itself is held; either goes to the writer's inbox by a send that
// never waits. The writer encodes a held frame at once, as the input log
// does, and releases it, keeping only the newest checkpoint not yet
// written; every BatchEvery it writes what waits in one fenced transaction
// (store.Persister), trying again with a growing wait when it fails,
// dropping nothing and keeping the order.
//
// The inbox holds Inbox items not yet written. Half full, the writer asks
// the simulation to hold admission (bus.Hold), so the world takes on no
// more than it can record; below a quarter, to let it go. Full, it can no
// longer record what it has promised, and Failed says so: the process must
// stop. A batch refused because another process has taken the lease
// (store.ErrFenced) stops the writing for good, and Failed says that too.
package persist

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

const (
	// CheckpointEvery is how often the world is checkpointed: 10 s of ticks.
	// A checkpoint's WAL is almost all its own bytes (151 KB at 1,000
	// boats), so the interval sets the WAL's volume, about 67 MB an hour
	// at 1,000 boats; and how much of the world a crash loses. A stop in
	// order writes a final checkpoint whatever the interval.
	CheckpointEvery = 300
	// Inbox is how many items may wait to be written: 10 s of ticks.
	Inbox = 300
	// HoldAt and LetGoBelow are the inbox's fill at which admission is held,
	// and below which it is let go.
	HoldAt     = Inbox / 2
	LetGoBelow = Inbox / 4
	// BatchEvery is how often what waits is written.
	BatchEvery = 200 * time.Millisecond
	// FirstRetry and LastRetry bound the wait before a failed batch is tried
	// again, which doubles from the first to the last.
	FirstRetry = 500 * time.Millisecond
	LastRetry  = 5 * time.Second
)

// eventBuffer is an event buffer's starting size: a tick's events are few;
// a buffer that needs more grows once and keeps it.
const eventBuffer = 16

// ErrOverflow means the inbox was full: something lasting was not recorded.
var ErrOverflow = errors.New("persist: the inbox is full: the world's writes are too far behind")

// Writer writes a batch in one fenced transaction, bounding its time
// itself: store.Persister.
type Writer interface {
	Write(ctx context.Context, b store.Batch) error
}

// Config sets up the writer.
type Config struct {
	Frames *bus.Frames // the world's, to hold frames for checkpoints
	Store  Writer
	World  [16]byte // the world's ID
	Epoch  int64    // the lease's, which every batch is fenced with
	// What a checkpoint says made it.
	Build, Catalog string
	Layout         uint32
	// Hold is the sender of the server's own commands: admission held.
	Hold    bus.Sender
	Log     *slog.Logger
	Metrics *obs.Metrics // may be nil
	// Zero values are the defaults above; tests shorten them.
	Every                             int64
	BatchEvery, FirstRetry, LastRetry time.Duration
}

// Persist records a world's lasting state and writes it.
type Persist struct {
	cfg Config

	// The tick's side.
	items  chan item
	free   chan []store.Event
	latest atomic.Int64 // the latest tick recorded

	// unwritten counts the items sent and not yet written: the inbox's
	// fill.
	unwritten atomic.Int64
	oldest    atomic.Int64 // the oldest unwritten item's tick, or −1
	overflows atomic.Uint64
	events    atomic.Uint64 // events written
	written   atomic.Uint64 // checkpoints written
	cpBytes   atomic.Int64  // the latest checkpoint's size

	failOnce sync.Once
	fail     chan struct{}
	failErr  error

	// The writer's side.
	closing context.Context // set before items is closed
	ctx     context.Context // ends a write under way when Close's time is up
	cancel  context.CancelFunc
	done    chan struct{}
	err     error // why Run ended, read after done

	pending  [][]store.Event // event buffers not yet written, in order
	batch    []store.Event   // pending flattened, for a write
	cp       store.Checkpoint
	haveCP   bool
	holding  bool
	fenced   bool
	retryAt  time.Time
	retry    time.Duration
	lastFail time.Time
	m        metrics
}

// metrics are the writer's, resolved once; nil without obs.Metrics.
type metrics struct {
	batch, checkpoint               prometheus.Observer
	ok, failed, fenced, leaseFenced prometheus.Counter
}

type item struct {
	tick   int64
	events []store.Event // a lasting tick's events, a buffer of free's
	frame  *bus.Frame    // a checkpoint's, held, for the writer to release
}

// New makes the writer. Run must be running for it to write anything.
func New(cfg Config) *Persist {
	if cfg.Every <= 0 {
		cfg.Every = CheckpointEvery
	}
	if cfg.BatchEvery <= 0 {
		cfg.BatchEvery = BatchEvery
	}
	if cfg.FirstRetry <= 0 {
		cfg.FirstRetry = FirstRetry
	}
	if cfg.LastRetry <= 0 {
		cfg.LastRetry = LastRetry
	}
	p := &Persist{
		cfg:   cfg,
		items: make(chan item, Inbox),
		free:  make(chan []store.Event, Inbox),
		fail:  make(chan struct{}),
		done:  make(chan struct{}),
		batch: make([]store.Event, 0, 1024),
	}
	if m := cfg.Metrics; m != nil {
		p.m = metrics{
			batch: m.PersistBatch, checkpoint: m.PersistCheckpoint, ok: m.PersistWrites.WithLabelValues("ok"), failed: m.PersistWrites.WithLabelValues("failed"),
			fenced: m.PersistWrites.WithLabelValues("fenced"), leaseFenced: m.LeaseLost.WithLabelValues("fenced"),
		}
	}
	p.ctx, p.cancel = context.WithCancel(context.Background())
	p.oldest.Store(-1)
	for range Inbox {
		p.free <- make([]store.Event, 0, eventBuffer)
	}
	return p
}

// Record is given each frame as it is published: its lasting events, and
// every Every ticks the frame itself, go to the inbox. It never blocks.
func (p *Persist) Record(f *bus.Frame) {
	p.latest.Store(f.Tick)
	if p.failed() {
		return
	}
	if lasting(f) {
		select {
		case buf := <-p.free:
			if !p.send(item{tick: f.Tick, events: appendEvents(buf[:0], f)}) {
				p.free <- buf
				return
			}
		default:
			p.overflow()
			return
		}
	}
	if f.Tick%p.cfg.Every == 0 {
		fr := p.cfg.Frames.Acquire()
		if !p.send(item{tick: fr.Tick, frame: fr}) {
			fr.Release()
		}
	}
}

// send puts an item in the inbox, if there is room.
func (p *Persist) send(it item) bool {
	if p.unwritten.Load() >= Inbox {
		p.overflow()
		return false
	}
	select {
	case p.items <- it:
		p.unwritten.Add(1)
		return true
	default:
		p.overflow()
		return false
	}
}

func (p *Persist) overflow() {
	p.overflows.Add(1)
	p.failWith(ErrOverflow)
}

func (p *Persist) failWith(err error) {
	p.failOnce.Do(func() {
		p.failErr = err
		close(p.fail)
	})
}

func (p *Persist) failed() bool {
	select {
	case <-p.fail:
		return true
	default:
		return false
	}
}

// Failed is closed once the writer can no longer keep its promise: the
// inbox overflowed, or another process has taken the lease. Err says
// which. The process must stop.
func (p *Persist) Failed() <-chan struct{} { return p.fail }

// Err is why Failed was closed: ErrOverflow, or an error wrapping
// store.ErrFenced.
func (p *Persist) Err() error {
	select {
	case <-p.fail:
		return p.failErr
	default:
		return nil
	}
}

// lasting reports whether a frame's tick decided anything lasting.
func lasting(f *bus.Frame) bool {
	for i := range f.Events {
		if kindOf(&f.Events[i]) != "" {
			return true
		}
	}
	return false
}

// kindOf is the kind of lasting event a tick's event is, or "".
func kindOf(e *bus.Event) string {
	switch {
	case e.Op == bus.Join && (e.Reply.Result == bus.Joined || e.Reply.Result == bus.Admitted):
		return store.EventLaunched
	case e.Reply.Result == bus.Left:
		return store.EventReturned
	case e.Reply.Result == bus.Expired:
		return store.EventExpired
	}
	return ""
}

// appendEvents appends a frame's lasting events to dst.
func appendEvents(dst []store.Event, f *bus.Frame) []store.Event {
	for i := range f.Events {
		e := &f.Events[i]
		if k := kindOf(e); k != "" {
			dst = append(dst, store.Event{Tick: f.Tick, Kind: k, Account: e.Account, Boat: e.Reply.Boat})
		}
	}
	return dst
}

// Fill is the inbox's fill, from 0 to 1.
func (p *Persist) Fill() float64 { return float64(p.unwritten.Load()) / Inbox }

// Oldest is the world time between the oldest item not yet written and the
// latest tick, or 0 when nothing waits.
func (p *Persist) Oldest() time.Duration {
	o := p.oldest.Load()
	if o < 0 {
		return 0
	}
	return time.Duration(max(p.latest.Load()-o, 0)) * time.Second / physics.StepsPerSecond
}

// Overflows counts the items lost because the inbox was full.
func (p *Persist) Overflows() uint64 { return p.overflows.Load() }

// Events counts the events written.
func (p *Persist) Events() uint64 { return p.events.Load() }

// Checkpoints counts the checkpoints written.
func (p *Persist) Checkpoints() uint64 { return p.written.Load() }

// CheckpointBytes is the latest checkpoint's size, as encoded.
func (p *Persist) CheckpointBytes() int64 { return p.cpBytes.Load() }

// Run writes what Record hands it until Close, then writes what is left.
// It does not recover from panics: a bug here should stop the server.
func (p *Persist) Run() error {
	defer close(p.done)
	t := time.NewTicker(p.cfg.BatchEvery)
	defer t.Stop()
	for {
		select {
		case it, ok := <-p.items:
			if !ok {
				p.err = p.flush()
				return p.err
			}
			p.absorb(it)
		case now := <-t.C:
			if !now.Before(p.retryAt) {
				p.write(p.ctx)
			}
		}
		p.pressure()
	}
}

// absorb takes an item from the inbox into what waits: events in order; a
// frame encoded at once and released, replacing any checkpoint not yet
// written.
func (p *Persist) absorb(it item) {
	if p.fenced {
		p.forget(it)
		return
	}
	if p.oldest.Load() < 0 {
		p.oldest.Store(it.tick)
	}
	if it.events != nil {
		p.pending = append(p.pending, it.events)
		return
	}
	f := it.frame
	p.cp.Tick = f.Tick
	p.cp.Boats = len(f.Live)
	p.cp.Data = sim.AppendSnapshot(p.cp.Data[:0], f)
	f.Release()
	p.cpBytes.Store(int64(len(p.cp.Data)))
	if p.haveCP {
		// The older checkpoint is superseded: it will never be written.
		p.unwritten.Add(-1)
	}
	p.haveCP = true
}

// forget drops an item once writing has stopped for good.
func (p *Persist) forget(it item) {
	if it.events != nil {
		p.free <- it.events
	}
	if it.frame != nil {
		it.frame.Release()
	}
	p.unwritten.Add(-1)
}

// write writes what waits in one batch; on failure it is kept, and tried
// again after a growing wait.
func (p *Persist) write(ctx context.Context) error {
	if p.fenced || len(p.pending) == 0 && !p.haveCP {
		return nil
	}
	p.batch = p.batch[:0]
	for _, buf := range p.pending {
		p.batch = append(p.batch, buf...)
	}
	b := store.Batch{World: p.cfg.World, Epoch: p.cfg.Epoch, Events: p.batch}
	if p.haveCP {
		p.cp.Format = sim.SnapshotVersion
		p.cp.Build, p.cp.Catalog, p.cp.Layout, p.cp.Epoch = p.cfg.Build, p.cfg.Catalog, p.cfg.Layout, p.cfg.Epoch
		b.Checkpoint = &p.cp
	}
	start := time.Now()
	err := p.cfg.Store.Write(ctx, b)
	m := p.m
	if m.batch != nil {
		d := time.Since(start).Seconds()
		m.batch.Observe(d)
		if b.Checkpoint != nil {
			m.checkpoint.Observe(d)
		}
	}
	switch {
	case err == nil:
		n := int64(len(p.pending))
		for _, buf := range p.pending {
			p.free <- buf
		}
		clear(p.pending)
		p.pending = p.pending[:0]
		if p.haveCP {
			n++
			p.haveCP = false
			p.written.Add(1)
		}
		p.events.Add(uint64(len(p.batch)))
		p.unwritten.Add(-n)
		p.oldest.Store(-1)
		p.retry, p.retryAt = 0, time.Time{}
		if m.ok != nil {
			m.ok.Inc()
		}
		if !p.lastFail.IsZero() && p.cfg.Log != nil {
			p.cfg.Log.Info("the world's writes go through again", "since", time.Since(p.lastFail).Round(time.Millisecond).String())
			p.lastFail = time.Time{}
		}
		return nil
	case errors.Is(err, store.ErrFenced):
		p.fenced = true
		if m.fenced != nil {
			m.fenced.Inc()
			m.leaseFenced.Inc()
		}
		if p.cfg.Log != nil {
			p.cfg.Log.Error("the world's writes were refused: another process holds the simulation lease", "err", err)
		}
		for _, buf := range p.pending {
			p.free <- buf
		}
		p.unwritten.Add(-int64(len(p.pending)))
		p.pending = p.pending[:0]
		if p.haveCP {
			p.unwritten.Add(-1)
			p.haveCP = false
		}
		p.oldest.Store(-1)
		p.failWith(err)
		return err
	}
	if m.failed != nil {
		m.failed.Inc()
	}
	p.retry = min(max(2*p.retry, p.cfg.FirstRetry), p.cfg.LastRetry)
	p.retryAt = time.Now().Add(p.retry)
	if p.cfg.Log != nil && (p.lastFail.IsZero() || time.Since(p.lastFail) >= time.Minute) {
		p.cfg.Log.Warn("the world's writes failed; trying again", "err", err, "retry", p.retry.String(),
			"events", len(p.batch), "checkpoint", p.haveCP)
		p.lastFail = time.Now()
	}
	return err
}

// pressure holds admission while the inbox is half full, and lets it go
// once it is below a quarter.
func (p *Persist) pressure() {
	n := p.unwritten.Load()
	switch {
	case !p.holding && n >= HoldAt:
		if p.cfg.Hold.TrySend(bus.Command{Op: bus.Hold, Held: true}) == nil {
			p.holding = true
			if p.cfg.Log != nil {
				p.cfg.Log.Warn("the world's writes are behind: admission held", "unwritten", n)
			}
		}
	case p.holding && n < LetGoBelow:
		if p.cfg.Hold.TrySend(bus.Command{Op: bus.Hold}) == nil {
			p.holding = false
			if p.cfg.Log != nil {
				p.cfg.Log.Info("the world's writes have caught up: admission let go", "unwritten", n)
			}
		}
	}
}

// flush writes what is left, trying again until it is written or the
// closing context ends.
func (p *Persist) flush() error {
	ctx := p.closing
	for {
		err := p.write(ctx)
		if p.fenced {
			return p.Err()
		}
		if err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("persist: %d events and a checkpoint (%v) not written: %w", len(p.batch), p.haveCP, err)
		case <-time.After(time.Until(p.retryAt)):
		}
	}
}

// Close records final, if not nil, as the last checkpoint, and has Run
// write everything left, within ctx; it returns once Run has, with what
// Run returned. The world must have stopped ticking: nothing may be
// recorded after.
func (p *Persist) Close(ctx context.Context, final *bus.Frame) error {
	if final != nil {
		select {
		case p.items <- item{tick: final.Tick, frame: final}:
			p.unwritten.Add(1)
		case <-ctx.Done():
			final.Release()
		}
	}
	p.closing = ctx
	close(p.items)
	select {
	case <-p.done:
	case <-ctx.Done():
		p.cancel()
		<-p.done
	}
	p.cancel()
	return p.err
}
