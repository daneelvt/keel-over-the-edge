// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/auth/softkey"
	"github.com/daneelvt/keel-over-the-edge/internal/humancheck"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

func TestAddress(t *testing.T) {
	for _, tc := range []struct {
		name, header, remote string
		want, prefix         string
	}{
		{"IPv4", "203.0.113.7", "10.0.0.1:443", "203.0.113.7", "203.0.113.7/32"},
		{"IPv6 counted by its /56", "2001:db8:1:1ab:2:3:4:5", "10.0.0.1:443", "2001:db8:1:1ab:2:3:4:5", "2001:db8:1:100::/56"},
		{"IPv4 carried in IPv6", "::ffff:203.0.113.7", "10.0.0.1:443", "203.0.113.7", "203.0.113.7/32"},
		{"a header that does not parse", "203.0.113.7, 10.0.0.2", "198.51.100.4:5000", "198.51.100.4", "198.51.100.4/32"},
		{"a header with a zone", "fe80::1%eth0", "198.51.100.4:5000", "198.51.100.4", "198.51.100.4/32"},
		{"no header", "", "[2001:db8::7]:5000", "2001:db8::7", "2001:db8::/56"},
		{"no header, a mapped connection", "", "[::ffff:127.0.0.1]:5000", "127.0.0.1", "127.0.0.1/32"},
		{"nothing at all", "", "", "invalid IP", "invalid Prefix"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := addressOf(tc.header, tc.remote)
			if a.String() != tc.want || AddressPrefix(a).String() != tc.prefix {
				t.Errorf("%q, %q: %s %s, want %s %s", tc.header, tc.remote, a, AddressPrefix(a), tc.want, tc.prefix)
			}
		})
	}
	// The middleware puts it in the request's context.
	var got netip.Addr
	h := clientAddress(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { got = Address(r.Context()) }))
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set(AddressHeader, "2001:db8::1")
	h.ServeHTTP(httptest.NewRecorder(), r)
	if got.String() != "2001:db8::1" {
		t.Errorf("Address = %s", got)
	}
	if Address(context.Background()).IsValid() {
		t.Error("an address with no request")
	}
}

// TestAddressKeyed: one key for a whole /56, another for each IPv4
// address; keys differ under another key, and never hold the address.
func TestAddressKeyed(t *testing.T) {
	k1, k2 := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	keyed := func(k []byte, s string) []byte { return AddressKeyed(k, netip.MustParseAddr(s)) }
	if !bytes.Equal(keyed(k1, "2001:db8:1:100::1"), keyed(k1, "2001:db8:1:1ff:ffff::9")) {
		t.Error("one /56, two keys")
	}
	if bytes.Equal(keyed(k1, "2001:db8:1:100::1"), keyed(k1, "2001:db8:1:200::1")) {
		t.Error("two /56s, one key")
	}
	if bytes.Equal(keyed(k1, "203.0.113.7"), keyed(k1, "203.0.113.8")) {
		t.Error("two IPv4 addresses, one key")
	}
	if !bytes.Equal(keyed(k1, "203.0.113.7"), keyed(k1, "::ffff:203.0.113.7")) {
		t.Error("an IPv4 address carried in IPv6 is another")
	}
	if bytes.Equal(keyed(k1, "203.0.113.7"), keyed(k2, "203.0.113.7")) {
		t.Error("the key changes nothing")
	}
	if k := keyed(k1, "203.0.113.7"); len(k) != 32 || bytes.Contains(k, []byte{203, 0, 113, 7}) {
		t.Errorf("keyed %x", k)
	}
}

