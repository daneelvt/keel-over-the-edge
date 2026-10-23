// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
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
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/jobs"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/owner"
	"github.com/daneelvt/keel-over-the-edge/internal/persist"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/scripted"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen/chart"
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
  KEEL_PASSKEY_RP_ID   the domain players' passkeys are made for: the play
                       origin's host or a parent of it, never an IP address
                       (default the play origin's host)
  KEEL_PASSKEY_ORIGINS more origins of that domain whose pages may make and
                       use passkeys, comma-separated, for the browser tests'
                       other servers (default none)
  KEEL_DATABASE_URL    the database, a postgres:// URL (required)
  KEEL_PLAY_ADDR       the game's listener (default 127.0.0.1:8080)
  KEEL_AGENTS_ADDR     the AI agents' listener (default 127.0.0.1:8081)
  KEEL_INTERNAL_ADDR   probes, metrics, profiles and the owner's world page,
                       /owner/ (default 127.0.0.1:9090)
  KEEL_METRICS_ADDR    the metrics alone, GET /metrics, for a scraper that may
                       reach nothing else (default none)
  KEEL_LOG_LEVEL       debug, info, warn or error (default info)
  KEEL_TRACE_DIR       where traces of overrunning ticks go (default none)
  KEEL_REPLAY_DIR      where the input log goes (default memory only)
  KEEL_CLIENT_DIR      the game's built page, served by the game's listener,
                       and its world page, owner/ in it, by the internal one
                       (default none: another server serves them)
  KEEL_BOAT_LIMIT      the most boats at sea at once, from 1 to 4096; beyond it
                       players wait in a queue (default 1000)
  KEEL_BELL            how long the world sails on once players are told the
                       server is restarting, from 0s to 10s (default 3s)
  KEEL_DEV_SAILORS     scripted sailors to sail (default 0)
  KEEL_LAND            on: boats sail the world's land, run aground on it and
                       feel its shelter and fetch; off: its terrain is made,
                       stored and loaded, and sailed as open sea (default on)
  KEEL_WORLD_SEED      the seed a world's terrain is made from when it has
                       none (default one drawn at random)
  KEEL_WORLD_SCHEDULE  when worlds end: a weekday, a local time and a zone,
                       with how long before the end a world is closing and
                       its successor made (default "Sun 18:00
                       America/New_York notice=72h ahead=24h"); or a period
                       from an anchor in UTC, "every=10m
                       from=2026-11-01T00:00:00Z notice=4m ahead=3m"
  KEEL_WORLD_KEEP      how long an ended world's data is kept before its
                       partitions are dropped (default 672h)
  KEEL_DEV_COMMANDS    1 for the developer's commands on the internal listener:
                       POST /debug/wind?knots=…&from=… (a steady wind),
                       POST /debug/chart?all|subject=island:…|place:…|feature:…
                       (charted, credited to no one),
                       POST /debug/weather?regime=… (a regime held),
                       POST /debug/weather?auto (the world's own) and
                       POST /debug/encounter?situation=… (a scripted boat
                       meeting the first sailing player's) (default 0)
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
	api.Accounts
	auth.Sessions
	CheckSchema(ctx context.Context) (int64, error)
	ActiveOrFirstWorld(ctx context.Context, epoch time.Time) (store.World, error)
	LatestCheckpoint(ctx context.Context, world [16]byte) (store.Checkpoint, error)
	WorldSeed(ctx context.Context, world [16]byte) (seed uint64, generator int, ok bool, err error)
	LoadBundle(ctx context.Context, world [16]byte) (*store.Bundle, error)
	StoreBundle(ctx context.Context, world [16]byte, epoch int64, b *store.Bundle) error
	LoadWeather(ctx context.Context, world [16]byte) (*store.Weather, error)
	StoreWeather(ctx context.Context, world [16]byte, epoch int64, w *store.Weather) error
	SetChunkKey(ctx context.Context, world [16]byte, epoch int64, key []byte) ([]byte, error)
	SetWorldEnd(ctx context.Context, lease int64, world [16]byte, end time.Time) error
	NextWorld(ctx context.Context) (store.NextWorld, error)
	CreateNextWorld(ctx context.Context, lease int64, seed uint64, generator int, epoch time.Time) (store.World, error)
	SwitchWorld(ctx context.Context, lease int64, number int, next [16]byte, begins, ends time.Time) (store.World, error)
	DiscardNextWorld(ctx context.Context, lease int64, number int) error
	WorldsToDrop(ctx context.Context, before time.Time) ([]store.World, error)
	DropWorld(ctx context.Context, lease int64, w store.World) error
	WriteWorldNews(ctx context.Context, lease int64, world [16]byte, n store.WorldNews) error
	WriteGaleNews(ctx context.Context, lease int64, world [16]byte, n store.GaleNews) (bool, error)
	DeleteSessions(ctx context.Context, before time.Time) (int64, error)
	DeleteCeremonies(ctx context.Context, before time.Time) (int64, error)
	DeleteJobRuns(ctx context.Context, before time.Time) (int64, error)
	JobRuns(ctx context.Context, limit int) ([]store.JobRun, error)
	jobs.Store
	Chartings(ctx context.Context, world [16]byte) ([]store.Charting, error)
	News(ctx context.Context, world [16]byte, before *[16]byte, limit int) ([]store.News, error)
	api.Notices
	owner.Accounts
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
	// generate makes a world's terrain; the catalog's generator unless set.
	generate generator
}

// runServer runs the game until ctx ends, then stops it in order.
//
// It starts the internal listener first and stops it last, so the process
// can be observed throughout; then it waits for the database, not ready
// meanwhile, and checks its schema; then it waits for the simulation's
// lease, so only one process ever runs the world, and raises its epoch;
// then it loads the world being sailed, and its terrain, which it makes
// first if the world has none, and restores it from its checkpoint,
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
	// The owner's tools may stop the server, as a signal does, to start
	// again in a new world.
	ctx, restart := context.WithCancel(ctx)
	defer restart()
	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	build := buildID()
	log := obs.NewLogger(stdout, cfg.LogLevel, build)
	health := obs.NewHealth()
	metrics := obs.NewMetrics(build, catalog.Version)
	log.Info("starting", "catalog", catalog.Version)
	var page, worldPage *api.Page
	if cfg.ClientDir != "" {
		if page, err = api.OpenPage(cfg.ClientDir); err != nil {
			return err
		}
		log.Info("serving the page", "dir", cfg.ClientDir, "bytes", page.Size())
		dir := filepath.Join(cfg.ClientDir, "owner")
		if worldPage, err = api.OpenPage(dir); err != nil {
			log.Warn("the world page is not built: its data alone is served", "dir", dir, "err", err)
			worldPage = nil
		}
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
	var weatherHandler *lateHandler
	var weatherRoutes http.Handler
	if cfg.DevCommands {
		weatherHandler = &lateHandler{}
		weatherRoutes = weatherHandler
	}
	// The owner's tools, once the world is ready.
	ownerHandler := &lateHandler{}
	side := &sideServers{}
	side.serve(newServer(obs.Internal(health, metrics, flightHandler, replayHandler, weatherRoutes, ownerHandler), log), internalLn)
	log.Info("listening", "listener", "internal", "addr", internalLn.Addr().String())
	// The metrics alone, on a port of their own, for the scraper.
	if cfg.MetricsAddr != "" {
		metricsLn, err := opt.listen("tcp", cfg.MetricsAddr)
		if err != nil {
			return stopEarly(side, flight, err)
		}
		side.serve(newServer(obs.MetricsOnly(metrics), log), metricsLn)
		log.Info("listening", "listener", "metrics", "addr", metricsLn.Addr().String())
	}
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
			return stopEarly(side, flight, nil)
		}
		return stopEarly(side, flight, err)
	}
	var closeDB sync.Once
	defer closeDB.Do(db.Close)
	schema, err := db.CheckSchema(ctx)
	if err != nil {
		return stopEarly(side, flight, err)
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
		return stopEarly(side, flight, err)
	}
	waited := time.Now()
	leaseEpoch, err := sl.Take(ctx)
	if err != nil {
		if ctx.Err() != nil {
			// Stopped while waiting: nothing failed.
			return stopEarly(side, flight, nil)
		}
		return stopEarly(side, flight, err)
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
			return stopEarly(side, flight, nil)
		}
		return stopEarly(side, flight, err)
	}
	var closeWriter sync.Once
	defer closeWriter.Do(writer.Close)
	// The catalog, and what lasts from one world to the next.
	cat, err := catalog.Load()
	if err != nil {
		return stopEarly(side, flight, err)
	}
	waves, kinds := cat.Prepare()
	wcfg, err := weather.ConfigOf(cat)
	if err != nil {
		return stopEarly(side, flight, err)
	}
	if opt.generate == nil {
		opt.generate = catalogGenerator(cat)
	}
	passkeys, err := auth.NewPasskeys(cfg.PasskeyRPID, cfg.PasskeyOrigins)
	if err != nil {
		return stopEarly(side, flight, fmt.Errorf("passkeys: %w", err))
	}
	looks := make([]string, len(cat.Sailors))
	for i, s := range cat.Sailors {
		looks[i] = string(s.ID)
	}
	p := &process{
		cfg: cfg, opt: opt, build: build, log: log, health: health, metrics: metrics,
		db: db, writer: writer, lease: leaseEpoch, cat: cat, waves: waves, kinds: kinds, wcfg: wcfg,
		sessions: auth.NewCache(db, auth.CacheConfig{Lookups: metrics.SessionLookups, Log: log}),
		passkeys: passkeys, looks: looks, page: page, ownPage: worldPage, flight: flight,
		replayRoutes: replayHandler, devRoutes: weatherHandler, ownerRoutes: ownerHandler, playRoutes: &lateHandler{},
		fail: make(chan error, 1), making: make(chan struct{}, 1),
	}
	p.registerWorldMetrics()

	// The world sailed: its end set if it has none, and if its end passed
	// while keel was down, the next world begun first, before anyone is
	// let in.
	sailed, err := p.worldToSail(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return stopEarly(side, flight, nil)
		}
		return stopEarly(side, flight, err)
	}
	health.Waiting("")
	log.Info("world found", "world", sailed.Number, "epoch", sailed.Epoch, "ends", sailed.EndsAt)
	health.Beat()
	ready, err := p.loadWorld(ctx, sailed)
	if err != nil {
		if ctx.Err() != nil {
			return stopEarly(side, flight, nil)
		}
		return stopEarly(side, flight, err)
	}
	health.Waiting("")
	health.Beat()
	first, err := p.openWorld(ctx, ready)
	if err != nil {
		return stopEarly(side, flight, err)
	}
	p.current.Store(first)
	if weatherHandler != nil {
		log.Warn("developer commands are on: POST /debug/wind, /debug/weather, /debug/encounter, /debug/place and /debug/chart on the internal listener")
	}
	health.Beat()
	play := newServer(p.playRoutes, log)
	agents := newServer(obs.AccessLog(log, api.Agents()), log)
	p.jobs = jobs.New(jobs.Config{Store: db, Lease: leaseEpoch, Jobs: p.lifecycleJobs(), Log: log, Metrics: metrics})

	g, gctx := errgroup.WithContext(ctx)
	flightCtx, stopFlight := context.WithCancel(context.Background())
	jobsCtx, stopJobs := context.WithCancel(context.Background())
	defer stopFlight()
	defer stopJobs()
	jobsDone := make(chan struct{})

	first.start()
	if nw, err := db.NextWorld(ctx); err == nil && nw.Stored {
		metrics.WorldNextReady.Set(1)
	}
	log.Info("the world page is on the internal listener", "path", "/owner/", "built", worldPage != nil)
	g.Go(func() error {
		if err := sl.Watch(gctx); err != nil {
			p.lost.Store(true)
			log.Error("the simulation lease is lost: stopping", "err", err)
			return err
		}
		return nil
	})
	g.Go(func() error {
		// A world half that fails stops the process.
		select {
		case err := <-p.fail:
			return err
		case <-gctx.Done():
			return nil
		}
	})
	g.Go(func() error {
		defer close(jobsDone)
		p.jobs.Run(jobsCtx)
		return nil
	})
	if flight != nil {
		g.Go(func() error {
			flight.Run(flightCtx)
			return nil
		})
	}
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
		if p.lost.Load() {
			bell = 0
		}
		log.Info("stopping", "bell", bell.String())
		if opt.stopping != nil {
			opt.stopping()
		}
		// The jobs stop first: a run cut short is the next process's.
		stopJobs()
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
		// so they see it; then the world half closes.
		last := p.closeForStop(bell)
		<-jobsDone
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
		errs = append(errs, side.shutdown(ictx))
		log.Info("stopped", "tick", last)
		return errors.Join(errs...)
	})
	return g.Wait()
}

