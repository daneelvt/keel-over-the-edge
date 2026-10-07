// SPDX-License-Identifier: AGPL-3.0-only

// Package api serves the game's HTTP routes.
package api

import (
	"encoding/json"
	"net/http"
)

// Version identifies what a server runs. The client compares Catalog with
// its own catalog version.
type Version struct {
	Build   string `json:"build"`
	Catalog string `json:"catalog"`
}

// Handler returns the routes of the game's HTTP server.
func Handler(v Version) http.Handler {
	body, err := json.Marshal(v)
	if err != nil {
		panic(err) // Version always marshals.
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/version", func(w http.ResponseWriter, _ *http.Request) {
		h := w.Header()
		h.Set("Content-Type", "application/json")
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(body)
	})
	return mux
}
