// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/agentapi"
	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/config"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/jobs"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/owner"
	"github.com/daneelvt/keel-over-the-edge/internal/persist"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/replay"
	"github.com/daneelvt/keel-over-the-edge/internal/scripted"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/watch"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// keel is two halves. The process keeps what lasts from one world to the
// next: its configuration, logs and metrics, the listeners, the database's
// pools, the simulation's lease, the page, the sessions and the jobs. The
// world half is what belongs to one world: its terrain and chunks, its
// chart and sight table, the simulation and its loop, the input log, the
// world's writes, the game connections' edge and the owner's view of it.
// A world half is opened by openWorld and closed by close; at a world's end
// the switch closes the old half and opens the next in the running process,
// in a pause of under a second, rather than stopping the process and
// starting it again. The public routes reach the world half through one
// pointer each, swapped as the new half opens.

// process is what keel keeps across worlds.
type process struct {
	cfg      config.Config
	opt      serveOptions
	build    string
	log      *slog.Logger
	health   *obs.Health
	metrics  *obs.Metrics
	db       database
	writer   worldWriter
	lease    int64
	cat      *catalog.Catalog
	waves    *physics.Waves
	kinds    []physics.Prepared
	wcfg     *weather.Config
	sessions *auth.Cache
	passkeys *auth.Passkeys
	looks    []string
	page     *api.Page
	ownPage  *api.Page
	flight   *obs.Flight
	jobs     *jobs.Runner
	// agents is sign-in for AI apps and the MCP address.
	agents *agents
	// hand is the owner's hand on accounts, and every deletion's.
	hand *accounts.Accounts
	// allowing is the accounts that let anyone watch them always.
	allowing *watch.Allowing

	// The routes the world half serves, set as each opens.
	replayRoutes, devRoutes, ownerRoutes, playRoutes *lateHandler

	// lost: another process may hold the world: no bell, no final
	// checkpoint.
	lost atomic.Bool
	// fail is told of a world half's failure, which stops the process.
	fail chan error

	// mu is held while a world half is opened, closed or switched.
	mu       sync.Mutex
	stopping bool // under mu: no more switches
	current  atomic.Pointer[worldHalf]
	// switching is set while a switch is under way, from the loading of
	// the next world to its opening.
	switching atomic.Bool
	// ahead is the next world loaded ahead of the switch, or nil.
	ahead atomic.Pointer[readyWorld]
	// nextView is the next world's view on the world page, once stored.
	nextView atomic.Pointer[owner.Owner]
	// making holds a token while the next world is made, makingNow set;
	// remaking is set from the owner's asking for a new next world until it
	// is made. A making may take minutes, and another waits for it.
	making    chan struct{}
	makingNow atomic.Bool
	remaking  atomic.Bool

	carriedMu sync.Mutex
	carried   counts

	status atomic.Pointer[api.Status]
}

// counts are a world half's counters, carried over as it closes so the
// process's metrics keep counting up.
type counts struct {
	refused, allocated, replayBytes, segments, replayDropped uint64
	overflows, events, checkpoints                           uint64
}

func (c counts) add(o counts) counts {
	return counts{
		c.refused + o.refused, c.allocated + o.allocated, c.replayBytes + o.replayBytes, c.segments + o.segments,
		c.replayDropped + o.replayDropped, c.overflows + o.overflows, c.events + o.events, c.checkpoints + o.checkpoints,
	}
}

// count reads one of the counters across every world the process has
// sailed.
func (p *process) count(of func(counts) uint64) func() uint64 {
	return func() uint64 {
		p.carriedMu.Lock()
		c := p.carried
		p.carriedMu.Unlock()
		if h := p.current.Load(); h != nil {
			c = c.add(h.counts())
		}
		return of(c)
	}
}

// gauge reads a gauge of the world half, 0 while there is none.
func (p *process) gauge(of func(*worldHalf) float64) func() float64 {
	return func() float64 {
		if h := p.current.Load(); h != nil {
			return of(h)
		}
		return 0
	}
}

