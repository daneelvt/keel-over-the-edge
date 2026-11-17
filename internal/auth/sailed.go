// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"net/http"
	"time"
)

// SailedCookieName is the cookie that says this browser has made a sailor,
// or signed one in: the start screen then offers to sign in first. A
// security cookie, read by keel alone and used for nothing else.
const SailedCookieName = "__Host-keel-sailed"

// SailedCookie marks the browser as one that has had a sailor: set with
// every new session and again whenever the session cookie is, so it lasts
// as long (400 days from the last visit). Set by the server and HttpOnly,
// so no browser shortens it as it does cookies a script writes.
func SailedCookie() *http.Cookie {
	return &http.Cookie{
		Name:     SailedCookieName,
		Value:    "1",
		Path:     "/",
		MaxAge:   int(CookieMaxAge / time.Second),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}
}

// ClearedSailedCookie ends the mark: the player's account deleted, or a
// passkey no account has any more. Signing out keeps it.
func ClearedSailedCookie() *http.Cookie {
	c := SailedCookie()
	c.Value, c.MaxAge = "", -1
	return c
}

// Sailed reports whether the request's browser has had a sailor.
func Sailed(r *http.Request) bool {
	c, err := r.Cookie(SailedCookieName)
	return err == nil && c.Value == "1"
}
