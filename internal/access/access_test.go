// SPDX-License-Identifier: AGPL-3.0-only

package access

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// team is a team's key server, as Access serves /cdn-cgi/access/certs:
// the keys it publishes, and how many times they were fetched.
type team struct {
	srv     *httptest.Server
	mu      sync.Mutex
	keys    map[string]*rsa.PrivateKey
	fetches atomic.Int32
}

func newTeam(t *testing.T) *team {
	t.Helper()
	tm := &team{keys: map[string]*rsa.PrivateKey{}}
	tm.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cdn-cgi/access/certs" {
			http.NotFound(w, r)
			return
		}
		tm.fetches.Add(1)
		tm.mu.Lock()
		defer tm.mu.Unlock()
		type jwk struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			Alg string `json:"alg"`
			Use string `json:"use"`
			N   string `json:"n"`
			E   string `json:"e"`
		}
		var set struct {
			Keys []jwk `json:"keys"`
		}
		for kid, k := range tm.keys {
			set.Keys = append(set.Keys, jwk{Kty: "RSA", Kid: kid, Alg: "RS256", Use: "sig",
				N: b64(k.N.Bytes()), E: b64(big.NewInt(int64(k.E)).Bytes())})
		}
		_ = json.NewEncoder(w).Encode(set)
	}))
	t.Cleanup(tm.srv.Close)
	return tm
}

// key makes a key, published under kid or not.
func (tm *team) key(t *testing.T, kid string, publish bool) *rsa.PrivateKey {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if publish {
		tm.mu.Lock()
		tm.keys[kid] = k
		tm.mu.Unlock()
	}
	return k
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// sign makes a token of claims, signed RS256 by k under kid.
func sign(t *testing.T, k *rsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	head, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": kid, "typ": "JWT"})
	body, _ := json.Marshal(claims)
	in := b64(head) + "." + b64(body)
	sum := sha256.Sum256([]byte(in))
	sig, err := rsa.SignPKCS1v15(rand.Reader, k, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return in + "." + b64(sig)
}

const aud = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2"

// TestCheck: a token Access signed for the application passes; a wrong
// audience, a wrong issuer, an expired token, one not yet valid, one
// signed by a key the team does not have, none, a bad signature and a
// token of another algorithm are each refused.
func TestCheck(t *testing.T) {
	tm := newTeam(t)
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	c := New(Config{Issuer: tm.srv.URL, Audience: aud, Client: tm.srv.Client(), Now: func() time.Time { return now }})
	good := tm.key(t, "k1", true)
	stranger := tm.key(t, "k9", false)
	claims := func(change func(map[string]any)) map[string]any {
		m := map[string]any{
			"iss": tm.srv.URL, "aud": []string{aud}, "sub": "", "type": "app",
			"iat": now.Add(-time.Minute).Unix(), "nbf": now.Add(-time.Minute).Unix(), "exp": now.Add(time.Hour).Unix(),
			"common_name": "website.access",
		}
		if change != nil {
			change(m)
		}
		return m
	}
	check := func(token string) error {
		r := httptest.NewRequest("GET", "/api/status", nil)
		if token != "" {
			r.Header.Set(Header, token)
		}
		return c.Check(r)
	}
	if err := check(sign(t, good, "k1", claims(nil))); err != nil {
		t.Fatalf("a good token: %v", err)
	}
	// Tampered: the payload of another token under this one's signature.
	tampered := sign(t, good, "k1", claims(nil))
	other := sign(t, good, "k1", claims(func(m map[string]any) { m["common_name"] = "someone.else" }))
	tampered = tampered[:strings.Index(tampered, ".")] + other[strings.Index(other, "."):strings.LastIndex(other, ".")] + tampered[strings.LastIndex(tampered, "."):]
	refused := map[string]string{
		"a wrong audience":            sign(t, good, "k1", claims(func(m map[string]any) { m["aud"] = []string{"another-application"} })),
		"a wrong issuer":              sign(t, good, "k1", claims(func(m map[string]any) { m["iss"] = "https://other.cloudflareaccess.com" })),
		"expired":                     sign(t, good, "k1", claims(func(m map[string]any) { m["exp"] = now.Add(-time.Second).Unix() })),
		"not yet valid":               sign(t, good, "k1", claims(func(m map[string]any) { m["nbf"] = now.Add(time.Hour).Unix() })),
		"a stranger's key":            sign(t, stranger, "k9", claims(nil)),
		"the team's kid, another key": sign(t, stranger, "k1", claims(nil)),
		"none":                        "",
		"a bad signature":             tampered,
		"not a token":                 "not.a.token",
		"no signature":                b64([]byte(`{"alg":"none","kid":"k1"}`)) + "." + b64([]byte(`{}`)) + ".",
	}
	for why, token := range refused {
		if err := check(token); err == nil {
			t.Errorf("%s: passed", why)
		}
	}
	// HS256 with the public key as its secret, the old confusion.
	head, _ := json.Marshal(map[string]string{"alg": "HS256", "kid": "k1"})
	body, _ := json.Marshal(claims(nil))
	if err := check(b64(head) + "." + b64(body) + "." + b64([]byte("x"))); err == nil {
		t.Error("an HS256 token passed")
	}
}

// TestUnknownKey: a token signed by a key the checker has not seen
// fetches the team's keys again, and passes once the team publishes it;
// one the team does not have is refused after one fetch, and no other
// fetch is made for RefetchEvery, however many such tokens come.
func TestUnknownKey(t *testing.T) {
	tm := newTeam(t)
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	advance := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }
	c := New(Config{Issuer: tm.srv.URL, Audience: aud, Client: tm.srv.Client(), Now: clock})
	claims := func() map[string]any {
		n := clock()
		return map[string]any{"iss": tm.srv.URL, "aud": aud, "iat": n.Unix(), "exp": n.Add(time.Hour).Unix()}
	}
	check := func(token string) error {
		r := httptest.NewRequest("GET", "/api/status", nil)
		r.Header.Set(Header, token)
		return c.Check(r)
	}
	k1 := tm.key(t, "k1", true)
	if err := check(sign(t, k1, "k1", claims())); err != nil || tm.fetches.Load() != 1 {
		t.Fatalf("the first token: %v, %d fetches", err, tm.fetches.Load())
	}
	if err := check(sign(t, k1, "k1", claims())); err != nil || tm.fetches.Load() != 1 {
		t.Fatalf("again: %v, %d fetches", err, tm.fetches.Load())
	}
	// The team rotates its key: the new one is fetched when a token names
	// it.
	advance(time.Minute)
	k2 := tm.key(t, "k2", true)
	if err := check(sign(t, k2, "k2", claims())); err != nil || tm.fetches.Load() != 2 {
		t.Fatalf("the rotated key: %v, %d fetches", err, tm.fetches.Load())
	}
	// A key the team does not have: one fetch, refused, and no more
	// fetches for a while, while the keys held still pass.
	advance(time.Minute)
	forger := tm.key(t, "k3", false)
	for range 20 {
		if err := check(sign(t, forger, "k3", claims())); err == nil {
			t.Fatal("a forged key passed")
		}
	}
	if n := tm.fetches.Load(); n != 3 {
		t.Errorf("%d fetches after 20 forged tokens, want 3", n)
	}
	if err := check(sign(t, k2, "k2", claims())); err != nil {
		t.Errorf("a held key while refetching waits: %v", err)
	}
	advance(RefetchEvery)
	if err := check(sign(t, forger, "k3", claims())); err == nil || tm.fetches.Load() != 4 {
		t.Errorf("after the wait: %v, %d fetches", err, tm.fetches.Load())
	}
}
