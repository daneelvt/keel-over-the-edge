// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"hash/crc32"
	"math/big"
	"strings"
)

// The tokens the game issues to AI apps, each a string a secret scanner can
// find by its shape: keelote_, the kind, an underscore, 43 base62
// characters of 256 random bits, and 6 of the CRC-32 of all before them, so
// that a token mistyped or made up is told from one issued before anything
// is looked up (the shape GitHub's tokens have). The database keeps only
// the SHA-256 of the whole string.
const (
	tokenPrefix = "keelote_"
	// The kinds: an access token, a refresh token and a connection token.
	KindAccess     = "at"
	KindRefresh    = "rt"
	KindConnection = "ct"
	// KindClient is a client ID the game issued at registration: 128 bits,
	// 22 characters, no checksum. It is no secret.
	KindClient = "cl"
)

const (
	randomBytes = 32
	randomChars = 43
	checkChars  = 6
	clientBytes = 16
	clientChars = 22
)

// TokenLen is a token's length: keelote_xx_ and 49 characters.
const TokenLen = len(tokenPrefix) + 3 + randomChars + checkChars

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// base62Of writes b as a number in base 62, n characters, zeros first.
func base62Of(b []byte, n int) string {
	v := new(big.Int).SetBytes(b)
	out := make([]byte, n)
	sixtyTwo := big.NewInt(62)
	mod := new(big.Int)
	for i := n - 1; i >= 0; i-- {
		v.DivMod(v, sixtyTwo, mod)
		out[i] = base62[mod.Int64()]
	}
	return string(out)
}

func checksum(s string) string {
	c := crc32.ChecksumIEEE([]byte(s))
	return base62Of([]byte{byte(c >> 24), byte(c >> 16), byte(c >> 8), byte(c)}, checkChars)
}

// NewToken draws a token of a kind, and returns it with the SHA-256 the
// database keeps.
func NewToken(kind string) (string, [32]byte) {
	raw := make([]byte, randomBytes)
	_, _ = rand.Read(raw) // never fails (crypto/rand)
	body := tokenPrefix + kind + "_" + base62Of(raw, randomChars)
	t := body + checksum(body)
	return t, sha256.Sum256([]byte(t))
}

// ParseToken reads a token's kind and hash: false for anything not shaped
// as one the game issues, its checksum included.
func ParseToken(t string) (kind string, hash [32]byte, ok bool) {
	if len(t) != TokenLen || !strings.HasPrefix(t, tokenPrefix) || t[len(tokenPrefix)+2] != '_' {
		return "", hash, false
	}
	kind = t[len(tokenPrefix) : len(tokenPrefix)+2]
	switch kind {
	case KindAccess, KindRefresh, KindConnection:
	default:
		return "", hash, false
	}
	rest := t[len(tokenPrefix)+3:]
	for i := 0; i < len(rest); i++ {
		if strings.IndexByte(base62, rest[i]) < 0 {
			return "", hash, false
		}
	}
	body := t[:len(t)-checkChars]
	if checksum(body) != t[len(t)-checkChars:] {
		return "", hash, false
	}
	return kind, sha256.Sum256([]byte(t)), true
}

// NewClientID draws a client ID for a client that registers itself.
func NewClientID() string {
	raw := make([]byte, clientBytes)
	_, _ = rand.Read(raw)
	return tokenPrefix + KindClient + "_" + base62Of(raw, clientChars)
}

// Registered reports whether a client ID is one the game issued.
func Registered(clientID string) bool {
	if len(clientID) != len(tokenPrefix)+3+clientChars || !strings.HasPrefix(clientID, tokenPrefix+KindClient+"_") {
		return false
	}
	for _, c := range []byte(clientID[len(tokenPrefix)+3:]) {
		if strings.IndexByte(base62, c) < 0 {
			return false
		}
	}
	return true
}

// codeBytes is an authorization code's randomness.
const codeBytes = 32

// newCode draws an authorization code: base64url, unpadded, and its hash.
func newCode() (string, [32]byte) {
	raw := make([]byte, codeBytes)
	_, _ = rand.Read(raw)
	c := base64.RawURLEncoding.EncodeToString(raw)
	return c, sha256.Sum256([]byte(c))
}

// codeHash is the hash of a code as presented, or false when it cannot be
// one.
func codeHash(c string) ([32]byte, bool) {
	if len(c) != base64.RawURLEncoding.EncodedLen(codeBytes) {
		return [32]byte{}, false
	}
	if _, err := base64.RawURLEncoding.Strict().DecodeString(c); err != nil {
		return [32]byte{}, false
	}
	return sha256.Sum256([]byte(c)), true
}