// registerWorldMetrics registers the world half's metrics, once a process.
func (p *process) registerWorldMetrics() {
	m := p.metrics
	m.CounterFunc("keel_sim_commands_refused_total", "Commands refused because the queue was full.", p.count(func(c counts) uint64 { return c.refused }))
	m.CounterFunc("keel_sim_frames_allocated_total", "Frames made because every frame in the pool was in use.", p.count(func(c counts) uint64 { return c.allocated }))
	m.CounterFunc("keel_replay_bytes_total", "Bytes recorded in the input log.", p.count(func(c counts) uint64 { return c.replayBytes }))
	m.CounterFunc("keel_replay_segments_total", "Segments started in the input log.", p.count(func(c counts) uint64 { return c.segments }))
	m.CounterFunc("keel_replay_records_dropped_total", "Input log records lost because its writer was behind.", p.count(func(c counts) uint64 { return c.replayDropped }))
	m.GaugeFunc("keel_persist_inbox_fill_ratio", "The share of the world's writes' inbox holding what is not yet written.", nil,
		p.gauge(func(h *worldHalf) float64 { return h.lasting.Fill() }))
	m.GaugeFunc("keel_persist_oldest_seconds", "World time since the oldest of the world's writes not yet written; 0 when none waits.", nil,
		p.gauge(func(h *worldHalf) float64 { return h.lasting.Oldest().Seconds() }))
	m.GaugeFunc("keel_persist_checkpoint_bytes", "The latest checkpoint's size, as encoded.", nil,
		p.gauge(func(h *worldHalf) float64 { return float64(h.lasting.CheckpointBytes()) }))
	m.CounterFunc("keel_persist_overflow_total", "The world's writes lost because their inbox was full: the process stops.", p.count(func(c counts) uint64 { return c.overflows }))
	m.CounterFunc("keel_persist_events_total", "The world's lasting events written.", p.count(func(c counts) uint64 { return c.events }))
	m.CounterFunc("keel_persist_checkpoints_total", "The world's checkpoints written.", p.count(func(c counts) uint64 { return c.checkpoints }))
}

// readyWorld is a world loaded, not yet sailed: its row, its terrain and
// what is built from it, the chart and its sight table among them. The
// switch loads the next world so ahead of its beginning.
type readyWorld struct {
	row           store.World
	held          *terrain
	bundle        *worldgen.Bundle
	terrain       *sim.Terrain
	terrainDigest [32]byte
	chunks        *api.Chunks
	handout       *edge.Handout
	roamHandout   *edge.Handout
	mainLight     *pb.Light
	charts        *worldChart
	// timeline is the world's weather: its week as stored, until the world
	// opens with its own.
	timeline *weather.Timeline
}

// loadWorld loads a world's terrain, making it first if it has none, and
// builds from it what the world half serves: the chunks and their
// handouts, the places and lights, the chart and the islands' models.
func (p *process) loadWorld(ctx context.Context, row store.World) (*readyWorld, error) {
	held, err := worldTerrain(ctx, p.db, row, p.lease, p.cfg, p.opt.generate, p.health, p.log)
	if err != nil {
		return nil, err
	}
	cat, cfg := p.cat, p.cfg
	rw := &readyWorld{row: row, held: held, bundle: held.bundle}
	bundle := held.bundle
	if cfg.Land {
		rw.terrain = bundle.Terrain(cat.PrepareGround())
		rw.terrainDigest = bundle.Digest
		rw.chunks = api.NewChunks(row.ID, held.key, held.payloads)
		// A town's buildings, an arch's span and a wood's canopy stand over
		// the horizon as land as high would.
		var tops []edge.Top
		for _, t := range bundle.Tops(cat) {
			tops = append(tops, edge.Top{X: t[0], Y: t[1], Height: t[2]})
		}
		rw.handout = edge.NewHandout(bundle.Ground, rw.chunks.Paths(), handoutRule(cat)).WithTops(tops)
		// The owner's free camera sees from higher: its own handout.
		rw.roamHandout = edge.NewHandout(bundle.Ground, rw.chunks.Paths(), roamRule(cat)).WithTops(tops)
		// The places go with their chunks, the lights by range.
		places := wirePlaces(bundle, cat)
		var lights *edge.Lights
		rw.mainLight, lights = wireLights(bundle, cat)
		caps := wireCaps(bundle, cat)
		for _, h := range []*edge.Handout{rw.handout, rw.roamHandout} {
			h.SetPlaces(places)
			h.SetLights(lights)
			h.SetCaps(caps)
		}
		p.log.Info("serving the world's chunks", "world", row.Number, "bytes", rw.chunks.Size(), "places", len(places), "lights", len(bundle.Lights))
	} else {
		p.log.Warn("land is off: the world's terrain is sailed as open sea")
	}
	rw.timeline = p.shownWeek(ctx, row)
	// What can be charted, and the islands' models: the world's, whether
	// its land is sailed or not.
	made := time.Now()
	rw.charts = newWorldChart(bundle, cat, row.ID, held.key)
	p.log.Info("the world's chart is built", "world", row.Number, "subjects", len(rw.charts.world.Subjects), "models", rw.charts.models.Size(),
		"took", time.Since(made).Round(time.Millisecond).String())
	return rw, nil
}

