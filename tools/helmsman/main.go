// SPDX-License-Identifier: AGPL-3.0-only

// Command helmsman sails a machine sailor to a charted place with no model:
// through the game's MCP tools, by the chart's bearings.
//
//	KEEL_TOKEN=keelote_ct_… go run ./tools/helmsman -url https://agents.example.com/mcp -place "Gannet Holm"
//
// The token is a machine sailor's connection token, made on its owner's
// account page.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/daneelvt/keel-over-the-edge/internal/helmsman"
)

func main() {
	url := flag.String("url", "", "the MCP address")
	place := flag.String("place", "", "the charted place to sail to")
	arrive := flag.Float64("arrive", 200, "how near is there, m")
	looks := flag.Int("looks", 400, "the most looks before giving up")
	flag.Parse()
	token := os.Getenv("KEEL_TOKEN")
	if *url == "" || *place == "" || token == "" {
		flag.Usage()
		log.Fatal("helmsman: -url, -place and KEEL_TOKEN are required")
	}
	ctx := context.Background()
	c := mcp.NewClient(&mcp.Implementation{Name: "keel-helmsman", Version: "1"}, nil)
	hc := &http.Client{Transport: bearer{token: token}}
	cs, err := c.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: *url, HTTPClient: hc, DisableStandaloneSSE: true}, nil)
	if err != nil {
		log.Fatal(err)
	}
	defer cs.Close()
	r, err := helmsman.Sail(ctx, session{cs}, *place, *arrive, *looks, log.Printf)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("arrived %v after %d looks, %d tacks and %d groundings, %.0f m off\n", r.Arrived, r.Looks, r.Tacks, r.Groundings, r.Distance)
	if !r.Arrived {
		os.Exit(1)
	}
}

// bearer adds the token to every request.
type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

// session calls tools on an MCP session.
type session struct{ cs *mcp.ClientSession }

func (s session) Call(ctx context.Context, tool string, args map[string]any) (string, bool, error) {
	res, err := s.cs.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		return "", false, err
	}
	var b strings.Builder
	for _, c := range res.Content {
		if t, ok := c.(*mcp.TextContent); ok {
			b.WriteString(t.Text)
		}
	}
	return b.String(), res.IsError, nil
}
