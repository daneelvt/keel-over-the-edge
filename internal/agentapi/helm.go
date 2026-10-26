// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/time/rate"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/lookout"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/view"
)

// The machine sailors at sea. Each machine sailor whose agent has called
// since keel started has a helm, in memory: the connection it joins the
// world with, its boat once it has one, when it last called, what has
// happened to it, the numbers it gives the boats it has seen, its wind
// readout, its budgets and its one wait. Every app approved for the
// machine sailor sails the one boat through the one helm, so two apps
// never fight over a boat unseen.
//
// A helm reaches the simulation only as the scripted sailors do: through
// the bus, writing its boat's control slot and sending Join, Disconnect
// and Leave. Its agent's calls are taken one at a time, in turn, by a
// one-place channel rather than a mutex, which a test's fake clock cannot
// see through. A call that waits gives its turn up while it waits.

// connBase is where the helms' connection numbers begin: far above the
// game connections', which count up from 1, so the two never meet.
const connBase = 1 << 63

// DefaultSilence is how long a machine sailor's boat stays at sea with no
// call from its agent, before its grace begins.
const DefaultSilence = 3 * time.Minute

// The helms' housekeeping: silence is looked for once a second, and a
// helm with no boat and no call for an hour is forgotten.
const (
	sweepEvery = time.Second
	forgetIdle = time.Hour
	// primerAfter is the silence after which the next answer begins with
	// the primer again.
	primerAfter = time.Hour
	// joinWait is the longest a call waits for the simulation to answer
	// its Join: it answers within a tick.
	joinWait = 2 * time.Second
)

// CoreConfig sets up the machine sailors' core.
type CoreConfig struct {
	Log     *slog.Logger
	Metrics *obs.Metrics
	// Silence is how long a boat stays at sea without a call;
	// DefaultSilence if 0.
	Silence time.Duration
	// Limits are the two budgets of every machine sailor; DefaultLimits
	// if zero.
	Limits Limits
	// Stopped, if not nil, reports whether a machine sailor is stopped by
	// the game's operator, or its human is: its calls are refused.
	Stopped func(store.AccountID) bool
}

// Core is the machine sailors' side of the game: their helms, the world
// sailed, and the hub that wakes calls that wait.
type Core struct {
	cfg   CoreConfig
	sea   atomic.Pointer[Sea]
	conns atomic.Uint64

	mu    sync.Mutex
	helms map[store.AccountID]*helm

	hub *hub
	// stopping is closed as keel stops: every wait ends at once.
	stopping chan struct{}
	stopOnce sync.Once
	// bell is when keel restarts, Unix ns, once the bell has rung; 0
	// before.
	bell atomic.Int64
}