// worldHalf is a world sailed: its simulation and everything that serves
// it.
type worldHalf struct {
	p     *process
	ready *readyWorld
	row   store.World

	world   *sim.World
	bus     *bus.Bus
	inputs  *replay.Log
	loop    *loop.Loop
	game    *edge.Edge
	lasting *persist.Persist
	// forecasts issues the world's forecast.
	forecasts *forecast.Issuer
	// sea is the world as the machine sailors' tools reach it.
	sea   *agentapi.Sea
	tools *owner.Owner
	play  http.Handler

	// endsAt is when the world ends, Unix ns, 0 for none known: its row's,
	// unless a developer's command has brought it nearer; movedAt when that
	// command last did, 0 for never.
	endsAt, movedAt atomic.Int64

	stopLoop, stopSailors, stopEncoder, stopWatch  context.CancelFunc
	loopDone, inputsDone, sailorsDone, encoderDone chan struct{}
	lastingDone, watchDone                         chan struct{}
	closed                                         bool
}

// ends is when the world ends; zero for none known.
func (h *worldHalf) ends() time.Time {
	n := h.endsAt.Load()
	if n == 0 {
		return time.Time{}
	}
	return time.Unix(0, n).UTC()
}

// counts are the half's counters now.
func (h *worldHalf) counts() counts {
	return counts{
		refused: h.bus.Commands.Refused(), allocated: h.bus.Frames.Allocated(),
		replayBytes: h.inputs.Bytes(), segments: h.inputs.Segments(), replayDropped: h.inputs.Dropped(),
		overflows: h.lasting.Overflows(), events: h.lasting.Events(), checkpoints: h.lasting.Checkpoints(),
	}
}

