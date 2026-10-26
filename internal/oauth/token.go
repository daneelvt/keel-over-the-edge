// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"mime"
	"net/http"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The token endpoint (RFC 6749, 3.2, with OAuth 2.1's changes): a code
// exchanged once, with its PKCE verifier, for an access token and a
// refresh token; a refresh token rotated for a new pair (RFC 9700, 4.14.2:
// public clients' refresh tokens are rotated), the one before it accepted
// once more within RefreshGrace, and any other reuse ending the grant.
// Nothing here waits on another site: it answers well within the apps'
// timeouts.

// tokenAnswer is a successful token response (RFC 6749, 5.1).
type tokenAnswer struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
}

// token answers POST /oauth/token.
func (s *Server) token(w http.ResponseWriter, r *http.Request) {
	cors(w)
	m := s.cfg.Metrics
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/x-www-form-urlencoded" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "The request's body is a form (application/x-www-form-urlencoded).")
		return
	}
	if err := r.ParseForm(); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "The request's form could not be read.")
		return
	}
	f := r.PostForm
	for name, v := range f {
		if len(v) > 1 {
			writeOAuthError(w, http.StatusBadRequest, "invalid_request", "The parameter "+name+" was sent more than once.")
			return
		}
	}
	grant := f.Get("grant_type")
	refuse := func(status int, code, words string) {
		if grant == "authorization_code" || grant == "refresh_token" {
			m.OAuthTokens.WithLabelValues(grant, "refused").Inc()
		}
		writeOAuthError(w, status, code, words)
	}
	if f.Has("client_secret") || f.Has("client_assertion") || r.Header.Get("Authorization") != "" {
		refuse(http.StatusUnauthorized, "invalid_client", wordsSecret)
		return
	}
	clientID := f.Get("client_id")
	if clientID == "" {
		refuse(http.StatusUnauthorized, "invalid_client", "The client_id is required.")
		return
	}
	if !s.resource(f["resource"]) {
		refuse(http.StatusBadRequest, "invalid_target", wordsResource)
		return
	}
	switch grant {
	case "authorization_code":
		s.exchange(w, r, clientID, refuse)
	case "refresh_token":
		s.refresh(w, r, clientID, refuse)
	default:
		writeOAuthError(w, http.StatusBadRequest, "unsupported_grant_type", "The grant types are authorization_code and refresh_token.")
	}
}

// pkce reports whether a code verifier is the one a challenge was made
// from with S256 (RFC 7636, 4.6).
func pkce(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 || !unreserved(verifier) {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	return subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(challenge)) == 1
}

// issue draws a grant's pair of tokens and keeps it with keep.
func (s *Server) issue(keep func(store.Pair) error, ends time.Time) (tokenAnswer, error) {
	now := s.cfg.Now()
	expires := now.Add(AccessFor)
	if ends.Before(expires) {
		expires = ends
	}
	type drawn struct {
		access, refresh string
		pair            store.Pair
	}
	d, err := auth.Issue(s.cfg.Log, "token pair", func() drawn {
		at, ah := NewToken(KindAccess)
		rt, rh := NewToken(KindRefresh)
		return drawn{at, rt, store.Pair{Access: ah, AccessExpires: expires, Refresh: rh}}
	}, func(d drawn) error { return keep(d.pair) })
	if err != nil {
		return tokenAnswer{}, err
	}
	return tokenAnswer{
		AccessToken: d.access, TokenType: "Bearer", ExpiresIn: int64(expires.Sub(now).Seconds()),
		RefreshToken: d.refresh, Scope: Scope,
	}, nil
}

