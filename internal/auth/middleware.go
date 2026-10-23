// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// ErrorWriter answers a request with an error: a status and a code.
type ErrorWriter func(w http.ResponseWriter, status int, code string)

type sessionKey struct{}

// Current is a request's session: the account it names, and the hash of
// its token.
type Current struct {
	store.Session
	Hash [32]byte
}

// Confirmed reports whether a passkey was confirmed on the session lately
// enough to allow what cannot be undone.
func (c Current) Confirmed(now time.Time) bool { return now.Before(c.ConfirmedUntil) }

// FromContext is the account a request's session names, if it has one
// that is not held to adding a passkey.
func FromContext(ctx context.Context) (store.Account, bool) {
	c, ok := ctx.Value(sessionKey{}).(Current)
	if !ok || c.Held {
		return store.Account{}, false
	}
	return c.Account, true
}

// SessionFromContext is a request's session, if it has one, held or not.
func SessionFromContext(ctx context.Context) (Current, bool) {
	c, ok := ctx.Value(sessionKey{}).(Current)
	return c, ok
}

// Session reads the session cookie of each request, resolves it through
// the cache and puts the account in the request's context, and the account
// ID in the access log. A request without a cookie, or with one that names
// no session, goes on without an account. When the database cannot be
// asked, the request is answered 503: going on as nobody would send a
// returning player to make a new sailor.
func Session(c *Cache, log *slog.Logger, fail ErrorWriter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, err := r.Cookie(CookieName)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			hash, ok := HashToken(cookie.Value)
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			res, err := c.Resolve(r.Context(), hash)
			if errors.Is(err, store.ErrNotFound) {
				next.ServeHTTP(w, r)
				return
			}
			if err != nil {
				log.Warn("looking up a session", "request_id", obs.RequestID(r.Context()), "err", err)
				fail(w, http.StatusServiceUnavailable, "unavailable")
				return
			}
			if res.RenewCookie {
				http.SetCookie(w, SessionCookie(cookie.Value))
			}
			obs.SetAccount(r.Context(), res.Account.ID.String())
			ctx := context.WithValue(r.Context(), sessionKey{}, Current{Session: res.Session, Hash: hash})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// Required answers 401 to a request without a session and 403
// "add-passkey" to one whose session is held to adding a passkey, and
// passes the rest to h.
func Required(fail ErrorWriter, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, ok := SessionFromContext(r.Context())
		switch {
		case !ok:
			fail(w, http.StatusUnauthorized, "session")
		case c.Held:
			fail(w, http.StatusForbidden, "add-passkey")
		default:
			h.ServeHTTP(w, r)
		}
	})
}

// Signed answers 401 to a request without a session, and passes the rest
// to h, sessions held to adding a passkey among them.
func Signed(fail ErrorWriter, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := SessionFromContext(r.Context()); !ok {
			fail(w, http.StatusUnauthorized, "session")
			return
		}
		h.ServeHTTP(w, r)
	})
}
