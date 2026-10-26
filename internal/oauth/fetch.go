// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"code.dny.dev/ssrf"
	"golang.org/x/sync/singleflight"
	"golang.org/x/time/rate"
)

// The guarded fetch of a client's metadata document: another site's
// address, fetched by the game's server, is a way to make the server call
// where the site chooses (OWASP, Server Side Request Forgery Prevention
// Cheat Sheet). So, as the client ID metadata document draft (-02, 4.1 and
// 6.5) and OWASP ask:
//
//   - the connection is checked as it is made, by the address actually
//     dialled after DNS, so a name re-pointed between the check and the
//     dial (DNS rebinding) is stopped too: the dialer's Control refuses
//     every special-purpose address (RFC 6890's registries, and for IPv6
//     anything outside global unicast, NAT64, 6to4 and Teredo), port 443
//     alone;
//   - no proxy, which would hide the destination, whatever HTTP_PROXY says;
//   - no redirect followed; 200 alone is an answer;
//   - at most MaxDocument bytes read, within FetchTimeout in all;
//   - one fetch at a time per client ID, and at most FetchesPerMinute in
//     all, beyond which the request is refused for a minute.

// The fetch's bounds.
const (
	// MaxDocument is the most of a document read: the draft's 5 KB.
	MaxDocument = 5 << 10
	// FetchTimeout bounds a fetch, from the dial to the last byte.
	FetchTimeout = 3 * time.Second
	// FetchesPerMinute bounds the fetches of every client ID together.
	FetchesPerMinute = 30
)

var (
	// ErrBusy is a fetch refused: too many lately.
	ErrBusy = errors.New("oauth: too many documents fetched lately")
	// errFetch is a document that could not be fetched.
	errFetch = errors.New("oauth: the document could not be fetched")
)

// FetcherOptions are a fetcher's settings. The zero value is production's.
type FetcherOptions struct {
	// Loopback lets the fetcher reach 127.0.0.1 and ::1 on any port, over
	// plain http too: for tests, whose documents a local server serves. No
	// setting of the server's turns it on.
	Loopback bool
	// Resolver, if not nil, looks names up in place of the system's, for
	// tests.
	Resolver *net.Resolver
	// PerMinute replaces FetchesPerMinute, and Timeout FetchTimeout, when
	// not zero.
	PerMinute int
	Timeout   time.Duration
}

// Fetcher fetches clients' metadata documents, guarded.
type Fetcher struct {
	client   *http.Client
	loopback bool
	limit    *rate.Limiter
	flight   singleflight.Group
}

// NewFetcher makes a fetcher.
func NewFetcher(opt FetcherOptions) *Fetcher {
	timeout := FetchTimeout
	if opt.Timeout > 0 {
		timeout = opt.Timeout
	}
	perMinute := FetchesPerMinute
	if opt.PerMinute > 0 {
		perMinute = opt.PerMinute
	}
	guard := ssrf.New(ssrf.WithPorts(443))
	control := guard.Safe
	if opt.Loopback {
		loop := ssrf.New(ssrf.WithAnyPort(),
			ssrf.WithAllowedV4Prefixes(netip.MustParsePrefix("127.0.0.0/8")), ssrf.WithAllowedV6Prefixes(netip.MustParsePrefix("::1/128")))
		control = loop.Safe
	}
	dialer := &net.Dialer{Timeout: timeout, Control: control, Resolver: opt.Resolver}
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            dialer.DialContext,
		ForceAttemptHTTP2:      true,
		TLSHandshakeTimeout:    timeout,
		ResponseHeaderTimeout:  timeout,
		MaxIdleConns:           10,
		IdleConnTimeout:        30 * time.Second,
		MaxResponseHeaderBytes: 16 << 10,
	}
	return &Fetcher{
		client: &http.Client{
			Transport: transport,
			Timeout:   timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		loopback: opt.Loopback,
		limit:    rate.NewLimiter(rate.Limit(float64(perMinute)/60), perMinute),
	}
}

// Transport is the fetcher's transport, for tests that trust their own
// certificate.
func (f *Fetcher) Transport() *http.Transport { return f.client.Transport.(*http.Transport) }

// fetched is a document as it came: its body and how long it may be kept.
type fetched struct {
	body   []byte
	maxAge time.Duration
}

