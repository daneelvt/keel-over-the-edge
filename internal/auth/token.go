// SPDX-License-Identifier: AGPL-3.0-only

// Package auth knows who a request is from: the session token in its
// cookie, the account the token names, and the cache that saves asking the
// database each time.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"time"
)

// CookieName is the session cookie's. The __Host- prefix makes browsers
// accept it only when Secure, for the path / and without a Domain, so it
// stays on the host that set it and no sibling subdomain can set or read it
// (RFC 6265bis, section 4.1.3.2).
const CookieName = "__Host-keel-session"

// CookieMaxAge is the cookie's lifetime, the most browsers allow (RFC
// 6265bis caps it at 400 days). It is set again as the session is used, so
// a player who comes back never loses it.
const CookieMaxAge = 400 * 24 * time.Hour

// tokenBytes is a token's length before encoding: 256 random bits.
const tokenBytes = 32

// tokenLen is a token's length in unpadded base64url.
var tokenLen = base64.RawURLEncoding.EncodedLen(tokenBytes)

// NewToken draws a session token and returns it, as the cookie carries it,
// and its hash, as the database keeps it. A token this random needs no slow
// hash: the hash only keeps the database from holding the tokens
// themselves.
func NewToken() (string, [32]byte) {
	raw := make([]byte, tokenBytes)
	_, _ = rand.Read(raw) // never fails (crypto/rand)
	return base64.RawURLEncoding.EncodeToString(raw), sha256.Sum256(raw)
}

// HashToken is the hash of a token as a cookie carries it, or false when it
// is not one.
func HashToken(token string) ([32]byte, bool) {
	if len(token) != tokenLen {
		return [32]byte{}, false
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if err != nil || len(raw) != tokenBytes {
		return [32]byte{}, false
	}
	return sha256.Sum256(raw), true
}

// SessionCookie is the cookie that carries token: Secure and HttpOnly, so
// it travels only over HTTPS (or to a loopback address, which browsers
// treat as secure) and no script reads it; SameSite=Lax, so other sites'
// requests do not carry it, links to the game aside.
func SessionCookie(token string) *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(CookieMaxAge / time.Second),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}
}