// NewCore makes the machine sailors' core, with no world yet.
func NewCore(cfg CoreConfig) *Core {
	if cfg.Silence <= 0 {
		cfg.Silence = DefaultSilence
	}
	if cfg.Limits == (Limits{}) {
		cfg.Limits = DefaultLimits
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	c := &Core{cfg: cfg, helms: map[store.AccountID]*helm{}, stopping: make(chan struct{})}
	// Connection numbers go on from the clock, so a process's never meet
	// those of the process before, whose boats a checkpoint may restore.
	c.conns.Store(uint64(time.Now().UnixNano()) &^ connBase >> 1)
	c.hub = newHub(c)
	return c
}

// Silence is how long a boat stays at sea without a call.
func (c *Core) Silence() time.Duration { return c.cfg.Silence }

// Limits are the budgets of every machine sailor.
func (c *Core) Limits() Limits { return c.cfg.Limits }

// Open is told of a world as it opens, and returns what its simulation
// must hand each frame to. Boats of the world before are gone: each helm
// joins the new world at its agent's next call, told of the new world.
func (c *Core) Open(s *Sea) *Recorder {
	c.sea.Store(s)
	return c.hub.recorder(s)
}

// Close is told the world s has ended: waiting calls answer at once.
func (c *Core) Close(s *Sea) {
	if c.sea.CompareAndSwap(s, nil) {
		c.each(func(h *helm) { h.wakeAll(evWorldEnded) })
	}
}

// Bell rings the restart's bell: keel restarts in d, and every waiting
// call is told so at once.
func (c *Core) Bell(d time.Duration) {
	c.bell.Store(time.Now().Add(d).UnixNano())
	c.each(func(h *helm) {
		h.event(event{Kind: evRestart, Tick: h.lastTick(), Seconds: int64(d.Round(time.Second) / time.Second)})
	})
}

// Shutdown ends every wait at once, with the restart's words.
func (c *Core) Shutdown() {
	c.stopOnce.Do(func() { close(c.stopping) })
}

// each calls fn with every helm.
func (c *Core) each(fn func(*helm)) {
	c.mu.Lock()
	hs := make([]*helm, 0, len(c.helms))
	for _, h := range c.helms {
		hs = append(hs, h)
	}
	c.mu.Unlock()
	for _, h := range hs {
		fn(h)
	}
}

// Agent tells of a machine sailor's agent, for the world page: the app
// that last called, when, how long its wait has run, and its refusals.
func (c *Core) Agent(account bus.Account) (app string, last time.Time, waiting time.Duration, refusals uint64, ok bool) {
	c.mu.Lock()
	h := c.helms[store.AccountID(account)]
	c.mu.Unlock()
	if h == nil {
		return "", time.Time{}, 0, 0, false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.waiter != nil {
		waiting = time.Since(h.waiter.since)
	}
	return h.app, h.lastCall, waiting, h.refusals, true
}

// helmOf is the helm of the machine sailor the door accepted, made at its
// first call, its names and priority as the token's grant has them now.
func (c *Core) helmOf(a *oauth.Accepted) *helm {
	c.mu.Lock()
	defer c.mu.Unlock()
	h := c.helms[a.Account]
	if h == nil {
		l := c.cfg.Limits
		h = &helm{
			core: c, account: a.Account, conn: connBase + c.conns.Add(1), turn: make(chan struct{}, 1),
			orders: rate.NewLimiter(l.Orders, l.OrderBurst), looks: rate.NewLimiter(l.Looks, l.LookBurst),
			contacts: map[uint64]int{},
		}
		c.helms[a.Account] = h
		if c.cfg.Metrics != nil {
			c.cfg.Metrics.AgentHelms.Set(float64(len(c.helms)))
		}
	}
	h.mu.Lock()
	h.name, h.owner, h.priority = a.Name, a.OwnerName, a.Priority
	h.mu.Unlock()
	return h
}

// stopped reports whether a machine sailor is stopped.
func (c *Core) stopped(id store.AccountID) bool { return c.cfg.Stopped != nil && c.cfg.Stopped(id) }

// Stop forgets a machine sailor's helm, as when the account is stopped
// or deleted: a call waiting ends at once, refused with the words given,
// as does a call waiting for its turn; its boat leaves the water and its
// place in the queue is given up, with no grace.
func (c *Core) Stop(id store.AccountID, words string) {
	c.mu.Lock()
	h := c.helms[id]
	delete(c.helms, id)
	if c.cfg.Metrics != nil {
		c.cfg.Metrics.AgentHelms.Set(float64(len(c.helms)))
	}
	c.mu.Unlock()
	if h == nil {
		return
	}
	r := refuse(refusedStopped, words)
	h.mu.Lock()
	h.ended, h.waitEnd = r, r
	w, s, boat, queued := h.waiter, h.sea, h.boat, h.queued
	h.boat, h.queued, h.away = 0, false, true
	h.mu.Unlock()
	if w != nil {
		w.wake(wokeEnded)
	}
	if s == nil || s != c.sea.Load() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	switch {
	case boat != 0:
		_ = send(ctx, s, bus.Command{Op: bus.Leave, Boat: boat})
	case queued:
		_ = send(ctx, s, bus.Command{Op: bus.Disconnect, Account: bus.Account(id), Conn: h.conn})
	}
}

// Revoked is told a machine sailor's grants were revoked by the game's
// operator: a call waiting ends at once, refused with the words given, and
// its boat goes into its grace, so that its player's agent, approved
// again within it, keeps the boat.
func (c *Core) Revoked(id store.AccountID, words string) {
	c.mu.Lock()
	h := c.helms[id]
	c.mu.Unlock()
	if h == nil {
		return
	}
	h.mu.Lock()
	w := h.waiter
	if w != nil {
		h.waitEnd = refuse(refusedRevoked, words)
	}
	h.mu.Unlock()
	if w != nil {
		w.wake(wokeEnded)
	}
	h.disconnect()
}

// Run looks for silent agents once a second and forgets idle helms, until
// ctx ends; the hub runs beside it.
func (c *Core) Run(ctx context.Context) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		c.hub.run(ctx)
	}()
	t := time.NewTicker(sweepEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			<-done
			return
		case <-t.C:
			c.sweep(time.Now())
		}
	}
}

