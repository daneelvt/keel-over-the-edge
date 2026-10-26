// SPDX-License-Identifier: AGPL-3.0-only

// Package oauth is the game's OAuth authorization server, which AI apps
// sign in with to sail a player's machine sailor at the MCP address, as the
// Model Context Protocol's authorization (revision 2026-07-28) asks: OAuth
// 2.1 (draft -16) with PKCE, the server's metadata (RFC 8414), client ID
// metadata documents (draft -02) or dynamic registration (RFC 7591),
// resource indicators (RFC 8707), the issuer in every authorization
// response (RFC 9207), refresh tokens rotated (RFC 9700, 4.14) and
// revocation (RFC 7009).
//
// An app is approved on the approval page by the player's passkey, for one
// of their machine sailors, which the approval may make. Every app is a
// public client. The approval is a grant, which ends at the lifetime the
// owner sets, when the player revokes it, or with the machine sailor.
package oauth

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Store is what the authorization server keeps: the store.
type Store interface {
	Machines
	TokenStore
	Client(ctx context.Context, id string) (store.Client, error)
	ClientUsed(ctx context.Context, id string) error
	RegisterClient(ctx context.Context, c store.Client) error
	SaveRequest(ctx context.Context, r store.AuthRequest) error
	Request(ctx context.Context, hash [32]byte) (store.AuthRequest, error)
	ConfirmRequest(ctx context.Context, hash [32]byte, account store.AccountID, passkey [16]byte, until time.Time) error
	TakeRequest(ctx context.Context, hash [32]byte) (store.AuthRequest, error)
	AccountByUserHandle(ctx context.Context, handle []byte) (store.Holder, error)
	Profile(ctx context.Context, id store.AccountID) (store.Profile, error)
	AccountHeld(ctx context.Context, id store.AccountID) (bool, error)
	PasskeyUsed(ctx context.Context, id store.AccountID, p store.Passkey) error
	MachineCap(ctx context.Context, owner store.AccountID) (int, error)
	NameFree(ctx context.Context, key string) (bool, error)
	Approve(ctx context.Context, a store.Approval) (store.Approved, error)
	UseCode(ctx context.Context, hash [32]byte) (store.CodeGrant, error)
	IssuePair(ctx context.Context, grant [16]byte, p store.Pair) error
	Refresh(ctx context.Context, r store.Refresh) (store.Refreshed, error)
	RevokeToken(ctx context.Context, hash [32]byte, clientID string) (store.Revoked, error)
	SaveCeremony(ctx context.Context, c store.Ceremony) error
	TakeCeremony(ctx context.Context, hash [32]byte, kind string) (store.Ceremony, error)
}

// Config is what the authorization server needs.
type Config struct {
	// Issuer is the server's issuer identifier, the play origin; Resource
	// the MCP address its tokens are for.
	Issuer   string
	Resource string
	Store    Store
	Passkeys *auth.Passkeys
	Fetcher  *Fetcher
	Lifetime *Lifetime
	// Grants is the door's check, told at once of every grant ended here.
	Grants *Grants
	// Looks are the catalog's choices of a machine sailor's look, and Boat
	// the kind of boat each sailor brings to the fleet.
	Looks MachineLooks
	Boat  string
	// Build is the build, which alone reads the ceremonies it began.
	Build string
	// Zone is the time zone the refusals' dates are written in.
	Zone    *time.Location
	Log     *slog.Logger
	Metrics *obs.Metrics
	// Page, if not nil, serves the approval page's HTML. Without it, as in
	// development, the browser is sent on to /approve.html, which another
	// server serves.
	Page func(w http.ResponseWriter, r *http.Request)
	// AtSea, if not nil, reports whether a machine sailor is at sea.
	AtSea func(store.AccountID) bool
	// Created, if not nil, is told of a machine sailor made on the approval
	// page.
	Created func(id store.AccountID)
	// Now is the clock, time.Now unless set.
	Now func() time.Time
	// RegistrationsPerHour replaces RegistrationsPerHour when not zero, for
	// tests.
	RegistrationsPerHour int
}

// The authorization server's lifetimes.
const (
	// RequestFor is how long an authorization request waits on the
	// approval page.
	RequestFor = 10 * time.Minute
	// ConfirmFor is how long a passkey confirmed on the page lets it
	// approve.
	ConfirmFor = 5 * time.Minute
	// CodeFor is how long an authorization code may be exchanged.
	CodeFor = 60 * time.Second
	// AccessFor is how long an access token lasts, or less when its grant
	// ends sooner.
	AccessFor = time.Hour
	// RefreshGrace is how long after a refresh token is used it may be
	// used once more, for an app that did not get the answer.
	RefreshGrace = 30 * time.Second
	// MaxAppsPerMachine is how many apps may be approved for one machine
	// sailor at once.
	MaxAppsPerMachine = 10
)

// Server is the authorization server.
type Server struct {
	cfg     Config
	clients *clients
	reg     *registrations
}

