// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log/slog"
	"net"
	"net/http"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"golang.org/x/sync/errgroup"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/config"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/replay"
	"github.com/daneelvt/keel-over-the-edge/internal/scripted"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// shutdownTimeout bounds how long a stopping server waits for requests in
// flight.
const shutdownTimeout = 10 * time.Second

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
  KEEL_DEV_SAILORS     scripted sailors to sail (default 0)
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
	Stats() store.PoolStats
	Close()
}

func openStore(ctx context.Context, url string, opt store.Options) (database, error) {
	return store.Open(ctx, url, opt)
}

// serveOptions are what tests change about a server.
type serveOptions struct {
	listen  func(network, addr string) (net.Listener, error)
	flight  bool // start the runtime's flight recorder: one per process
	workers int
	// openDB opens the database; store.Open unless set.
	openDB func(ctx context.Context, url string, opt store.Options) (database, error)
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
// meanwhile, checks its schema and loads the world being sailed; then the
// world and its tick loop; then the public listeners; and only then is it
// ready. It stops in reverse: not ready, the public listeners shut down, the
// loop finishes its tick, the input log is flushed, the flight recorder
// stops, the database's pool closes, and the internal listener goes last.
// Once open, the database is not part of readiness: the simulation does not
// need it, and if it goes away only the requests that need it fail. The
// loop, its workers and the input log's writer do not recover from panics:
// a bug there stops the process.
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
	internal := newServer(obs.Internal(health, metrics, flightHandler, replayHandler), log)
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
	sailed, err := db.ActiveOrFirstWorld(ctx, firstEpoch)
	if err != nil {
		return stopEarly(internal, internalDone, flight, err)
	}
	epoch := sailed.Epoch
	registerPoolMetrics(metrics, db)
	health.Waiting("")
	log.Info("database ready", "schema", schema, "world", sailed.Number, "epoch", epoch)
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
	world, err := sim.New(sim.Config{Kinds: kinds, Workers: opt.workers, Tick: loop.TickAt(time.Now(), epoch)})
	if err != nil {
		return stopEarly(internal, internalDone, flight, err)
	}
	defer world.Close()
	b := world.Bus()
	inputs := replay.New(replay.Config{
		Frames: b.Frames,
		Header: replay.Header{Build: build, Catalog: catalog.Version, Layout: physics.LayoutVersion, Capacity: world.Capacity(), Epoch: epoch},
		Dir:    cfg.ReplayDir,
		Log:    log,
	})
	world.Record(inputs)
	replayHandler.set(inputs)
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
	log.Info("world ready", "kinds", len(kinds), "capacity", world.Capacity(), "workers", opt.workers, "tick", world.Now())
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
	}), log)
	agents := newServer(obs.AccessLog(log, api.Agents()), log)

	g, gctx := errgroup.WithContext(ctx)
	loopCtx, stopLoop := context.WithCancel(context.Background())
	sailorsCtx, stopSailors := context.WithCancel(context.Background())
	flightCtx, stopFlight := context.WithCancel(context.Background())
	defer stopLoop()
	defer stopSailors()
	defer stopFlight()
	loopDone := make(chan struct{})
	inputsDone := make(chan struct{})
	sailorsDone := make(chan struct{})

	g.Go(func() error {
		defer close(inputsDone)
		return inputs.Run()
	})
	g.Go(func() error {
		defer close(loopDone)
		return tickLoop.Run(loopCtx)
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
		log.Info("stopping")
		if opt.stopping != nil {
			opt.stopping()
		}
		sctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		errs := []error{play.Shutdown(sctx), agents.Shutdown(sctx)}
		health.Listening(false)
		stopSailors()
		<-sailorsDone
		stopLoop()
		<-loopDone
		inputs.Close()
		<-inputsDone
		stopFlight()
		if flight != nil {
			flight.Stop()
		}
		closeDB.Do(db.Close)
		errs = append(errs, internal.Shutdown(sctx), <-internalDone)
		return errors.Join(errs...)
	})
	err = g.Wait()
	log.Info("stopped", "tick", world.Now())
	return err
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

// buildID is the VCS revision the binary was built from, with "-dirty" when
// the tree had uncommitted changes, or "dev" when the build has no VCS
// information (go run, go test).
func buildID() string {
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