// sweep sends the boats of silent agents into their grace, and forgets the
// helms with neither a boat nor a call for an hour.
func (c *Core) sweep(now time.Time) {
	c.mu.Lock()
	var silent []*helm
	for id, h := range c.helms {
		h.mu.Lock()
		quiet := now.Sub(h.lastCall)
		afloat := h.boat != 0 || h.queued
		if afloat && !h.away && h.waiter == nil && quiet >= c.cfg.Silence {
			silent = append(silent, h)
		}
		if !afloat && h.waiter == nil && quiet >= forgetIdle {
			delete(c.helms, id)
		}
		h.mu.Unlock()
	}
	if c.cfg.Metrics != nil {
		c.cfg.Metrics.AgentHelms.Set(float64(len(c.helms)))
	}
	c.mu.Unlock()
	for _, h := range silent {
		h.mu.Lock()
		h.left = leftSilent
		h.mu.Unlock()
		if h.disconnect() && c.cfg.Metrics != nil {
			c.cfg.Metrics.AgentSilences.Inc()
		}
	}
}

// Why a boat left the water, told at the next call.
const (
	leftSilent  = "silent"  // its agent fell silent, and its grace ended
	leftGrace   = "grace"   // its grace ended with no call: after keel restarted
	leftAsked   = "asked"   // its agent asked: boat leave
	leftFalls   = "falls"   // the falls took the world
	leftWorld   = "world"   // a new world began
	leftUnknown = "unknown" // it was not found again
)

// helm is a machine sailor's helm.
type helm struct {
	core    *Core
	account store.AccountID
	conn    uint64
	// turn is held by the call being answered.
	turn chan struct{}

	orders, looks *rate.Limiter

	mu       sync.Mutex
	name     string
	owner    string
	priority bool
	app      string
	lastCall time.Time
	// before is when the agent called before the call being answered.
	before time.Time
	// sea is the world the helm last joined; slot, gen and boat its boat
	// there, boat 0 for none; queued, with its place, while it waits for
	// one.
	sea      *Sea
	slot     int32
	gen      uint16
	boat     uint64
	queued   bool
	position int32
	// away: its agent fell silent and its boat's grace has begun, or its
	// place is given up; the next call joins again.
	away bool
	// left is why its boat last left the water, until a call is told.
	left string
	// ended is a stopped machine sailor's refusal, for every call still
	// under way; waitEnd ends the call waiting, once.
	ended, waitEnd *refusal
	// pilot is the last order written: its mode, way, order count and
	// target; held is the sheet it holds, in the control's steps.
	ordered  bool
	refusals uint64
	// apps are the apps that have called, each logged once.
	apps map[string]bool

	// What the reports keep: the seq of the last report, the numbers of
	// the boats in sight, and the wind readout's samples.
	seq      int64
	contacts map[uint64]int
	next     int
	readout  lookout.Readout
	ring     ring
	waiter   *waiter
	// tracks are the boats' bearings and ranges at the last report.
	tracks map[uint64]sighting
	// turning is the autopilot's turn under way at the hub's last look.
	turning uint8
	// The lookout's room: the view's candidates, and its last view by
	// slot.
	cands []view.Candidate
	kept  []uint8
}

