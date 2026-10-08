// SPDX-License-Identifier: AGPL-3.0-only

// Package api serves the game's HTTP routes.
package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Version identifies what a server runs. The client compares Catalog with
// its own catalog version.
type Version struct {
	Build   string `json:"build"`
	Catalog string `json:"catalog"`
}

// Guests makes guests: the store.
type Guests interface {
	CreateGuest(ctx context.Context, g store.Guest) (store.AccountID, error)
}

// The limits on an ordinary request.
const (
	// ReadTimeout is how long a request may take to arrive, its body
	// included, and WriteTimeout how long its response may take to go out.
	ReadTimeout  = 10 * time.Second
	WriteTimeout = 30 * time.Second
	// BodyLimit is the largest body a request may have.
	BodyLimit = 16 << 10
)

// Config is what the game's routes need.
type Config struct {
	Version  Version
	Log      *slog.Logger
	Metrics  *obs.Metrics
	Guests   Guests
	Sessions *auth.Cache
	// Looks are the catalog's sailors a guest may choose, by id.
	Looks []string
	// ReadTimeout and WriteTimeout, if not zero, replace the constants, for
	// tests.
	ReadTimeout, WriteTimeout time.Duration
}

// longLived are the routes whose connections stay open, which set deadlines
// of their own: none yet.
var longLived = map[string]bool{}

// Handler returns the game's HTTP server: its routes behind the middleware
// every request passes, in order:
//
//  1. the request ID and the access log, which learns the route and the
//     account from the steps below
//  2. the client's address (not yet: players reach the server directly)
//  3. read and write deadlines, except on long-lived routes
//  4. a limit on the body's size
//  5. cross-origin protection: a browser's unsafe request from another
//     origin is refused
//  6. the session: the account the cookie names, if any
//  7. limits on how often a client may ask (not yet)
func Handler(cfg Config) http.Handler {
	if cfg.ReadTimeout == 0 {
		cfg.ReadTimeout = ReadTimeout
	}
	if cfg.WriteTimeout == 0 {
		cfg.WriteTimeout = WriteTimeout
	}
	a := &api{cfg: cfg, looks: map[string]bool{}}
	for _, l := range cfg.Looks {
		a.looks[l] = true
	}
	for _, r := range refusals {
		cfg.Metrics.GuestsRefused.WithLabelValues(r)
	}

	mux := http.NewServeMux()
	mux.Handle("GET /api/version", versionHandler(cfg.Version))
	mux.HandleFunc("POST /guest", a.guest)
	mux.Handle("GET /api/me", auth.Required(writeError, http.HandlerFunc(a.me)))

	cop := http.NewCrossOriginProtection()
	cop.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		cfg.Metrics.CrossOriginRefused.Inc()
		writeError(w, http.StatusForbidden, "cross-origin")
	}))

	var h http.Handler = mux
	h = auth.Session(cfg.Sessions, cfg.Log, writeError)(h)
	h = cop.Handler(h)
	h = bodyLimit(BodyLimit, h)
	h = deadlines(mux, cfg.ReadTimeout, cfg.WriteTimeout, h)
	h = route(mux, h)
	return obs.AccessLog(cfg.Log, h)
}

// refusals are the reasons a guest's name is refused, as the metrics label
// them.
var refusals = []string{
	string(moderation.Short), string(moderation.Long), string(moderation.Characters),
	string(moderation.Scripts), string(moderation.Words), "taken",
}

type api struct {
	cfg   Config
	looks map[string]bool
}

func versionHandler(v Version) http.Handler {
	body, err := json.Marshal(v)
	if err != nil {
		panic(err) // Version always marshals.
	}
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		h := w.Header()
		h.Set("Content-Type", "application/json")
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(body)
	})
}

// route tells the access log the route a request will match, before any
// step can refuse it.
func route(mux *http.ServeMux, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pattern := mux.Handler(r)
		obs.SetRoute(r.Context(), pattern)
		next.ServeHTTP(w, r)
	})
}

// deadlines bounds how long a request may take to arrive and its response
// to go out, so a slow client cannot hold a connection. The server's own
// timeouts cannot do it: they would cut long-lived connections too.
func deadlines(mux *http.ServeMux, read, write time.Duration, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := mux.Handler(r); !longLived[pattern] {
			rc := http.NewResponseController(w)
			now := time.Now()
			// A writer that reaches no connection, as a test's recorder,
			// goes unbounded.
			_ = rc.SetReadDeadline(now.Add(read))
			_ = rc.SetWriteDeadline(now.Add(write))
		}
		next.ServeHTTP(w, r)
	})
}

// bodyLimit refuses to read more than limit bytes of a body.
func bodyLimit(limit int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		next.ServeHTTP(w, r)
	})
}
