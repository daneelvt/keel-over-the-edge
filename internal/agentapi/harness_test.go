// SPDX-License-Identifier: AGPL-3.0-only

package agentapi_test

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/agentapi"
	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/auth/softkey"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// The game's two listeners for AI apps' tests, on the test database: the
// play listener, with the authorization server and the game's account
// routes, and the agents' listener, with the MCP address. A third server,
// over TLS on loopback, serves client metadata documents, which the
// fetcher's test option lets it reach.

const (
	testRPID   = "localhost"
	testOrigin = "http://localhost"
	boatKind   = "test-boat"
)

var testLooks = oauth.MachineLooks{
	Versions: []oauth.LookOption{{ID: "v1", Name: "first"}, {ID: "v2", Name: "second"}},
	Finishes: []oauth.LookOption{{ID: "f1", Name: "Tin", Colour: "#999999"}},
	Colours:  []oauth.LookOption{{ID: "c1", Name: "deep red", Colour: "#9e2b25"}, {ID: "c2", Name: "navy blue", Colour: "#24406b"}},
}

// syncBuffer is a log written by the servers and read by the test.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type harness struct {
	t        *testing.T
	st       *store.Store
	db       string
	play     *httptest.Server
	agents   *httptest.Server
	docs     *httptest.Server
	origin   string
	resource string
	lifetime *oauth.Lifetime
	grants   *oauth.Grants
	metrics  *obs.Metrics
	logs     *syncBuffer
	// documents are the documents served, by path.
	docMu     sync.Mutex
	documents map[string]docAnswer
	fetched   map[string]int
	// clock is the servers' time, now unless moved.
	clockMu sync.Mutex
	offset  time.Duration
}

type docAnswer struct {
	status int
	body   string
	header map[string]string
	delay  time.Duration
}

type harnessOptions struct {
	registrations int
	fetches       int
}

func (h *harness) now() time.Time {
	h.clockMu.Lock()
	defer h.clockMu.Unlock()
	return time.Now().Add(h.offset)
}

// later moves the servers' clock on.
func (h *harness) later(d time.Duration) {
	h.clockMu.Lock()
	defer h.clockMu.Unlock()
	h.offset += d
}

func listen(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return ln
}

func newHarness(t *testing.T, opt ...harnessOptions) *harness {
	t.Helper()
	var o harnessOptions
	if len(opt) > 0 {
		o = opt[0]
	}
	st, u := storetest.Store(t, store.Options{})
	h := &harness{t: t, st: st, db: u, logs: &syncBuffer{}, documents: map[string]docAnswer{}, fetched: map[string]int{}}
	h.metrics = obs.NewMetrics("test", "cat")
	log := obs.NewLogger(h.logs, slog.LevelInfo, "test")

	h.docs = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.docMu.Lock()
		d, ok := h.documents[r.URL.Path]
		h.fetched[r.URL.Path]++
		h.docMu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		time.Sleep(d.delay)
		w.Header().Set("Content-Type", "application/json")
		for k, v := range d.header {
			w.Header().Set(k, v)
		}
		if d.status != 0 {
			w.WriteHeader(d.status)
		}
		_, _ = io.WriteString(w, d.body)
	}))
	t.Cleanup(h.docs.Close)

	playLn, agentsLn := listen(t), listen(t)
	h.origin = "http://localhost:" + port(playLn)
	h.resource = "http://localhost:" + port(agentsLn) + "/mcp"
	passkeys, err := auth.NewPasskeys(testRPID, []string{testOrigin})
	if err != nil {
		t.Fatal(err)
	}
	h.lifetime = oauth.NewLifetime(oauth.DefaultLifetime)
	h.grants = oauth.NewGrants(st, h.lifetime, time.UTC, h.now)
	fetcher := oauth.NewFetcher(oauth.FetcherOptions{Loopback: true, PerMinute: o.fetches, Timeout: time.Second})
	pool := x509.NewCertPool()
	pool.AddCert(h.docs.Certificate())
	fetcher.Transport().TLSClientConfig = &tls.Config{RootCAs: pool}
	server := oauth.New(oauth.Config{
		Issuer: h.origin, Resource: h.resource, Store: st, Passkeys: passkeys, Fetcher: fetcher,
		Lifetime: h.lifetime, Grants: h.grants, Looks: testLooks, Boat: boatKind, Build: "test",
		Log: log, Metrics: h.metrics, Now: h.now, RegistrationsPerHour: o.registrations,
		Page: func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "the approval page") },
	})
	play := api.Handler(api.Config{
		Version: api.Version{Build: "test", Catalog: "cat"}, Log: log, Metrics: h.metrics,
		Accounts: st, Sessions: auth.NewCache(st, auth.CacheConfig{}), Passkeys: passkeys, Looks: []string{"figure"},
		Boat: boatKind, OAuth: server, Grants: h.grants, MCP: h.resource, Lifetime: h.lifetime, MachineLooks: testLooks,
		Machines: st,
	})
	h.play = httptest.NewUnstartedServer(play)
	h.play.Listener.Close()
	h.play.Listener = playLn
	h.play.Start()
	t.Cleanup(h.play.Close)

	usage := agentapi.NewUsage(st, log)
	agents, err := agentapi.Handler(agentapi.Config{
		Resource: h.resource, Issuer: h.origin, Grants: h.grants, Used: usage.Used, Build: "test", Log: log, Metrics: h.metrics,
	})
	if err != nil {
		t.Fatal(err)
	}
	h.agents = httptest.NewUnstartedServer(agents)
	h.agents.Listener.Close()
	h.agents.Listener = agentsLn
	h.agents.Start()
	t.Cleanup(h.agents.Close)
	return h
}

