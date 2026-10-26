// SPDX-License-Identifier: AGPL-3.0-only

// Package agentapi serves the AI agents' listener: the MCP address, behind
// a door that lets in only the game's own tokens, and the resource's
// metadata, which tells an app where to sign in.
package agentapi

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"

	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The door at the MCP address. Every request passes it, in order:
//
//  1. a preflight is answered, for apps that run in a browser: any origin,
//     no credentials (the token is a header, never a cookie);
//  2. the Host must be the MCP address's own: a site whose name is
//     re-pointed at the game (DNS rebinding) sends its own name, so the
//     check the MCP SDK makes of a loopback peer's Host is made here
//     instead, against the address, whoever the peer (a local proxy sends
//     from loopback with the page's Host, which the SDK's would refuse);
//  3. an Origin, if sent, must be https or this computer's (MCP's
//     transports, 2026-07-28: servers validate the Origin);
//  4. the bearer token must be one the game issued for this address, an
//     access token or a connection token, checked by its shape before any
//     lookup, then found, its grant unrevoked and within the lifetime,
//     its machine sailor there.
//
// A refusal is a 401 whose WWW-Authenticate carries invalid_token and the
// words for the player (RFC 6750, 3.1), the resource's metadata and the
// scope (RFC 9728, 5.1); its body says the same in plain text. What the
// door accepted reaches the SDK's own bearer middleware, which hands it to
// the tools as the request's token info.

// Config is what the agents' listener needs.
type Config struct {
	// Resource is the MCP address; Issuer the authorization server's.
	Resource string
	Issuer   string
	Grants   *oauth.Grants
	// Used, if not nil, is told of a grant whose token was accepted, off
	// the request: Usage records it.
	Used func(grant [16]byte)
	// Build names the MCP server's version.
	Build   string
	Log     *slog.Logger
	Metrics *obs.Metrics
}

type acceptedKey struct{}

// metadataPath is the resource's metadata's path for an MCP address's:
// the well-known suffix inserted before its path (RFC 9728, 3.1).
func metadataPath(resource *url.URL) string {
	return "/.well-known/oauth-protected-resource" + resource.EscapedPath()
}

type door struct {
	cfg      Config
	host     string
	metadata string
	next     http.Handler
}

// challenge is the WWW-Authenticate a refusal carries.
func (d *door) challenge(w http.ResponseWriter, code, words string) {
	params := []string{}
	if code != "" {
		params = append(params, `error="`+code+`"`, `error_description="`+quote(words)+`"`)
	}
	params = append(params, `resource_metadata="`+d.metadata+`"`, `scope="`+oauth.Scope+`"`)
	w.Header().Set("WWW-Authenticate", "Bearer "+strings.Join(params, ", "))
}

// quote makes words fit a quoted-string: no quotation marks, backslashes
// or controls.
func quote(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '"' || r == '\\' || r < 0x20 || r == 0x7f || r > 0x7e {
			return -1
		}
		return r
	}, s)
}

func (d *door) counted(result string) { d.cfg.Metrics.DoorRequests.WithLabelValues(result).Inc() }

func (d *door) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Protocol-Version")
	if r.Method == http.MethodOptions {
		h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version, Last-Event-ID")
		h.Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !sameHost(r.Host, d.host) {
		d.counted("host")
		http.Error(w, "This is not Keel Over the Edge's MCP address.", http.StatusForbidden)
		return
	}
	if o := r.Header.Get("Origin"); o != "" && !allowedOrigin(o) {
		d.counted("origin")
		http.Error(w, "Requests from this origin are not accepted.", http.StatusForbidden)
		return
	}
	fields := strings.Fields(r.Header.Get("Authorization"))
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
		d.counted("missing")
		d.challenge(w, "", "")
		http.Error(w, "Sign in to Keel Over the Edge: connect your AI app, or send a connection token.", http.StatusUnauthorized)
		return
	}
	start := time.Now()
	a, warm, err := d.cfg.Grants.Check(r.Context(), fields[1])
	cache := "cold"
	if warm {
		cache = "warm"
	}
	d.cfg.Metrics.DoorDuration.WithLabelValues(cache).Observe(time.Since(start).Seconds())
	if refused, ok := errors.AsType[*oauth.Refused](err); ok {
		d.counted(refused.Result)
		d.challenge(w, "invalid_token", refused.Words)
		http.Error(w, refused.Words, http.StatusUnauthorized)
		return
	}
	if err != nil {
		d.cfg.Log.Warn("checking a token", "request_id", obs.RequestID(r.Context()), "err", err)
		http.Error(w, "Keel Over the Edge cannot answer just now: try again in a moment.", http.StatusServiceUnavailable)
		return
	}
	d.counted("accepted")
	obs.SetAccount(r.Context(), a.Account.String())
	if d.cfg.Used != nil {
		d.cfg.Used(a.Grant)
	}
	d.next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), acceptedKey{}, a)))
}

