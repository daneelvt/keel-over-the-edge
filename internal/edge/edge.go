// SPDX-License-Identifier: AGPL-3.0-only

// Package edge is the game connection: GET /ws, upgraded to a WebSocket
// (RFC 6455) once the session, the account and the request's Origin pass,
// then a Hello whose versions must match the server's, a Join through the
// bus, and from then on the player's inputs in and their boat's snapshots
// out.
//
// Each connection has a reader (the request's own goroutine) and a writer.
// Encoders, one a core, each with its own connections and each woken as each
// frame is published, write their connections' snapshots into the
// connections' mailboxes: the own boat, and the other boats in its area of
// interest as changes from a snapshot the client holds; the writer sends
// the newest. The client stamps each input for the tick it predicted it
// for, and the edge holds it until the tick before that is published, so
// the tick applies it then. A connection's account sails one boat, through
// one connection at a time: a newer connection takes the boat over and the
// older is closed. When the world is at its limit, a connection waits in
// the simulation's queue, told its place, until it is given a boat. When a
// connection ends its boat's grace begins, or its place in the queue is
// given up (bus.Disconnect).
package edge

import (
	"bufio"
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"path"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/watch"
)

// The close codes the edge sends, beside RFC 6455's and IANA's own.
const (
	// CloseReplaced: another connection for the account has taken the boat.
	CloseReplaced websocket.StatusCode = 4001
	// CloseVersion: the client's protocol, catalog or physics layout
	// differs from the server's.
	CloseVersion websocket.StatusCode = 4002
	// CloseRemoved: the player's account was stopped by the game's
	// operator, or deleted; the reason says which, and the client shows it
	// and does not connect again.
	CloseRemoved websocket.StatusCode = 4003
	// CloseWorldEnded: the falls have taken the world; the next one is
	// reached by connecting again.
	CloseWorldEnded websocket.StatusCode = 4004
)

// The reasons a connection closed with CloseRemoved carries, which the
// client shows its player.
const (
	ReasonStopped = "This sailor has been stopped."
	ReasonDeleted = "This sailor has been deleted."
)

// SeenAfter is how long a game connection must have been open for its end
// to be recorded as its session's and its account's last seen: one open
// longer than this has used no other route meanwhile, perhaps.
const SeenAfter = time.Hour

// Limits are a connection's limits; zero fields take the defaults.
type Limits struct {
	// Hello is how long after the upgrade the client's Hello may come.
	Hello time.Duration
	// Join is how long the simulation may take to answer a Join.
	Join time.Duration
	// Idle is how long a connection may send nothing before it is dropped.
	Idle time.Duration
	// Write is how long one message may take to write before the
	// connection is dropped.
	Write time.Duration
	// Rate and Burst are the messages a second a client may send, and how
	// many at once; Drops is how many over the rate in DropWindow close it.
	Rate       rate.Limit
	Burst      int
	Drops      int
	DropWindow time.Duration
	// Queue is how many messages other than snapshots may wait to be
	// written; past it the connection is closed.
	Queue int
	// ReadLimit is the largest message a client may send, in bytes.
	ReadLimit int64
}

// DefaultLimits are the starting values.
var DefaultLimits = Limits{
	Hello:      10 * time.Second,
	Join:       time.Second,
	Idle:       60 * time.Second,
	Write:      10 * time.Second,
	Rate:       60,
	Burst:      120,
	Drops:      120,
	DropWindow: 10 * time.Second,
	Queue:      256,
	ReadLimit:  1024,
}

func (l Limits) withDefaults() Limits {
	d := DefaultLimits
	set := func(v *time.Duration, def time.Duration) {
		if *v == 0 {
			*v = def
		}
	}
	set(&l.Hello, d.Hello)
	set(&l.Join, d.Join)
	set(&l.Idle, d.Idle)
	set(&l.Write, d.Write)
	set(&l.DropWindow, d.DropWindow)
	if l.Rate == 0 {
		l.Rate = d.Rate
	}
	if l.Burst == 0 {
		l.Burst = d.Burst
	}
	if l.Drops == 0 {
		l.Drops = d.Drops
	}
	if l.Queue == 0 {
		l.Queue = d.Queue
	}
	if l.ReadLimit == 0 {
		l.ReadLimit = d.ReadLimit
	}
	return l
}

// A Clock tells world time: the loop's.
type Clock interface {
	// WorldTime is the time since the world's epoch; ok is false until the
	// world is ticking.
	WorldTime() (t time.Duration, ok bool)
}

