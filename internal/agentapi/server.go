// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/modelcontextprotocol/go-sdk/oauthex"

	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
)

// The MCP server, on the official Go SDK: stateless, each request on its
// own, so a restart loses nothing an app holds. Its one tool, handbook,
// tells an agent which machine sailor it sails as; the sea's tools come
// when machine sailors may sail.

// MaxBody is the most an MCP request's body may be.
const MaxBody = 64 << 10

// The limits on a request, as the game's listener has them.
const (
	ReadTimeout  = 10 * time.Second
	WriteTimeout = 30 * time.Second
)

// instructions are the server's instructions to the agent.
const instructions = "Keel Over the Edge is a sailing game in one shared world. You sail one machine sailor in it, " +
	"for the player who connected you: call handbook to learn which. The sea opens to machine sailors with the next update of the game."

type handbookIn struct {
	Topic string `json:"topic,omitempty" jsonschema:"What to read about. Until the sea opens to machine sailors, every topic has the same answer."`
}

// Handbook is the handbook's answer for a machine sailor.
func Handbook(name, owner string) string {
	whose := "a machine sailor"
	if owner != "" {
		whose = owner + "'s machine sailor"
	}
	return fmt.Sprintf("You sail as %s, %s, in Keel Over the Edge. The sea opens to machine sailors with the next update of the game.", name, whose)
}

func handbook(_ context.Context, req *mcp.CallToolRequest, _ handbookIn) (*mcp.CallToolResult, any, error) {
	a, ok := acceptedOf(req.Extra.TokenInfo)
	if !ok {
		return nil, nil, fmt.Errorf("no machine sailor signed in")
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: Handbook(a.Name, a.OwnerName)}}}, nil, nil
}

// NewServer is the MCP server, its tools added.
func NewServer(build string) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "keel-over-the-edge", Title: "Keel Over the Edge", Version: build},
		&mcp.ServerOptions{Instructions: instructions})
	closed := false
	mcp.AddTool(s, &mcp.Tool{
		Name:  "handbook",
		Title: "The handbook",
		Description: "Which machine sailor you sail as in Keel Over the Edge, and whose, and what you can do at sea. " +
			"Call it first.",
		Annotations: &mcp.ToolAnnotations{Title: "The handbook", ReadOnlyHint: true, IdempotentHint: true, OpenWorldHint: &closed},
	}, handbook)
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
	server := NewServer(cfg.Build)
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
	return []string{resource.EscapedPath(), metadataPath(resource), "/.well-known/oauth-protected-resource"}
}

func routeOf(mux *http.ServeMux, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pattern := mux.Handler(r)
		obs.SetRoute(r.Context(), pattern)
		next.ServeHTTP(w, r)
	})
}

func deadlines(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		now := time.Now()
		_ = rc.SetReadDeadline(now.Add(ReadTimeout))
		_ = rc.SetWriteDeadline(now.Add(WriteTimeout))
		next.ServeHTTP(w, r)
	})
}
