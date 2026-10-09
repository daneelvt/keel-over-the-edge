// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"golang.org/x/sync/errgroup"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/config"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/persist"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/replay"
	"github.com/daneelvt/keel-over-the-edge/internal/scripted"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// shutdownTimeout bounds how long a stopping server waits for requests in
// flight.
const shutdownTimeout = 10 * time.Second

// finalTimeout bounds how long a stopping server waits for the world's
// final checkpoint and every event left to be written; closeTimeout, how
// long it waits for the game connections to close, a peer that has not
// answered by then dropped without its handshake (the library's own bounds
// on a close are 5 s to write it and 5 s to wait for the answer).
const (
	finalTimeout = config.FinalCheckpointTimeout
	closeTimeout = config.CloseTimeout
)

// firstEpoch is the epoch of the first world, made when the database has
// none: tick 0 at midnight UTC on 1 January 2026.
var firstEpoch = time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)

const serveUsage = `usage: keel serve

Configured from the environment:
  KEEL_PLAY_ORIGIN     the players' HTTPS origin (required)
  KEEL_DATABASE_URL    the database, a postgres:// URL (required)
  KEEL_PLAY_ADDR       the game's listener (default 127.0.0.1:8080)
  KEEL_AGENTS_ADDR     the AI agents' listener (default 127.0.0.1:8081)
  KEEL_INTERNAL_ADDR   probes, metrics, profiles (default 127.0.0.1:9090)
  KEEL_LOG_LEVEL       debug, info, warn or error (default info)
  KEEL_TRACE_DIR       where traces of overrunning ticks go (default none)
  KEEL_REPLAY_DIR      where the input log goes (default memory only)
  KEEL_CLIENT_DIR      the game's built page, served by the game's listener
                       (default none: another server serves it)
  KEEL_BOAT_LIMIT      the most boats at sea at once, from 1 to 4096; beyond it
                       players wait in a queue (default 1000)
  KEEL_BELL            how long the world sails on once players are told the
                       server is restarting, from 0s to 10s (default 3s)
  KEEL_DEV_SAILORS     scripted sailors to sail (default 0)
  KEEL_DEV_COMMANDS    1 for the developer's commands on the internal listener:
                       POST /debug/wind?knots=…&from=… (default 0)
`

func serve(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { io.WriteString(stderr, serveUsage) }
	if err := fs.Parse(args); err != nil {
		return errUsage
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return errUsage
	}
	return runServer(ctx, getenv, stdout, serveOptions{
		listen:  net.Listen,
		flight:  true,
		workers: runtime.GOMAXPROCS(0),
	})
}

// database is what the server asks of the store.
type database interface {
	api.Guests
	auth.Sessions
	CheckSchema(ctx context.Context) (int64, error)
	ActiveOrFirstWorld(ctx context.Context, epoch time.Time) (store.World, error)
	LatestCheckpoint(ctx context.Context, world [16]byte) (store.Checkpoint, error)
	Stats() store.PoolStats
	Close()
}

func openStore(ctx context.Context, url string, opt store.Options) (database, error) {
	return store.Open(ctx, url, opt)
}

// lease is the simulation's lease: store.Lease.
type lease interface {
	Take(ctx context.Context) (int64, error)
	Watch(ctx context.Context) error
	Release(ctx context.Context)
}

func openLease(url string, opt store.LeaseOptions) (lease, error) { return store.NewLease(url, opt) }

// worldWriter writes the world's events and checkpoints: store.Persister.
type worldWriter interface {
	persist.Writer
	Close()
}

func openWriter(ctx context.Context, url string, opt store.Options) (worldWriter, error) {
	return store.OpenPersister(ctx, url, opt)
}

