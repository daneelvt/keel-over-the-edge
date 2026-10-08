// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"container/list"
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Sessions is where sessions are kept: the store.
type Sessions interface {
	// Session finds a session by its token's hash, or store.ErrNotFound.
	Session(ctx context.Context, hash [32]byte) (store.Session, error)
	// Touch records the session, and its account, seen now.
	Touch(ctx context.Context, hash [32]byte) error
}

// The cache's settings, starting values.
const (
	// CacheFor is how long an account found is used before it is fetched
	// again: how long a change to it can go unseen.
	CacheFor = 30 * time.Second
	// CacheEntries bounds the cache; past it the oldest entry goes.
	CacheEntries = 100_000
	// TouchEvery is how often a session's last-seen time is written while
	// it is used.
	TouchEvery = time.Hour
	// RenewCookieAfter is how long after the cookie was set it is set again.
	RenewCookieAfter = 24 * time.Hour
)

// CacheConfig is a cache's settings; zero values take the constants above.
type CacheConfig struct {
	TTL              time.Duration
	MaxEntries       int
	TouchEvery       time.Duration
	RenewCookieAfter time.Duration
	// Now is the clock, time.Now unless set.
	Now func() time.Time
	// Lookups, if not nil, counts lookups by result: hit, miss or unknown.
	Lookups *prometheus.CounterVec
	Log     *slog.Logger
}

// Cache resolves session tokens to accounts, keeping what it found for a
// while. Only sessions found are kept, so tokens nobody holds cannot fill
// it. It also decides when a session's last-seen time is written and when
// its cookie is set again.
type Cache struct {
	sessions Sessions
	cfg      CacheConfig
	hit      prometheus.Counter
	miss     prometheus.Counter
	unknown  prometheus.Counter

	mu      sync.Mutex
	entries map[[32]byte]*entry
	order   *list.List // of *entry, oldest at the front
}

type entry struct {
	hash    [32]byte
	account store.Account
	fetched time.Time
	// seen is when the session was last recorded seen, as the database has
	// it or as this cache last wrote it.
	seen time.Time
	// cookieSet is when this process last set the cookie: zero since the
	// entry was made, so the cookie is set at least once by each process
	// that serves the session.
	cookieSet time.Time
	elem      *list.Element
}

// NewCache makes a cache in front of sessions.
func NewCache(sessions Sessions, cfg CacheConfig) *Cache {
	if cfg.TTL <= 0 {
		cfg.TTL = CacheFor
	}
	if cfg.MaxEntries <= 0 {
		cfg.MaxEntries = CacheEntries
	}
	if cfg.TouchEvery <= 0 {
		cfg.TouchEvery = TouchEvery
	}
	if cfg.RenewCookieAfter <= 0 {
		cfg.RenewCookieAfter = RenewCookieAfter
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	c := &Cache{sessions: sessions, cfg: cfg, entries: map[[32]byte]*entry{}, order: list.New()}
	if cfg.Lookups != nil {
		c.hit, c.miss, c.unknown = cfg.Lookups.WithLabelValues("hit"), cfg.Lookups.WithLabelValues("miss"), cfg.Lookups.WithLabelValues("unknown")
	}
	return c
}

func count(c prometheus.Counter) {
	if c != nil {
		c.Inc()
	}
}

// Resolved is a session's account, and whether to set its cookie again.
type Resolved struct {
	Account     store.Account
	RenewCookie bool
}

// Resolve finds the account whose session token hashes to hash, from the
// cache when it is fresh and from the store otherwise, or store.ErrNotFound.
func (c *Cache) Resolve(ctx context.Context, hash [32]byte) (Resolved, error) {
	now := c.cfg.Now()
	c.mu.Lock()
	if e := c.entries[hash]; e != nil && now.Sub(e.fetched) < c.cfg.TTL {
		res, touch := c.use(e, now)
		c.mu.Unlock()
		count(c.hit)
		c.touch(ctx, hash, touch)
		return res, nil
	}
	c.mu.Unlock()

	s, err := c.sessions.Session(ctx, hash)
	if errors.Is(err, store.ErrNotFound) {
		count(c.unknown)
		c.Forget(hash)
		return Resolved{}, err
	}
	if err != nil {
		return Resolved{}, err
	}
	count(c.miss)
	c.mu.Lock()
	e := c.entries[hash]
	if e == nil {
		e = &entry{hash: hash}
		c.add(e)
	} else {
		c.order.MoveToBack(e.elem)
	}
	e.account, e.fetched = s.Account, now
	if s.LastSeen.After(e.seen) {
		e.seen = s.LastSeen
	}
	res, touch := c.use(e, now)
	c.mu.Unlock()
	c.touch(ctx, hash, touch)
	return res, nil
}

// use reads an entry for a request, deciding whether to write its last-seen
// time and set its cookie, so that of requests at once only one does.
func (c *Cache) use(e *entry, now time.Time) (Resolved, bool) {
	touch := now.Sub(e.seen) >= c.cfg.TouchEvery
	if touch {
		e.seen = now
	}
	renew := e.cookieSet.IsZero() || now.Sub(e.cookieSet) >= c.cfg.RenewCookieAfter
	if renew {
		e.cookieSet = now
	}
	return Resolved{Account: e.account, RenewCookie: renew}, touch
}

func (c *Cache) touch(ctx context.Context, hash [32]byte, touch bool) {
	if !touch {
		return
	}
	// A failure is only logged: the time is written again within the hour.
	if err := c.sessions.Touch(ctx, hash); err != nil {
		c.cfg.Log.Warn("recording a session seen", "err", err)
	}
}

// Add caches a session just made, its cookie just set.
func (c *Cache) Add(hash [32]byte, account store.Account) {
	now := c.cfg.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if old := c.entries[hash]; old != nil {
		c.remove(old)
	}
	c.add(&entry{hash: hash, account: account, fetched: now, seen: now, cookieSet: now})
}

// Forget drops a session from the cache at once, as when it ends.
func (c *Cache) Forget(hash [32]byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e := c.entries[hash]; e != nil {
		c.remove(e)
	}
}

// Len is how many sessions are cached.
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

func (c *Cache) add(e *entry) {
	e.elem = c.order.PushBack(e)
	c.entries[e.hash] = e
	for len(c.entries) > c.cfg.MaxEntries {
		c.remove(c.order.Front().Value.(*entry))
	}
}

func (c *Cache) remove(e *entry) {
	c.order.Remove(e.elem)
	delete(c.entries, e.hash)
}