// fetch fetches the document at a client ID's address: errFetch, wrapped
// with what went wrong, or ErrBusy.
func (f *Fetcher) fetch(ctx context.Context, clientID string) (fetched, error) {
	v, err, _ := f.flight.Do(clientID, func() (any, error) {
		if !f.limit.Allow() {
			return fetched{}, ErrBusy
		}
		return f.get(ctx, clientID)
	})
	if err != nil {
		return fetched{}, err
	}
	return v.(fetched), nil
}

func (f *Fetcher) get(ctx context.Context, clientID string) (fetched, error) {
	// The fetch is the server's, not the request's: one that the player's
	// browser gives up on still fills the cache for the next.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), f.client.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, clientID, nil)
	if err != nil {
		return fetched{}, fmt.Errorf("%w: %v", errFetch, err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Keel Over the Edge (client metadata)")
	res, err := f.client.Do(req)
	if err != nil {
		return fetched{}, fmt.Errorf("%w: %v", errFetch, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fetched{}, fmt.Errorf("%w: status %d", errFetch, res.StatusCode)
	}
	if mt, _, err := mime.ParseMediaType(res.Header.Get("Content-Type")); err != nil || !jsonType(mt) {
		return fetched{}, fmt.Errorf("%w: content type %q", errFetch, res.Header.Get("Content-Type"))
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, MaxDocument+1))
	if err != nil {
		return fetched{}, fmt.Errorf("%w: %v", errFetch, err)
	}
	if len(body) > MaxDocument {
		return fetched{}, fmt.Errorf("%w: more than %d bytes", errFetch, MaxDocument)
	}
	return fetched{body: body, maxAge: maxAge(res.Header, time.Now())}, nil
}

// jsonType is JSON's media type, or one of its +json kin.
func jsonType(mt string) bool { return mt == "application/json" || strings.HasSuffix(mt, "+json") }

// maxAge is how long an answer says it may be kept: Cache-Control's
// max-age, or else Expires; zero when neither says, or no-store or
// no-cache does.
func maxAge(h http.Header, now time.Time) time.Duration {
	for _, d := range strings.Split(h.Get("Cache-Control"), ",") {
		d = strings.ToLower(strings.TrimSpace(d))
		if d == "no-store" || d == "no-cache" {
			return 0
		}
		if v, ok := strings.CutPrefix(d, "max-age="); ok {
			if s, err := strconv.ParseInt(strings.Trim(v, `"`), 10, 64); err == nil && s > 0 {
				return time.Duration(min(s, int64(365*24*3600))) * time.Second
			}
			return 0
		}
	}
	if e := h.Get("Expires"); e != "" {
		if t, err := http.ParseTime(e); err == nil && t.After(now) {
			return t.Sub(now)
		}
	}
	return 0
}

// allowsLoopback reports whether the fetcher may reach a client ID on a
// loopback address: in tests alone.
func (f *Fetcher) allowsLoopback(u *url.URL) bool {
	if !f.loopback {
		return false
	}
	ip := net.ParseIP(u.Hostname())
	return ip != nil && ip.IsLoopback()
}

// documentCache keeps documents fetched, by client ID, for as long as
// their answers said, within bounds; a document fetched again replaces
// the one kept.
type documentCache struct {
	mu      sync.Mutex
	entries map[string]cachedDocument
}

type cachedDocument struct {
	client  Client
	expires time.Time
}

// The bounds of how long a document is kept: at least CacheAtLeast, so a
// document said to be kept for no time is not fetched at every approval,
// and at most CacheAtMost, so a client's change reaches the game in a day.
const (
	CacheAtLeast = 5 * time.Minute
	CacheAtMost  = 24 * time.Hour
	// cacheEntries bounds the cache; past it, it starts again empty.
	cacheEntries = 10_000
)

func (c *documentCache) get(id string, now time.Time) (Client, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[id]
	if !ok || !now.Before(e.expires) {
		return Client{}, false
	}
	return e.client, true
}

func (c *documentCache) put(id string, cl Client, maxAge time.Duration, now time.Time) {
	keep := min(max(maxAge, CacheAtLeast), CacheAtMost)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil || len(c.entries) >= cacheEntries {
		c.entries = map[string]cachedDocument{}
	}
	c.entries[id] = cachedDocument{client: cl, expires: now.Add(keep)}
}
