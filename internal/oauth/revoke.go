// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"errors"
	"mime"
	"net/http"

	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// revoke answers POST /oauth/revoke (RFC 7009): a refresh token ends its
// grant, and so does a connection token; an access token ends itself.
// Anything else, or nothing, is answered 200 all the same (2.2), so the
// endpoint tells nobody which tokens exist.
func (s *Server) revoke(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/x-www-form-urlencoded" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "The request's body is a form (application/x-www-form-urlencoded).")
		return
	}
	if err := r.ParseForm(); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "The request's form could not be read.")
		return
	}
	if r.PostForm.Has("client_secret") || r.PostForm.Has("client_assertion") {
		writeOAuthError(w, http.StatusUnauthorized, "invalid_client", wordsSecret)
		return
	}
	done := func() {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
	}
	_, hash, ok := ParseToken(r.PostForm.Get("token"))
	if !ok {
		done()
		return
	}
	rev, err := s.cfg.Store.RevokeToken(r.Context(), hash, r.PostForm.Get("client_id"))
	switch {
	case errors.Is(err, store.ErrNotFound):
	case err != nil:
		s.cfg.Log.Warn("revoking a token", "request_id", obs.RequestID(r.Context()), "err", err)
		writeOAuthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "Keel Over the Edge cannot answer just now: try again.")
		return
	case rev.WholeGrant:
		s.cfg.Grants.ForgetGrants(rev.Grant)
		s.cfg.Log.Info("an app revoked its grant", "request_id", obs.RequestID(r.Context()), "grant", store.AccountID(rev.Grant).String())
	default:
		s.cfg.Grants.ForgetToken(hash)
	}
	done()
}