// ownerConfig is what the owner's tools are made from: a world sailed's,
// or the next world's, which has no frames, edge or clock.
type ownerConfig struct {
	cat      *catalog.Catalog
	bus      *bus.Bus // nil for the next world
	bundle   *worldgen.Bundle
	made     time.Time
	sailed   store.World
	wcfg     *weather.Config
	timeline *weather.Timeline // nil for a world whose week is not yet made
	terrain  *sim.Terrain      // nil with land off
	db       database
	sessions *auth.Cache
	game     *edge.Edge
	charts   *worldChart // nil with land off
	clock    owner.Clock
	page     *api.Page
	log      *slog.Logger
	metrics  *obs.Metrics
	// lifecycle is the world's life, and the owner's hand on it; from, a
	// view of the same world already drawn.
	lifecycle owner.Life
	from      *owner.Owner
	// forecasts is the world's forecast issuer; nil for the next world.
	forecasts *forecast.Issuer
}

// ownerTools are the owner's tools: the world page and its controls.
func ownerTools(c ownerConfig) *owner.Owner {
	kinds := make([]string, len(c.cat.Boats))
	for i, b := range c.cat.Boats {
		kinds[i] = b.Name
	}
	waves, _ := c.cat.Prepare()
	regimes := make([]string, len(c.cat.Weather.Regimes))
	for i, r := range c.cat.Weather.Regimes {
		regimes[i] = string(r.ID)
	}
	cfg := owner.Config{
		Bundle: c.bundle, Weather: c.wcfg.Prepared, Timeline: c.timeline, SystemKinds: systemKindNames(c.cat), Waves: waves,
		Kinds: kinds, Regimes: regimes, Sky: c.cat.PrepareSky(),
		World:    owner.World{Number: c.sailed.Number, ID: c.sailed.ID, Epoch: c.sailed.Epoch, Made: c.made},
		Calm:     c.cat.World.MainPort.Calm * 1852,
		Accounts: c.db, Page: c.page, Log: c.log, Metrics: c.metrics,
		Life: c.lifecycle, From: c.from,
	}
	if c.bus != nil {
		cfg.Frames, cfg.Owner, cfg.Clock = c.bus.Frames, c.bus.Commands.Owner(), c.clock
		cfg.Sessions, cfg.Edge = c.sessions, c.game
	}
	if c.forecasts != nil {
		cfg.Forecasts = c.forecasts
	}
	cfg.Words, cfg.Outlook = weather.WordsOf(c.cat), c.cat.Weather.Forecast.Outlook.Samples
	cfg.Risks, cfg.Fog = weather.RisksOf(c.cat)
	cfg.RiskMarks = make([][]string, len(c.cat.Weather.Regimes))
	for _, r := range c.cat.Weather.Forecast.Risks {
		if i := weather.RegimeIndex(c.cat, string(r.Regime)); i >= 0 {
			for _, m := range r.Marks {
				cfg.RiskMarks[i] = append(cfg.RiskMarks[i], string(m))
			}
		}
	}
	for _, k := range c.cat.World.Places.Kinds {
		cfg.PlaceKinds = append(cfg.PlaceKinds, owner.PlaceKind{ID: string(k.ID), Name: k.Name, Site: string(k.Site), Mark: k.Mark})
	}
	for _, k := range c.cat.World.Features.Kinds {
		cfg.FeatureKinds = append(cfg.FeatureKinds, owner.FeatureKind{ID: string(k.ID), Name: k.Name, Site: string(k.Site), Mark: string(k.Mark)})
	}
	plants := map[string]string{}
	for _, p := range c.cat.World.Flora.Kinds {
		plants[string(p.ID)] = p.Name
	}
	for _, s := range c.cat.World.Surfaces {
		var names []string
		for _, cv := range s.Cover {
			names = append(names, plants[string(cv.Plant)])
		}
		cfg.SurfacePlants = append(cfg.SurfacePlants, names)
	}
	for _, ch := range c.cat.World.Lights.Characters {
		cfg.Characters = append(cfg.Characters, owner.Character{Notation: ch.Notation, Colour: string(ch.Colour), Steps: ch.Steps})
	}
	for _, f := range c.cat.World.Lights.FogSignals {
		cfg.FogSignals = append(cfg.FogSignals, owner.FogSignal{Notation: f.Notation, Steps: f.Steps})
	}
	cfg.SoundsUnder = c.cat.World.Lights.FogSignal.Sounds * 1852
	cfg.TownLook = chart.TownLook{Surfaces: map[int32]string{}}
	for i, s := range c.cat.World.Surfaces {
		if s.Town != nil {
			cfg.TownLook.Surfaces[int32(i)] = string(s.Look.Top)
		}
	}
	for _, k := range c.cat.World.Towns.Buildings {
		cfg.TownKinds = append(cfg.TownKinds, k.Name)
		cfg.TownLook.Kinds = append(cfg.TownLook.Kinds, string(k.Colour))
		cfg.TownLook.Props = append(cfg.TownLook.Props, k.Prop != nil && *k.Prop)
	}
	if t := c.terrain; t != nil {
		cfg.Ground, cfg.Shelter, cfg.Circulation = t.Ground, t.Shelter, t.Circulation
	}
	if ch := c.charts; ch != nil {
		cfg.Subjects, cfg.Charted = len(ch.world.Subjects), ch.chartedList
		cfg.LightSignals = ch.world.FogSignals
	}
	return owner.New(cfg)
}

