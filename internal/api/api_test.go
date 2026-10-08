// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// syncBuffer is a log that handlers write while the test reads.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

// noGuests is a store that is never reached.
type noGuests struct{}

func (noGuests) CreateGuest(context.Context, store.Guest) (store.AccountID, error) {
	return store.AccountID{}, errors.New("no database in this test")
}

func (noGuests) Session(context.Context, [32]byte) (store.Session, error) {
	return store.Session{}, store.ErrNotFound
}

func (noGuests) Touch(context.Context, [32]byte) error { return nil }

type testServer struct {
	*httptest.Server
	logs    *syncBuffer
	metrics *obs.Metrics
}

type database interface {
	Guests
	auth.Sessions
}

func newTestServer(t *testing.T, db database, change func(*Config)) *testServer {
	t.Helper()
	logs := &syncBuffer{}
	m := obs.NewMetrics("test", "cat")
	cfg := Config{
		Version:  Version{Build: "abc123", Catalog: "0123456789abcdef"},
		Log:      obs.NewLogger(logs, slog.LevelInfo, "test"),
		Metrics:  m,
		Guests:   db,
		Sessions: auth.NewCache(db, auth.CacheConfig{Lookups: m.SessionLookups}),
		Looks:    []string{"figure", "other-figure"},
	}
	if change != nil {
		change(&cfg)
	}
	srv := httptest.NewServer(Handler(cfg))
	t.Cleanup(srv.Close)
	return &testServer{Server: srv, logs: logs, metrics: m}
}

func TestVersion(t *testing.T) {
	srv := newTestServer(t, noGuests{}, nil)
	res, err := http.Get(srv.URL + "/api/version")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q", ct)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q", cc)
	}
	var got Version
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if want := (Version{Build: "abc123", Catalog: "0123456789abcdef"}); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestVersionOnlyGet(t *testing.T) {
	srv := newTestServer(t, noGuests{}, nil)
	for _, c := range []struct {
		method, path string
		status       int
	}{
		{"POST", "/api/version", http.StatusMethodNotAllowed},
		{"GET", "/api/nothing", http.StatusNotFound},
		{"GET", "/guest", http.StatusMethodNotAllowed},
	} {
		req, _ := http.NewRequest(c.method, srv.URL+c.path, nil)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != c.status {
			t.Errorf("%s %s answered %d, want %d", c.method, c.path, res.StatusCode, c.status)
		}
	}
}

