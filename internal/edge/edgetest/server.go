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
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
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
	Limits   edge.Limits
	// Kinds are the world's boats, prepared; the catalog's if nil.
	Kinds []physics.Prepared
	// Record, if not nil, is told of each frame too, on the ticking
	// goroutine.
	Record sim.Recorder
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

	cancel  context.CancelFunc
	done    sync.WaitGroup
	stopped bool
}

// CatalogKinds is the catalog's boats, prepared.
func CatalogKinds(t testing.TB) []physics.Prepared {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	ks := make([]physics.Prepared, len(cat.Boats))
	for i := range cat.Boats {
		p := catalog.PhysicsParams(&cat.Boats[i])
		physics.Prepare(&p, &ks[i])
	}
	return ks
}

// NewServer starts a server: in a synctest bubble, it ticks on the
// bubble's clock. Stop stops it.
func NewServer(t testing.TB, cfg Config) *Server {
	t.Helper()
	if cfg.Capacity == 0 {
		cfg.Capacity = 16
	}
	if cfg.Kinds == nil {
		cfg.Kinds = CatalogKinds(t)
	}
	log := slog.New(slog.DiscardHandler)
	w, err := sim.New(sim.Config{Capacity: cfg.Capacity, Kinds: cfg.Kinds, Workers: 1,
		Tick: loop.TickAt(time.Now(), Epoch), Grace: cfg.Grace})
	if err != nil {
		t.Fatal(err)
	}
	m := obs.NewMetrics("test", catalog.Version)
	s := &Server{World: w, Metrics: m, Sessions: NewSessions(), Kinds: cfg.Kinds}
	s.Loop = loop.New(loop.Config{World: w, Epoch: Epoch, Log: log, Metrics: m})
	s.Edge = edge.New(edge.Config{
		Bus: w.Bus(), World: WorldID, Clock: s.Loop,
		Protocol: protocol.Version, Catalog: catalog.Version, Layout: physics.LayoutVersion,
		Origin: PlayOrigin, Log: log, Metrics: m, Fail: api.WriteError, Limits: cfg.Limits,
	})
	if cfg.Record != nil {
		w.Record(s.Edge, cfg.Record)
	} else {
		w.Record(s.Edge)
	}
	s.HTTP = httptest.NewTestServer(t, api.Handler(api.Config{
		Version:  api.Version{Build: "test", Catalog: catalog.Version},
		Log:      log,
		Metrics:  m,
		Sessions: auth.NewCache(s.Sessions, auth.CacheConfig{Log: log}),
		Game:     s.Edge,
	}))
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.done.Add(2)
	go func() { defer s.done.Done(); s.Loop.Run(ctx) }()
	go func() { defer s.done.Done(); s.Edge.Run(ctx) }()
	t.Cleanup(s.Stop)
	return s
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

// Add makes an account of kind with a session, and returns the session's
// cookie's value.
func (s *Sessions) Add(name string, kind store.Kind) (token string, id store.AccountID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next++
	id = store.AccountID{0x01, 0x99, 0xc2, 0xa4, 0x5f, 0x7e, 0x7c, 0x3a, 0x9d, 0x0e, 0, 0, 0, 0, 0, s.next}
	token, hash := auth.NewToken()
	s.by[hash] = store.Session{Account: store.Account{ID: id, Kind: kind, Name: name}}
	return token, id
}

// Guest makes a guest, and returns its session's cookie's value.
func (s *Server) Guest(name string) (token string, id store.AccountID) {
	return s.Sessions.Add(name, store.Human)
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

// ErrNoWelcome is a connection that ended before its Welcome.
var ErrNoWelcome = errors.New("edgetest: the connection ended before its Welcome")
