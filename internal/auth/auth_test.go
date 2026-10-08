// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

func TestTokens(t *testing.T) {
	const n = 1_000_000
	hashes := make([][32]byte, n)
	for i := range n {
		tok, hash := NewToken()
		if len(tok) != 43 {
			t.Fatalf("token %q is %d characters", tok, len(tok))
		}
		raw, err := base64.RawURLEncoding.Strict().DecodeString(tok)
		if err != nil || sha256.Sum256(raw) != hash {
			t.Fatalf("token %q: %v, or its hash is not SHA-256 of its bytes", tok, err)
		}
		if got, ok := HashToken(tok); !ok || got != hash {
			t.Fatalf("HashToken(%q) = %x, %v", tok, got, ok)
		}
		hashes[i] = hash
	}
	slices.SortFunc(hashes, func(a, b [32]byte) int { return bytes.Compare(a[:], b[:]) })
	for i := 1; i < n; i++ {
		if hashes[i] == hashes[i-1] {
			t.Fatal("a token drawn twice")
		}
	}
}

func TestHashTokenRefusesMalformed(t *testing.T) {
	tok, _ := NewToken()
	for _, bad := range []string{
		"", "x", tok[:42], tok + "A", tok[:42] + "=", tok[:42] + "+", tok[:42] + "/", tok[:42] + " ",
		strings.Repeat("A", 42) + "B", // 43 characters whose last has bits beyond the 32 bytes
		base64.StdEncoding.EncodeToString(make([]byte, 32)),
	} {
		if _, ok := HashToken(bad); ok {
			t.Errorf("HashToken(%q) accepted", bad)
		}
	}
}

func TestSessionCookie(t *testing.T) {
	c := SessionCookie("abc")
	want := "__Host-keel-session=abc; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax"
	if got := c.String(); got != want {
		t.Fatalf("cookie %q\nwant   %q", got, want)
	}
	if c.Domain != "" {
		t.Fatal("a __Host- cookie has no Domain")
	}
}

// fakeSessions is a store of sessions in memory that counts its calls.
type fakeSessions struct {
	mu       sync.Mutex
	sessions map[[32]byte]store.Session
	lookups  int
	touched  []time.Time
	fail     error
}

func (f *fakeSessions) Session(_ context.Context, hash [32]byte) (store.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lookups++
	if f.fail != nil {
		return store.Session{}, f.fail
	}
	s, ok := f.sessions[hash]
	if !ok {
		return store.Session{}, store.ErrNotFound
	}
	return s, nil
}

func (f *fakeSessions) Touch(_ context.Context, hash [32]byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.sessions[hash]
	s.LastSeen = time.Now()
	f.sessions[hash] = s
	f.touched = append(f.touched, time.Now())
	return nil
}

func (f *fakeSessions) add(name string) [32]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sessions == nil {
		f.sessions = map[[32]byte]store.Session{}
	}
	hash := sha256.Sum256([]byte(name))
	f.sessions[hash] = store.Session{Account: store.Account{ID: store.AccountID(hash[:16]), Kind: store.Human, Name: name}, LastSeen: time.Now()}
	return hash
}

func (f *fakeSessions) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lookups, len(f.touched)
}

func TestCacheExpires(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := &fakeSessions{}
		hash := f.add("Ann")
		lookups := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "l"}, []string{"result"})
		c := NewCache(f, CacheConfig{Lookups: lookups})
		ctx := context.Background()
		for range 10 {
			res, err := c.Resolve(ctx, hash)
			if err != nil || res.Account.Name != "Ann" {
				t.Fatalf("%+v, %v", res, err)
			}
			time.Sleep(2 * time.Second)
		}
		// 20 s in: one lookup; at 30 s, another.
		if n, _ := f.counts(); n != 1 {
			t.Fatalf("%d lookups within 30 s", n)
		}
		time.Sleep(10 * time.Second)
		if _, err := c.Resolve(ctx, hash); err != nil {
			t.Fatal(err)
		}
		if n, _ := f.counts(); n != 2 {
			t.Fatalf("%d lookups after 30 s", n)
		}
		if hit, miss := testutil.ToFloat64(lookups.WithLabelValues("hit")), testutil.ToFloat64(lookups.WithLabelValues("miss")); hit != 9 || miss != 2 {
			t.Fatalf("hits %v, misses %v", hit, miss)
		}
	})
}

func TestCacheTouchesHourlyAndRenewsDaily(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := &fakeSessions{}
		hash := f.add("Ann")
		c := NewCache(f, CacheConfig{})
		ctx := context.Background()
		var renewed []time.Duration
		start := time.Now()
		// A request a minute for two days.
		for range 2 * 24 * 60 {
			res, err := c.Resolve(ctx, hash)
			if err != nil {
				t.Fatal(err)
			}
			if res.RenewCookie {
				renewed = append(renewed, time.Since(start))
			}
			time.Sleep(time.Minute)
		}
		_, touches := f.counts()
		f.mu.Lock()
		touched := slices.Clone(f.touched)
		f.mu.Unlock()
		if touches != 47 && touches != 48 {
			t.Fatalf("last seen written %d times in 48 hours", touches)
		}
		for i := 1; i < len(touched); i++ {
			if gap := touched[i].Sub(touched[i-1]); gap < time.Hour {
				t.Fatalf("written again after %v", gap)
			}
		}
		// The first request after the entry is made sets the cookie, then
		// once a day.
		if !slices.Equal(renewed, []time.Duration{0, 24 * time.Hour}) {
			t.Fatalf("cookie set at %v", renewed)
		}
	})
}

