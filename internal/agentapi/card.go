// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"encoding/json"
	"net/http"
)

// The server card: what an AI app or a directory needs to know of the
// game's MCP server before connecting, at /mcp/server-card (the MCP
// Server Cards extension): its name and version, its one address and how
// it is reached, how to sign in, and its tools.

// serverCard is the card.
type serverCard struct {
	Name        string       `json:"name"`
	Title       string       `json:"title"`
	Version     string       `json:"version"`
	Description string       `json:"description"`
	WebsiteURL  string       `json:"websiteUrl,omitempty"`
	Remotes     []cardRemote `json:"remotes"`
	Auth        cardAuth     `json:"authentication"`
	Tools       []cardTool   `json:"tools"`
}

type cardRemote struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

type cardAuth struct {
	Type                 string   `json:"type"`
	AuthorizationServers []string `json:"authorizationServers"`
	ResourceMetadata     string   `json:"resourceMetadata"`
	Scopes               []string `json:"scopes"`
}

type cardTool struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

// cardHandler serves the server card.
func cardHandler(resource, issuer, metadata, scope, build string) http.Handler {
	c := serverCard{
		Name: "keel-over-the-edge", Title: "Keel Over the Edge", Version: build,
		Description: "A sailing game in one shared world that never pauses: skipper a machine sailor's boat beside human players, chart islands, keep off the falls.",
		WebsiteURL:  issuer,
		Remotes:     []cardRemote{{Type: "streamable-http", URL: resource}},
		Auth:        cardAuth{Type: "oauth2", AuthorizationServers: []string{issuer}, ResourceMetadata: metadata, Scopes: []string{scope}},
	}
	for _, d := range tools() {
		c.Tools = append(c.Tools, cardTool{Name: d.tool.Name, Title: d.tool.Title, Description: d.tool.Description})
	}
	body, _ := json.MarshalIndent(&c, "", "  ")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Type", "application/json")
		h.Set("Cache-Control", "public, max-age=3600")
		h.Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		_, _ = w.Write(body)
	})
}