// take waits for the helm's turn, or for ctx.
func (h *helm) take(ctx context.Context) error {
	select {
	case h.turn <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// give gives the turn up.
func (h *helm) give() { <-h.turn }

// called records a call now, from app.
func (h *helm) called(now time.Time, app string) {
	h.mu.Lock()
	h.before, h.lastCall = h.lastCall, now
	if app != "" {
		h.app = app
	}
	h.mu.Unlock()
}

// lastTick is the tick of the latest event the helm knows of.
func (h *helm) lastTick() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ring.last()
}

// joinResult is what going to sea came to.
type joinResult struct {
	// joined: the boat is at sea, sailed by the helm; rejoined: it was
	// already. queued, at position, while the sea is full.
	joined, rejoined, queued bool
	position                 int32
	full                     bool
	// told is why the boat left the water before, if a call has not yet
	// been told.
	told string
}

// errNoSea is no world sailed: keel is between worlds or starting.
var errNoSea = errors.New("agentapi: no world is sailed")

// atSea makes sure the helm has its boat, joining the world if it has
// none: the sea it is in and the latest frame, held, which the caller
// releases. With the helm's turn held.
func (h *helm) atSea(ctx context.Context) (*Sea, *bus.Frame, joinResult, error) {
	s := h.core.sea.Load()
	if s == nil {
		return nil, nil, joinResult{}, errNoSea
	}
	var res joinResult
	h.mu.Lock()
	f := s.Bus.Frames.Acquire()
	if h.sea != s {
		// A new world: its ticks are its own, so what the helm kept of the
		// last is let go.
		if h.sea != nil {
			if h.boat != 0 {
				h.left = leftWorld
			}
			h.ring, h.seq = ring{}, 0
			h.ring.add(event{Tick: f.Tick, Kind: evNewWorld, Words: "a new world began"})
		}
		h.sea, h.boat, h.queued, h.away = s, 0, false, false
		clear(h.contacts)
	}
	res.told, h.left = h.left, ""
	found := h.locate(f)
	// A boat found that the helm does not sail (one restored as keel
	// started, in its grace, or one another process's helm joined) is
	// taken over with a Join, which ends its grace.
	need := !found || h.away || f.Conn[h.slot] != h.conn || f.Grace[h.slot] != 0
	h.mu.Unlock()
	if !need {
		return s, f, res, nil
	}
	f.Release()
	r, err := h.join(ctx, s)
	if err != nil {
		return nil, nil, res, err
	}
	h.mu.Lock()
	h.away = false
	switch r.Result {
	case bus.Joined, bus.Rejoined:
		h.slot, h.gen, h.boat, h.queued = r.Slot, r.Gen, r.Boat, false
		res.joined, res.rejoined = r.Result == bus.Joined, r.Result == bus.Rejoined
		if r.Result == bus.Joined {
			h.ordered = false
			clear(h.contacts)
		}
	case bus.Queued:
		h.boat, h.queued, h.position = 0, true, r.Position
		res.queued, res.position = true, r.Position
	case bus.Full:
		h.boat, h.queued = 0, false
		res.full = true
	}
	h.mu.Unlock()
	f = s.Bus.Frames.Acquire()
	if r.Result != bus.Full {
		// The frame that took the Join may not be the one acquired yet.
		for f.Tick < r.Tick {
			f.Release()
			select {
			case <-ctx.Done():
				return nil, nil, res, ctx.Err()
			case <-time.After(time.Second / 60):
			}
			f = s.Bus.Frames.Acquire()
		}
	}
	return s, f, res, nil
}

// locate finds the helm's boat in f, by its ID or else by its account, as
// a place in the queue gives it one; and reports whether it sails. With mu
// held.
func (h *helm) locate(f *bus.Frame) bool {
	if h.boat != 0 && h.slot >= 0 && int(h.slot) < len(f.Occupied) && f.Occupied[h.slot] && f.Boat[h.slot] == h.boat {
		h.queued = false
		return true
	}
	for _, s := range f.Live {
		if f.Owner[s] == bus.Account(h.account) {
			if h.boat != f.Boat[s] {
				h.ordered = false
			}
			h.slot, h.gen, h.boat, h.queued = s, f.Gen[s], f.Boat[s], false
			return true
		}
	}
	if h.boat != 0 && h.left == "" {
		h.left = leftUnknown
	}
	h.boat = 0
	if h.queued {
		for i := range f.Queue {
			if f.Queue[i].Account == bus.Account(h.account) {
				h.position, _ = bus.QueuePlace(f.Queue, i)
				return false
			}
		}
		h.queued = false
	}
	return false
}

// join asks the simulation for the helm's boat, and waits for its answer.
func (h *helm) join(ctx context.Context, s *Sea) (bus.Reply, error) {
	h.mu.Lock()
	priority := h.priority
	h.mu.Unlock()
	reply := make(chan bus.Reply, 1)
	cmd := bus.Command{Op: bus.Join, Account: bus.Account(h.account), Conn: h.conn, Machine: true, Priority: priority, Reply: reply}
	if err := send(ctx, s, cmd); err != nil {
		return bus.Reply{}, err
	}
	t := time.NewTimer(joinWait)
	defer t.Stop()
	select {
	case r := <-reply:
		return r, nil
	case <-t.C:
		return bus.Reply{}, errBusy
	case <-ctx.Done():
		return bus.Reply{}, ctx.Err()
	}
}

// errBusy is the simulation's command queue full, or no answer in time.
var errBusy = errors.New("agentapi: the simulation is busy")

// send queues a command, trying for a second while the queue is full.
func send(ctx context.Context, s *Sea, c bus.Command) error {
	players := s.Bus.Commands.Players()
	for range 30 {
		err := players.TrySend(c)
		if !errors.Is(err, bus.ErrBusy) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second / 30):
		}
	}
	return errBusy
}

