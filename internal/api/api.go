// SPDX-License-Identifier: AGPL-3.0-only

// Package api serves the game's HTTP routes.
package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Version identifies what a server runs. The client compares Catalog with
// its own catalog version.
type Version struct {
	Build   string `json:"build"`
	Catalog string `json:"catalog"`
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
	Accounts Accounts
	Sessions *auth.Cache
	// Passkeys are the ceremonies with the browser's passkey prompt.
	Passkeys *auth.Passkeys
	// Deletions deletes accounts at their players' word, as the owner's
	// deletions do: its boat leaves the water, its game connection closes,
	// its credits lose its name, and its machine sailors' tokens are
	// refused at once.
	Deletions Deletions
	// Looks are the catalog's sailors a new sailor may choose, by id.
	Looks []string
	// Boat is the kind of boat each sailor brings to its account's fleet,
	// the catalog's.
	Boat string
	// OAuth, if not nil, is the authorization server AI apps sign in with,
	// whose routes this serves; Grants is the MCP address's check, told
	// of every grant ended here. MCP is the MCP address, Lifetime how long
	// a grant lasts and MachineLooks the choices of a machine sailor's
	// look. AtSea, if not nil, reports whether a machine sailor is at sea.
	OAuth        *oauth.Server
	Grants       *oauth.Grants
	MCP          string
	Lifetime     *oauth.Lifetime
	MachineLooks oauth.MachineLooks
	AtSea        func(store.AccountID) bool
	// Machines are the account's machine sailors, their grants and
	// connection tokens: the store.
	Machines Machines
	// Game, if not nil, is the game connection, GET /ws: it checks the
	// session itself, so it can count those it refuses.
	Game http.Handler
	// Page, if not nil, is the game's built page, served at / and
	// /assets/. Without it, as in development, another server serves the
	// page and sends the rest here.
	Page *Page
	// Chunks, if not nil, are the world's chunks, served at their
	// addresses under /w/; Models its islands' models.
	Chunks *Chunks
	Models *Models
	// News, if not nil, is the world's news, served a page of NewsPage
	// items at a time.
	News     NewsSource
	NewsPage int
	// Notices, if not nil, keeps an account's notices switched off, of
	// NoticeKinds, the kinds that may be.
	Notices     Notices
	NoticeKinds []string
	// Watch, if not nil, is the world's watching: the list of sailors to
	// watch, and the setting that lets others watch a human.
	Watch Watching
	// Status, if not nil, is the game's status as last published, served
	// at GET /api/status; Website is the origin whose pages may read it.
	Status  func() *Status
	Website string
	// ReadTimeout and WriteTimeout, if not zero, replace the constants, for
	// tests.
	ReadTimeout, WriteTimeout time.Duration
}

// Deletions are the accounts' deletions: internal/accounts.
type Deletions interface {
	DeleteByPlayer(ctx context.Context, id store.AccountID) error
	DeleteMachineByPlayer(ctx context.Context, owner, id store.AccountID) error
}

var _ Deletions = (*accounts.Accounts)(nil)

// longLived are the routes whose connections stay open, which set deadlines
// of their own: the game connection.
var longLived = map[string]bool{"GET /ws": true}