func FuzzAddress(f *testing.F) {
	for _, s := range [][2]string{
		{"203.0.113.7", "10.0.0.1:443"}, {"2001:db8:1:1ab::5", ""}, {"::ffff:203.0.113.7", ""},
		{"fe80::1%eth0", "[fe80::1%eth0]:80"}, {"", "[::1]:5000"}, {"not an address", "nor this"},
		{"1.2.3.4, 5.6.7.8", "1.2.3.4"}, {"::", "0.0.0.0:0"},
	} {
		f.Add(s[0], s[1])
	}
	key := bytes.Repeat([]byte{9}, 32)
	f.Fuzz(func(t *testing.T, header, remote string) {
		a := addressOf(header, remote)
		if a.Zone() != "" || a.Is4In6() {
			t.Fatalf("%q %q: %s", header, remote, a)
		}
		p := AddressPrefix(a)
		switch {
		case !a.IsValid():
			if p.IsValid() {
				t.Fatalf("a prefix for no address: %s", p)
			}
		case a.Is4() && p.Bits() != 32, a.Is6() && p.Bits() != IPv6Prefix, !p.Contains(a):
			t.Fatalf("%s's prefix %s", a, p)
		}
		if k := AddressKeyed(key, a); len(k) != 32 {
			t.Fatalf("keyed %d bytes", len(k))
		}
	})
}

// siteverify stands in for Cloudflare's: its answer, how long it waits
// first, and how often it was asked.
type siteverify struct {
	mu     sync.Mutex
	answer string
	status int
	slow   time.Duration
	asked  atomic.Int32
}

func (s *siteverify) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.asked.Add(1)
	s.mu.Lock()
	answer, status, slow := s.answer, s.status, s.slow
	s.mu.Unlock()
	if slow > 0 {
		select {
		case <-time.After(slow):
		case <-r.Context().Done():
			return
		}
	}
	if status != 0 {
		w.WriteHeader(status)
		return
	}
	_, _ = w.Write([]byte(answer))
}

func (s *siteverify) says(answer string, status int, slow time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.answer, s.status, s.slow = answer, status, slow
}

const passedCheck = `{"success":true,"hostname":"localhost","action":"new-sailor","error-codes":[]}`

// door is a server whose new sailors are counted and checked, with its
// store, the owner's switches and the stand-in for Cloudflare.
type door struct {
	srv      *testServer
	st       *store.Store
	u        string
	switches *aboard.Switches
	cf       *siteverify
}

func newDoor(t *testing.T, change func(*Config)) *door {
	t.Helper()
	st, u := storetest.Store(t, store.Options{})
	cf := &siteverify{answer: passedCheck}
	cfSrv := httptest.NewServer(cf)
	t.Cleanup(cfSrv.Close)
	d := &door{st: st, u: u, switches: aboard.NewSwitches(aboard.DefaultLifetime), cf: cf}
	d.srv = newTestServer(t, st, func(c *Config) {
		c.Switches = d.switches
		c.NewSailors = &NewSailors{Count: st, Key: bytes.Repeat([]byte{7}, 32), SiteKey: "the-site-key", Script: "/turnstile/api.js?render=explicit",
			Check: humancheck.New(humancheck.Config{Secret: "the-secret", VerifyURL: cfSrv.URL, Hostname: "localhost", Timeout: 300 * time.Millisecond})}
		if change != nil {
			change(c)
		}
	})
	return d
}

func sailorBody(name, check string) string {
	return `{"name":"` + name + `","look":"rover","version":"female","skin":"tone-2","hair":"brown","colour":"madder-red","born":{"year":1990,"month":1},"check":"` + check + `"}`
}

// browserAt is a browser whose requests come from addr.
func (d *door) browserAt(t *testing.T, addr string) *browser {
	b := newBrowser(t, d.srv)
	b.addr = addr
	return b
}

// make makes a sailor, its check passed, failing the test unless it is made.
func (b *browser) make(name string) {
	b.t.Helper()
	status, opts := b.post("/account/begin", sailorBody(name, "a-token"))
	if status != 200 {
		b.t.Fatalf("%s from %s: begin %d %s", name, b.addr, status, opts)
	}
	key, answer, err := softkey.Create([]byte(opts), testOrigin)
	if err != nil {
		b.t.Fatal(err)
	}
	if status, body := b.post("/account/finish", string(answer)); status != 201 {
		b.t.Fatalf("%s from %s: finish %d %s", name, b.addr, status, body)
	}
	b.keys = append(b.keys, key)
}

// name is the nth sailor's name: names may hold no digits.
func name(n int) string {
	return "Sailor " + strings.Map(func(r rune) rune { return 'a' + (r - '0') }, strconv.Itoa(n+100))
}

