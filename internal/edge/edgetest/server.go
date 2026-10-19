// SPDX-License-Identifier: AGPL-3.0-only

// Package edgetest runs the game connection in a test: a world ticking on
// the loop, the edge and the game's routes, served on net/http/httptest's
// in-memory network, so that a test in a testing/synctest bubble runs
// minutes of connection in milliseconds; and a Go client that speaks the
// protocol and predicts its boat as the page does.
package edgetest

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// Epoch is the test worlds' epoch: a synctest bubble's clock starts on it,
// so tick 0 falls on the bubble's first instant.
var Epoch = time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)

// WorldID is the test worlds' ID, as Welcome names it.
const WorldID = "0199c2a4-5f7e-7c3a-9d0e-000000000001"

// PlayOrigin is the players' origin the test server is configured with;
// the in-memory server's own host is example.com.
const PlayOrigin = "https://play.keel.test"

// Config sets up a test server; zero fields take defaults.
type Config struct {
	Capacity int // 16
	Grace    int64
	Limit    int // the boat limit; the capacity if 0
	Encoders int // the edge's encoders; GOMAXPROCS if 0
	Limits   edge.Limits
	Ends     time.Time // the world's end, as Welcome tells it
	// Kinds are the world's boats, prepared, and Waves the sea they were
	// prepared for; the catalog's if Kinds is nil.
	Kinds []physics.Prepared
	Waves *physics.Waves
	// Weather is the world's own weather; nil is a steady wind
	// (sim.DefaultSpell).
	Weather *weather.Timeline
	// Encounters are how the world's boats meet; the catalog's if nil.
	Encounters *physics.EncounterPrepared
	// Record, if not nil, is told of each frame too, on the ticking
	// goroutine, before the edge.
	Record sim.Recorder
	// Terrain, if not nil, is the world's land, sailed; Chunks then hands
	// out its chunks' addresses, and Payloads serves them.
	Terrain  *sim.Terrain
	Chunks   *edge.Handout
	Payloads *api.Chunks
	// RoamChunks, if not nil, hands out the chunks to the owner's free
	// camera as it roams.
	RoamChunks *edge.Handout
	// Edge is how boats meet the world's edge; the catalog's if nil.
	Edge *sim.Edge
}

// Server is the game's server in a test.
type Server struct {
	World    *sim.World
	Loop     *loop.Loop
	Edge     *edge.Edge
	HTTP     *httptest.Server
	Metrics  *obs.Metrics
	Sessions *Sessions
	Kinds    []physics.Prepared
	Waves    *physics.Waves
	Weather  *weather.Timeline
	// Encounters are how the world's boats meet.
	Encounters *physics.EncounterPrepared

	cfg      Config
	sessions *auth.Cache
	handler  atomic.Pointer[http.Handler] // the game's routes, replaced by a restart
	cancel   context.CancelFunc
	done     sync.WaitGroup
	stopped  bool
}

// CatalogEdge is the catalog's edge: five seconds' fall, and approaches
// survived 20 m back out of the mist band.
var CatalogEdge = sim.Edge{Fall: 150, Clear: 20}

// circulation is the way round the disk of a world of terrain t.
func circulation(t *sim.Terrain) int32 {
	if t == nil {
		return 0
	}
	return int32(t.Circulation)
}

// CatalogKinds is the catalog's sea and its boats, prepared.
func CatalogKinds(t testing.TB) (*physics.Waves, []physics.Prepared) {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return cat.Prepare()
}

// NewServer starts a server: in a synctest bubble, it ticks on the
// bubble's clock. Stop stops it.
func NewServer(t testing.TB, cfg Config) *Server {
	t.Helper()
	if cfg.Capacity == 0 {
		cfg.Capacity = 16
	}
	if cfg.Kinds == nil {
		cfg.Waves, cfg.Kinds = CatalogKinds(t)
	}
	if cfg.Weather == nil {
		cfg.Weather = weather.Fixed(sim.DefaultSpell)
	}
	if cfg.Encounters == nil {
		cat, err := catalog.Load()
		if err != nil {
			t.Fatal(err)
		}
		cfg.Encounters = cat.PrepareEncounters()
	}
	if cfg.Edge == nil {
		cfg.Edge = &CatalogEdge
	}
	m := obs.NewMetrics("test", catalog.Version)
	s := &Server{Metrics: m, Sessions: NewSessions(), Kinds: cfg.Kinds, Waves: cfg.Waves, Weather: cfg.Weather, Encounters: cfg.Encounters, cfg: cfg}
	s.sessions = auth.NewCache(s.Sessions, auth.CacheConfig{Log: slog.New(slog.DiscardHandler)})
	s.start(t, s.newWorld(t))
	s.HTTP = httptest.NewTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		(*s.handler.Load()).ServeHTTP(w, r)
	}))
	t.Cleanup(s.Stop)
	return s
}