func port(ln net.Listener) string {
	_, p, _ := net.SplitHostPort(ln.Addr().String())
	return p
}

// document serves a client's metadata document and returns its client ID.
func (h *harness) document(path string, d docAnswer) string {
	h.docMu.Lock()
	defer h.docMu.Unlock()
	h.documents[path] = d
	return h.docs.URL + path
}

func (h *harness) fetchedCount(path string) int {
	h.docMu.Lock()
	defer h.docMu.Unlock()
	return h.fetched[path]
}

// clientDoc is a client's document, naming the client ID it is served at.
func clientDoc(id string, redirects ...string) string {
	b, _ := json.Marshal(map[string]any{"client_id": id, "client_name": "Test App", "redirect_uris": redirects, "token_endpoint_auth_method": "none"})
	return string(b)
}

// browserJar keeps cookies as a browser on localhost does: Secure ones
// too, over plain HTTP.
type browserJar struct {
	mu sync.Mutex
	by map[string]*http.Cookie
}

func (j *browserJar) SetCookies(_ *url.URL, cs []*http.Cookie) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, c := range cs {
		if c.MaxAge < 0 {
			delete(j.by, c.Name)
			continue
		}
		j.by[c.Name] = &http.Cookie{Name: c.Name, Value: c.Value}
	}
}

func (j *browserJar) Cookies(*url.URL) []*http.Cookie {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]*http.Cookie, 0, len(j.by))
	for _, c := range j.by {
		out = append(out, c)
	}
	return out
}

// browser is a player's browser: its cookies and the passkeys it holds.
type browser struct {
	t    *testing.T
	h    *harness
	jar  *browserJar
	c    *http.Client
	keys []*softkey.Key
}

func (h *harness) browser() *browser {
	jar := &browserJar{by: map[string]*http.Cookie{}}
	return &browser{t: h.t, h: h, jar: jar, c: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}}
}

// do sends a request to the play listener with a JSON body, or none for "".
func (b *browser) do(method, path, body string) (int, string, http.Header) {
	b.t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	target := path
	if !strings.HasPrefix(path, "http") {
		target = b.h.origin + path
	}
	req, _ := http.NewRequest(method, target, r)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := b.c.Do(req)
	if err != nil {
		b.t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(out)), res.Header
}

func (b *browser) post(path, body string) (int, string) {
	s, out, _ := b.do("POST", path, body)
	return s, out
}

// sailor makes a player's sailor with a new passkey, signed in.
func (b *browser) sailor(name string) {
	b.t.Helper()
	status, opts := b.post("/account/begin", `{"name":"`+name+`","look":"figure"}`)
	if status != 200 {
		b.t.Fatalf("begin: %d %s", status, opts)
	}
	key, answer, err := softkey.Create([]byte(opts), testOrigin)
	if err != nil {
		b.t.Fatal(err)
	}
	if status, body := b.post("/account/finish", string(answer)); status != 201 {
		b.t.Fatalf("finish: %d %s", status, body)
	}
	b.keys = append(b.keys, key)
}

// signOut ends the game session, keeping the passkey: an app's sign-in
// window has none.
func (b *browser) signOut() {
	b.t.Helper()
	b.jar.mu.Lock()
	delete(b.jar.by, auth.CookieName)
	b.jar.mu.Unlock()
}

// passkey answers the approval's passkey ceremony with the browser's
// newest passkey.
func (b *browser) passkey() (int, string) {
	b.t.Helper()
	status, opts := b.post("/oauth/approve/begin", "")
	if status != 200 {
		return status, opts
	}
	answer, err := b.keys[len(b.keys)-1].Get([]byte(opts))
	if err != nil {
		b.t.Fatal(err)
	}
	return b.post("/oauth/approve/finish", string(answer))
}

// pkcePair is a code verifier and its S256 challenge.
func pkcePair(seed string) (verifier, challenge string) {
	verifier = strings.Repeat(seed, 43/len(seed)+1)[:43]
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// authorizeURL is an authorization request's address.
func (h *harness) authorizeURL(clientID, redirect, state, challenge string, extra url.Values) string {
	q := url.Values{
		"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirect}, "state": {state},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "resource": {h.resource},
	}
	for k, v := range extra {
		if len(v) == 0 {
			delete(q, k)
		} else {
			q[k] = v
		}
	}
	return h.origin + "/oauth/authorize?" + q.Encode()
}

// approved runs an authorization request through the approval page, the
// browser signed in by its passkey, approving for a machine sailor made
// there (make) or one of the player's (machine), and returns the redirect.
func (b *browser) approved(authorize string, approve string) *url.URL {
	b.t.Helper()
	status, body, _ := b.do("GET", authorize, "")
	if status != 200 || body != "the approval page" {
		b.t.Fatalf("authorize: %d %s", status, body)
	}
	if status, body := b.passkey(); status != 200 {
		b.t.Fatalf("the approval's passkey: %d %s", status, body)
	}
	status, body = b.post("/oauth/approve", approve)
	if status != 200 {
		b.t.Fatalf("approve: %d %s", status, body)
	}
	var out struct{ Redirect string }
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		b.t.Fatal(err)
	}
	u, err := url.Parse(out.Redirect)
	if err != nil {
		b.t.Fatal(err)
	}
	return u
}

// form posts a form to the play listener, as an app's server does.
func (h *harness) form(path string, v url.Values) (int, map[string]any) {
	h.t.Helper()
	res, err := http.Post(h.origin+path, "application/x-www-form-urlencoded", strings.NewReader(v.Encode()))
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	body, _ := io.ReadAll(res.Body)
	_ = json.Unmarshal(body, &out)
	return res.StatusCode, out
}

const makeAnn = `{"make":{"name":"Iron Mary","version":"v1","finish":"f1","colour":"c1"}}`