// serveOptions are what tests change about a server.
type serveOptions struct {
	listen  func(network, addr string) (net.Listener, error)
	flight  bool // start the runtime's flight recorder: one per process
	workers int
	// openDB opens the database; store.Open unless set. openLease and
	// openWriter open the simulation's lease and the world's writer;
	// store.NewLease and store.OpenPersister unless set.
	openDB     func(ctx context.Context, url string, opt store.Options) (database, error)
	openLease  func(url string, opt store.LeaseOptions) (lease, error)
	openWriter func(ctx context.Context, url string, opt store.Options) (worldWriter, error)
	// dbRetry, if not zero, is the first wait between attempts to reach
	// the database.
	dbRetry time.Duration
	// afterTick runs after each tick, within it.
	afterTick func(tick int64)
	// stopping runs as the server begins to stop, once it is no longer
	// ready.
	stopping func()
}

// runServer runs the game until ctx ends, then stops it in order.
//
// It starts the internal listener first and stops it last, so the process
// can be observed throughout; then it waits for the database, not ready
// meanwhile, and checks its schema; then it waits for the simulation's
// lease, so only one process ever runs the world, and raises its epoch;
// then it loads the world being sailed and restores it from its checkpoint,
// if the checkpoint is recent and of this build's formats; then the world,
// its tick loop, the world's writer and the game connection's encoder;
// then the public listeners; and only then is it ready.
//
// It stops so that a restart is a pause, not a reset: not ready at once,
// the public listeners shut down beside the rest; every game connection is
// told the server is restarting (the bell), and the world sails on for
// KEEL_BELL so players see it; the scripted sailors and the loop stop; the
// world's final checkpoint and every event left are written (at most
// finalTimeout); only then is every game connection closed with 1012 (at
// most closeTimeout), so a slow phone can never cost the checkpoint; then
// the encoder, the input log, the flight recorder, the world's writer, the
// lease, released, the database's pool, and the internal listener last.
//
// Once open, the database is not part of readiness: the simulation does not
// need it, and if it goes away only the requests that need it fail, and the
// world's writes wait. A lease lost for good, or a write refused because
// another process holds it, stops the server as a signal would but with no
// bell and no final checkpoint, and it exits 1; so does an inbox of the
// world's writes too full to record what it promised, after a final
// checkpoint. The loop, its workers and the writers do not recover from
// panics: a bug there stops the process, and the next restores the last
// checkpoint.
func runServer(ctx context.Context, getenv func(string) string, stdout io.Writer, opt serveOptions) error {
	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	build := buildID()
	log := obs.NewLogger(stdout, cfg.LogLevel, build)
	health := obs.NewHealth()
	metrics := obs.NewMetrics(build, catalog.Version)
	log.Info("starting", "catalog", catalog.Version)
	var page *api.Page
	if cfg.ClientDir != "" {
		if page, err = api.OpenPage(cfg.ClientDir); err != nil {
			return err
		}
		log.Info("serving the page", "dir", cfg.ClientDir, "bytes", page.Size())
	}

	// The internal listener, at once: /livez answers while the rest starts.
	internalLn, err := opt.listen("tcp", cfg.InternalAddr)
	if err != nil {
		return err
	}
	var flight *obs.Flight
	var flightHandler http.Handler
	if opt.flight {
		flight = obs.NewFlight(cfg.TraceDir, log, metrics)
		if err := flight.Start(); err != nil {
			log.Warn("the flight recorder did not start", "err", err)
			flight = nil
		} else {
			flightHandler = flight
		}
	}
	replayHandler := &lateHandler{}
	var windHandler *lateHandler
	var wind http.Handler
	if cfg.DevCommands {
		windHandler = &lateHandler{}
		wind = windHandler
	}
	internal := newServer(obs.Internal(health, metrics, flightHandler, replayHandler, wind), log)
	internalDone := make(chan error, 1)
	go func() { internalDone <- serveUntilClosed(internal, internalLn) }()
	log.Info("listening", "listener", "internal", "addr", internalLn.Addr().String())
	health.Beat()

	// The database: waited for, its schema checked, the world it holds.
	health.Waiting("the database")
	openDB := opt.openDB
	if openDB == nil {
		openDB = openStore
	}
	db, err := openDB(ctx, cfg.DatabaseURL, store.Options{
		Log: log, Beat: health.Beat, FirstRetry: opt.dbRetry,
		QueryDuration: metrics.DBQueryDuration, QueryErrors: metrics.DBQueryErrors,
	})
	if err != nil {
		if ctx.Err() != nil {
			// Stopped while waiting: nothing failed.
			return stopEarly(internal, internalDone, flight, nil)
		}
		return stopEarly(internal, internalDone, flight, err)
	}
	var closeDB sync.Once
	defer closeDB.Do(db.Close)
	schema, err := db.CheckSchema(ctx)
	if err != nil {
		return stopEarly(internal, internalDone, flight, err)
	}
	metrics.SchemaVersion.Set(float64(schema))
	registerPoolMetrics(metrics, db)
	log.Info("database ready", "schema", schema)
	health.Beat()

	// The simulation's lease, before anything reads the world.
	if opt.openLease == nil {
		opt.openLease = openLease
	}
	host, _ := os.Hostname()
	holder := host + " " + build
	health.Waiting("the simulation lease")
	sl, err := opt.openLease(cfg.DatabaseURL, store.LeaseOptions{
		Holder: holder, Log: log, Beat: health.Beat,
		Waiting: func(h string) { health.Waiting("the simulation lease (held by " + h + ")") },
		Lost:    func(outcome string) { metrics.LeaseLost.WithLabelValues(outcome).Inc() },
	})
	if err != nil {
		return stopEarly(internal, internalDone, flight, err)
	}
	waited := time.Now()
	leaseEpoch, err := sl.Take(ctx)
	if err != nil {
		if ctx.Err() != nil {
			// Stopped while waiting: nothing failed.
			return stopEarly(internal, internalDone, flight, nil)
		}
		return stopEarly(internal, internalDone, flight, err)
	}
	var release sync.Once
	releaseLease := func() { release.Do(func() { sl.Release(context.Background()) }) }
	defer releaseLease()
	metrics.LeaseEpoch.Set(float64(leaseEpoch))
	metrics.LeaseWait.Set(time.Since(waited).Seconds())
	log.Info("the simulation lease is this process's", "epoch", leaseEpoch, "holder", holder, "waited", time.Since(waited).Round(time.Millisecond).String())
	health.Beat()

	// The world's writer, with a pool of its own.
	if opt.openWriter == nil {
		opt.openWriter = openWriter
	}
	health.Waiting("the database")
	writer, err := opt.openWriter(ctx, cfg.DatabaseURL, store.Options{
		Log: log, Beat: health.Beat, FirstRetry: opt.dbRetry,
		QueryDuration: metrics.DBQueryDuration, QueryErrors: metrics.DBQueryErrors,
	})
	if err != nil {
		if ctx.Err() != nil {
			return stopEarly(internal, internalDone, flight, nil)
		}
		return stopEarly(internal, internalDone, flight, err)
	}
	var closeWriter sync.Once
	defer closeWriter.Do(writer.Close)
	sailed, err := db.ActiveOrFirstWorld(ctx, firstEpoch)
	if err != nil {
		return stopEarly(internal, internalDone, flight, err)
	}
	epoch := sailed.Epoch
	health.Waiting("")
	log.Info("world found", "world", sailed.Number, "epoch", epoch)
	health.Beat()

	// The catalog and the world.
	cat, err := catalog.Load()
	if err != nil {
		return stopEarly(internal, internalDone, flight, err)
	}
	kinds := make([]physics.Prepared, len(cat.Boats))
	for i := range cat.Boats {
		p := catalog.PhysicsParams(&cat.Boats[i])
		physics.Prepare(&p, &kinds[i])
	}
	world, err := sim.New(sim.Config{Kinds: kinds, Workers: opt.workers, Tick: loop.TickAt(time.Now(), epoch), Limit: cfg.BoatLimit})
	if err != nil {
		return stopEarly(internal, internalDone, flight, err)
	}
	defer world.Close()
	if err := restore(ctx, db, world, sailed, log, metrics); err != nil {
		return stopEarly(internal, internalDone, flight, err)
	}
	b := world.Bus()
	inputs := replay.New(replay.Config{
		Frames: b.Frames,
		Header: replay.Header{Build: build, Catalog: catalog.Version, Layout: physics.LayoutVersion, Capacity: world.Capacity(), Epoch: epoch, Grace: world.Grace(), Limit: world.Limit()},
		Dir:    cfg.ReplayDir,
		Log:    log,
	})
	replayHandler.set(inputs)
	if windHandler != nil {
		windHandler.set(windRoute(b.Commands.Developer()))
		log.Warn("developer commands are on: POST /debug/wind on the internal listener")
	}
	metrics.CounterFunc("keel_sim_commands_refused_total", "Commands refused because the queue was full.", b.Commands.Refused)
	metrics.CounterFunc("keel_sim_frames_allocated_total", "Frames made because every frame in the pool was in use.", b.Frames.Allocated)
	metrics.CounterFunc("keel_replay_bytes_total", "Bytes recorded in the input log.", inputs.Bytes)
	metrics.CounterFunc("keel_replay_segments_total", "Segments started in the input log.", inputs.Segments)
	metrics.CounterFunc("keel_replay_records_dropped_total", "Input log records lost because its writer was behind.", inputs.Dropped)
	lcfg := loop.Config{World: world, Epoch: epoch, Log: log, Metrics: metrics, Health: health, AfterTick: opt.afterTick}
	if flight != nil {
		lcfg.Overrun = flight.Overrun
	}
	tickLoop := loop.New(lcfg)
	game := edge.New(edge.Config{
		Bus: b, World: store.AccountID(sailed.ID).String(), Clock: tickLoop,
		Protocol: protocol.Version, Catalog: catalog.Version, Layout: physics.LayoutVersion,
		Origin: cfg.PlayOrigin, Log: log, Metrics: metrics, Fail: api.WriteError,
	})
	lasting := persist.New(persist.Config{
		Frames: b.Frames, Store: writer, World: sailed.ID, Epoch: leaseEpoch,
		Build: build, Catalog: catalog.Version, Layout: physics.LayoutVersion,
		Hold: b.Commands.Server(), Log: log, Metrics: metrics,
	})
	metrics.GaugeFunc("keel_persist_inbox_fill_ratio", "The share of the world's writes' inbox holding what is not yet written.", nil, lasting.Fill)
	metrics.GaugeFunc("keel_persist_oldest_seconds", "World time since the oldest of the world's writes not yet written; 0 when none waits.", nil,
		func() float64 { return lasting.Oldest().Seconds() })
	metrics.GaugeFunc("keel_persist_checkpoint_bytes", "The latest checkpoint's size, as encoded.", nil,
		func() float64 { return float64(lasting.CheckpointBytes()) })
	metrics.CounterFunc("keel_persist_overflow_total", "The world's writes lost because their inbox was full: the process stops.", lasting.Overflows)
	metrics.CounterFunc("keel_persist_events_total", "The world's lasting events written.", lasting.Events)
	metrics.CounterFunc("keel_persist_checkpoints_total", "The world's checkpoints written.", lasting.Checkpoints)
	world.Record(inputs, game, lasting)
	log.Info("world ready", "kinds", len(kinds), "capacity", world.Capacity(), "limit", world.Limit(), "workers", opt.workers, "tick", world.Now())
	health.Beat()

	looks := make([]string, len(cat.Sailors))
	for i, s := range cat.Sailors {
		looks[i] = string(s.ID)
	}
	play := newServer(api.Handler(api.Config{
		Version:  api.Version{Build: build, Catalog: catalog.Version},
		Log:      log,
		Metrics:  metrics,
		Guests:   db,
		Sessions: auth.NewCache(db, auth.CacheConfig{Lookups: metrics.SessionLookups, Log: log}),
		Looks:    looks,
		Game:     game,
		Page:     page,
	}), log)
	agents := newServer(obs.AccessLog(log, api.Agents()), log)

	g, gctx := errgroup.WithContext(ctx)
	loopCtx, stopLoop := context.WithCancel(context.Background())
	sailorsCtx, stopSailors := context.WithCancel(context.Background())
	flightCtx, stopFlight := context.WithCancel(context.Background())
	encoderCtx, stopEncoder := context.WithCancel(context.Background())
	defer stopEncoder()
	defer stopLoop()
	defer stopSailors()
	defer stopFlight()
	loopDone := make(chan struct{})
	inputsDone := make(chan struct{})
	sailorsDone := make(chan struct{})
	encoderDone := make(chan struct{})
	// lost: another process may hold the world: no bell, no final
	// checkpoint.
	var lost atomic.Bool

	g.Go(func() error {
		defer close(inputsDone)
		return inputs.Run()
	})
	g.Go(func() error {
		// What it returns, the stop logs: a fence, or what the final flush
		// could not write.
		_ = lasting.Run()
		return nil
	})
	g.Go(func() error {
		if err := sl.Watch(gctx); err != nil {
			lost.Store(true)
			log.Error("the simulation lease is lost: stopping", "err", err)
			return err
		}
		return nil
	})
	g.Go(func() error {
		select {
		case <-lasting.Failed():
			err := lasting.Err()
			if errors.Is(err, store.ErrFenced) {
				lost.Store(true)
			}
			log.Error("the world's writes cannot go on: stopping", "err", err)
			return err
		case <-gctx.Done():
			return nil
		}
	})
	g.Go(func() error {
		defer close(loopDone)
		return tickLoop.Run(loopCtx)
	})
	g.Go(func() error {
		defer close(encoderDone)
		game.Run(encoderCtx)
		return nil
	})
	if flight != nil {
		g.Go(func() error {
			flight.Run(flightCtx)
			return nil
		})
	}
	g.Go(func() error {
		defer close(sailorsDone)
		if cfg.DevSailors == 0 {
			return nil
		}
		return scripted.Run(sailorsCtx, scripted.Config{N: cfg.DevSailors, Bus: b, Seed: uint64(time.Now().UnixNano()), Log: log})
	})
	// The public listeners, once the world is ticking.
	g.Go(func() error {
		for _, l := range []struct {
			name, addr string
			srv        *http.Server
		}{{"play", cfg.PlayAddr, play}, {"agents", cfg.AgentsAddr, agents}} {
			ln, err := opt.listen("tcp", l.addr)
			if err != nil {
				return err
			}
			g.Go(func() error { return serveUntilClosed(l.srv, ln) })
			log.Info("listening", "listener", l.name, "addr", ln.Addr().String())
		}
		health.Listening(true)
		health.Beat()
		log.Info("ready")
		return nil
	})
	// Stopping, on a signal or the first failure.
	g.Go(func() error {
		<-gctx.Done()
		health.Stopping()
		bell := cfg.Bell
		if lost.Load() {
			bell = 0
		}
		log.Info("stopping", "bell", bell.String())
		if opt.stopping != nil {
			opt.stopping()
		}
		// The public listeners stop taking requests, beside the rest.
		listeners := make(chan error, 1)
		go func() {
			sctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
			defer cancel()
			err := errors.Join(play.Shutdown(sctx), agents.Shutdown(sctx))
			health.Listening(false)
			listeners <- err
		}()
		// The bell: every phone is told, and the world sails on a moment
		// so they see it.
		game.Bell(bell)
		time.Sleep(bell)
		stopSailors()
		<-sailorsDone
		stopLoop()
		<-loopDone
		// The final checkpoint, of the last frame, and every event left,
		// before any connection is closed.
		start := time.Now()
		var final *bus.Frame
		if !lost.Load() {
			final = b.Frames.Acquire()
		}
		fctx, fcancel := context.WithTimeout(context.Background(), finalTimeout)
		err := lasting.Close(fctx, final)
		fcancel()
		switch {
		case lost.Load():
		case err != nil:
			log.Error("the final checkpoint was not written", "err", err)
		default:
			log.Info("the final checkpoint is written", "tick", world.Now(), "took", time.Since(start).Round(time.Millisecond).String())
		}
		// Shutdown leaves hijacked connections alone: the game's are closed
		// here, with 1012.
		cctx, ccancel := context.WithTimeout(context.Background(), closeTimeout)
		if err := game.Shutdown(cctx); err != nil {
			log.Warn("game connections dropped: they did not answer their close in time", "err", err)
		}
		ccancel()
		stopEncoder()
		<-encoderDone
		inputs.Close()
		<-inputsDone
		stopFlight()
		if flight != nil {
			flight.Stop()
		}
		closeWriter.Do(writer.Close)
		releaseLease()
		closeDB.Do(db.Close)
		errs := []error{<-listeners}
		ictx, icancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer icancel()
		errs = append(errs, internal.Shutdown(ictx), <-internalDone)
		return errors.Join(errs...)
	})
	err = g.Wait()
	log.Info("stopped", "tick", world.Now())
	return err
}