// roamRule is the rule for the chunks the owner's free camera is handed:
// the catalog's, seen from the highest the free camera goes.
func roamRule(cat *catalog.Catalog) edge.HandoutRule {
	r := handoutRule(cat)
	h := &cat.World.Handout
	r.Camera = edge.DefaultRoamReach.High
	r.FarSea = max(h.FarSeaLeast, h.FarSeaHorizon*math.Sqrt(2*h.Dome*r.Camera))
	return r
}

// handoutRule is the catalog's rule for which chunks a connection is
// handed.
func handoutRule(cat *catalog.Catalog) edge.HandoutRule {
	h := &cat.World.Handout
	return edge.HandoutRule{
		Near: h.Near, Camera: h.Camera, Dome: h.Dome, Margin: h.Margin, Shallow: h.Shallows, Look: h.Look,
		FarSea: max(h.FarSeaLeast, h.FarSeaHorizon*math.Sqrt(2*h.Dome*h.Camera)),
	}
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
		"boats", r.Boats, "waiting", r.Waiting, "ashore", r.Ashore, "written_by", cp.Build, "written_at", cp.WrittenAt)
	return nil
}

// devRoutes are the developer's commands: the weather, encounters, and
// moving a boat.
func devRoutes(ctx context.Context, b *bus.Bus, cat *catalog.Catalog, charts *worldChart, log *slog.Logger) http.Handler {
	wx := weatherRoute(b, cat)
	enc := encounterRoute(ctx, b, cat, log)
	place := placeRoute(b, log)
	chartIt := chartRoute(b, charts, log)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/debug/encounter":
			enc.ServeHTTP(w, r)
		case "/debug/place":
			place.ServeHTTP(w, r)
		case "/debug/chart":
			chartIt.ServeHTTP(w, r)
		default:
			wx.ServeHTTP(w, r)
		}
	})
}

