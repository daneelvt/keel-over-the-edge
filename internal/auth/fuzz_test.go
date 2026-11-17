// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// FuzzRecoveryCode: whatever a player types as a recovery code is read
// without a panic; what is read as a code is 128 bits, its hash theirs,
// and the code written out from them reads back to the same hash.
func FuzzRecoveryCode(f *testing.F) {
	code, _ := NewRecoveryCode()
	for _, s := range []string{
		code, strings.ReplaceAll(code, "-", ""), strings.ToLower(code), " " + strings.ReplaceAll(code, "-", " ") + "\n",
		"", "7KQ2", strings.Repeat("Z", 25), strings.Repeat("Z", 27), strings.Repeat("U", 26),
		strings.Repeat("0", 25) + "1", "7KQ2-M9XD-0F3H-RB6C-Z1WN-5TPE-4!", "iIlLoO", "ǅ",
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, typed string) {
		hash, ok := HashRecoveryCode(typed)
		if !ok {
			if hash != [32]byte{} {
				t.Fatal("a code refused has a hash")
			}
			return
		}
		var plain strings.Builder
		for _, r := range strings.ToUpper(typed) {
			if !strings.ContainsRune(" -\t\n\r", r) {
				plain.WriteRune(r)
			}
		}
		read := strings.NewReplacer("I", "1", "L", "1", "O", "0").Replace(plain.String())
		raw, err := crockford.DecodeString(read)
		if err != nil || len(raw) != recoveryBytes || sha256.Sum256(raw) != hash {
			t.Fatalf("%q read as a code, but not as its bytes", typed)
		}
		if again, ok := HashRecoveryCode(crockford.EncodeToString(raw)); !ok || again != hash {
			t.Fatalf("%q written out again reads otherwise", typed)
		}
	})
}

// FuzzSessionCookie: whatever Cookie header a request carries, the
// session's step reads it without a panic, and asks for a session only
// for a token of 32 bytes, by its hash.
func FuzzSessionCookie(f *testing.F) {
	tok, _ := NewToken()
	for _, s := range []string{
		CookieName + "=" + tok,
		CookieName + "=" + tok + "; " + CookieName + "=x",
		"a=b; " + CookieName + `="` + tok + `"`,
		CookieName + "=" + tok[:42], CookieName + "=" + tok + "A", CookieName + "=" + tok[:42] + "=",
		CookieName + "=" + base64.StdEncoding.EncodeToString(make([]byte, 32)),
		CookieName + "=", "", ";;;", "__Host-keel-create=" + tok,
	} {
		f.Add(s)
	}
	sessions := &fakeSessions{}
	c := NewCache(sessions, CacheConfig{})
	step := Session(c, slog.New(slog.DiscardHandler), func(w http.ResponseWriter, status int, _ string) { w.WriteHeader(status) })
	f.Fuzz(func(t *testing.T, header string) {
		r := httptest.NewRequest(http.MethodGet, "/api/me", nil)
		r.Header.Set("Cookie", header)
		var cookie string
		if ck, err := r.Cookie(CookieName); err == nil {
			cookie = ck.Value
		}
		_, valid := HashToken(cookie)
		before, _ := sessions.counts()
		w := httptest.NewRecorder()
		reached := false
		step(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			reached = true
			if _, ok := SessionFromContext(r.Context()); ok {
				t.Fatalf("%q signed in", header)
			}
		})).ServeHTTP(w, r)
		after, _ := sessions.counts()
		if !reached || (after != before && !valid) {
			t.Fatalf("%q: reached %v, looked up %d times, a token %v", header, reached, after-before, valid)
		}
		if valid {
			raw, err := base64.RawURLEncoding.DecodeString(cookie)
			if err != nil || len(raw) != tokenBytes || base64.RawURLEncoding.EncodeToString(raw) != cookie {
				t.Fatalf("%q read as a token", cookie)
			}
		}
	})
}