// restore restores the world from its checkpoint, if there is one this
// build can read, younger than the grace: world time resumes at the
// present, and every boat waits in its grace for its sailor. Otherwise the
// world starts empty, and the log says why.
func restore(ctx context.Context, db database, world *sim.World, sailed store.World, log *slog.Logger, m *obs.Metrics) error {
	result := func(r string) { m.Restores.WithLabelValues(r).Inc() }
	cp, err := db.LatestCheckpoint(ctx, sailed.ID)
	if errors.Is(err, store.ErrNotFound) {
		result("none")
		log.Info("no checkpoint: the world starts empty")
		return nil
	}
	if err != nil {
		return err
	}
	if cp.Format != sim.SnapshotVersion || cp.Catalog != catalog.Version || cp.Layout != physics.LayoutVersion {
		result("incompatible")
		log.Warn("the checkpoint is of another build: the world starts empty", "tick", cp.Tick, "written_by", cp.Build,
			"format", cp.Format, "catalog", cp.Catalog, "layout", cp.Layout,
			"want_format", sim.SnapshotVersion, "want_catalog", catalog.Version, "want_layout", physics.LayoutVersion)
		return nil
	}
	now := loop.TickAt(time.Now(), sailed.Epoch)
	age := loop.TimeOf(now, sailed.Epoch).Sub(loop.TimeOf(cp.Tick, sailed.Epoch))
	if now-cp.Tick >= world.Grace() {
		result("too_old")
		log.Info("the checkpoint is older than the grace: the world starts empty", "tick", cp.Tick, "age", age.Round(time.Millisecond).String())
		return nil
	}
	r, err := world.Restore(cp.Data, now)
	if err != nil {
		result("incompatible")
		log.Warn("the checkpoint could not be read: the world starts empty", "tick", cp.Tick, "written_by", cp.Build, "err", err)
		return nil
	}
	result("restored")
	m.RestoredBoats.Set(float64(r.Boats))
	m.RestoreGap.Set(age.Seconds())
	log.Info("the world is restored from its checkpoint", "tick", r.From, "now", now, "gap", age.Round(time.Millisecond).String(),
		"boats", r.Boats, "waiting", r.Waiting, "written_by", cp.Build, "written_at", cp.WrittenAt)
	return nil
}