// TestCrossOrigin is a browser's requests from every kind of site, against
// the game's routes: unsafe requests from another origin are refused, safe
// ones never.
func TestCrossOrigin(t *testing.T) {
	srv := newTestServer(t, noGuests{}, nil)
	host := strings.TrimPrefix(srv.URL, "http://")
	cases := []struct {
		name          string
		method, path  string
		fetchSite     string
		origin        string
		crossOriginOK bool
	}{
		{"same origin", "POST", "/guest", "same-origin", "", true},
		{"typed or bookmarked", "POST", "/guest", "none", "", true},
		{"the website on the apex", "POST", "/guest", "same-site", "https://keelovertheedge.com", false},
		{"another site", "POST", "/guest", "cross-site", "https://evil.example", false},
		{"an old browser, same origin", "POST", "/guest", "", "http://" + host, true},
		{"an old browser, another origin", "POST", "/guest", "", "https://evil.example", false},
		{"neither header: not a browser", "POST", "/guest", "", "", true},
		{"a GET from another site", "GET", "/api/me", "cross-site", "https://evil.example", true},
		{"a GET of the version from another site", "GET", "/api/version", "cross-site", "", true},
		{"a HEAD from another site", "HEAD", "/api/version", "cross-site", "", true},
	}
	refused := 0
	for _, c := range cases {
		req, _ := http.NewRequest(c.method, srv.URL+c.path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		if c.fetchSite != "" {
			req.Header.Set("Sec-Fetch-Site", c.fetchSite)
		}
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		got := res.StatusCode != http.StatusForbidden
		if got != c.crossOriginOK {
			t.Errorf("%s: %d %s", c.name, res.StatusCode, body)
		}
		if !got {
			refused++
			if !strings.Contains(string(body), `"cross-origin"`) {
				t.Errorf("%s: refused with %s", c.name, body)
			}
		}
	}
	if n := testutil.ToFloat64(srv.metrics.CrossOriginRefused); int(n) != refused {
		t.Errorf("counted %v refusals, want %d", n, refused)
	}
}

func post(t *testing.T, c *http.Client, url, contentType, body string) (int, string, *http.Response) {
	t.Helper()
	if c == nil {
		c = http.DefaultClient
	}
	res, err := c.Post(url, contentType, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(b)), res
}

func TestGuestRefusesMalformed(t *testing.T) {
	srv := newTestServer(t, noGuests{}, nil)
	cases := []struct {
		name, contentType, body string
		status                  int
		code                    string
	}{
		{"a form", "application/x-www-form-urlencoded", "name=Ann&look=figure", 415, "content-type"},
		{"no type", "", `{"name":"Ann","look":"figure"}`, 415, "content-type"},
		{"an unknown member", "application/json", `{"name":"Ann","look":"figure","admin":true}`, 400, "malformed"},
		{"a name twice", "application/json", `{"name":"Ann","name":"Admin","look":"figure"}`, 400, "malformed"},
		{"invalid UTF-8", "application/json", "{\"name\":\"A\xffn\",\"look\":\"figure\"}", 400, "malformed"},
		{"not an object", "application/json", `["Ann"]`, 400, "malformed"},
		{"trailing data", "application/json", `{"name":"Ann","look":"figure"} {}`, 400, "malformed"},
		{"a look not in the catalog", "application/json", `{"name":"Ann","look":"pirate-king"}`, 400, "look"},
		{"too large", "application/json", `{"name":"` + strings.Repeat("A", 17<<10) + `","look":"figure"}`, 413, "too-large"},
		{"a short name", "application/json", `{"name":"Al","look":"figure"}`, 422, "short"},
		{"no name", "application/json", `{"look":"figure"}`, 422, "short"},
		{"a long name", "application/json", `{"name":"Abcdefghijklmnopqrstu","look":"figure"}`, 422, "long"},
		{"a symbol", "application/json", `{"name":"Ann ⚓","look":"figure"}`, 422, "characters"},
		{"mixed scripts", "application/json", `{"name":"Pаypal","look":"figure"}`, 422, "scripts"},
		{"a reserved name", "application/json", `{"name":"Harbourmaster","look":"figure"}`, 422, "words"},
	}
	for _, c := range cases {
		status, body, res := post(t, nil, srv.URL+"/guest", c.contentType, c.body)
		if status != c.status || body != `{"error":"`+c.code+`"}` {
			t.Errorf("%s: %d %s, want %d %s", c.name, status, body, c.status, c.code)
		}
		if res.Header.Get("Set-Cookie") != "" || res.Header.Get("Cache-Control") != "no-store" {
			t.Errorf("%s: headers %v", c.name, res.Header)
		}
	}
	for reason, want := range map[string]float64{"short": 2, "long": 1, "characters": 1, "scripts": 1, "words": 1, "taken": 0} {
		if got := testutil.ToFloat64(srv.metrics.GuestsRefused.WithLabelValues(reason)); got != want {
			t.Errorf("refused %s: %v, want %v", reason, got, want)
		}
	}
}

// TestBodyCutAtItsDeadline sends half a body and waits: the handler's read
// fails at the deadline, and the request is answered.
func TestBodyCutAtItsDeadline(t *testing.T) {
	srv := newTestServer(t, noGuests{}, func(c *Config) { c.ReadTimeout = 200 * time.Millisecond })
	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	start := time.Now()
	_, _ = io.WriteString(conn, "POST /guest HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"name\":")
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if took := time.Since(start); res.StatusCode != 400 || took < 200*time.Millisecond || took > 3*time.Second {
		t.Fatalf("%d after %v", res.StatusCode, took)
	}
}

func jar(t *testing.T) *http.Client {
	t.Helper()
	j, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: j}
}

