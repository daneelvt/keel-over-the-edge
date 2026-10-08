// SPDX-License-Identifier: AGPL-3.0-only

// Package store is everything the game keeps in PostgreSQL: the migrations
// that make its schema, and the queries that read and write it. It is the
// only package that talks to the database; the rest of the server speaks
// the game's types (AccountID, Account, World) and the store's errors.
//
// Queries are SQL in queries/, compiled by sqlc against the migrations into
// the db package, so each one is checked against the schema when it is
// built. They run through one pgx pool.
package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// The pool's size. The server keeps 20 connections in all; this pool is the
// share of the API and of starting up.
const (
	MaxConns = 17
	MinConns = 2
)

// Options are how a store is opened.
type Options struct {
	// Log, if not nil, is told about failed attempts to reach the database,
	// at most once a minute.
	Log *slog.Logger
	// Beat, if not nil, is called while waiting for the database, at least
	// every second, to show the process is not stuck.
	Beat func()
	// QueryDuration and QueryErrors, if not nil, time each query and count
	// its failures, labelled by the query's name.
	QueryDuration *prometheus.HistogramVec
	QueryErrors   *prometheus.CounterVec
	// FirstRetry and LastRetry bound the wait between attempts, which
	// doubles from the first to the last. Zero means 0.5 s and 30 s.
	FirstRetry, LastRetry time.Duration
}

// Store is the game's database.
type Store struct {
	pool *pgxpool.Pool
	q    *db.Queries
}

// ErrConfig is a database URL that pgx cannot read; trying again cannot help.
var ErrConfig = errors.New("store: the database URL")

// Open opens a pool on the database at url, a postgres:// URL or a key=value
// string, and waits until the database answers, trying again with a growing
// wait until ctx ends. A database that is not up yet is usual when the
// server starts beside it, and waiting costs less than exiting and being
// restarted.
func Open(ctx context.Context, url string, opt Options) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		// pgx's message names the part it could not read, never the password.
		return nil, fmt.Errorf("%w: %v", ErrConfig, err)
	}
	cfg.MaxConns = MaxConns
	cfg.MinConns = MinConns
	cfg.ConnConfig.RuntimeParams["application_name"] = "keel"
	if opt.QueryDuration != nil || opt.QueryErrors != nil {
		cfg.ConnConfig.Tracer = newTracer(opt.QueryDuration, opt.QueryErrors)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := waitUp(ctx, pool, cfg.ConnConfig, opt); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool, q: db.New(pool)}, nil
}

// waitUp pings the database until it answers or ctx ends.
func waitUp(ctx context.Context, pool *pgxpool.Pool, cc *pgx.ConnConfig, opt Options) error {
	wait := orDefault(opt.FirstRetry, 500*time.Millisecond)
	last := orDefault(opt.LastRetry, 30*time.Second)
	beat := func() {
		if opt.Beat != nil {
			opt.Beat()
		}
	}
	var logged time.Time
	for {
		beat()
		// Each attempt is bounded, so a database that never answers cannot
		// hold the process past its heartbeat.
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := pool.Ping(pctx)
		cancel()
		if err == nil {
			if !logged.IsZero() && opt.Log != nil {
				opt.Log.Info("the database answers", "host", cc.Host, "database", cc.Database)
			}
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if opt.Log != nil && time.Since(logged) >= time.Minute {
			opt.Log.Warn("waiting for the database", "host", cc.Host, "database", cc.Database, "err", err, "retry", wait.String())
			logged = time.Now()
		}
		t := time.NewTimer(wait)
		tick := time.NewTicker(time.Second)
	sleep:
		for {
			select {
			case <-ctx.Done():
				t.Stop()
				tick.Stop()
				return ctx.Err()
			case <-tick.C:
				beat()
			case <-t.C:
				break sleep
			}
		}
		tick.Stop()
		wait = min(2*wait, last)
	}
}

func orDefault(d, def time.Duration) time.Duration {
	if d <= 0 {
		return def
	}
	return d
}

// Close closes the pool, waiting for the connections in use.
func (s *Store) Close() { s.pool.Close() }

// PoolStats is how the pool is used.
type PoolStats struct {
	Acquired, Idle, Constructing, Max int32
	// AcquireWait is the total time requests have waited for a connection,
	// and EmptyAcquires how many found none idle.
	AcquireWait   time.Duration
	EmptyAcquires int64
}

// Stats reads the pool's numbers now.
func (s *Store) Stats() PoolStats {
	st := s.pool.Stat()
	return PoolStats{
		Acquired: st.AcquiredConns(), Idle: st.IdleConns(), Constructing: st.ConstructingConns(), Max: st.MaxConns(),
		AcquireWait: st.AcquireDuration(), EmptyAcquires: st.EmptyAcquireCount(),
	}
}

// inTx runs fn in a transaction, committed if fn returns nil and rolled
// back otherwise.
func (s *Store) inTx(ctx context.Context, fn func(q *db.Queries) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
}

// tracer times queries by name: sqlc begins each query with
// "-- name: <Name> :<kind>", and anything else is "other", so the metrics'
// labels stay a closed set. Each query's metrics are resolved the first time
// it runs and kept.
type tracer struct {
	duration *prometheus.HistogramVec
	errors   *prometheus.CounterVec

	mu      sync.RWMutex
	queries map[string]*queryMetrics // by SQL text
}

type queryMetrics struct {
	name     string
	duration prometheus.Observer
	errors   prometheus.Counter
}

func newTracer(duration *prometheus.HistogramVec, errs *prometheus.CounterVec) *tracer {
	return &tracer{duration: duration, errors: errs, queries: map[string]*queryMetrics{}}
}

// queryName is the name sqlc gave a query, or "other".
func queryName(sql string) string {
	rest, ok := strings.CutPrefix(sql, "-- name: ")
	if !ok {
		return "other"
	}
	name, _, ok := strings.Cut(rest, " ")
	if !ok || name == "" {
		return "other"
	}
	return name
}

func (t *tracer) metrics(sql string) *queryMetrics {
	t.mu.RLock()
	m := t.queries[sql]
	t.mu.RUnlock()
	if m != nil {
		return m
	}
	name := queryName(sql)
	key := sql
	if name == "other" {
		// Statements that are not sqlc's (BEGIN, COMMIT, the migrations'
		// version check) share one entry, so the map stays small.
		key = ""
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if m := t.queries[key]; m != nil {
		return m
	}
	m = &queryMetrics{name: name}
	if t.duration != nil {
		m.duration = t.duration.WithLabelValues(name)
	}
	if t.errors != nil {
		m.errors = t.errors.WithLabelValues(name)
	}
	t.queries[key] = m
	return m
}

type traceKey struct{}

type traceStart struct {
	m     *queryMetrics
	start time.Time
}

func (t *tracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, traceKey{}, traceStart{m: t.metrics(data.SQL), start: time.Now()})
}

func (t *tracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	s, ok := ctx.Value(traceKey{}).(traceStart)
	if !ok {
		return
	}
	if s.m.duration != nil {
		s.m.duration.Observe(time.Since(s.start).Seconds())
	}
	if data.Err != nil && s.m.errors != nil && !errors.Is(data.Err, pgx.ErrNoRows) {
		s.m.errors.Inc()
	}
}

// uniqueViolation reports whether err is PostgreSQL's unique_violation on
// the constraint named.
func uniqueViolation(err error, constraint string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == constraint
}