func (s *Server) newWorld(t testing.TB) *sim.World {
	t.Helper()
	cfg := s.cfg
	w, err := sim.New(sim.Config{Capacity: cfg.Capacity, Kinds: cfg.Kinds, Waves: cfg.Waves, Encounters: cfg.Encounters, Workers: 1,
		Tick: loop.TickAt(time.Now(), Epoch), Grace: cfg.Grace, Limit: cfg.Limit, Weather: cfg.Weather, Terrain: cfg.Terrain, Edge: cfg.Edge})
	if err != nil {
		t.Fatal(err)
	}
	return w
}

// start runs w: its loop, an edge, and the game's routes.
func (s *Server) start(t testing.TB, w *sim.World) {
	t.Helper()
	cfg, m := s.cfg, s.Metrics
	log := slog.New(slog.DiscardHandler)
	s.World = w
	s.Loop = loop.New(loop.Config{World: w, Epoch: Epoch, Log: log, Metrics: m})
	s.Edge = edge.New(edge.Config{
		Bus: w.Bus(), World: WorldID, Epoch: Epoch, Ends: cfg.Ends, Clock: s.Loop,
		Protocol: protocol.Version, Catalog: catalog.Version, Layout: physics.LayoutVersion,
		Origin: PlayOrigin, Log: log, Metrics: m, Fail: api.WriteError, Limits: cfg.Limits, Encoders: cfg.Encoders,
		Land: cfg.Terrain != nil, Chunks: cfg.Chunks, Circulation: circulation(cfg.Terrain),
		Lip: cfg.Weather.Prepared().Edge(), RoamChunks: cfg.RoamChunks,
	})
	if cfg.Record != nil {
		// The test's recorder first, so it has each frame before any
		// client can be sent it.
		w.Record(cfg.Record, s.Edge)
	} else {
		w.Record(s.Edge)
	}
	h := api.Handler(api.Config{
		Version:  api.Version{Build: "test", Catalog: catalog.Version},
		Log:      log,
		Metrics:  m,
		Sessions: s.sessions,
		Game:     s.Edge,
		Chunks:   cfg.Payloads,
	})
	s.handler.Store(&h)
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.done.Add(2)
	go func() { defer s.done.Done(); s.Loop.Run(ctx) }()
	go func() { defer s.done.Done(); s.Edge.Run(ctx) }()
}

// restartBell is how long the world sails on once Restart has rung the
// bell, as keel serve's does for KEEL_BELL: long enough for every
// connection's writer to send it before the close goes after it.
const restartBell = 100 * time.Millisecond

// Restart restarts the server as a deploy restarts keel serve: every
// connection is told, the world sails on for the bell, stops and is
// checkpointed, and the connections are closed with 1012; for pause the
// game connection is refused, as while no server is ready; then a new
// world is restored from the checkpoint, and served by a new loop and
// edge.
func (s *Server) Restart(t testing.TB, pause time.Duration) {
	t.Helper()
	s.Edge.Bell(restartBell)
	time.Sleep(restartBell)
	s.cancel()
	s.done.Wait()
	f := s.World.Bus().Frames.Acquire()
	checkpoint := sim.AppendSnapshot(nil, f)
	f.Release()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = s.Edge.Shutdown(ctx)
	s.World.Close()
	time.Sleep(pause)
	w := s.newWorld(t)
	if _, err := w.Restore(checkpoint, loop.TickAt(time.Now(), Epoch)); err != nil {
		t.Fatal(err)
	}
	s.start(t, w)
}

// Stop stops the server as keel serve does: every connection closed with
// 1012, then the loop and the encoder.
func (s *Server) Stop() {
	if s.stopped {
		return
	}
	s.stopped = true
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	_ = s.Edge.Shutdown(ctx)
	s.cancel()
	s.done.Wait()
	s.HTTP.Close()
	s.World.Close()
}

// URL is the game connection's URL on the in-memory network.
func (s *Server) URL() string { return "ws://example.com/ws" }