// openWorld opens the world half of a world loaded: the simulation, at its
// checkpoint if it has a recent one of this build's formats; its chart
// restored; the input log, the tick loop, the edge, the world's writes,
// the owner's view and the game's routes. Nothing runs until start.
func (p *process) openWorld(ctx context.Context, rw *readyWorld) (*worldHalf, error) {
	cat, cfg, row := p.cat, p.cfg, rw.row
	epoch := row.Epoch
	timeline, err := p.weekFor(ctx, rw)
	if err != nil {
		return nil, fmt.Errorf("the world's week of weather: %w", err)
	}
	rw.timeline = timeline
	sighting := rw.charts.sight(cat, epoch)
	world, err := sim.New(sim.Config{
		Kinds: p.kinds, Waves: p.waves, Weather: timeline, Encounters: cat.PrepareEncounters(), Workers: p.opt.workers,
		Tick: loop.TickAt(time.Now(), epoch), Limit: cfg.BoatLimit, Terrain: rw.terrain, Edge: edgeOf(cat), Sight: sighting,
	})
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*worldHalf, error) {
		world.Close()
		return nil, err
	}
	if err := restore(ctx, p.db, world, row, p.log, p.metrics); err != nil {
		return fail(err)
	}
	if err := rw.charts.restore(ctx, p.db, row.ID, world, p.log); err != nil {
		return fail(err)
	}
	b := world.Bus()
	h := &worldHalf{p: p, ready: rw, row: row, world: world, bus: b}
	if !row.EndsAt.IsZero() {
		h.endsAt.Store(row.EndsAt.UnixNano())
	}
	h.inputs = replay.New(replay.Config{
		Frames: b.Frames,
		Header: replay.Header{Build: p.build, Catalog: catalog.Version, Layout: physics.LayoutVersion, Capacity: world.Capacity(), Epoch: epoch, Grace: world.Grace(), Limit: world.Limit(),
			Seed: rw.bundle.Seed, Generator: rw.bundle.Generator, Terrain: rw.terrainDigest,
			WeatherVersion: timeline.Week().Version, WeatherEnds: time.UnixMicro(timeline.Week().Ends).UTC(), Weather: weekDigest(timeline.Week())},
		Dir: cfg.ReplayDir,
		Log: p.log,
	})
	lcfg := loop.Config{World: world, Epoch: epoch, Log: p.log, Metrics: p.metrics, Health: p.health, AfterTick: p.opt.afterTick}
	if p.flight != nil {
		lcfg.Overrun = p.flight.Overrun
	}
	h.loop = loop.New(lcfg)
	h.forecasts = p.forecastsOf(rw, row, timeline)
	h.game = edge.New(edge.Config{
		Bus: b, World: store.AccountID(row.ID).String(), Epoch: epoch, Ends: row.EndsAt, Closing: closingOf(row, cfg), Zone: zoneOf(cfg), Clock: h.loop,
		Protocol: protocol.Version, Catalog: catalog.Version, Layout: physics.LayoutVersion,
		Origin: cfg.PlayOrigin, Log: p.log, Metrics: p.metrics, Fail: api.WriteError,
		Land: cfg.Land, Chunks: rw.handout, Circulation: circulationOf(rw.terrain),
		Lip: p.wcfg.Prepared.Edge(), RoamChunks: rw.roamHandout, MainLight: rw.mainLight, Chart: rw.charts.model,
		Forecast: h.forecasts,
		Stopped:  func(a bus.Account) bool { return p.hand.Stopped().Has(store.AccountID(a)) },
		Seen:     p.sessions.Seen,
		Watch:    p.watchTarget, Allowing: p.allowing, SpectatorLimit: cfg.SpectatorLimit,
		Agent: p.agents.core.Attending,
	})
	h.lasting = persist.New(persist.Config{
		Frames: b.Frames, Store: p.writer, World: row.ID, Epoch: p.lease,
		Build: p.build, Catalog: catalog.Version, Layout: physics.LayoutVersion,
		Hold: b.Commands.Server(), Log: p.log, Metrics: p.metrics,
		Chart: rw.charts.model, Written: rw.charts.model.Add, FoldWithin: rw.charts.model.FoldWithin(),
	})
	h.sea = p.seaOf(h, rw, sighting)
	world.Record(h.inputs, h.game, h.lasting, h.forecasts, p.agents.core.Open(h.sea))
	h.tools = ownerTools(ownerConfig{
		cat: cat, bus: b, bundle: rw.bundle, made: rw.held.made, sailed: row, wcfg: p.wcfg, timeline: timeline, terrain: rw.terrain,
		db: p.db, sessions: p.sessions, game: h.game, charts: rw.charts, clock: h.loop, page: p.ownPage, log: p.log, metrics: p.metrics,
		lifecycle: p, from: p.nextView.Load(), forecasts: h.forecasts, agents: p.agents, hand: p.hand,
		aiCap: world.AICap(), aiReserve: world.AIReserve(),
	})
	playCfg := api.Config{
		Version:   api.Version{Build: p.build, Catalog: catalog.Version},
		Log:       p.log,
		Metrics:   p.metrics,
		Accounts:  p.db,
		Sessions:  p.sessions,
		Passkeys:  p.passkeys,
		Deletions: p.hand,
		Looks:     p.looks,
		Game:      h.game,
		Page:      p.page,
		Chunks:    rw.chunks,
		Models:    modelsOf(rw.charts),

		News:        news{db: p.db, world: row.ID},
		NewsPage:    cat.News.Page,
		Notices:     p.db,
		NoticeKinds: noticeKinds(cat),
		Status:      p.statusNow,
		Website:     websiteOf(cfg.PlayOrigin),
	}
	playCfg.Watch = watch.New(watch.Config{Store: p.db, Allowing: p.allowing, Frames: b.Frames, Edge: h.game, Kinds: boatIDs(cat)})
	p.agents.apiConfig(&playCfg, p)
	h.play = api.Handler(playCfg)
	p.log.Info("world ready", "world", row.Number, "kinds", len(p.kinds), "capacity", world.Capacity(), "limit", world.Limit(),
		"workers", p.opt.workers, "tick", world.Now(), "ends", row.EndsAt)
	return h, nil
}