// sameHost compares a request's Host with the MCP address's, the default
// port written or not.
func sameHost(got, want string) bool {
	trim := func(h string) string { return strings.TrimSuffix(strings.ToLower(h), ":443") }
	return got != "" && trim(got) == trim(want)
}

// allowedOrigin is an Origin the MCP address accepts: any https page, or
// one on this computer.
func allowedOrigin(o string) bool {
	u, err := url.Parse(o)
	if err != nil || u.Host == "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return true
	case "http":
		host := u.Hostname()
		if strings.EqualFold(host, "localhost") {
			return true
		}
		ip := net.ParseIP(host)
		return ip != nil && ip.IsLoopback()
	}
	return false
}

// verifier hands the SDK's bearer middleware what the door accepted.
func verifier(ctx context.Context, _ string, _ *http.Request) (*auth.TokenInfo, error) {
	a, ok := ctx.Value(acceptedKey{}).(*oauth.Accepted)
	if !ok {
		return nil, auth.ErrInvalidToken
	}
	return &auth.TokenInfo{
		Scopes: []string{oauth.Scope}, Expiration: a.Until, UserID: a.Account.String(),
		Extra: map[string]any{extraAccepted: a},
	}, nil
}

// extraAccepted is the token info's key for what the door accepted.
const extraAccepted = "keel.accepted"

// acceptedOf is what the door accepted, from a tool's token info.
func acceptedOf(ti *auth.TokenInfo) (*oauth.Accepted, bool) {
	if ti == nil {
		return nil, false
	}
	a, ok := ti.Extra[extraAccepted].(*oauth.Accepted)
	return a, ok
}

// Usage writes when each grant was last used, off the requests: at most
// once an hour each, by one writer.
type Usage struct {
	store interface {
		GrantUsed(ctx context.Context, grant [16]byte, at time.Time) error
	}
	log  *slog.Logger
	ch   chan [16]byte
	last map[[16]byte]time.Time
}

// UsageEvery is how often a grant's last use is written while it is used.
const UsageEvery = time.Hour

// NewUsage makes the writer of grants' last uses.
func NewUsage(st interface {
	GrantUsed(ctx context.Context, grant [16]byte, at time.Time) error
}, log *slog.Logger) *Usage {
	return &Usage{store: st, log: log, ch: make(chan [16]byte, 256), last: map[[16]byte]time.Time{}}
}

// Used records a grant used now; when the writer is behind, the use is
// dropped, to be written at the next.
func (u *Usage) Used(grant [16]byte) {
	select {
	case u.ch <- grant:
	default:
	}
}

// Run writes the uses until ctx ends.
func (u *Usage) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case g := <-u.ch:
			now := time.Now()
			if now.Sub(u.last[g]) < UsageEvery {
				continue
			}
			u.last[g] = now
			if len(u.last) > 100_000 {
				u.last = map[[16]byte]time.Time{g: now}
			}
			wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			if err := u.store.GrantUsed(wctx, g, now); err != nil {
				u.log.Warn("recording a grant used", "grant", store.AccountID(g).String(), "err", err)
				delete(u.last, g)
			}
			cancel()
		}
	}
}
