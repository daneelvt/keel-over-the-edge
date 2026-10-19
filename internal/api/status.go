// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
)

// The status: GET /api/status, what the website shows of the game: the
// sailors at sea and waiting for a boat, the world and when it ends. The
// same for everyone and published once a second, so it needs no session
// and is kept 30 s by the edge's cache. The website, on its own origin,
// may read it (CORS, without credentials); no other origin's page may.

// Status is the game as the website shows it.
type Status struct {
	AtSea  int `json:"atSea"`
	Queued int `json:"queued"`
	World  int `json:"world"`
	// EndsAt is when the world ends, RFC 3339 in UTC; "" for no end known.
	EndsAt  string `json:"endsAt,omitempty"`
	Closing bool   `json:"closing"`
}

// statusRoute is the status's route.
const statusRoute = "GET /api/status"

// statusKeep is how long a cache may keep the status.
const statusKeep = "public, max-age=30"

// statusHandler serves the status that now gives, 503 before there is one;
// website, if not "", is the origin whose pages may read it.
func statusHandler(now func() *Status, website string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		// The same for every request, so the edge's cache, which keeps one
		// copy whatever the Origin, never keeps one without it.
		if website != "" {
			h.Set("Access-Control-Allow-Origin", website)
		}
		st := now()
		if st == nil {
			h.Set("Cache-Control", "no-store")
			writeError(w, http.StatusServiceUnavailable, "starting")
			return
		}
		body, err := json.Marshal(st)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal")
			return
		}
		h.Set("Content-Type", "application/json")
		h.Set("Cache-Control", statusKeep)
		_, _ = w.Write(body)
	})
}