// TestNewSailorsPerAddress: 20 sailors made from one /56 in a day, the 21st
// is refused before its passkey with the time to wait, while another /56
// and an IPv4 address make theirs; the owner's number takes effect at once;
// only sailors made count; a server started again counts what the
// database holds; a day later the address may make sailors again.
func TestNewSailorsPerAddress(t *testing.T) {
	d := newDoor(t, nil)
	for i := range aboard.DefaultNewSailorsPerAddress {
		d.browserAt(t, fmt.Sprintf("2001:db8:1:1%02x::1", i)).make(name(i))
	}
	asked := d.cf.asked.Load()
	full := d.browserAt(t, "2001:db8:1:1ff::9")
	status, body := full.post("/account/begin", sailorBody("Sailor Over", "a-token"))
	if status != 429 || body != `{"error":"often"}` {
		t.Fatalf("the 21st: %d %s", status, body)
	}
	if n := d.cf.asked.Load(); n != asked {
		t.Errorf("a full address spent %d checks", n-asked)
	}
	res, err := http.DefaultClient.Do(func() *http.Request {
		r, _ := http.NewRequest("POST", d.srv.URL+"/account/begin", strings.NewReader(sailorBody("Sailor Over", "a-token")))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set(AddressHeader, "2001:db8:1:1ff::9")
		return r
	}())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	wait, _ := strconv.Atoi(res.Header.Get("Retry-After"))
	if res.StatusCode != 429 || wait < 23*3600 || wait > 24*3600 {
		t.Errorf("Retry-After %q", res.Header.Get("Retry-After"))
	}
	if got := testutil.ToFloat64(d.srv.metrics.NewSailorsRefused.WithLabelValues("address")); got != 2 {
		t.Errorf("refused for the address: %v", got)
	}
	d.browserAt(t, "2001:db8:1:200::1").make("Other Net")
	d.browserAt(t, "203.0.113.7").make("Four Square")

	// The owner raises the number: the 21st is made at once.
	d.switches.SetNewSailorsPerAddress(21)
	full.make("Sailor Over")
	if status, _ := d.browserAt(t, "2001:db8:1:150::1").post("/account/begin", sailorBody("Sailor More", "a-token")); status != 429 {
		t.Fatalf("the 22nd: %d", status)
	}
	// Lowered to 2: the IPv4 address has made 1, and may make 1 more. A
	// begin alone counts for nothing, so a cancelled prompt costs nothing.
	d.switches.SetNewSailorsPerAddress(2)
	four := d.browserAt(t, "203.0.113.7")
	for range 3 {
		if status, body := four.post("/account/begin", sailorBody("Four Again", "a-token")); status != 200 {
			t.Fatalf("begun again: %d %s", status, body)
		}
	}
	four.make("Four Again")
	if status, _ := d.browserAt(t, "203.0.113.7").post("/account/begin", sailorBody("Four More", "a-token")); status != 429 {
		t.Fatalf("the third from the IPv4 address: %d", status)
	}

	// Started again on the same database: the count holds.
	again := newTestServer(t, d.st, func(c *Config) {
		c.Switches = d.switches
		c.NewSailors = &NewSailors{Count: d.st, Key: bytes.Repeat([]byte{7}, 32)}
	})
	b := newBrowser(t, again)
	b.addr = "203.0.113.7"
	if status, _ := b.post("/account/begin", sailorBody("Four More", "")); status != 429 {
		t.Fatalf("after a restart: %d", status)
	}
	// A day on, the address's rows no longer count.
	must := storetest.PoolOn(t, d.u)
	if _, err := must.Exec(context.Background(), "UPDATE new_sailor_from SET made_at = made_at - interval '24 hours'"); err != nil {
		t.Fatal(err)
	}
	b.make("Four More")
}