// Client is an HTTP client on the in-memory network, whose connections pass
// through wrap if it is not nil.
func (s *Server) Client(wrap func(netConn) netConn) *http.Client {
	c := *s.HTTP.Client()
	if wrap != nil {
		tr := c.Transport.(*http.Transport).Clone()
		dial := tr.DialContext
		tr.DialContext = func(ctx context.Context, network, addr string) (netConn, error) {
			nc, err := dial(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			return wrap(nc), nil
		}
		c.Transport = tr
	}
	return &c
}

// Sessions is a store of sessions in memory: auth.Sessions.
type Sessions struct {
	mu   sync.Mutex
	by   map[[32]byte]store.Session
	next byte
}

// NewSessions makes an empty store of sessions.
func NewSessions() *Sessions { return &Sessions{by: map[[32]byte]store.Session{}} }

// Session finds a session by its token's hash.
func (s *Sessions) Session(_ context.Context, hash [32]byte) (store.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.by[hash]; ok {
		return v, nil
	}
	return store.Session{}, store.ErrNotFound
}

// Touch does nothing.
func (s *Sessions) Touch(context.Context, [32]byte) error { return nil }

// Accounts finds the accounts of ids among the sessions'.
func (s *Sessions) Accounts(_ context.Context, ids []store.AccountID) (map[store.AccountID]store.Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[store.AccountID]store.Account{}
	for _, v := range s.by {
		if slices.Contains(ids, v.ID) {
			out[v.ID] = v.Account
		}
	}
	return out, nil
}

// SetTools sets or clears the owner's flag of a human account.
func (s *Sessions) SetTools(_ context.Context, id store.AccountID, on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	for h, v := range s.by {
		if v.ID == id && v.Kind == store.Human {
			v.Tools = on
			s.by[h] = v
			found = true
		}
	}
	if !found {
		return store.ErrNotFound
	}
	return nil
}

// Add makes an account of kind with a session, and returns the session's
// cookie's value.
func (s *Sessions) Add(name string, kind store.Kind) (token string, id store.AccountID) {
	return s.add(store.Account{Kind: kind, Name: name})
}

func (s *Sessions) add(a store.Account) (token string, id store.AccountID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next++
	id = store.AccountID{0x01, 0x99, 0xc2, 0xa4, 0x5f, 0x7e, 0x7c, 0x3a, 0x9d, 0x0e, 0, 0, 0, 0, 0, s.next}
	token, hash := auth.NewToken()
	a.ID = id
	s.by[hash] = store.Session{Account: a}
	return token, id
}

// Guest makes a guest, and returns its session's cookie's value.
func (s *Server) Guest(name string) (token string, id store.AccountID) {
	return s.Sessions.Add(name, store.Human)
}

// Owner makes a guest that carries the owner's flag.
func (s *Server) Owner(name string) (token string, id store.AccountID) {
	return s.Sessions.add(store.Account{Kind: store.Human, Name: name, Tools: true})
}

// Owned sends one of the owner's tools' commands, at the next tick.
func (s *Server) Owned(c bus.Command) {
	owner := s.World.Bus().Commands.Owner()
	for owner.TrySend(c) != nil {
		time.Sleep(time.Second / 30)
	}
}

// SmallReadBuffer makes a client's connection hold at most n bytes the
// client has not read, so that a client that stops reading holds up the
// server's writes, as a TCP connection's window does. The in-memory
// network's buffers are otherwise unbounded.
func SmallReadBuffer(n int) func(netConn) netConn {
	return func(c netConn) netConn {
		if b, ok := c.(interface{ SetReadBufferSize(int) }); ok {
			b.SetReadBufferSize(n)
		}
		return c
	}
}

// Crowd puts n boats with no connection in the world, each at a position
// at, and returns their IDs.
func (s *Server) Crowd(t testing.TB, n int, at func(i int) physics.State) []uint64 {
	t.Helper()
	dev := s.World.Bus().Commands.Developer()
	replies := make([]chan bus.Reply, n)
	for i := range n {
		replies[i] = make(chan bus.Reply, 1)
		var a bus.Account
		a[0], a[1], a[14], a[15] = 0xcc, 0xcc, byte(i>>8), byte(i)
		for dev.TrySend(bus.Command{Op: bus.Join, Account: a, Reply: replies[i]}) != nil {
			time.Sleep(time.Second / 30)
		}
	}
	boats := make([]uint64, n)
	for i, r := range replies {
		rep := <-r
		if rep.Result != bus.Joined {
			t.Fatalf("a crowd's boat: %+v", rep)
		}
		boats[i] = rep.Boat
		s.Place(rep.Boat, at(i))
	}
	return boats
}

// Place puts a boat at a state, at the next tick.
func (s *Server) Place(boat uint64, st physics.State) {
	dev := s.World.Bus().Commands.Developer()
	for dev.TrySend(bus.Command{Op: bus.Place, Boat: boat, State: st}) != nil {
		time.Sleep(time.Second / 30)
	}
}

// ErrNoWelcome is a connection that ended before its Welcome.
var ErrNoWelcome = errors.New("edgetest: the connection ended before its Welcome")