// Config sets up an edge.
type Config struct {
	Bus *bus.Bus
	// World is the world's ID, as Welcome names it, and Epoch the moment
	// its time counts from, which Welcome carries too.
	World string
	Epoch time.Time
	// Ends is when the world ends, as Welcome tells it, and Closing when
	// its last days begin; zero for no end known. Zone is the time zone the
	// schedule's ends are published in, "" for UTC.
	Ends    time.Time
	Closing time.Time
	Zone    string
	Clock   Clock
	// Protocol, Catalog and Layout are the versions a client's Hello must
	// carry.
	Protocol string
	Catalog  string
	Layout   uint32
	// Origin is the players' origin. An upgrade's Origin header must name
	// its host or the request's own; a request without one passes.
	Origin  string
	Log     *slog.Logger
	Metrics *obs.Metrics
	// Fail answers a request refused before the upgrade: a status and a
	// code, as the game's other routes answer.
	Fail   auth.ErrorWriter
	Limits Limits
	// Encoders is how many goroutines encode snapshots; 0 means
	// GOMAXPROCS.
	Encoders int
	// Land says the world's land is sailed, as the Welcome tells the
	// client; Chunks, if not nil, hands out its chunks' addresses.
	Land   bool
	Chunks *Handout
	// MainLight is the main port's light, which the Welcome carries, or nil.
	MainLight *pb.Light
	// Chart, if not nil, is the world's chart: sent whole after the
	// Welcome, then what is charted as it is written.
	Chart ChartSource
	// Forecast, if not nil, is the world's forecast: its latest issue sent
	// after the Welcome with what has been, then each issue as it is made.
	Forecast ForecastSource
	// Circulation is the world's way round the disk for its current, as
	// the Welcome tells the client: 1, −1 or 0 for none.
	Circulation int32
	// Lip is the disk's lip, m from the centre; Roam, how far the owner's
	// free camera roams about it, DefaultRoamReach if zero; and RoamChunks,
	// if not nil, the handout of the land's chunks to a roaming camera,
	// made for its greatest height.
	Lip        float64
	Roam       RoamReach
	RoamChunks *Handout
	// Stopped, if not nil, reports whether an account is stopped by the
	// game's operator: it is refused at the upgrade, and again as its
	// connection claims its boat, so a stop in between is not missed.
	Stopped func(bus.Account) bool
	// Seen, if not nil, is told of a connection that ends after SeenAfter
	// open (or after LongAfter, if not zero), by its session's token hash:
	// its session and account were seen then.
	Seen      func(hash [32]byte)
	LongAfter time.Duration
	// Watch, if not nil, finds a sailor to watch by its name's key
	// (moderation.Key): store.ErrNotFound for none. SpectatorLimit is how
	// many may watch at once, DefaultSpectatorLimit if zero.
	Watch          func(ctx context.Context, key string) (watch.Target, error)
	SpectatorLimit int
	// Agent, if not nil, reads a machine sailor's AI agent, by the sailor's
	// account: when it last called, the zero time for never, and whether a
	// wait of its is under way. An owner watching their own machine
	// sailor is told from it whether the agent attends.
	Agent func(bus.Account) (last time.Time, waiting bool)
}

// Edge serves the game connection.
type Edge struct {
	cfg     Config
	lim     Limits
	origins []string
	m       metrics

	// ctx is every connection's context; cancel ends them all, for good.
	ctx    context.Context
	cancel context.CancelFunc

	// endsUs and closingUs are the world's end and its last days' start as
	// Welcome tells them, µs of UTC, 0 for none.
	endsUs, closingUs atomic.Int64

	nextConn atomic.Uint64
	registry registry
	reach    RoamReach
	latest   atomic.Int64 // the latest published tick
	encs     []*encoder
	spect    spectators
	voyages  voyages

	mu      sync.Mutex
	closing bool
	// ended: the world has ended, and the next is opening: a connection
	// that comes meanwhile is told to try again (1013) rather than refused.
	ended   bool
	conns   map[*conn]struct{}
	running sync.WaitGroup // every connection's goroutines
	helpers sync.WaitGroup // what waits on the simulation for a connection that has gone
}

// New makes an edge. Run must be running for connections to be welcomed.
func New(cfg Config) *Edge {
	ctx, cancel := context.WithCancel(context.Background())
	e := &Edge{
		cfg:    cfg,
		lim:    cfg.Limits.withDefaults(),
		m:      newMetrics(cfg.Metrics),
		ctx:    ctx,
		cancel: cancel,
		conns:  map[*conn]struct{}{},
	}
	if e.cfg.LongAfter == 0 {
		e.cfg.LongAfter = SeenAfter
	}
	e.reach = cfg.Roam
	if e.reach == (RoamReach{}) {
		e.reach = DefaultRoamReach
	}
	if u, err := url.Parse(cfg.Origin); err == nil && u.Host != "" {
		e.origins = []string{u.Host}
	}
	e.registry.init()
	e.spect.init(cfg.SpectatorLimit)
	e.voyages.m = map[bus.Account]uint64{}
	e.m.spectatorLimit.Set(float64(e.spect.limit))
	e.SetEnds(cfg.Ends, cfg.Closing)
	n := cfg.Encoders
	if n < 1 {
		n = runtime.GOMAXPROCS(0)
	}
	capacity := cfg.Bus.Frames.Latest().Capacity()
	for range n {
		enc := &encoder{}
		enc.init(e, capacity)
		e.encs = append(e.encs, enc)
	}
	e.m.encoders.Set(float64(n))
	return e
}