// TestSigningInNeverLimited: an address that has made all its sailors
// still signs in, 21 times over, and uses its recovery code.
func TestSigningInNeverLimited(t *testing.T) {
	d := newDoor(t, nil)
	d.switches.SetNewSailorsPerAddress(1)
	b := d.browserAt(t, "198.51.100.4")
	b.make("Ann Bonny")
	if status, _ := d.browserAt(t, "198.51.100.4").post("/account/begin", sailorBody("Mary Read", "a-token")); status != 429 {
		t.Fatalf("the second sailor: %d", status)
	}
	for i := range 21 {
		other := d.browserAt(t, "198.51.100.4")
		other.keys = b.keys
		if status, body := other.signIn(i%2 == 0); status != 200 {
			t.Fatalf("sign-in %d: %d %s", i+1, status, body)
		}
	}
	if got := testutil.ToFloat64(d.srv.metrics.NewSailorsRefused.WithLabelValues("address")); got != 1 {
		t.Errorf("refused for the address: %v", got)
	}
}

// TestHumanCheck: a token passes only as Cloudflare says, for this host
// and action; no token, a refused or spent one, or another host's or
// action's is 403 check; Cloudflare slow or down is 503 and no sailor
// (failing closed); switched off, no check is made but the count holds.
func TestHumanCheck(t *testing.T) {
	d := newDoor(t, nil)
	for _, tc := range []struct {
		name, token, answer string
		status              int
		slow                time.Duration
		want                int
		body                string
		asked               int32
	}{
		{"no token", "", passedCheck, 0, 0, 403, `{"error":"check"}`, 0},
		{"too long", strings.Repeat("x", humancheck.MaxToken+1), passedCheck, 0, 0, 403, `{"error":"check"}`, 0},
		{"refused", "a-token", `{"success":false,"error-codes":["invalid-input-response"]}`, 0, 0, 403, `{"error":"check"}`, 1},
		{"spent", "a-token", `{"success":false,"error-codes":["timeout-or-duplicate"]}`, 0, 0, 403, `{"error":"check"}`, 1},
		{"wrong hostname", "a-token", `{"success":true,"hostname":"evil.example","action":"new-sailor"}`, 0, 0, 403, `{"error":"check"}`, 1},
		{"wrong action", "a-token", `{"success":true,"hostname":"localhost","action":"login"}`, 0, 0, 403, `{"error":"check"}`, 1},
		{"Cloudflare down", "a-token", "", 503, 0, 503, `{"error":"check-unavailable"}`, 2},
		{"Cloudflare slow", "a-token", passedCheck, 0, time.Second, 503, `{"error":"check-unavailable"}`, 1},
		{"passed", "a-token", passedCheck, 0, 0, 200, "", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d.cf.says(tc.answer, tc.status, tc.slow)
			before := d.cf.asked.Load()
			status, body := d.browserAt(t, "203.0.113.9").post("/account/begin", sailorBody("Ann Bonny", tc.token))
			if status != tc.want || tc.body != "" && body != tc.body {
				t.Errorf("%d %s", status, body)
			}
			if n := d.cf.asked.Load() - before; n != tc.asked {
				t.Errorf("Cloudflare asked %d times", n)
			}
		})
	}
	m := d.srv.metrics
	for r, want := range map[string]float64{"passed": 1, "refused": 5, "spent": 1, "unavailable": 2, "off": 0} {
		if got := testutil.ToFloat64(m.HumanChecks.WithLabelValues(r)); got != want {
			t.Errorf("checks %s: %v, want %v", r, got, want)
		}
	}
	if got := testutil.ToFloat64(m.NewSailorsRefused.WithLabelValues("check")); got != 8 {
		t.Errorf("refused for the check: %v", got)
	}

	// Switched off: no check is asked, any token or none, and the count
	// still holds.
	d.cf.says(`{"success":false,"error-codes":["invalid-input-response"]}`, 0, 0)
	d.switches.SetHumanCheck(false)
	d.switches.SetNewSailorsPerAddress(1)
	before := d.cf.asked.Load()
	off := d.browserAt(t, "192.0.2.1")
	if status, opts := off.post("/account/begin", sailorBody("Mary Read", "")); status != 200 {
		t.Fatalf("switched off: %d %s", status, opts)
	}
	off.make("Mary Read")
	if status, _ := d.browserAt(t, "192.0.2.1").post("/account/begin", sailorBody("Anne Read", "")); status != 429 {
		t.Fatalf("switched off, the address full: %d", status)
	}
	if d.cf.asked.Load() != before || testutil.ToFloat64(m.HumanChecks.WithLabelValues("off")) != 2 {
		t.Errorf("switched off: asked %d, off %v", d.cf.asked.Load()-before, testutil.ToFloat64(m.HumanChecks.WithLabelValues("off")))
	}
}

