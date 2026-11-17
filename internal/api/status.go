// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"net/http"
)

// The status: GET /api/status, what the website shows of the game and its
// map (internal/status). The website's Worker alone may read it: it is
// behind a Cloudflare Access application of its own, which lets through
// only the Worker's service token, and here every request must carry the
// token Access signs what it lets through with (Access), or it is
// refused. Without Access set up the route is not served at all. Its
// answer is never kept by a cache: the protected address must not sit in
// the zone's cache for anyone to read.

// statusRoute is the status's route.
const statusRoute = "GET /api/status"

// statusKeep is how a cache may keep the status: not at all.
const statusKeep = "private, no-store"

// StatusSource is the status as JSON and gzipped; nil before there is one.
type StatusSource func(ctx context.Context) (body, gzipped []byte, err error)

// Access checks that a request came through the Access application in
// front of the route: internal/access.
type Access interface {
	Check(r *http.Request) error
}

// accessRoutes are the routes behind Access: they read no session, and
// TestOpenRoutes finds them registered behind it.
var accessRoutes = map[string]bool{statusRoute: true}

// accessed is h behind Access: a request without a token Access signed
// for the route is refused, 403.
func accessed(a Access, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.Check(r) != nil {
			w.Header().Set("Cache-Control", "no-store")
			writeError(w, http.StatusForbidden, "access")
			return
		}
		h.ServeHTTP(w, r)
	})
}

// statusHandler serves the status that now gives, gzipped to a caller
// that takes it; 503 before there is one.
func statusHandler(now StatusSource) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Cache-Control", statusKeep)
		body, gz, err := now(r.Context())
		switch {
		case err != nil:
			writeError(w, http.StatusInternalServerError, "internal")
			return
		case body == nil:
			writeError(w, http.StatusServiceUnavailable, "starting")
			return
		}
		h.Set("Content-Type", "application/json")
		h.Set("Vary", "Accept-Encoding")
		if gz != nil && acceptsGzip(r) {
			h.Set("Content-Encoding", "gzip")
			body = gz
		}
		_, _ = w.Write(body)
	})
}
