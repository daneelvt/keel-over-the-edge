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

// EdgeBuckets are the game connection's histogram buckets, in seconds:
// encoding a frame for every connection, and writing one message.
var EdgeBuckets = []float64{0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1, 5, 10}

// ViewBuckets are the boats in a connection's view, by band: 0 to 64.
var ViewBuckets = []float64{0, 1, 2, 4, 8, 12, 16, 24, 32, 48, 64}

// SnapshotBuckets are snapshots' sizes, in bytes: 160 is the header alone,
// the own boat with nobody near.
var SnapshotBuckets = []float64{160, 192, 256, 320, 384, 512, 640, 768, 1024, 1312}

// LagBuckets are how many ticks the newest snapshot sent is ahead of the
// newest the client has acknowledged.
var LagBuckets = []float64{0, 2, 4, 6, 8, 10, 15, 20, 30, 45, 60, 90, 150}

// MarginBuckets are the input arrival margin's buckets, in ticks: how long
// before the tick it was stamped for an input arrived, negative when late.
var MarginBuckets = []float64{-10, -5, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30}

// WaitBuckets are how long players wait in the queue for a boat, in seconds.
var WaitBuckets = []float64{1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600}

// ClientBuckets are the phones' round trips and frame times, in seconds.
var ClientBuckets = []float64{0.005, 0.01, 0.017, 0.025, 0.033, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2}

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
	BoatLimit     prometheus.Gauge
	QueueLength   prometheus.Gauge
	Admissions    *prometheus.CounterVec // by result
	QueueWait     prometheus.Histogram
	GridDuration  prometheus.Histogram
	Workers       prometheus.Gauge
	Commands      *prometheus.CounterVec // by kind and result
	Snapshots     *prometheus.CounterVec // flight recorder snapshots, by reason
	Falls         prometheus.Counter     // boats gone over the lip
	Approaches    prometheus.Counter     // voyages ended with an approach to the lip survived

	OwnerActions *prometheus.CounterVec // the owner's controls, by action
	OwnerRefused *prometheus.CounterVec // what the owner's tools refused, by what was asked
	OwnerView    prometheus.Histogram   // building the world page's view

	DBQueryDuration    *prometheus.HistogramVec // by query
	DBQueryErrors      *prometheus.CounterVec   // by query
	SchemaVersion      prometheus.Gauge
	GuestsCreated      prometheus.Counter
	GuestsRefused      *prometheus.CounterVec // by reason
	SessionLookups     *prometheus.CounterVec // by result: hit, miss or unknown
	CrossOriginRefused prometheus.Counter
	ChunkRequests      *prometheus.CounterVec // by result: ok, refused
	ChunkBytes         prometheus.Counter
	ChunksHanded       prometheus.Counter

	Grace *prometheus.CounterVec // by result: started, rejoined, expired

	LeaseEpoch        prometheus.Gauge
	LeaseWait         prometheus.Gauge
	LeaseLost         *prometheus.CounterVec // by outcome: retaken, lost, fenced
	Restores          *prometheus.CounterVec // by result
	RestoredBoats     prometheus.Gauge
	RestoreGap        prometheus.Gauge
	PersistBatch      prometheus.Histogram
	PersistCheckpoint prometheus.Histogram
	PersistWrites     *prometheus.CounterVec // by result: ok, failed, fenced

	JobRuns        *prometheus.CounterVec // by job and outcome
	JobLastOK      *prometheus.GaugeVec   // by job
	WorldNumber    prometheus.Gauge
	WorldEnds      prometheus.Gauge
	WorldNextReady prometheus.Gauge
	WorldSwitches  *prometheus.CounterVec // by how: scheduled, late, by_hand
	WorldSwitch    prometheus.Gauge

	EdgeConnections     prometheus.Gauge
	EdgeUpgrades        *prometheus.CounterVec // by result
	EdgeHellos          *prometheus.CounterVec // by result
	EdgeJoins           *prometheus.CounterVec // by result
	EdgeCloses          *prometheus.CounterVec // by code
	EdgeMessages        *prometheus.CounterVec // by direction and kind
	EdgeBytes           *prometheus.CounterVec // by direction
	EdgeDropped         *prometheus.CounterVec // by reason
	EdgeEncodeDuration  prometheus.Histogram
	EdgeWriteDuration   prometheus.Histogram
	EdgeEncoders        prometheus.Gauge
	EdgeQueued          prometheus.Gauge
	EdgeViewBoats       *prometheus.HistogramVec // by band
	EdgeSnapshotBytes   prometheus.Histogram
	EdgeSnapshotEntries *prometheus.CounterVec // by op
	EdgeSnapshotLag     prometheus.Histogram
	EdgeResyncs         *prometheus.CounterVec // by result
	EdgeInputMargin     prometheus.Histogram
	ClientRTT           prometheus.Histogram
	ClientFrame         prometheus.Histogram
	ClientTier          *prometheus.GaugeVec // by tier
	ClientRenderScale   prometheus.Histogram
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
		Falls: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "keel_falls_total", Help: "Boats gone over the lip of the falls.",
		}),
		Approaches: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "keel_approaches_total", Help: "Voyages ended with an approach to the lip survived.",
		}),
		OwnerActions: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "keel_owner_actions_total", Help: "The world page's controls used, by action: flag, unflag, place, unseen, seen.",
		}, []string{"action"}),
		OwnerRefused: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "keel_owner_refused_total", Help: "What the owner's tools refused, by what was asked: roam from an account without the flag, place, flag, unseen, request (a guard's refusal).",
		}, []string{"what"}),
		OwnerView: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "keel_owner_view_seconds", Help: "How long building the world page's view of the world took, once a second.",
			Buckets: []float64{0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25},
		}),
		Boats: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "keel_sim_boats", Help: "Boats in the world.",
		}),
		BoatLimit: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "keel_sim_boat_limit", Help: "The most boats the world holds at once.",
		}),
		QueueLength: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "keel_sim_queue_length", Help: "Players waiting for a boat.",
		}),
		Admissions: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "keel_sim_admissions_total", Help: "Joins and the queue, by result: joined, rejoined, queued, admitted, dequeued or full.",
		}, []string{"result"}),
		QueueWait: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "keel_sim_queue_wait_seconds", Help: "How long each player given a boat from the queue waited.", Buckets: WaitBuckets,
		}),
		GridDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "keel_sim_grid_duration_seconds", Help: "How long sorting the boats into the grid took, each tick.", Buckets: TickBuckets,
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
	m.ChunkRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_chunk_requests_total", Help: "Requests for a world chunk that reached the server: ok, or refused for an address it never handed out.",
	}, []string{"result"})
	for _, r := range []string{"ok", "refused"} {
		m.ChunkRequests.WithLabelValues(r)
	}
	m.ChunkBytes = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "keel_chunk_bytes_total", Help: "Bytes of world chunks the server sent: what the edge's cache did not hold.",
	})
	m.ChunksHanded = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "keel_chunks_handed_total", Help: "World chunks' addresses handed to game connections.",
	})
	m.Grace = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_sim_grace_total",
		Help: "Boats' graces after their connection ended: started, ended by a join of the same account (rejoined, which counts any join that found the account's boat), or expired.",
	}, []string{"result"})
	m.EdgeConnections = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_edge_connections", Help: "Game connections open.",
	})
	m.EdgeUpgrades = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_edge_upgrades_total", Help: "Requests for the game connection, by result.",
	}, []string{"result"})
	m.EdgeHellos = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_edge_hello_total", Help: "Game connections' first messages, by result: ok, or what differed.",
	}, []string{"result"})
	m.EdgeJoins = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_edge_joins_total", Help: "Game connections' joins, by result.",
	}, []string{"result"})
	m.EdgeCloses = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_edge_closes_total", Help: "Game connections ended, by the close code sent or received, or none.",
	}, []string{"code"})
	m.EdgeMessages = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_edge_messages_total", Help: "Game messages, by direction and kind.",
	}, []string{"direction", "kind"})
	m.EdgeBytes = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_edge_bytes_total", Help: "Game connections' WebSocket frames' bytes, by direction.",
	}, []string{"direction"})
	m.EdgeDropped = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_edge_messages_dropped_total", Help: "Game messages dropped: over a connection's rate, or a snapshot replaced before it was sent.",
	}, []string{"reason"})
	m.EdgeEncodeDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "keel_edge_encode_duration_seconds", Help: "How long each encoder took over a frame for its connections.", Buckets: EdgeBuckets,
	})
	m.EdgeEncoders = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_edge_encoders", Help: "Encoders: goroutines writing connections' snapshots, each its own connections.",
	})
	m.EdgeQueued = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_edge_queued_connections", Help: "Game connections waiting in the queue for a boat.",
	})
	m.EdgeViewBoats = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name: "keel_edge_view_boats", Help: "Other boats in a snapshot's view, by band.", Buckets: ViewBuckets,
	}, []string{"band"})
	m.EdgeSnapshotBytes = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "keel_edge_snapshot_bytes", Help: "Snapshots' sizes, their kind byte included.", Buckets: SnapshotBuckets,
	})
	m.EdgeSnapshotEntries = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_edge_snapshot_entries_total", Help: "Entries written in snapshots' views, by op.",
	}, []string{"op"})
	m.EdgeSnapshotLag = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "keel_edge_snapshot_lag_ticks", Help: "The tick of each snapshot sent less the newest the client had acknowledged.", Buckets: LagBuckets,
	})
	m.EdgeResyncs = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_edge_resyncs_total", Help: "Clients' requests for a full snapshot: honoured, or ignored as more than one a second.",
	}, []string{"result"})
	m.EdgeWriteDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "keel_edge_write_duration_seconds", Help: "How long writing a game message took.", Buckets: EdgeBuckets,
	})
	m.EdgeInputMargin = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "keel_edge_input_margin_ticks", Help: "How many ticks before the tick it was stamped for each input arrived; negative when late.", Buckets: MarginBuckets,
	})
	m.ClientRTT = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "keel_client_rtt_seconds", Help: "Round trips as the clients measure them.", Buckets: ClientBuckets,
	})
	m.ClientFrame = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "keel_client_frame_seconds", Help: "The clients' 95th percentile frame times.", Buckets: ClientBuckets,
	})
	m.ClientTier = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "keel_client_tier", Help: "Clients connected, by the tier they draw at: low, medium, high, or unknown.",
	}, []string{"tier"})
	m.ClientRenderScale = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "keel_client_render_scale", Help: "The pixel ratios the clients draw at.",
		Buckets: []float64{0.5, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 1.75, 2},
	})
	m.LeaseEpoch = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_sim_lease_epoch", Help: "The simulation lease's epoch this process took it at: one more for each process that has run the world.",
	})
	m.LeaseWait = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_sim_lease_wait_seconds", Help: "How long this process waited for the simulation lease as it started.",
	})
	m.LeaseLost = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_sim_lease_lost_total",
		Help: "The simulation lease's connection lost and taken back with its epoch unchanged (retaken), or not (lost); or a write refused because another took the lease (fenced).",
	}, []string{"outcome"})
	m.Restores = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_sim_restores_total",
		Help: "The world's checkpoint as the process started: restored, none, too_old (older than the grace) or incompatible (another format, catalog or physics layout).",
	}, []string{"result"})
	m.RestoredBoats = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_sim_restored_boats", Help: "Boats restored from the checkpoint as the process started.",
	})
	m.RestoreGap = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_sim_restore_gap_seconds", Help: "World time between the checkpoint restored and the process's first tick.",
	})
	m.PersistBatch = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "keel_persist_batch_duration_seconds", Help: "How long writing each batch of the world's events and checkpoint took.", Buckets: DBBuckets,
	})
	m.PersistCheckpoint = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "keel_persist_checkpoint_duration_seconds", Help: "How long writing each batch that held a checkpoint took.", Buckets: DBBuckets,
	})
	m.PersistWrites = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_persist_batches_total", Help: "Batches of the world's events and checkpoint, by result: ok, failed (tried again) or fenced.",
	}, []string{"result"})
	m.JobRuns = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_job_runs_total", Help: "Jobs' runs, by job and outcome: ok, skipped (nothing to do) or failed (tried again).",
	}, []string{"job", "outcome"})
	m.JobLastOK = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "keel_job_last_ok_timestamp_seconds", Help: "When each job's last run that succeeded or had nothing to do finished, in Unix seconds; 0 if none has since the process started.",
	}, []string{"job"})
	m.WorldNumber = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_world_number", Help: "The number of the world being sailed.",
	})
	m.WorldEnds = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_world_ends_timestamp_seconds", Help: "When the world being sailed ends, in Unix seconds.",
	})
	m.WorldNextReady = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_world_next_ready", Help: "1 when the next world is made, checked and stored; 0 until then.",
	})
	m.WorldSwitches = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "keel_world_switches_total", Help: "Worlds begun in the running process, by how: scheduled (at the end), late (on start, the end missed) or by_hand.",
	}, []string{"how"})
	m.WorldSwitch = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "keel_world_switch_seconds", Help: "The last switch's pause, from the old world's last tick to the new world's first.",
	})
	for _, h := range []string{"scheduled", "late", "by_hand"} {
		m.WorldSwitches.WithLabelValues(h)
	}
	reg.MustRegister(m.JobRuns, m.JobLastOK, m.WorldNumber, m.WorldEnds, m.WorldNextReady, m.WorldSwitches, m.WorldSwitch)
	for _, o := range []string{"retaken", "lost", "fenced"} {
		m.LeaseLost.WithLabelValues(o)
	}
	for _, r := range []string{"restored", "none", "too_old", "incompatible"} {
		m.Restores.WithLabelValues(r)
	}
	for _, r := range []string{"ok", "failed", "fenced"} {
		m.PersistWrites.WithLabelValues(r)
	}
	reg.MustRegister(m.LeaseEpoch, m.LeaseWait, m.LeaseLost, m.Restores, m.RestoredBoats, m.RestoreGap, m.PersistBatch, m.PersistCheckpoint, m.PersistWrites)
	reg.MustRegister(m.Grace, m.EdgeConnections, m.EdgeUpgrades, m.EdgeHellos, m.EdgeJoins, m.EdgeCloses, m.EdgeMessages,
		m.EdgeBytes, m.EdgeDropped, m.EdgeEncodeDuration, m.EdgeWriteDuration, m.EdgeInputMargin, m.ClientRTT, m.ClientFrame, m.ClientTier, m.ClientRenderScale,
		m.EdgeEncoders, m.EdgeQueued, m.EdgeViewBoats, m.EdgeSnapshotBytes, m.EdgeSnapshotEntries, m.EdgeSnapshotLag, m.EdgeResyncs)
	reg.MustRegister(info, m.Tick, m.TickDuration, m.PhaseDuration, m.Ticks, m.TicksLate, m.TicksSkipped,
		m.ClockDrift, m.Boats, m.BoatLimit, m.QueueLength, m.Admissions, m.QueueWait, m.GridDuration, m.Workers, m.Commands, m.Snapshots,
		m.DBQueryDuration, m.DBQueryErrors, m.SchemaVersion, m.GuestsCreated, m.GuestsRefused, m.SessionLookups, m.CrossOriginRefused,
		m.ChunkRequests, m.ChunkBytes, m.ChunksHanded, m.Falls, m.Approaches)
	for _, a := range []string{"flag", "unflag", "place", "unseen", "seen", "world", "remake"} {
		m.OwnerActions.WithLabelValues(a)
	}
	for _, w := range []string{"roam", "place", "flag", "unseen", "request", "world", "remake"} {
		m.OwnerRefused.WithLabelValues(w)
	}
	reg.MustRegister(m.OwnerActions, m.OwnerRefused, m.OwnerView)
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