// TestBeginsOrder: the cheap refusals come before the check, so they cost
// none of Cloudflare's checks; whether the name is free comes after it.
func TestBeginsOrder(t *testing.T) {
	d := newDoor(t, nil)
	d.browserAt(t, "203.0.113.20").make("Calico Jack")
	asked := d.cf.asked.Load()
	for _, tc := range []struct{ body, want string }{
		{sailorBody("J", "a-token"), `{"error":"short"}`},
		{strings.Replace(sailorBody("Jack Rackham", "a-token"), `"rover"`, `"no-such-look"`, 1), `{"error":"look"}`},
		{strings.Replace(sailorBody("Jack Rackham", "a-token"), `"year":1990`, `"year":2024`, 1), `{"error":"young"}`},
	} {
		if status, body := d.browserAt(t, "203.0.113.21").post("/account/begin", tc.body); body != tc.want {
			t.Errorf("%d %s, want %s", status, body, tc.want)
		}
	}
	d.switches.SetNewSailorsPerAddress(1)
	if status, _ := d.browserAt(t, "203.0.113.20").post("/account/begin", sailorBody("Jack Rackham", "a-token")); status != 429 {
		t.Errorf("a full address: %d", status)
	}
	if n := d.cf.asked.Load(); n != asked {
		t.Fatalf("refusals before the check spent %d checks", n-asked)
	}
	if status, body := d.browserAt(t, "203.0.113.22").post("/account/begin", sailorBody("Calico Jack", "a-token")); status != 422 || body != `{"error":"taken"}` {
		t.Fatalf("a taken name: %d %s", status, body)
	}
	if n := d.cf.asked.Load(); n != asked+1 {
		t.Fatalf("a taken name is answered after %d checks", n-asked)
	}
}

// TestMeWithoutSession: GET /api/me's 401 says whether the browser has had
// a sailor and how to render the check, null with none or switched off.
func TestMeWithoutSession(t *testing.T) {
	d := newDoor(t, nil)
	b := newBrowser(t, d.srv)
	if status, body := b.do("GET", "/api/me", ""); status != 401 ||
		body != `{"error":"session","sailed":false,"check":{"siteKey":"the-site-key","script":"/turnstile/api.js?render=explicit"}}` {
		t.Fatalf("%d %s", status, body)
	}
	d.switches.SetHumanCheck(false)
	b.jar.SetCookies(nil, []*http.Cookie{auth.SailedCookie()})
	if status, body := b.do("GET", "/api/me", ""); status != 401 || body != `{"error":"session","sailed":true,"check":null}` {
		t.Fatalf("switched off, sailed: %d %s", status, body)
	}
	d.switches.SetHumanCheck(true)
	none := newDoor(t, func(c *Config) { c.NewSailors.Check = nil })
	if status, body := newBrowser(t, none.srv).do("GET", "/api/me", ""); status != 401 || body != `{"error":"session","sailed":false,"check":null}` {
		t.Fatalf("no check set up: %d %s", status, body)
	}
}

// sailedSet finds the marker among cookies set, the last of them as a
// browser keeps it, and whether it was set or cleared.
func sailedSet(cs []*http.Cookie) (c *http.Cookie, set, cleared bool) {
	for _, k := range cs {
		if k.Name == auth.SailedCookieName {
			c, set, cleared = k, k.MaxAge > 0, k.MaxAge < 0
		}
	}
	return c, set, cleared
}

