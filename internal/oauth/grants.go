// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The grant lifetime: how long an approval or a connection token lasts
// from when it was made. Its end is reckoned at every use from the
// lifetime as it is now, so shortening it ends older grants at once.
const (
	DefaultLifetime = 90 * 24 * time.Hour
	MinLifetime     = time.Minute
	MaxLifetime     = 400 * 24 * time.Hour
)

// Lifetime is the grant lifetime, as the database has it, kept in memory.
type Lifetime struct{ d atomic.Int64 }

// NewLifetime keeps a lifetime.
func NewLifetime(d time.Duration) *Lifetime {
	l := &Lifetime{}
	l.Set(d)
	return l
}

// Get is the lifetime.
func (l *Lifetime) Get() time.Duration { return time.Duration(l.d.Load()) }

// Set sets the lifetime in memory, once the database has it.
func (l *Lifetime) Set(d time.Duration) { l.d.Store(int64(d)) }

// TokenStore finds tokens: the store.
type TokenStore interface {
	TokenGrant(ctx context.Context, hash [32]byte) (store.TokenGrant, error)
}

// Accepted is a token the door accepts: the machine sailor it sails as,
// its grant, and when it stops being accepted: the earlier of the token's
// expiry and its grant's end.
type Accepted struct {
	Account   store.AccountID
	Name      string
	OwnerName string
	Grant     [16]byte
	// Connection is a connection token's; ClientName names the app
	// otherwise.
	Connection bool
	ClientName string
	Until      time.Time
}

// Refused is a token the door refuses: the result its metric counts, and
// the words for the app's player.
type Refused struct {
	Result string
	Words  string
}

func (r *Refused) Error() string { return "oauth: a token refused: " + r.Result }

// GrantsCacheFor is how long a token found is used before it is looked up
// again; what ends it (a revocation, a deletion, the lifetime changed)
// tells the cache at once.
const GrantsCacheFor = 30 * time.Second

// grantsCacheEntries bounds the cache; past it, it starts again empty.
const grantsCacheEntries = 100_000

// Grants checks the tokens AI apps present at the MCP address, keeping
// what it found for GrantsCacheFor.
type Grants struct {
	store    TokenStore
	lifetime *Lifetime
	zone     *time.Location
	now      func() time.Time

	mu      sync.Mutex
	entries map[[32]byte]grantEntry
}

type grantEntry struct {
	t       store.TokenGrant
	fetched time.Time
}

// NewGrants makes the door's check, against st, with the lifetime given;
// its refusals write dates in zone.
func NewGrants(st TokenStore, lifetime *Lifetime, zone *time.Location, now func() time.Time) *Grants {
	if now == nil {
		now = time.Now
	}
	return &Grants{store: st, lifetime: lifetime, zone: zone, now: now, entries: map[[32]byte]grantEntry{}}
}

// Check checks a token presented, of the kinds the door takes (access and
// connection tokens): an *Accepted, or a *Refused, or another error when
// the database cannot be asked. warm reports whether it was cached.
func (g *Grants) Check(ctx context.Context, token string) (a *Accepted, warm bool, err error) {
	kind, hash, ok := ParseToken(token)
	if !ok || (kind != KindAccess && kind != KindConnection) {
		return nil, false, &Refused{Result: "malformed", Words: wordsInvalid}
	}
	now := g.now()
	g.mu.Lock()
	e, warm := g.entries[hash]
	g.mu.Unlock()
	if !warm || now.Sub(e.fetched) >= GrantsCacheFor {
		warm = false
		t, err := g.store.TokenGrant(ctx, hash)
		if errors.Is(err, store.ErrNotFound) {
			return nil, false, &Refused{Result: "unknown", Words: wordsInvalid}
		}
		if err != nil {
			return nil, false, err
		}
		e = grantEntry{t: t, fetched: now}
		g.mu.Lock()
		if len(g.entries) >= grantsCacheEntries {
			g.entries = map[[32]byte]grantEntry{}
		}
		g.entries[hash] = e
		g.mu.Unlock()
	}
	t := e.t
	connection := t.GrantKind == store.GrantConnection
	if (kind == KindConnection) != (t.Kind == store.TokenConnection) {
		return nil, warm, &Refused{Result: "unknown", Words: wordsInvalid}
	}
	if !t.Revoked.IsZero() {
		return nil, warm, &Refused{Result: "revoked", Words: EndedWords(connection, t.RevokedWhy, t.Revoked, g.zone)}
	}
	ends := t.Approved.Add(g.lifetime.Get())
	if !now.Before(ends) {
		return nil, warm, &Refused{Result: "ended", Words: EndedWords(connection, "", ends, g.zone)}
	}
	until := ends
	if !t.Expires.IsZero() {
		if !now.Before(t.Expires) {
			return nil, warm, &Refused{Result: "expired", Words: wordsExpired}
		}
		if t.Expires.Before(until) {
			until = t.Expires
		}
	}
	return &Accepted{
		Account: t.Account, Name: t.Name, OwnerName: t.OwnerName, Grant: t.Grant,
		Connection: connection, ClientName: t.ClientName, Until: until,
	}, warm, nil
}

// ForgetGrants drops the tokens of grants from the cache at once, as when
// they are revoked.
func (g *Grants) ForgetGrants(ids ...[16]byte) {
	g.forget(func(t store.TokenGrant) bool {
		for _, id := range ids {
			if t.Grant == id {
				return true
			}
		}
		return false
	})
}

// ForgetAccounts drops the tokens of machine sailors from the cache at
// once, as when they are deleted.
func (g *Grants) ForgetAccounts(ids ...store.AccountID) {
	g.forget(func(t store.TokenGrant) bool {
		for _, id := range ids {
			if t.Account == id {
				return true
			}
		}
		return false
	})
}

// ForgetToken drops one token from the cache, as when it is revoked.
func (g *Grants) ForgetToken(hash [32]byte) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.entries, hash)
}

// ForgetAll empties the cache, as when the lifetime changes.
func (g *Grants) ForgetAll() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.entries = map[[32]byte]grantEntry{}
}

// forget walks the whole cache, which a rare change can afford.
func (g *Grants) forget(drop func(store.TokenGrant) bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for h, e := range g.entries {
		if drop(e.t) {
			delete(g.entries, h)
		}
	}
}
