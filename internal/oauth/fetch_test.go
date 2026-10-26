// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// fakeDNS answers every A and AAAA question with the address it is told,
// as a name re-pointed at a private address would be.
type fakeDNS struct {
	mu   sync.Mutex
	addr netip.Addr
	conn net.PacketConn
}

func newFakeDNS(t *testing.T) *fakeDNS {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	d := &fakeDNS{conn: pc}
	t.Cleanup(func() { pc.Close() })
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			var p dnsmessage.Parser
			h, err := p.Start(buf[:n])
			if err != nil {
				continue
			}
			q, err := p.Question()
			if err != nil {
				continue
			}
			d.mu.Lock()
			a := d.addr
			d.mu.Unlock()
			b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: h.ID, Response: true, Authoritative: true})
			_ = b.StartQuestions()
			_ = b.Question(q)
			_ = b.StartAnswers()
			rh := dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 1}
			switch {
			case q.Type == dnsmessage.TypeA && a.Is4():
				_ = b.AResource(rh, dnsmessage.AResource{A: a.As4()})
			case q.Type == dnsmessage.TypeAAAA && a.Is6():
				_ = b.AAAAResource(rh, dnsmessage.AAAAResource{AAAA: a.As16()})
			}
			out, _ := b.Finish()
			_, _ = pc.WriteTo(out, from)
		}
	}()
	return d
}

func (d *fakeDNS) set(a string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.addr = netip.MustParseAddr(a)
}

func (d *fakeDNS) resolver() *net.Resolver {
	return &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var dl net.Dialer
		return dl.DialContext(ctx, "udp", d.conn.LocalAddr().String())
	}}
}

// TestDeniedRanges: a client ID's name that resolves to any special-use
// address is refused as the connection is made, by the address dialled:
// loopback, private, CGNAT, link-local, the cloud's metadata address,
// benchmarking, reserved and multicast ranges, and in IPv6 NAT64, 6to4,
// Teredo, site-local, unique local and the IPv4-mapped forms of them.
func TestDeniedRanges(t *testing.T) {
	dns := newFakeDNS(t)
	f := NewFetcher(FetcherOptions{Resolver: dns.resolver(), Timeout: time.Second, PerMinute: 1000})
	for _, a := range []string{
		"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "100.64.0.1", "169.254.169.254", "0.0.0.1",
		"198.18.0.1", "240.0.0.1", "192.0.0.1", "224.0.0.1", "255.255.255.255",
		"::1", "fe80::1", "fc00::1", "fec0::1", "64:ff9b::a00:1", "2002:a00:1::", "2001::1", "::ffff:10.0.0.1",
	} {
		dns.set(a)
		_, err := f.get(context.Background(), "https://client.example/client.json")
		if !errors.Is(err, errFetch) || !strings.Contains(err.Error(), "prohibited") {
			t.Errorf("%s: %v", a, err)
		}
	}
	// A literal address is checked the same way, and a port but 443 is
	// refused.
	for _, u := range []string{"https://10.1.2.3/client.json", "https://93.184.215.14:8443/client.json"} {
		if _, err := f.get(context.Background(), u); !errors.Is(err, errFetch) || !strings.Contains(err.Error(), "prohibited") {
			t.Errorf("%s: %v", u, err)
		}
	}
}

// docServer is a client's server, over TLS on loopback, which the
// fetcher's test option reaches.
func docServer(t *testing.T, h http.HandlerFunc) (*httptest.Server, *Fetcher) {
	t.Helper()
	s := httptest.NewTLSServer(h)
	t.Cleanup(s.Close)
	f := NewFetcher(FetcherOptions{Loopback: true, Timeout: 300 * time.Millisecond, PerMinute: 1000})
	pool := x509.NewCertPool()
	pool.AddCert(s.Certificate())
	f.Transport().TLSClientConfig = &tls.Config{RootCAs: pool}
	return s, f
}

// TestFetch: a redirect is not followed, anything but 200 is an error, a
// body past 5 KB is refused, a slow server is cut off, and the content
// must be JSON.
func TestFetch(t *testing.T) {
	var slow atomic.Bool
	s, f := docServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "/ok", http.StatusFound)
		case "/large":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(strings.Repeat(" ", MaxDocument+1)))
		case "/exactly":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(strings.Repeat(" ", MaxDocument)))
		case "/slow":
			if slow.Load() {
				time.Sleep(time.Second)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("{}"))
		case "/html":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("{}"))
		case "/ok":
			if r.Header.Get("Accept") != "application/json" {
				http.Error(w, "accept", http.StatusNotAcceptable)
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "public, max-age=300")
			_, _ = w.Write([]byte("{}"))
		default:
			http.NotFound(w, r)
		}
	})
	ctx := context.Background()
	if got, err := f.get(ctx, s.URL+"/ok"); err != nil || string(got.body) != "{}" || got.maxAge != 5*time.Minute {
		t.Fatalf("ok: %+v %v", got, err)
	}
	if _, err := f.get(ctx, s.URL+"/exactly"); err != nil {
		t.Errorf("5 KB exactly: %v", err)
	}
	slow.Store(true)
	for path, want := range map[string]string{"/redirect": "302", "/large": "more than", "/missing": "404", "/slow": "", "/html": "content type"} {
		_, err := f.get(ctx, s.URL+path)
		if !errors.Is(err, errFetch) || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", path, err)
		}
	}
}

