// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/modelcontextprotocol/go-sdk/oauthex"

	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
)

// The MCP server, on the official Go SDK: stateless, each request on its
// own, so a restart loses nothing an app holds; every protocol era the SDK
// serves, on the one address. Its twelve tools sail a machine sailor's
// boat (Core).

// MaxBody is the most an MCP request's body may be.
const MaxBody = 64 << 10

// The limits on a request, as the game's listener has them. A waiting
// call sets a write deadline of its own: its wait and deadlineMargin.
const (
	ReadTimeout    = 10 * time.Second
	WriteTimeout   = 30 * time.Second
	deadlineMargin = 15 * time.Second
)

// toolsTTL is how long an app may keep the tool list: it never changes
// but with a release.
const toolsTTL = 24 * time.Hour

// NewServer is the MCP server, its tools answered by core.
func NewServer(build string, core *Core) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "keel-over-the-edge", Title: "Keel Over the Edge", Version: build},
		&mcp.ServerOptions{Instructions: instructions, SetCacheable: func(_ context.Context, req mcp.Request, c *mcp.Cacheable) {
			if _, ok := req.(*mcp.ListToolsRequest); ok {
				c.TTLMs = int(toolsTTL / time.Millisecond)
			}
		}})
	core.addTools(s)
	return s
}

// Handler is the agents' listener's routes: the MCP address, behind its
// door, and the resource's metadata, at its path-inserted address and at
// the root, where some apps look first. Anything else is answered 404.
func Handler(cfg Config) (http.Handler, error) {
	resource, err := url.Parse(cfg.Resource)
	if err != nil {
		return nil, err
	}
	metadataURL := resource.Scheme + "://" + resource.Host + metadataPath(resource)
	core := cfg.Core
	if core == nil {
		core = NewCore(CoreConfig{Log: cfg.Log, Metrics: cfg.Metrics})
	}
	server := NewServer(cfg.Build, core)
	streamable := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{
		Stateless: true, MaxRequestBodyBytes: MaxBody,
		// The door checks the Host against the MCP address itself.
		DisableLocalhostProtection: true,
	})
	bearer := auth.RequireBearerToken(verifier, &auth.RequireBearerTokenOptions{
		ResourceMetadataURL: metadataURL, Scopes: []string{oauth.Scope},
	})
	d := &door{cfg: cfg, host: resource.Host, metadata: metadataURL, next: bearer(streamable)}
	meta := auth.ProtectedResourceMetadataHandler(&oauthex.ProtectedResourceMetadata{
		Resource:               cfg.Resource,
		AuthorizationServers:   []string{cfg.Issuer},
		ScopesSupported:        []string{oauth.Scope},
		BearerMethodsSupported: []string{"header"},
		ResourceName:           "Keel Over the Edge",
	})
	mux := http.NewServeMux()
	mcpPath := resource.EscapedPath()
	mux.Handle(mcpPath, d)
	card := cardHandler(cfg.Resource, cfg.Issuer, metadataURL, oauth.Scope, cfg.Build)
	mux.Handle("GET "+cardPath(resource), card)
	mux.Handle("OPTIONS "+cardPath(resource), card)
	for _, p := range []string{metadataPath(resource), "/.well-known/oauth-protected-resource"} {
		mux.Handle("GET "+p, meta)
		mux.Handle("OPTIONS "+p, meta)
	}
	h := http.Handler(mux)
	h = deadlines(h)
	h = routeOf(mux, h)
	return obs.AccessLog(cfg.Log, h), nil
}

// Paths are the paths the agents' listener answers for an MCP address.
func Paths(resource *url.URL) []string {
	return []string{resource.EscapedPath(), cardPath(resource), metadataPath(resource), "/.well-known/oauth-protected-resource"}
}

// cardPath is the server card's path beside the MCP address's.
func cardPath(resource *url.URL) string {
	return strings.TrimSuffix(resource.EscapedPath(), "/") + "/server-card"
}

func routeOf(mux *http.ServeMux, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pattern := mux.Handler(r)
		obs.SetRoute(r.Context(), pattern)
		next.ServeHTTP(w, r)
	})
}

// deadlines sets each request's read and write deadlines. Past the write
// deadline an answer written is lost, so a call that waits longer moves
// its own on (extendDeadline).
func deadlines(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		now := time.Now()
		_ = rc.SetReadDeadline(now.Add(ReadTimeout))
		_ = rc.SetWriteDeadline(now.Add(WriteTimeout))
		extend := func(d time.Duration) { _ = rc.SetWriteDeadline(time.Now().Add(d)) }
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), deadlineKey{}, extend)))
	})
}

type deadlineKey struct{}

// extendDeadline moves the write deadline of the request ctx belongs to
// to d from now, if it was set by deadlines.
func extendDeadline(ctx context.Context, d time.Duration) {
	if extend, ok := ctx.Value(deadlineKey{}).(func(time.Duration)); ok {
		extend(d)
	}
}