func (s *Server) exchange(w http.ResponseWriter, r *http.Request, clientID string, refuse func(int, string, string)) {
	f := r.PostForm
	hash, ok := codeHash(f.Get("code"))
	if !ok {
		refuse(http.StatusBadRequest, "invalid_grant", wordsCode)
		return
	}
	c, err := s.cfg.Store.UseCode(r.Context(), hash)
	switch {
	case errors.Is(err, store.ErrCodeUsed):
		// A code used twice may have been stolen: its grant ends, and the
		// tokens first issued for it with it (RFC 6749, 4.1.2).
		s.cfg.Grants.ForgetGrants(c.Grant)
		s.cfg.Log.Warn("a code used twice: its grant revoked", "request_id", obs.RequestID(r.Context()), "grant", store.AccountID(c.Grant).String())
		refuse(http.StatusBadRequest, "invalid_grant", wordsCodeTwice)
		return
	case errors.Is(err, store.ErrNotFound):
		refuse(http.StatusBadRequest, "invalid_grant", wordsCode)
		return
	case err != nil:
		s.cfg.Log.Warn("exchanging a code", "request_id", obs.RequestID(r.Context()), "err", err)
		writeOAuthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "Keel Over the Edge cannot answer just now: try again.")
		return
	}
	now := s.cfg.Now()
	switch {
	case !now.Before(c.Expires):
		refuse(http.StatusBadRequest, "invalid_grant", wordsCode)
		return
	case c.ClientID != clientID:
		refuse(http.StatusBadRequest, "invalid_grant", wordsClient)
		return
	case f.Get("redirect_uri") != c.RedirectURI:
		refuse(http.StatusBadRequest, "invalid_grant", wordsRedirect)
		return
	case !pkce(f.Get("code_verifier"), c.CodeChallenge):
		refuse(http.StatusBadRequest, "invalid_grant", wordsVerifier)
		return
	}
	ends := c.Approved.Add(s.cfg.Lifetime.Get())
	if c.Revoked || !now.Before(ends) {
		refuse(http.StatusBadRequest, "invalid_grant", EndedWords(false, "", ends, s.cfg.Zone))
		return
	}
	answer, err := s.issue(func(p store.Pair) error { return s.cfg.Store.IssuePair(r.Context(), c.Grant, p) }, ends)
	if err != nil {
		s.cfg.Log.Warn("issuing tokens", "request_id", obs.RequestID(r.Context()), "err", err)
		writeOAuthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "Keel Over the Edge cannot answer just now: try again.")
		return
	}
	if Registered(clientID) {
		_ = s.cfg.Store.ClientUsed(r.Context(), clientID)
	}
	s.cfg.Metrics.OAuthTokens.WithLabelValues("authorization_code", "issued").Inc()
	obs.SetAccount(r.Context(), c.Account.String())
	writeJSON(w, http.StatusOK, answer)
}

func (s *Server) refresh(w http.ResponseWriter, r *http.Request, clientID string, refuse func(int, string, string)) {
	kind, hash, ok := ParseToken(r.PostForm.Get("refresh_token"))
	if !ok || kind != KindRefresh {
		refuse(http.StatusBadRequest, "invalid_grant", wordsInvalid)
		return
	}
	var done store.Refreshed
	answer, err := s.issue(func(p store.Pair) error {
		var err error
		done, err = s.cfg.Store.Refresh(r.Context(), store.Refresh{
			Old: hash, ClientID: clientID, New: p, Now: s.cfg.Now(), Lifetime: s.cfg.Lifetime.Get(), Grace: RefreshGrace,
		})
		return err
	}, s.cfg.Now().Add(AccessFor))
	if ended, ok := errors.AsType[*store.GrantEnded](err); ok {
		refuse(http.StatusBadRequest, "invalid_grant", EndedWords(false, ended.Why, ended.At, s.cfg.Zone))
		return
	}
	switch {
	case errors.Is(err, store.ErrRefreshReused):
		s.cfg.Metrics.OAuthReuse.WithLabelValues("revoked").Inc()
		s.cfg.Grants.ForgetGrants(done.Grant)
		s.cfg.Log.Warn("a refresh token used again: its grant revoked", "request_id", obs.RequestID(r.Context()),
			"grant", store.AccountID(done.Grant).String(), "client", clientID)
		refuse(http.StatusBadRequest, "invalid_grant", EndedWords(false, store.RevokedReuse, s.cfg.Now(), s.cfg.Zone))
		return
	case errors.Is(err, store.ErrNotFound):
		refuse(http.StatusBadRequest, "invalid_grant", wordsInvalid)
		return
	case errors.Is(err, store.ErrWrongClient):
		refuse(http.StatusBadRequest, "invalid_grant", wordsClient)
		return
	case err != nil:
		s.cfg.Log.Warn("refreshing tokens", "request_id", obs.RequestID(r.Context()), "err", err)
		writeOAuthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "Keel Over the Edge cannot answer just now: try again.")
		return
	}
	// The access token issued may not outlast its grant.
	if now := s.cfg.Now(); done.GrantEnds.Before(now.Add(AccessFor)) {
		answer.ExpiresIn = int64(done.GrantEnds.Sub(now).Seconds())
	}
	if done.Grace {
		s.cfg.Metrics.OAuthReuse.WithLabelValues("grace").Inc()
	}
	if Registered(clientID) {
		_ = s.cfg.Store.ClientUsed(r.Context(), clientID)
	}
	s.cfg.Metrics.OAuthTokens.WithLabelValues("refresh_token", "issued").Inc()
	obs.SetAccount(r.Context(), done.Account.String())
	writeJSON(w, http.StatusOK, answer)
}