// placeRoute moves a boat by hand, on the internal listener only, with
// KEEL_DEV_COMMANDS=1: the boat given, or the boat of the account given,
// or else the first player's sailing, put at rest at a point, heading as
// given, at the next tick. It answers with the boat moved and where.
//
//	POST /debug/place?east=…&north=…&heading=…[&boat=…|&account=…]   metres east and north of the centre, degrees
func placeRoute(b *bus.Bus, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		q := r.URL.Query()
		east, err1 := strconv.ParseFloat(q.Get("east"), 64)
		north, err2 := strconv.ParseFloat(q.Get("north"), 64)
		heading, err3 := strconv.ParseFloat(q.Get("heading"), 64)
		if q.Get("heading") == "" {
			heading, err3 = 0, nil
		}
		if err1 != nil || err2 != nil || err3 != nil || math.Abs(east) > 20000 || math.Abs(north) > 20000 ||
			math.IsNaN(heading) || math.IsInf(heading, 0) {
			http.Error(w, "east and north, metres within 20 km of the centre, and heading, degrees, are required", http.StatusBadRequest)
			return
		}
		var wanted uint64
		byBoat := q.Has("boat")
		if byBoat {
			n, err := strconv.ParseUint(q.Get("boat"), 10, 64)
			if err != nil || n == 0 {
				http.Error(w, "boat is not a boat's id", http.StatusBadRequest)
				return
			}
			wanted = n
		}
		var account bus.Account
		byAccount := q.Has("account")
		if byAccount {
			raw := strings.ReplaceAll(q.Get("account"), "-", "")
			if len(raw) != 32 {
				http.Error(w, "account is not an account's id", http.StatusBadRequest)
				return
			}
			if _, err := hex.Decode(account[:], []byte(raw)); err != nil {
				http.Error(w, "account is not an account's id", http.StatusBadRequest)
				return
			}
		}
		f := b.Frames.Acquire()
		boat := uint64(0)
		for _, s := range f.Live {
			if byBoat && f.Boat[s] == wanted || !byBoat && (byAccount && f.Owner[s] == account || !byAccount && f.Conn[s] != 0 && f.Grace[s] == 0) {
				boat = f.Boat[s]
				break
			}
		}
		f.Release()
		if boat == 0 {
			http.Error(w, "no such boat at sea", http.StatusConflict)
			return
		}
		rad := math.Mod(math.Mod(heading, 360)+360, 360) * math.Pi / 180
		if rad > math.Pi {
			rad -= 2 * math.Pi
		}
		st := physics.State{X: east, Y: north, Heading: rad}
		if err := b.Commands.Developer().TrySend(bus.Command{Op: bus.Place, Boat: boat, State: st}); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		log.Info("a boat placed by hand", "boat", boat, "east", east, "north", north, "heading", heading)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"boat": boat, "east": east, "north": north, "heading": heading})
	})
}