// windRoute is POST /debug/wind?knots=…&from=…: the wind becomes knots 10 m
// up, from the given degrees, at the next tick. A developer's command, on
// the internal listener only, with KEEL_DEV_COMMANDS=1.
func windRoute(dev bus.Sender) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		knots, err1 := strconv.ParseFloat(q.Get("knots"), 64)
		from, err2 := strconv.ParseFloat(q.Get("from"), 64)
		if err1 != nil || err2 != nil || knots < 0 || knots > 100 || math.IsNaN(from) || math.IsInf(from, 0) {
			http.Error(w, "knots, from 0 to 100, and from, in degrees, are required", http.StatusBadRequest)
			return
		}
		rad := math.Mod(math.Mod(from, 360)+360, 360) * math.Pi / 180
		if err := dev.TrySend(bus.Command{Op: bus.SetWind, Wind: bus.Wind{Speed: knots * 1852 / 3600, From: rad}}); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// registerPoolMetrics reports the database pool's use, read when scraped.
func registerPoolMetrics(m *obs.Metrics, db database) {
	for state, read := range map[string]func(store.PoolStats) int32{
		"acquired":     func(s store.PoolStats) int32 { return s.Acquired },
		"idle":         func(s store.PoolStats) int32 { return s.Idle },
		"constructing": func(s store.PoolStats) int32 { return s.Constructing },
	} {
		m.GaugeFunc("keel_db_pool_connections", "The database pool's connections, by state.",
			prometheus.Labels{"state": state}, func() float64 { return float64(read(db.Stats())) })
	}
	m.GaugeFunc("keel_db_pool_max_connections", "The most connections the database pool opens.", nil,
		func() float64 { return float64(db.Stats().Max) })
	m.SecondsFunc("keel_db_pool_acquire_wait_seconds_total", "Time requests have waited for a database connection.",
		func() time.Duration { return db.Stats().AcquireWait })
	m.CounterFunc("keel_db_pool_empty_acquire_total", "Requests for a database connection that found none idle.",
		func() uint64 { return uint64(db.Stats().EmptyAcquires) })
}