// accountsWorld is the world sailed as the accounts' actions reach it, or
// nil between worlds.
func (p *process) accountsWorld() accounts.World {
	h := p.current.Load()
	if h == nil {
		return nil
	}
	return accountsWorld{h}
}

// accountsWorld is a world half as the accounts' actions reach it.
type accountsWorld struct{ h *worldHalf }

// Stopped takes a stopped account out of the game: its connection closes
// with 4003, its boat leaves the water, its place in the queue goes.
func (w accountsWorld) Stopped(id store.AccountID) {
	w.h.game.Remove(bus.Account(id), edge.ReasonStopped)
}

// Deleted does the same for an account deleted, and its credits on the
// chart lose its name, as the database's have.
func (w accountsWorld) Deleted(id store.AccountID) {
	w.h.game.Remove(bus.Account(id), edge.ReasonDeleted)
	if c := w.h.ready.charts; c != nil {
		c.model.Forget(id)
	}
}

// Watching is whose boat an account's game connection watches.
func (w accountsWorld) Watching(id store.AccountID) (string, bool) {
	return w.h.game.Watching(bus.Account(id))
}

// Sea is where an account's boat is in the latest frame.
func (w accountsWorld) Sea(id store.AccountID) (accounts.Sea, bool) {
	f := w.h.bus.Frames.Acquire()
	defer f.Release()
	a := bus.Account(id)
	for _, s := range f.Live {
		if f.Owner[s] == a {
			st := &f.State[s]
			out := accounts.Sea{Boat: f.Boat[s], East: st.X, North: st.Y, Connected: f.Conn[s] != 0 && f.Grace[s] == 0, Machine: f.Machine[s]}
			if g := f.Grace[s]; g != 0 {
				out.Grace = float64(g-f.Tick) * physics.Dt
			}
			return out, true
		}
	}
	for i := range f.Queue {
		if f.Queue[i].Account == a {
			pos, _ := bus.QueuePlace(f.Queue, i)
			return accounts.Sea{Queued: true, Position: int(pos), Machine: f.Queue[i].Machine}, true
		}
	}
	return accounts.Sea{}, false
}