// sessionCookie is the session cookie a response set.
func sessionCookie(res *http.Response) *http.Cookie {
	for _, c := range res.Cookies() {
		if c.Name == auth.CookieName {
			return c
		}
	}
	return nil
}

func get(t *testing.T, c *http.Client, url string, cookie *http.Cookie) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(b))
}

func TestGuest(t *testing.T) {
	st, _ := storetest.Store(t, store.Options{})
	srv := newTestServer(t, st, nil)
	c := http.DefaultClient

	if status, body := get(t, c, srv.URL+"/api/me", nil); status != 401 || body != `{"error":"session"}` {
		t.Fatalf("me without a session: %d %s", status, body)
	}
	status, body, res := post(t, c, srv.URL+"/guest", "application/json", `{"name":"  Ann   Bonny ","look":"figure"}`)
	if status != 201 || body != `{"name":"Ann Bonny","look":"figure"}` {
		t.Fatalf("guest: %d %s", status, body)
	}
	cookie := sessionCookie(res)
	if cookie == nil || !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" || cookie.MaxAge != 400*24*3600 {
		t.Fatalf("the cookie: %+v", cookie)
	}
	if status, body := get(t, c, srv.URL+"/api/me", cookie); status != 200 || body != `{"name":"Ann Bonny","look":"figure","kind":"human","saved":false}` {
		t.Fatalf("me: %d %s", status, body)
	}
	for name, v := range map[string]string{"unknown": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "malformed": "x"} {
		if status, _ := get(t, c, srv.URL+"/api/me", &http.Cookie{Name: auth.CookieName, Value: v}); status != 401 {
			t.Errorf("me with an %s cookie: %d", name, status)
		}
	}

	// With a session, no second guest.
	req, _ := http.NewRequest("POST", srv.URL+"/guest", strings.NewReader(`{"name":"Mary Read","look":"figure"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 409 || sessionCookie(res) != nil {
		t.Fatalf("a second guest: %d", res.StatusCode)
	}

	// The name, and its look-alikes, are taken.
	for _, name := range []string{"Ann Bonny", "ann-bonny", "AnnBonny", "Ann B0nny", "Ａｎｎ Ｂｏｎｎｙ"} {
		if status, body, _ := post(t, c, srv.URL+"/guest", "application/json", `{"name":"`+name+`","look":"figure"}`); status != 422 || body != `{"error":"taken"}` {
			t.Errorf("%q: %d %s", name, status, body)
		}
	}
	if n := testutil.ToFloat64(srv.metrics.GuestsCreated); n != 1 {
		t.Errorf("%v guests counted", n)
	}

	// The access log names the account, and holds no cookie, name or body.
	logs := srv.logs.String()
	if !strings.Contains(logs, `"route":"GET /api/me"`) || !strings.Contains(logs, `"account":"`) || !strings.Contains(logs, `"route":"POST /guest"`) {
		t.Errorf("the access log lacks the routes or the account:\n%s", logs)
	}
	for _, secret := range []string{cookie.Value, "Bonny", "figure", "Mary"} {
		if strings.Contains(logs, secret) {
			t.Errorf("the access log holds %q", secret)
		}
	}
}

// TestGuestsAtOnce makes two guests with one name at once: one is made and
// the other refused.
func TestGuestsAtOnce(t *testing.T) {
	st, _ := storetest.Store(t, store.Options{})
	srv := newTestServer(t, st, nil)
	var wg sync.WaitGroup
	statuses := make([]int, 8)
	for i := range statuses {
		wg.Go(func() {
			res, err := jar(t).Post(srv.URL+"/guest", "application/json", strings.NewReader(`{"name":"Calico Jack","look":"figure"}`))
			if err != nil {
				t.Error(err)
				return
			}
			res.Body.Close()
			statuses[i] = res.StatusCode
		})
	}
	wg.Wait()
	made := 0
	for _, s := range statuses {
		switch s {
		case 201:
			made++
		case 422:
		default:
			t.Errorf("status %d", s)
		}
	}
	if made != 1 {
		t.Fatalf("%d guests made with one name: %v", made, statuses)
	}
}