// stopEarly stops what has started when starting fails.
func stopEarly(internal *http.Server, done <-chan error, flight *obs.Flight, err error) error {
	if flight != nil {
		flight.Stop()
	}
	internal.Close()
	<-done
	return err
}

// newServer makes an HTTP server. Only ReadHeaderTimeout and IdleTimeout
// are set: ReadTimeout and WriteTimeout would also cut off long-lived
// connections such as WebSockets. Routes that need deadlines set their own.
func newServer(h http.Handler, log *slog.Logger) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
}

// serveUntilClosed serves ln until the server is shut down.
func serveUntilClosed(srv *http.Server, ln net.Listener) error {
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// lateHandler answers 503 until it is given its handler.
type lateHandler struct {
	h atomic.Pointer[http.Handler]
}

func (l *lateHandler) set(h http.Handler) { l.h.Store(&h) }

func (l *lateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := l.h.Load()
	if h == nil {
		http.Error(w, "starting", http.StatusServiceUnavailable)
		return
	}
	(*h).ServeHTTP(w, r)
}

// buildOverride, when set at build time with
// -ldflags "-X main.buildOverride=…", is the build ID: an image is built
// without the repository's history, so it has no VCS information of its own.
var buildOverride string

// buildID is buildOverride when set; or else the VCS revision the binary
// was built from, with "-dirty" when the tree had uncommitted changes; or
// "dev" when the build has no VCS information (go run, go test).
func buildID() string {
	if buildOverride != "" {
		return buildOverride
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}
	var rev, dirty string
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			if s.Value == "true" {
				dirty = "-dirty"
			}
		}
	}
	if rev == "" {
		return "dev"
	}
	if len(rev) > 12 {
		rev = rev[:12]
	}
	return rev + dirty
}