// TestSailedMarker: the marker is set by a new sailor, a sign-in and the
// recovery code, set again with the session cookie a day on, kept on
// signing out, and cleared by the player's deletion and by a sign-in with
// a passkey no account has.
func TestSailedMarker(t *testing.T) {
	var offset atomic.Int64
	now := func() time.Time { return time.Now().Add(time.Duration(offset.Load())) }
	d := newDoor(t, func(c *Config) {
		c.Sessions = auth.NewCache(c.Accounts.(database), auth.CacheConfig{Now: now})
	})
	b := d.browserAt(t, "203.0.113.30")
	b.make("Ann Bonny")
	c, set, _ := sailedSet(b.last)
	if !set || c.Value != "1" || c.Path != "/" || !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode ||
		c.MaxAge != 400*24*3600 {
		t.Fatalf("made: %+v", c)
	}
	// Signing out keeps it.
	if status, _ := b.post("/logout", ""); status != 204 {
		t.Fatalf("logout %d", status)
	}
	if _, set, cleared := sailedSet(b.last); set || cleared || b.jar.get(auth.SailedCookieName) == nil {
		t.Fatal("signing out touched the marker")
	}
	// A sign-in sets it, on a browser that had none.
	other := d.browserAt(t, "203.0.113.31")
	other.keys = b.keys
	if status, _ := other.signIn(false); status != 200 {
		t.Fatalf("sign-in %d", status)
	}
	if _, set, _ := sailedSet(other.last); !set {
		t.Fatal("a sign-in did not set the marker")
	}
	// A day on, the session cookie is set again, and the marker with it.
	other.jar.SetCookies(nil, []*http.Cookie{{Name: auth.SailedCookieName, MaxAge: -1}})
	if status, _ := other.do("GET", "/api/me", ""); status != 200 {
		t.Fatalf("me %d", status)
	}
	if _, set, _ := sailedSet(other.last); set {
		t.Fatal("set again within the day")
	}
	offset.Store(int64(25 * time.Hour))
	if status, _ := other.do("GET", "/api/me", ""); status != 200 {
		t.Fatalf("me a day on: %d", status)
	}
	session, renewed := false, false
	for _, c := range other.last {
		session = session || c.Name == auth.CookieName && c.MaxAge > 0
		renewed = renewed || c.Name == auth.SailedCookieName && c.MaxAge > 0
	}
	if !session || !renewed {
		t.Fatalf("a day on: session %t, marker %t: %v", session, renewed, other.last)
	}
	offset.Store(0)

	// The recovery code sets it.
	mary := d.browserAt(t, "203.0.113.32")
	status, body := mary.post("/account/begin", sailorBody("Mary Read", "a-token"))
	if status != 200 {
		t.Fatal(body)
	}
	key, answer, _ := softkey.Create([]byte(body), testOrigin)
	mary.keys = append(mary.keys, key)
	_, body = mary.post("/account/finish", string(answer))
	code := decode[sailorResponse](t, body).RecoveryCode
	lost := newBrowser(t, d.srv)
	if status, body := lost.post("/recovery", `{"code":"`+code+`"}`); status != 200 {
		t.Fatalf("recovery: %d %s", status, body)
	}
	if _, set, _ := sailedSet(lost.last); !set {
		t.Fatal("the recovery code did not set the marker")
	}

	// The owner deletes Mary's account: her passkey's sign-in clears it.
	holder, err := d.st.AccountByUserHandle(context.Background(), mary.keys[0].UserHandle)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.st.DeleteAccount(context.Background(), holder.ID); err != nil {
		t.Fatal(err)
	}
	dead := newBrowser(t, d.srv)
	dead.keys = mary.keys
	dead.jar.SetCookies(nil, []*http.Cookie{auth.SailedCookie()})
	if status, body := dead.signIn(false); status != 404 || !strings.Contains(body, "unknown-passkey") {
		t.Fatalf("a dead passkey: %d %s", status, body)
	}
	if _, _, cleared := sailedSet(dead.last); !cleared || dead.jar.get(auth.SailedCookieName) != nil {
		t.Fatal("unknown-passkey kept the marker")
	}

	// The player deletes their own account: cleared.
	if status, _ := other.confirm(); status != 200 {
		t.Fatalf("confirm %d", status)
	}
	if status, body := other.post("/api/account/delete", `{"name":"Ann Bonny"}`); status != 200 {
		t.Fatalf("delete: %d %s", status, body)
	}
	if _, _, cleared := sailedSet(other.last); !cleared {
		t.Fatalf("the player's deletion kept the marker: %v", other.last)
	}
}