// Handler returns the game's HTTP server: its routes behind the middleware
// every request passes, in order:
//
//  1. the request ID and the access log, which learns the route and the
//     account from the steps below
//  2. the client's address (not yet: players reach the server directly)
//  3. read and write deadlines, except on long-lived routes
//  4. a limit on the body's size
//  5. cross-origin protection: a browser's unsafe request from another
//     origin is refused, but at the routes AI apps call (their token,
//     revocation and registration), which read no cookie
//  6. the session: the account the cookie names, if any
//  7. limits on how often a client may ask (not yet)
//
// A path with dot segments or repeated slashes is answered 404 before any of
// it.
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
		cfg.Metrics.NamesRefused.WithLabelValues(r)
	}
	for _, k := range ceremonyKinds {
		for _, r := range ceremonyResults {
			cfg.Metrics.Ceremonies.WithLabelValues(k, r)
		}
	}
	cfg.Metrics.SignIns.WithLabelValues("prompt")
	cfg.Metrics.SignIns.WithLabelValues("conditional")

	mux := http.NewServeMux()
	mux.Handle("GET /api/version", versionHandler(cfg.Version))
	required := func(h http.HandlerFunc) http.Handler { return auth.Required(writeError, h) }
	signed := func(h http.HandlerFunc) http.Handler { return auth.Signed(writeError, h) }
	mux.HandleFunc("POST /account/begin", a.beginAccount)
	mux.HandleFunc("POST /account/finish", a.finishAccount)
	mux.HandleFunc("POST /signin/begin", a.beginSignIn)
	mux.HandleFunc("POST /signin/finish", a.finishSignIn)
	mux.HandleFunc("POST /recovery", a.recover)
	mux.Handle("POST /logout", signed(a.logout))
	mux.Handle("GET /api/me", signed(a.me))
	mux.Handle("GET /api/account", required(a.account))
	mux.Handle("POST /api/account/passkeys/begin", signed(a.beginPasskey))
	mux.Handle("POST /api/account/passkeys/finish", signed(a.finishPasskey))
	mux.Handle("POST /api/account/passkeys/remove", required(a.removePasskey))
	mux.Handle("POST /api/account/confirm/begin", required(a.beginConfirm))
	mux.Handle("POST /api/account/confirm/finish", required(a.finishConfirm))
	mux.Handle("POST /api/account/recovery", required(a.newRecoveryCode))
	mux.Handle("POST /api/account/logout-others", required(a.logoutOthers))
	mux.Handle("POST /api/account/delete", required(a.deleteAccount))
	if cfg.Machines != nil {
		mux.Handle("GET /api/machines", required(a.machines))
		mux.Handle("POST /api/machines", required(a.makeMachine))
		mux.Handle("POST /api/machines/delete", required(a.deleteMachine))
		mux.Handle("POST /api/machines/revoke", required(a.revokeApp))
		mux.Handle("POST /api/machines/token", required(a.makeToken))
		mux.Handle("POST /api/machines/token/revoke", required(a.revokeToken))
	}
	if cfg.OAuth != nil {
		cfg.OAuth.Register(mux)
	}
	if cfg.Notices != nil {
		mux.Handle("POST /api/me/notices", required(a.setNotices))
	}
	if cfg.Watch != nil {
		mux.Handle("GET /api/watch", required(a.watchList))
		mux.Handle("POST /api/me/spectators", required(a.setSpectators))
	}
	if cfg.News != nil {
		mux.Handle(newsRoute, newNews(cfg.News, cfg.NewsPage))
	}
	if cfg.Status != nil {
		mux.Handle(statusRoute, statusHandler(cfg.Status, cfg.Website))
	}
	if cfg.Game != nil {
		mux.Handle("GET /ws", cfg.Game)
	}
	if cfg.Page != nil {
		cfg.Page.register(mux)
	}
	if cfg.Chunks != nil {
		mux.Handle(chunkRoute, cfg.Chunks.serve(cfg.Metrics))
	}
	if cfg.Models != nil {
		mux.Handle(modelRoute, cfg.Models.serve(cfg.Metrics))
	}
	mux.HandleFunc(chunksRoute, func(w http.ResponseWriter, _ *http.Request) {
		cfg.Metrics.ChunkRequests.WithLabelValues("refused").Inc()
		w.Header().Set("X-Content-Type-Options", "nosniff")
		writeError(w, http.StatusNotFound, "not-found")
	})
	mux.HandleFunc(robotsRoute, serveRobots)

	cop := http.NewCrossOriginProtection()
	if cfg.OAuth != nil {
		// The routes AI apps call from their own servers, or from a page
		// of their own origin, read no cookie: nothing a page could make
		// them do is the player's.
		for _, p := range oauth.CrossOrigin {
			cop.AddInsecureBypassPattern(p)
		}
	}
	cop.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		cfg.Metrics.CrossOriginRefused.Inc()
		writeError(w, http.StatusForbidden, "cross-origin")
	}))

	open := map[string]bool{}
	for p := range openRoutes {
		open[p] = true
	}
	if cfg.OAuth != nil {
		for _, p := range oauth.Routes {
			open[p] = true
		}
	}
	var h http.Handler = session(mux, open, auth.Session(cfg.Sessions, cfg.Log, writeError))
	h = cop.Handler(h)
	h = bodyLimit(BodyLimit, h)
	h = deadlines(mux, cfg.ReadTimeout, cfg.WriteTimeout, h)
	h = cleanPaths(h)
	h = route(mux, h)
	return obs.AccessLog(cfg.Log, h)
}

// robotsRoute is robots.txt's route.
const robotsRoute = "GET /robots.txt"

// openRoutes are the routes besides the page's that need no session: what
// they serve is the same for everyone who has the address. The
// authorization server's routes need none either: an AI app's sign-in is
// never the game's session.
var openRoutes = map[string]bool{chunkRoute: true, chunksRoute: true, modelRoute: true, robotsRoute: true, newsRoute: true, statusRoute: true}

// session reads the session for every route but the page's and the open
// ones: the page is the same for everyone, and loads even when the database
// cannot be asked; a chunk is cached by the edge for everyone, so its
// answer carries no cookie.
func session(mux *http.ServeMux, open map[string]bool, mw func(http.Handler) http.Handler) http.Handler {
	withSession := mw(mux)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := mux.Handler(r); pageRoutes[pattern] || open[pattern] {
			mux.ServeHTTP(w, r)
			return
		}
		withSession.ServeHTTP(w, r)
	})
}

// refusals are the reasons a new sailor's name is refused, as the metrics
// label them.
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