// start runs the world half and serves it: its loop, its writes, its
// encoders and the owner's view, the scripted sailors; then the routes.
func (h *worldHalf) start() {
	p := h.p
	var loopCtx, sailorsCtx, encoderCtx, watchCtx context.Context
	loopCtx, h.stopLoop = context.WithCancel(context.Background())
	sailorsCtx, h.stopSailors = context.WithCancel(context.Background())
	encoderCtx, h.stopEncoder = context.WithCancel(context.Background())
	watchCtx, h.stopWatch = context.WithCancel(context.Background())
	h.loopDone, h.inputsDone, h.sailorsDone, h.encoderDone = make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	h.lastingDone, h.watchDone = make(chan struct{}), make(chan struct{})
	go func() {
		defer close(h.inputsDone)
		if err := h.inputs.Run(); err != nil {
			p.failWith(err)
		}
	}()
	go func() {
		defer close(h.lastingDone)
		// What it returns, the stop logs: a fence, or what the final flush
		// could not write.
		_ = h.lasting.Run()
	}()
	go func() {
		defer close(h.watchDone)
		select {
		case <-h.lasting.Failed():
			err := h.lasting.Err()
			if errors.Is(err, store.ErrFenced) {
				p.lost.Store(true)
			}
			p.log.Error("the world's writes cannot go on: stopping", "err", err)
			p.failWith(err)
		case <-watchCtx.Done():
		}
	}()
	go func() {
		defer close(h.loopDone)
		_ = h.loop.Run(loopCtx)
	}()
	go func() {
		defer close(h.encoderDone)
		// The world page's view, and the status, built while the encoders
		// run.
		var wg sync.WaitGroup
		wg.Go(func() { h.tools.Run(encoderCtx) })
		wg.Go(func() { h.forecasts.Run(encoderCtx) })
		wg.Go(func() { p.publishStatus(encoderCtx, h) })
		h.game.Run(encoderCtx)
		wg.Wait()
	}()
	go func() {
		defer close(h.sailorsDone)
		if p.cfg.DevSailors == 0 {
			return
		}
		_ = scripted.Run(sailorsCtx, scripted.Config{N: p.cfg.DevSailors, Bus: h.bus, Seed: uint64(time.Now().UnixNano()), Log: p.log})
	}()
	p.replayRoutes.set(h.inputs)
	if p.devRoutes != nil {
		dev := devRoutes(sailorsCtx, h.bus, p.cat, h.ready.charts, p.log)
		end := endRoute(p, h)
		p.devRoutes.set(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/debug/end" {
				end.ServeHTTP(w, r)
				return
			}
			dev.ServeHTTP(w, r)
		}))
	}
	p.ownerRoutes.set(p.ownerHandler(h))
	p.playRoutes.set(h.play)
	p.metrics.WorldNumber.Set(float64(h.row.Number))
	if !h.ends().IsZero() {
		p.metrics.WorldEnds.Set(float64(h.ends().Unix()))
	}
}

// closeHow is how a world half closes.
type closeHow int

const (
	// closeStop: keel stops. The bell first, then the final checkpoint, and
	// every connection closed with 1012, to come back to this world.
	closeStop closeHow = iota
	// closeEnded: the world has ended, its last tick ticked. Its final
	// checkpoint and the boats the falls took are written, and every
	// connection is closed with 4004, to come back to the next world.
	closeEnded
)

// close closes the world half: the scripted sailors and the loop stop; the
// world's final checkpoint and every event left are written (at most
// finalTimeout), and only then is every game connection closed (at most
// closeTimeout), so a slow phone can never cost the checkpoint; then the
// encoders, the input log and the simulation's workers. It returns the
// world's last tick.
func (h *worldHalf) close(how closeHow) int64 {
	p := h.p
	if h.closed {
		return h.world.Now()
	}
	h.closed = true
	h.stopSailors()
	<-h.sailorsDone
	h.stopLoop()
	<-h.loopDone
	last := h.world.Now()
	start := time.Now()
	var final *bus.Frame
	bound := finalTimeout
	lost := p.lost.Load()
	if lost {
		// The events left are tried once more, briefly: fenced at once if
		// another process holds the world, and if the database is away,
		// waiting for it only lengthens the pause.
		bound = time.Second
	} else {
		final = h.bus.Frames.Acquire()
	}
	h.stopWatch()
	<-h.watchDone
	fctx, fcancel := context.WithTimeout(context.Background(), bound)
	err := h.lasting.Close(fctx, final)
	fcancel()
	<-h.lastingDone
	switch {
	case lost:
	case err != nil:
		p.log.Error("the final checkpoint was not written", "world", h.row.Number, "err", err)
	default:
		p.log.Info("the final checkpoint is written", "world", h.row.Number, "tick", last, "took", time.Since(start).Round(time.Millisecond).String())
	}
	// Shutdown leaves hijacked connections alone: the game's are closed
	// here.
	cctx, ccancel := context.WithTimeout(context.Background(), closeTimeout)
	if how == closeEnded {
		err = h.game.WorldEnded(cctx)
	} else {
		err = h.game.Shutdown(cctx)
	}
	if err != nil {
		p.log.Warn("game connections dropped: they did not answer their close in time", "err", err)
	}
	ccancel()
	p.agents.core.Close(h.sea)
	h.stopEncoder()
	<-h.encoderDone
	h.inputs.Close()
	<-h.inputsDone
	p.carriedMu.Lock()
	p.carried = p.carried.add(h.counts())
	p.carriedMu.Unlock()
	h.world.Close()
	return last
}

