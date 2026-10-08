// SPDX-License-Identifier: AGPL-3.0-only

package obs

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// TickBuckets are the tick's histogram buckets, in seconds: fine below the
// 10 ms a tick should stay under, with edges at 10 ms, at 25 ms, where a
// tick counts as an overrun, and at 33 ms, a whole tick.
var TickBuckets = []float64{
	0.0005, 0.001, 0.002, 0.003, 0.005, 0.0075, 0.010, 0.015, 0.020, 0.025, 0.033, 0.050, 0.100,
}

// DBBuckets are the database queries' histogram buckets, in seconds.
var DBBuckets = []float64{0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5}

// Metrics are the server's metrics, on a registry of their own rather than
// the global one. Names follow Prometheus's practice: base units, _seconds,
// _total. Everything a tick updates is resolved when the server starts, so
// updating it allocates nothing.
type Metrics struct {
	Registry *prometheus.Registry

	Tick          prometheus.Gauge
	TickDuration  prometheus.Histogram
	PhaseDuration *prometheus.HistogramVec // by phase
	Ticks         prometheus.Counter
	TicksLate     prometheus.Counter
	TicksSkipped  prometheus.Counter
	ClockDrift    prometheus.Gauge
	Boats         prometheus.Gauge
	Workers       prometheus.Gauge
	Commands      *prometheus.CounterVec // by kind and result
	Snapshots     *prometheus.CounterVec // flight recorder snapshots, by reason

	DBQueryDuration    *prometheus.HistogramVec // by query
	DBQueryErrors      *prometheus.CounterVec   // by query
	SchemaVersion      prometheus.Gauge
	GuestsCreated      prometheus.Counter
	GuestsRefused      *prometheus.CounterVec // by reason
	SessionLookups     *prometheus.CounterVec // by result: hit, miss or unknown
	CrossOriginRefused prometheus.Counter
}

// NewMetrics makes the metrics, with the Go runtime's and the process's.
func NewMetrics(build, catalog string) *Metrics {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	info := prometheus.NewGauge(prometheus.GaugeOpts{
		Name:        "keel_build_info",
		Help:        "The build and catalog this server runs; always 1.",
		ConstLabels: prometheus.Labels{"build": build, "catalog": catalog},
	})
	info.Set(1)
	m := &Metrics{
		Registry: reg,
		Tick: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "keel_sim_tick", Help: "The world's latest tick, counted from its epoch.",
		}),
		TickDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "keel_sim_tick_duration_seconds", Help: "How long each tick took.", Buckets: TickBuckets,
		}),
		PhaseDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "keel_sim_phase_duration_seconds", Help: "How long each phase of a tick took.", Buckets: TickBuckets,
		}, []string{"phase"}),
		Ticks: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "keel_sim_ticks_total", Help: "Ticks run.",
		}),
		TicksLate: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "keel_sim_ticks_late_total", Help: "Ticks run back to back to catch up with the clock.",
		}),
		TicksSkipped: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "keel_sim_ticks_skipped_total", Help: "Ticks skipped because the loop fell too far behind the clock.",
		}),
		ClockDrift: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "keel_sim_clock_drift_seconds", Help: "World time minus UTC as a tick starts.",
		}),
		Boats: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "keel_sim_boats", Help: "Boats in the world.",
		}),
		Workers: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "keel_sim_physics_workers", Help: "Goroutines that stepped boats in the latest tick.",
		}),
		Commands: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "keel_sim_commands_total", Help: "Commands applied, by kind and result.",
		}, []string{"kind", "result"}),
		Snapshots: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "keel_flightrecorder_snapshots_total", Help: "Execution traces written by the flight recorder, by reason.",
		}, []string{"reason"}),
	}
	m.DBQueryDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name: "keel_db_query_duration_seconds", Help: "How long each database query took, by the query's name.", Buckets: DBBuckets,
	}, []string{"query"})
	m.DBQueryErrors = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_db_query_errors_total", Help: "Database queries that failed, by the query's name.",
	}, []string{"query"})
	m.SchemaVersion = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_db_schema_version", Help: "The newest migration the database has had.",
	})
	m.GuestsCreated = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "keel_guests_created_total", Help: "Guests created.",
	})
	m.GuestsRefused = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_guests_refused_total", Help: "Guests refused for their name, by reason.",
	}, []string{"reason"})
	m.SessionLookups = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_session_cache_lookups_total", Help: "Sessions looked up: found in the cache, fetched from the database, or unknown.",
	}, []string{"result"})
	m.CrossOriginRefused = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "keel_http_cross_origin_refused_total", Help: "Requests refused as cross-origin.",
	})
	reg.MustRegister(info, m.Tick, m.TickDuration, m.PhaseDuration, m.Ticks, m.TicksLate, m.TicksSkipped,
		m.ClockDrift, m.Boats, m.Workers, m.Commands, m.Snapshots,
		m.DBQueryDuration, m.DBQueryErrors, m.SchemaVersion, m.GuestsCreated, m.GuestsRefused, m.SessionLookups, m.CrossOriginRefused)
	return m
}

// CounterFunc registers a counter whose value fn reads when scraped, for
// counts kept by the parts that count them.
func (m *Metrics) CounterFunc(name, help string, fn func() uint64) {
	m.Registry.MustRegister(prometheus.NewCounterFunc(prometheus.CounterOpts{Name: name, Help: help},
		func() float64 { return float64(fn()) }))
}

// SecondsFunc registers a counter of seconds whose value fn reads when
// scraped.
func (m *Metrics) SecondsFunc(name, help string, fn func() time.Duration) {
	m.Registry.MustRegister(prometheus.NewCounterFunc(prometheus.CounterOpts{Name: name, Help: help},
		func() float64 { return fn().Seconds() }))
}

// GaugeFunc registers a gauge whose value fn reads when scraped, with
// labels fixed when it is registered.
func (m *Metrics) GaugeFunc(name, help string, labels prometheus.Labels, fn func() float64) {
	m.Registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: name, Help: help, ConstLabels: labels}, fn))
}

// Handler serves the metrics in Prometheus's text format.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{})
}