// Record is told of each frame as the simulation publishes it: a
// sim.Recorder. It wakes the encoders and never blocks.
func (e *Edge) Record(f *bus.Frame) {
	e.latest.Store(f.Tick)
	for _, enc := range e.encs {
		enc.wake()
	}
}

// Run encodes snapshots until ctx ends.
func (e *Edge) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, enc := range e.encs {
		wg.Go(func() { enc.run(ctx) })
	}
	wg.Go(func() { e.tellSpectators(ctx) })
	wg.Wait()
}

// encoderFor is the encoder with the fewest connections, which c joins.
func (e *Edge) encoderFor() *encoder {
	best := e.encs[0]
	for _, enc := range e.encs[1:] {
		if enc.load.Load() < best.load.Load() {
			best = enc
		}
	}
	best.load.Add(1)
	return best
}

// ServeHTTP is GET /ws: the session first, then the account's kind, then the
// upgrade, whose Origin the library checks; then the connection's whole
// life, on this goroutine.
func (e *Edge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	acc, ok := auth.FromContext(r.Context())
	if !ok {
		e.m.upgrade[upgradeNoSession].Inc()
		e.cfg.Fail(w, http.StatusUnauthorized, "session")
		return
	}
	if acc.Kind != store.Human {
		// AI agents sail through their own interface, never this one.
		e.m.upgrade[upgradeAI].Inc()
		e.cfg.Fail(w, http.StatusForbidden, "ai-account")
		return
	}
	if e.stopped(bus.Account(acc.ID)) {
		e.m.upgrade[upgradeStopped].Inc()
		e.cfg.Fail(w, http.StatusForbidden, "stopped")
		return
	}
	e.mu.Lock()
	closing, ended := e.closing, e.ended
	e.mu.Unlock()
	if closing && !ended {
		e.cfg.Fail(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	// A hijacked connection keeps no deadline the server set (net/http
	// clears them as it hijacks), but the Hijacker's contract allows it to,
	// so they are cleared here; the connection then sets its own limits.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})
	hj := &hijacked{ResponseWriter: w}
	ws, err := websocket.Accept(hj, r, &websocket.AcceptOptions{
		OriginPatterns:  e.origins,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		if !originAllowed(r, e.origins) {
			e.m.upgrade[upgradeOrigin].Inc()
		} else {
			e.m.upgrade[upgradeBad].Inc()
		}
		e.cfg.Log.Debug("game connection refused", "request_id", obs.RequestID(r.Context()), "err", err)
		return
	}
	e.m.upgrade[upgradeOK].Inc()
	if closing {
		// A browser cannot read why an upgrade was refused: the close says
		// to come back in a moment, to the next world.
		_ = ws.Close(websocket.StatusTryAgainLater, "a new world is opening")
		return
	}
	c := newConn(e, ws, hj.conn, bus.Account(acc.ID), acc.Tools, acc.Priority, obs.RequestID(r.Context()))
	if cur, ok := auth.SessionFromContext(r.Context()); ok {
		c.session = cur.Hash
	}
	if !e.track(c) {
		_ = ws.Close(websocket.StatusServiceRestart, "the server is restarting")
		return
	}
	defer e.untrack(c)
	c.run()
}

// stopped reports whether an account is stopped by the game's operator.
func (e *Edge) stopped(a bus.Account) bool { return e.cfg.Stopped != nil && e.cfg.Stopped(a) }

// hijacked keeps the socket the library hijacks, so a connection can be
// closed under a close handshake its peer never answers.
type hijacked struct {
	http.ResponseWriter
	conn net.Conn
}

func (h *hijacked) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	c, brw, err := http.NewResponseController(h.ResponseWriter).Hijack()
	h.conn = c
	return c, brw, err
}

// track counts c as open, unless the edge is closing.
func (e *Edge) track(c *conn) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closing {
		return false
	}
	e.conns[c] = struct{}{}
	e.running.Add(1)
	e.m.connections.Inc()
	return true
}

func (e *Edge) untrack(c *conn) {
	e.mu.Lock()
	delete(e.conns, c)
	e.mu.Unlock()
	e.m.connections.Dec()
	c.countTier(-1)
	e.running.Done()
}

// originAllowed is the library's own Origin rule, for counting refusals: no
// Origin, the request's own host, or a host the patterns match.
func originAllowed(r *http.Request, patterns []string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(r.Host, u.Host) {
		return true
	}
	for _, p := range patterns {
		target := u.Host
		if strings.Contains(p, "://") {
			target = u.Scheme + "://" + u.Host
		}
		if ok, _ := path.Match(strings.ToLower(p), strings.ToLower(target)); ok {
			return true
		}
	}
	return false
}

// SetEnds sets the world's end and its last days' start, as the Welcomes
// from now on tell them.
func (e *Edge) SetEnds(ends, closing time.Time) {
	e.endsUs.Store(endsUs(ends))
	e.closingUs.Store(endsUs(closing))
}

// endsUs is a world's end as Welcome carries it: µs of UTC, 0 for none.
func endsUs(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMicro()
}