// failWith stops the process with err, once.
func (p *process) failWith(err error) {
	select {
	case p.fail <- err:
	default:
	}
}

// errStopping is a switch asked of a process that is stopping.
var errStopping = errors.New("keel is stopping")

// errSwitching is a switch asked while another is under way.
var errSwitching = errors.New("a switch is under way")

// switchTo ends the world sailed, whose last tick has been ticked, and
// begins the next, loaded: the old half closed, the two worlds' rows
// switched in one transaction, at begins, the new world's epoch, to end at
// ends; the new half opened and served. how labels the metrics: scheduled
// or by_hand. A failure once the old half is closed stops the process: the
// next start finds the world's end passed and switches then.
func (p *process) switchTo(ctx context.Context, next *readyWorld, begins, ends time.Time, how string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopping {
		return errStopping
	}
	old := p.current.Load()
	start := time.Now()
	last := old.close(closeEnded)
	closed := time.Now()
	row, err := p.switchRows(ctx, old.row.Number, next.row.ID, begins, ends)
	if err != nil {
		p.failWith(fmt.Errorf("the switch to world %d: %w", next.row.Number, err))
		return err
	}
	next.row = row
	h, err := p.openWorld(ctx, next)
	if err != nil {
		p.failWith(fmt.Errorf("opening world %d: %w", row.Number, err))
		return err
	}
	p.current.Store(h)
	p.ahead.Store(nil)
	p.nextView.Store(nil)
	h.start()
	took := time.Since(start)
	p.metrics.WorldSwitches.WithLabelValues(how).Inc()
	p.metrics.WorldSwitch.Set(took.Seconds())
	p.metrics.WorldNextReady.Set(0)
	p.log.Info("a new world begins", "how", how, "ended", old.row.Number, "last_tick", last, "begun", row.Number,
		"epoch", row.Epoch, "ends", row.EndsAt, "closing_took", closed.Sub(start).Round(time.Millisecond).String(),
		"took", took.Round(time.Millisecond).String())
	if p.jobs != nil {
		p.jobs.Poke()
	}
	return nil
}

// switchRows switches the worlds' rows, trying again for a few seconds if
// the database does not answer; a fence is final.
func (p *process) switchRows(ctx context.Context, ending int, next [16]byte, begins, ends time.Time) (store.World, error) {
	deadline := time.Now().Add(10 * time.Second)
	for {
		row, err := p.db.SwitchWorld(ctx, p.lease, ending, next, begins, ends)
		if err == nil || errors.Is(err, store.ErrFenced) || errors.Is(err, store.ErrNotActive) || errors.Is(err, store.ErrNoNext) ||
			time.Now().After(deadline) || ctx.Err() != nil {
			if errors.Is(err, store.ErrFenced) {
				p.lost.Store(true)
			}
			return row, err
		}
		p.log.Warn("the switch's transaction failed: trying again", "err", err)
		time.Sleep(500 * time.Millisecond)
	}
}

// closeForStop closes the world half as keel stops: every game connection
// is told the server is restarting (the bell), and the world sails on for
// the bell so players see it; then the half closes. No switch begins
// after; one under way finishes first. It returns the last tick.
func (p *process) closeForStop(bell time.Duration) int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stopping = true
	h := p.current.Load()
	if h == nil {
		return 0
	}
	h.game.Bell(bell)
	p.agents.core.Bell(bell)
	time.Sleep(bell)
	return h.close(closeStop)
}

// watchTarget is the sailor whose name has key, to watch.
func (p *process) watchTarget(ctx context.Context, key string) (watch.Target, error) {
	t, err := p.db.WatchTarget(ctx, key)
	return watch.Target(t), err
}

// boatIDs are the catalog's boats' ids, by the world's index of kinds.
func boatIDs(cat *catalog.Catalog) []string {
	ids := make([]string, len(cat.Boats))
	for i, b := range cat.Boats {
		ids[i] = string(b.ID)
	}
	return ids
}