// TestDocumentCache: a document is kept as long as its answer says, within
// five minutes and a day; an error or an invalid document is never kept;
// two requests at once fetch once; past the limit, fetches are refused.
func TestDocumentCache(t *testing.T) {
	var fetches atomic.Int32
	var fail atomic.Bool
	var cc atomic.Value
	cc.Store("max-age=0")
	release := make(chan struct{})
	var s *httptest.Server
	s, f := docServer(t, func(w http.ResponseWriter, r *http.Request) {
		fetches.Add(1)
		if r.URL.Path == "/wait.json" {
			<-release
		}
		if fail.Load() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", cc.Load().(string))
		_, _ = w.Write([]byte(`{"client_id":"` + s.URL + r.URL.Path + `","client_name":"App","redirect_uris":["https://app.example/cb"]}`))
	})
	now := time.Now()
	clock := func() time.Time { return now }
	results := map[string]int{}
	var mu sync.Mutex
	c := &clients{fetcher: f, now: clock, counted: func(r string) { mu.Lock(); results[r]++; mu.Unlock() }, took: func(time.Duration) {}}
	ctx := context.Background()
	id := s.URL + "/client.json"

	// A 404 is not kept: the next request fetches again.
	fail.Store(true)
	for range 2 {
		if _, err := c.resolve(ctx, id); !errors.Is(err, errDocument) {
			t.Fatalf("a 404: %v", err)
		}
	}
	if fetches.Load() != 2 {
		t.Fatalf("a 404 kept: %d fetches", fetches.Load())
	}
	fail.Store(false)
	// max-age=0 is kept the five minutes at least.
	if cl, err := c.resolve(ctx, id); err != nil || cl.Name != "App" || cl.Host != "127.0.0.1" {
		t.Fatalf("resolve: %+v %v", cl, err)
	}
	now = now.Add(4 * time.Minute)
	_, _ = c.resolve(ctx, id)
	if fetches.Load() != 3 {
		t.Fatalf("within five minutes: %d fetches", fetches.Load())
	}
	now = now.Add(2 * time.Minute)
	cc.Store("max-age=31536000")
	_, _ = c.resolve(ctx, id)
	if fetches.Load() != 4 {
		t.Fatalf("after five minutes: %d fetches", fetches.Load())
	}
	// A year's max-age is kept a day.
	now = now.Add(23 * time.Hour)
	_, _ = c.resolve(ctx, id)
	now = now.Add(2 * time.Hour)
	_, _ = c.resolve(ctx, id)
	if fetches.Load() != 5 {
		t.Fatalf("a year's max-age: %d fetches", fetches.Load())
	}
	if results["cached"] != 2 || results["fetched"] != 3 || results["failed"] != 2 {
		t.Fatalf("counted: %v", results)
	}

	// Two at once for one client ID fetch once.
	wait := s.URL + "/wait.json"
	before := fetches.Load()
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			if _, err := c.resolve(ctx, wait); err != nil {
				t.Error(err)
			}
		})
	}
	time.Sleep(100 * time.Millisecond)
	close(release)
	wg.Wait()
	if fetches.Load() != before+1 {
		t.Fatalf("two at once: %d fetches", fetches.Load()-before)
	}

	// Past the limit, a fetch is refused, and no request is made.
	limited := NewFetcher(FetcherOptions{Loopback: true, PerMinute: 2})
	limited.Transport().TLSClientConfig = f.Transport().TLSClientConfig
	lc := &clients{fetcher: limited, now: clock, counted: func(string) {}, took: func(time.Duration) {}}
	for i := range 3 {
		_, err := lc.resolve(ctx, s.URL+"/n"+string(rune('a'+i))+".json")
		if i < 2 && errors.Is(err, ErrBusy) || i == 2 && !errors.Is(err, ErrBusy) {
			t.Fatalf("fetch %d: %v", i, err)
		}
	}
}

func TestMaxAge(t *testing.T) {
	now := time.Now()
	for cc, want := range map[string]time.Duration{
		"max-age=300":                   5 * time.Minute,
		"public, max-age=60, immutable": time.Minute,
		"no-store, max-age=600":         0,
		"no-cache":                      0,
		"max-age=x":                     0,
		"":                              0,
	} {
		if got := maxAge(http.Header{"Cache-Control": {cc}}, now); got != want {
			t.Errorf("%q: %v, want %v", cc, got, want)
		}
	}
	h := http.Header{"Expires": {now.Add(time.Hour).UTC().Format(http.TimeFormat)}}
	if got := maxAge(h, now); got < 59*time.Minute || got > time.Hour {
		t.Errorf("Expires: %v", got)
	}
}