// New makes the authorization server.
func New(cfg Config) *Server {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Zone == nil {
		cfg.Zone = time.UTC
	}
	m := cfg.Metrics
	s := &Server{cfg: cfg}
	s.clients = &clients{
		store: cfg.Store, fetcher: cfg.Fetcher, now: cfg.Now,
		counted: func(r string) { m.ClientFetches.WithLabelValues(r).Inc() },
		took:    func(d time.Duration) { m.ClientFetchTime.Observe(d.Seconds()) },
	}
	s.reg = newRegistrations(cfg.RegistrationsPerHour)
	return s
}

// The routes. Those an app calls from its own servers, or a browser-based
// app from its own origin, read no cookie: they answer any origin (CORS
// without credentials) and pass the game's cross-origin protection. The
// approval page's keep every protection.
const (
	routeMetadata     = "GET /.well-known/oauth-authorization-server"
	routeAuthorize    = "GET /oauth/authorize"
	routeRequest      = "GET /oauth/request"
	routeApproveBegin = "POST /oauth/approve/begin"
	routeApproveEnd   = "POST /oauth/approve/finish"
	routeApprove      = "POST /oauth/approve"
	routeDeny         = "POST /oauth/deny"
	routeToken        = "POST /oauth/token"
	routeRevoke       = "POST /oauth/revoke"
	routeRegister     = "POST /oauth/register"
)

// CrossOrigin are the routes any origin may call, and their preflights.
var CrossOrigin = []string{routeToken, routeRevoke, routeRegister}

// Routes are every route the server answers; none reads the game's
// session.
var Routes = []string{
	routeMetadata, routeAuthorize, routeRequest, routeApproveBegin, routeApproveEnd, routeApprove, routeDeny,
	routeToken, routeRevoke, routeRegister,
	"OPTIONS /.well-known/oauth-authorization-server", "OPTIONS /oauth/token", "OPTIONS /oauth/revoke", "OPTIONS /oauth/register",
}

// Register adds the server's routes to mux.
func (s *Server) Register(mux *http.ServeMux) {
	mux.HandleFunc(routeMetadata, s.metadata)
	mux.HandleFunc(routeAuthorize, s.authorize)
	mux.HandleFunc(routeRequest, s.request)
	mux.HandleFunc(routeApproveBegin, s.beginApprove)
	mux.HandleFunc(routeApproveEnd, s.finishApprove)
	mux.HandleFunc(routeApprove, s.approve)
	mux.HandleFunc(routeDeny, s.deny)
	mux.HandleFunc(routeToken, s.token)
	mux.HandleFunc(routeRevoke, s.revoke)
	mux.HandleFunc(routeRegister, s.register)
	for _, p := range []string{"/.well-known/oauth-authorization-server", "/oauth/token", "/oauth/revoke", "/oauth/register"} {
		mux.HandleFunc("OPTIONS "+p, preflight)
	}
}

// cors lets any origin read an answer, without credentials: the routes
// that carry it read no cookie, so a page gains nothing it did not hold.
func cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Expose-Headers", "Retry-After")
}

func preflight(w http.ResponseWriter, _ *http.Request) {
	cors(w)
	h := w.Header()
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Protocol-Version")
	h.Set("Access-Control-Max-Age", "86400")
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		panic(err) // the server's answers always marshal
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
}

// writeError answers the approval page's routes as the game's API does:
// {"error": code}, a code the page puts into words.
func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

// oauthError is an error as RFC 6749 (5.2) writes one.
type oauthError struct {
	Error       string `json:"error"`
	Description string `json:"error_description,omitempty"`
}

func writeOAuthError(w http.ResponseWriter, status int, code, words string) {
	writeJSON(w, status, oauthError{code, words})
}

func (s *Server) unavailable(w http.ResponseWriter, r *http.Request, doing string, err error) {
	s.cfg.Log.Warn(doing, "request_id", obs.RequestID(r.Context()), "err", err)
	writeError(w, http.StatusServiceUnavailable, "unavailable")
}

// resource reads a request's resource indicator (RFC 8707): absent, the
// MCP address, or it with one trailing slash, which some apps send, all
// read as the MCP address; any other is refused.
func (s *Server) resource(values []string) bool {
	switch len(values) {
	case 0:
		return true
	case 1:
		v := values[0]
		return v == s.cfg.Resource || v == s.cfg.Resource+"/"
	}
	return false
}

// single is a parameter given at most once (RFC 6749, 3.1), and whether
// it was.
func single(q url.Values, name string) (string, bool) {
	v := q[name]
	switch len(v) {
	case 0:
		return "", true
	case 1:
		return v[0], true
	}
	return "", false
}

// callback is a redirect URI with an authorization response's parameters
// added to its query, the issuer always among them (RFC 9207).
func (s *Server) callback(redirect string, params url.Values) string {
	params.Set("iss", s.cfg.Issuer)
	u, _ := url.Parse(redirect)
	q := u.Query()
	for k, v := range params {
		q[k] = v
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// unreserved reports whether s is made of RFC 3986's unreserved
// characters, as a code verifier is.
func unreserved(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-._~", c) >= 0) {
			return false
		}
	}
	return true
}