// disconnect ends the helm's connection: its boat's grace begins, or its
// place in the queue is given up; it reports whether it had either.
func (h *helm) disconnect() bool {
	h.mu.Lock()
	s, had := h.sea, h.boat != 0 || h.queued
	h.away = true
	h.mu.Unlock()
	if s == nil || !had {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return send(ctx, s, bus.Command{Op: bus.Disconnect, Account: bus.Account(h.account), Conn: h.conn}) == nil
}

// leave takes the helm's boat out of the water, as its agent asks.
func (h *helm) leave(ctx context.Context, s *Sea) (bool, error) {
	h.mu.Lock()
	boat, queued := h.boat, h.queued
	h.mu.Unlock()
	var c bus.Command
	switch {
	case boat != 0:
		c = bus.Command{Op: bus.Leave, Boat: boat}
	case queued:
		c = bus.Command{Op: bus.Disconnect, Account: bus.Account(h.account), Conn: h.conn}
	default:
		return false, nil
	}
	// The boat is gone once the simulation has answered: a call after
	// this one never finds it again.
	reply := make(chan bus.Reply, 1)
	c.Reply = reply
	if err := send(ctx, s, c); err != nil {
		return false, err
	}
	t := time.NewTimer(joinWait)
	defer t.Stop()
	select {
	case r := <-reply:
		for f := s.Bus.Frames.Acquire(); f.Tick < r.Tick; f = s.Bus.Frames.Acquire() {
			f.Release()
			select {
			case <-ctx.Done():
				return false, ctx.Err()
			case <-time.After(time.Second / 60):
			}
		}
	case <-t.C:
		return false, errBusy
	case <-ctx.Done():
		return false, ctx.Err()
	}
	h.mu.Lock()
	h.boat, h.queued, h.left = 0, false, ""
	h.mu.Unlock()
	return true, nil
}