func TestCacheAddedSessionNeedsNothing(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := &fakeSessions{}
		hash := f.add("Ann")
		c := NewCache(f, CacheConfig{})
		c.Add(hash, store.Account{Name: "Ann"})
		res, err := c.Resolve(context.Background(), hash)
		if lookups, touches := f.counts(); err != nil || res.RenewCookie || lookups != 0 || touches != 0 {
			t.Fatalf("%+v, %v; %d lookups, %d touches", res, err, lookups, touches)
		}
	})
}

func TestCacheBounded(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := &fakeSessions{}
		c := NewCache(f, CacheConfig{MaxEntries: 3})
		ctx := context.Background()
		var hashes [][32]byte
		for _, name := range []string{"a", "b", "c", "d"} {
			h := f.add(name)
			hashes = append(hashes, h)
			if _, err := c.Resolve(ctx, h); err != nil {
				t.Fatal(err)
			}
			time.Sleep(time.Second)
		}
		if c.Len() != 3 {
			t.Fatalf("%d entries", c.Len())
		}
		before, _ := f.counts()
		// The newest three are cached; the oldest was dropped.
		for _, h := range hashes[1:] {
			if _, err := c.Resolve(ctx, h); err != nil {
				t.Fatal(err)
			}
		}
		if n, _ := f.counts(); n != before {
			t.Fatal("a newer entry was dropped")
		}
		if _, err := c.Resolve(ctx, hashes[0]); err != nil {
			t.Fatal(err)
		}
		if n, _ := f.counts(); n != before+1 {
			t.Fatal("the oldest entry was kept")
		}
	})
}

func TestCacheKeepsOnlyHits(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := &fakeSessions{}
		lookups := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "l"}, []string{"result"})
		c := NewCache(f, CacheConfig{Lookups: lookups})
		for i := range 100 {
			if _, err := c.Resolve(context.Background(), sha256.Sum256([]byte{byte(i)})); !errors.Is(err, store.ErrNotFound) {
				t.Fatal(err)
			}
		}
		if c.Len() != 0 || testutil.ToFloat64(lookups.WithLabelValues("unknown")) != 100 {
			t.Fatalf("%d entries after unknown tokens", c.Len())
		}
	})
}

func TestForget(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := &fakeSessions{}
		hash := f.add("Ann")
		c := NewCache(f, CacheConfig{})
		ctx := context.Background()
		if _, err := c.Resolve(ctx, hash); err != nil {
			t.Fatal(err)
		}
		// The session ends: forgotten at once, not 30 s later.
		f.mu.Lock()
		delete(f.sessions, hash)
		f.mu.Unlock()
		c.Forget(hash)
		if _, err := c.Resolve(ctx, hash); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("after Forget: %v", err)
		}
	})
}

func failJSON(w http.ResponseWriter, status int, code string) {
	w.WriteHeader(status)
	_, _ = w.Write([]byte(code))
}

func TestMiddleware(t *testing.T) {
	f := &fakeSessions{}
	tok, hash := NewToken()
	f.add("Ann")
	f.sessions[hash] = store.Session{Account: store.Account{Name: "Ann", Kind: store.Human}, LastSeen: time.Now()}
	c := NewCache(f, CacheConfig{})
	h := Session(c, slog.New(slog.DiscardHandler), failJSON)(Required(failJSON, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a, _ := FromContext(r.Context())
		_, _ = w.Write([]byte(a.Name))
	})))
	serve := func(cookie string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/api/me", nil)
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: CookieName, Value: cookie})
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	unknown, _ := NewToken()
	for name, cookie := range map[string]string{"none": "", "malformed": "not-a-token", "unknown": unknown} {
		if w := serve(cookie); w.Code != 401 {
			t.Errorf("%s: %d", name, w.Code)
		}
	}
	w := serve(tok)
	if w.Code != 200 || w.Body.String() != "Ann" || !strings.HasPrefix(w.Header().Get("Set-Cookie"), CookieName+"="+tok) {
		t.Fatalf("%d %q %q", w.Code, w.Body.String(), w.Header().Get("Set-Cookie"))
	}
	if w := serve(tok); w.Header().Get("Set-Cookie") != "" {
		t.Fatal("the cookie set again at once")
	}
	c.Forget(hash)
	f.fail = errors.New("the database is down")
	if w := serve(tok); w.Code != 503 {
		t.Fatalf("with the database down: %d", w.Code)
	}
}