// encounterRoute stages an encounter, on the internal listener only, with
// KEEL_DEV_COMMANDS=1: a scripted boat placed to meet the first sailing
// player's boat in one of the situations the Articles are tested with,
// held on its course and trim for half a minute. It answers with where the
// boat was put, and the Article the bump should be judged by.
//
//	POST /debug/encounter?situation=port-starboard|windward-leeward|overtaking|tacking|luffing|capsized
func encounterRoute(ctx context.Context, b *bus.Bus, cat *catalog.Catalog, log *slog.Logger) http.Handler {
	cfg := scripted.EncounterConfig{Bus: b, Weather: cat.PrepareWeather(), Length: cat.Boats[0].LengthOverall, Log: log}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		situation := r.URL.Query().Get("situation")
		if _, ok := scripted.Situations[situation]; !ok {
			http.Error(w, "situation, one of "+strings.Join(scripted.SituationNames(), ", ")+", is required", http.StatusBadRequest)
			return
		}
		staged, err := scripted.Encounter(ctx, cfg, situation)
		switch {
		case errors.Is(err, scripted.ErrNoPlayer):
			http.Error(w, err.Error(), http.StatusConflict)
			return
		case err != nil:
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(staged)
	})
}

// weatherRoute is the developer's weather, on the internal listener only,
// with KEEL_DEV_COMMANDS=1. Each takes effect from the second after next,
// so every client hears of it before it predicts a tick it applies to; a
// system is born at the first keyframe from then.
//
//	POST /debug/wind?knots=…&from=…   a steady wind of knots 10 m up, from the given degrees
//	POST /debug/weather?regime=…      one endless spell of the catalog's regime of that id
//	POST /debug/weather?front[=…]     a front now, an endless spell of that regime, or the first frontal one, behind it
//	POST /debug/weather?system=…&in=5m[&east=…&north=…|&at=boat]
//	                                  a system of the catalog's kind of that id, to reach the point, metres east and north
//	                                  of the centre, or the first player's boat, in the time given, at its strongest
//	POST /debug/weather?auto          the world's own weather again
func weatherRoute(b *bus.Bus, cat *catalog.Catalog) http.Handler {
	dev := b.Commands.Developer()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		var wx bus.Weather
		switch {
		case q.Has("front"):
			i := weather.RegimeIndex(cat, q.Get("front"))
			if q.Get("front") == "" {
				i = slices.IndexFunc(cat.Weather.Regimes, func(r catalog.Regime) bool { return r.Frontal })
			}
			if i < 0 {
				http.Error(w, "front, the id of one of the catalog's regimes, or none for the first frontal one", http.StatusBadRequest)
				return
			}
			wx = bus.Weather{Mode: bus.WeatherFront, Regime: uint16(i)}
		case q.Has("system"):
			k := weather.KindIndex(cat, q.Get("system"))
			in, err := time.ParseDuration(q.Get("in"))
			if k < 0 || err != nil || in < 0 || in > 6*time.Hour {
				http.Error(w, "system, the id of one of the catalog's kinds of system, and in, a duration up to 6h, are required", http.StatusBadRequest)
				return
			}
			east, err1 := strconv.ParseFloat(q.Get("east"), 64)
			north, err2 := strconv.ParseFloat(q.Get("north"), 64)
			if q.Get("at") == "boat" {
				f := b.Frames.Acquire()
				found := false
				for _, s := range f.Live {
					if f.Conn[s] != 0 && f.Grace[s] == 0 {
						east, north, found = f.State[s].X, f.State[s].Y, true
						break
					}
				}
				f.Release()
				if !found {
					http.Error(w, "no player's boat at sea", http.StatusConflict)
					return
				}
			} else if err1 != nil || err2 != nil || math.Abs(east) > 20000 || math.Abs(north) > 20000 {
				http.Error(w, "east and north, metres within 20 km of the centre, or at=boat, are required", http.StatusBadRequest)
				return
			}
			wx = bus.Weather{Mode: bus.WeatherSystem, Kind: uint16(k), East: int32(math.Round(east * 4)), North: int32(math.Round(north * 4)),
				In: uint32(in.Seconds() * physics.StepsPerSecond)}

		case r.URL.Path == "/debug/wind":
			knots, err1 := strconv.ParseFloat(q.Get("knots"), 64)
			from, err2 := strconv.ParseFloat(q.Get("from"), 64)
			if err1 != nil || err2 != nil || knots < 0 || knots > 100 || math.IsNaN(from) || math.IsInf(from, 0) {
				http.Error(w, "knots, from 0 to 100, and from, in degrees, are required", http.StatusBadRequest)
				return
			}
			rad := math.Mod(math.Mod(from, 360)+360, 360) * math.Pi / 180
			wx = weather.Steady(knots*1852/3600, rad)
		case q.Has("auto"):
			wx = bus.Weather{Mode: bus.WeatherAuto}
		default:
			i := weather.RegimeIndex(cat, q.Get("regime"))
			if i < 0 {
				http.Error(w, "regime, the id of one of the catalog's regimes, or auto, is required", http.StatusBadRequest)
				return
			}
			wx = bus.Weather{Mode: bus.WeatherHeld, Regime: uint16(i)}
		}
		if err := dev.TrySend(bus.Command{Op: bus.SetWeather, Weather: wx}); err != nil {
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
func stopEarly(side *sideServers, flight *obs.Flight, err error) error {
	if flight != nil {
		flight.Stop()
	}
	side.close()
	return err
}

// sideServers are the servers that open first and close last: the
// internal listener's, and the metrics listener's if it has one.
type sideServers struct {
	servers []*http.Server
	done    []chan error
}

// serve serves ln with srv until it is closed or shut down.
func (s *sideServers) serve(srv *http.Server, ln net.Listener) {
	done := make(chan error, 1)
	go func() { done <- serveUntilClosed(srv, ln) }()
	s.servers = append(s.servers, srv)
	s.done = append(s.done, done)
}

// close closes them at once, and waits for them.
func (s *sideServers) close() {
	for i, srv := range s.servers {
		srv.Close()
		<-s.done[i]
	}
}

// shutdown lets their requests finish, within ctx.
func (s *sideServers) shutdown(ctx context.Context) error {
	var errs []error
	for i, srv := range s.servers {
		errs = append(errs, srv.Shutdown(ctx), <-s.done[i])
	}
	return errors.Join(errs...)
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
