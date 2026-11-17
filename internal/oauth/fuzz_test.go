// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// What AI apps send the authorization server, from their servers or an
// owner's browser, with whatever a fuzzer makes of it: the authorize
// query, the token and revoke forms, a registration, a redirect URI
// against a client's list, a client's metadata document and a token's
// shape. No target needs a database or the network, and each one's seeds
// are the tests' own requests, so they run with every other test.

const (
	fuzzIssuer   = "https://play.example.com"
	fuzzResource = "https://agents.example.com/mcp"
	// fuzzRegistered is a client that registered itself, and fuzzDocument
	// one known by its metadata document, cached.
	fuzzRegistered = "keelote_cl_0123456789ABCDEFGHIJKL"
	fuzzDocument   = "https://app.example/oauth/client.json"
	fuzzRedirect   = "https://app.example/callback"
	fuzzLoopback   = "http://127.0.0.1/callback"
	fuzzChallenge  = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
)

// fuzzStore is the store as far as the routes fuzzed reach it: the two
// clients, requests kept, registrations kept, and every code and token
// unknown. Any other method would panic, as a fault of the test.
type fuzzStore struct {
	Store
	mu    sync.Mutex
	saved []store.AuthRequest
}

func (*fuzzStore) Client(_ context.Context, id string) (store.Client, error) {
	if id == fuzzRegistered {
		return store.Client{ID: id, Name: "Registered", RedirectURIs: []string{fuzzRedirect, fuzzLoopback}}, nil
	}
	return store.Client{}, store.ErrNotFound
}

func (*fuzzStore) ClientUsed(context.Context, string) error           { return nil }
func (*fuzzStore) RegisterClient(context.Context, store.Client) error { return nil }
func (*fuzzStore) UseCode(context.Context, [32]byte) (store.CodeGrant, error) {
	return store.CodeGrant{}, store.ErrNotFound
}

func (*fuzzStore) Refresh(context.Context, store.Refresh) (store.Refreshed, error) {
	return store.Refreshed{}, store.ErrNotFound
}

func (*fuzzStore) RevokeToken(context.Context, [32]byte, string) (store.Revoked, error) {
	return store.Revoked{}, store.ErrNotFound
}

func (s *fuzzStore) SaveRequest(_ context.Context, r store.AuthRequest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saved = append(s.saved[:0], r)
	return nil
}

// last is the request the authorize route kept last, and forgets it.
func (s *fuzzStore) last() (store.AuthRequest, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.saved) == 0 {
		return store.AuthRequest{}, false
	}
	r := s.saved[0]
	s.saved = s.saved[:0]
	return r, true
}

// fuzzServer is the authorization server on fuzzStore, with the document's
// client cached and every fetch refused before it leaves the machine.
func fuzzServer(f *testing.F) (*Server, *fuzzStore) {
	f.Helper()
	st := &fuzzStore{}
	fetcher := NewFetcher(FetcherOptions{})
	fetcher.Transport().DialContext = func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("no network in a fuzz test")
	}
	s := New(Config{
		Issuer: fuzzIssuer, Resource: fuzzResource, Store: st, Fetcher: fetcher,
		Lifetime: NewLifetime(DefaultLifetime), Grants: NewGrants(nil, NewLifetime(DefaultLifetime), time.UTC, time.Now),
		Log: slog.New(slog.DiscardHandler), Metrics: obs.NewMetrics("test", "cat"), RegistrationsPerHour: 1 << 30,
	})
	s.clients.cache.put(fuzzDocument, Client{ID: fuzzDocument, Name: "An app", RedirectURIs: []string{fuzzRedirect}, Host: "app.example"},
		24*time.Hour, time.Now())
	return s, st
}

// FuzzAuthorize: GET /oauth/authorize's query never panics. It is
// answered by a page that refuses it, by a return to a redirect URI the
// client listed with the issuer named, or by the approval page, the
// request kept with its client's listed redirect, a PKCE challenge and a
// state of at most MaxState.
func FuzzAuthorize(f *testing.F) {
	s, st := fuzzServer(f)
	good := url.Values{
		"client_id": {fuzzRegistered}, "redirect_uri": {fuzzRedirect}, "response_type": {"code"}, "state": {"xyz"},
		"code_challenge": {fuzzChallenge}, "code_challenge_method": {"S256"}, "scope": {"sail"}, "resource": {fuzzResource},
	}
	f.Add(good.Encode())
	for _, change := range []url.Values{
		{"client_id": {fuzzDocument}},
		{"redirect_uri": {"http://127.0.0.1:51234/callback"}},
		{"client_id": {fuzzRegistered, fuzzRegistered}},
		{"client_id": {"https://other.example/client.json"}},
		{"client_id": {"keelote_cl_0000000000000000000000"}},
		{"redirect_uri": {"https://app.example/callback/"}},
		{"code_challenge": nil, "code_challenge_method": nil},
		{"code_challenge_method": {"plain"}},
		{"code_challenge": {"abc"}},
		{"response_type": {"token"}},
		{"resource": {"https://agents.example.com/other"}},
		{"state": {strings.Repeat("s", MaxState+1)}},
	} {
		q := url.Values{}
		for k, v := range good {
			q[k] = v
		}
		for k, v := range change {
			if v == nil {
				delete(q, k)
			} else {
				q[k] = v
			}
		}
		f.Add(q.Encode())
	}
	f.Add("client_id=%zz")
	// The good request reaches the approval page, by either client, so
	// the fuzzer starts from every check passed.
	for _, id := range []string{fuzzRegistered, fuzzDocument} {
		q := url.Values{}
		for k, v := range good {
			q[k] = v
		}
		q.Set("client_id", id)
		w := httptest.NewRecorder()
		s.authorize(w, httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+q.Encode(), nil))
		if _, ok := st.last(); w.Code != http.StatusSeeOther || !ok {
			f.Fatalf("the good request by %s answered %d", id, w.Code)
		}
	}
	f.Fuzz(func(t *testing.T, query string) {
		r := httptest.NewRequest(http.MethodGet, "/oauth/authorize", nil)
		r.URL.RawQuery = query
		w := httptest.NewRecorder()
		s.authorize(w, r)
		kept, ok := st.last()
		switch w.Code {
		case http.StatusBadRequest, http.StatusServiceUnavailable:
			if ok {
				t.Fatalf("%q refused, but kept", query)
			}
		case http.StatusFound:
			back, err := url.Parse(w.Header().Get("Location"))
			if err != nil || back.Query().Get("iss") != fuzzIssuer || back.Query().Get("error") == "" || ok {
				t.Fatalf("%q sent back to %q", query, w.Header().Get("Location"))
			}
			q := back.Query()
			for _, k := range []string{"error", "error_description", "state", "iss"} {
				q.Del(k)
			}
			back.RawQuery = q.Encode()
			if !matchRedirect(back.String(), []string{fuzzRedirect, fuzzLoopback}) {
				t.Fatalf("%q sent back to %q, not a listed redirect", query, back)
			}
		case http.StatusSeeOther:
			if !ok || !matchRedirect(kept.RedirectURI, []string{fuzzRedirect, fuzzLoopback}) ||
				len(kept.CodeChallenge) != 43 || !unreserved(kept.CodeChallenge) || len(kept.State) > MaxState {
				t.Fatalf("%q kept as %+v", query, kept)
			}
		default:
			t.Fatalf("%q answered %d", query, w.Code)
		}
	})
}

// FuzzTokenForm: POST /oauth/token's and /oauth/revoke's forms never
// panic. Every code and token being unknown, the token route answers an
// OAuth error, and the revoke route 200 or an OAuth error, never a token.
func FuzzTokenForm(f *testing.F) {
	s, _ := fuzzServer(f)
	for _, v := range []url.Values{
		{"grant_type": {"authorization_code"}, "client_id": {fuzzRegistered}, "redirect_uri": {fuzzRedirect},
			"code_verifier": {strings.Repeat("v", 43)}, "code": {strings.Repeat("c", 43)}},
		{"grant_type": {"authorization_code"}, "code": {strings.Repeat("c", 43)}, "client_id": {"keelote_cl_0000000000000000000000"}},
		{"grant_type": {"client_credentials"}, "client_id": {fuzzRegistered}},
		{"grant_type": {"refresh_token"}, "refresh_token": {"keelote_rt_" + strings.Repeat("0", 49)}, "client_id": {fuzzRegistered}},
		{"grant_type": {"authorization_code"}, "client_id": {fuzzRegistered}, "client_secret": {"x"}},
		{"grant_type": {"authorization_code"}, "client_id": {fuzzRegistered}, "resource": {fuzzResource + "/"}},
		{"token": {"keelote_at_" + strings.Repeat("0", 49)}, "client_id": {fuzzRegistered}},
		{"grant_type": {"authorization_code", "refresh_token"}},
	} {
		f.Add(v.Encode())
	}
	if tok, _ := NewToken(KindRefresh); tok != "" {
		f.Add(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok}, "client_id": {fuzzRegistered}}.Encode())
	}
	f.Add("grant_type=%zz")
	f.Fuzz(func(t *testing.T, form string) {
		for _, route := range []func(http.ResponseWriter, *http.Request){s.token, s.revoke} {
			r := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form))
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			w := httptest.NewRecorder()
			route(w, r)
			if w.Code == http.StatusOK && w.Body.Len() == 0 {
				continue // revoked, or nothing to revoke
			}
			var e oauthError
			if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil || e.Error == "" || w.Code < 400 {
				t.Fatalf("%q answered %d %s", form, w.Code, w.Body)
			}
		}
	})
}

// FuzzRegister: POST /oauth/register's body never panics; a client
// registered has a client ID the game issued, a name of 1 to 100
// characters with no control character, and 1 to 10 redirect URIs it
// accepts; every other answer is an OAuth error.
func FuzzRegister(f *testing.F) {
	s, _ := fuzzServer(f)
	for _, b := range []string{
		`{"client_name":"Registered","redirect_uris":["https://app.example/callback"]}`,
		`{"redirect_uris":["https://oauth-redirect.googleusercontent.com/r/x"],"token_endpoint_auth_method":"client_secret_basic","scope":"x"}`,
		`{"redirect_uris":["cursor://x/cb"]}`,
		`{"redirect_uris":["http://app.example/cb"]}`,
		`{"redirect_uris":["https://a.example/cb"],"response_types":["token"]}`,
		`redirect_uris=x`,
		`{"redirect_uris":["http://localhost/cb"],"client_name":"Gemini CLI"}`,
		`{"redirect_uris":["http://localhost/cb"],"client_name":"\u0007"}`,
		`{"redirect_uris":[],"grant_types":["implicit"]}`,
	} {
		f.Add([]byte(b))
	}
	f.Fuzz(func(t *testing.T, body []byte) {
		r := httptest.NewRequest(http.MethodPost, "/oauth/register", bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		s.register(w, r)
		if w.Code != http.StatusCreated {
			var e oauthError
			if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil || e.Error == "" {
				t.Fatalf("%q answered %d %s", body, w.Code, w.Body)
			}
			return
		}
		var out registered
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		n := utf8.RuneCountInString(out.ClientName)
		if !Registered(out.ClientID) || n == 0 || n > MaxClientName || !redirectList(out.RedirectURIs) ||
			strings.ContainsFunc(out.ClientName, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
			t.Fatalf("%q registered as %+v", body, out)
		}
	})
}

// FuzzRedirect: a redirect URI against a client's list never panics; one
// matched is one the game accepts; one matched that is not on this
// computer is listed character for character; the answer sent to one
// matched keeps it and names the issuer.
func FuzzRedirect(f *testing.F) {
	listed := "https://claude.ai/api/mcp/auth_callback\nhttp://localhost/callback\nhttp://127.0.0.1/callback?x=1\nhttp://[::1]:9000/oauth_callback"
	for _, uri := range []string{
		"https://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback/", "https://Claude.ai/api/mcp/auth_callback",
		"https://claude.ai:443/api/mcp/auth_callback", "http://localhost:51234/callback", "http://LOCALHOST:51234/callback",
		"http://127.0.0.1:8080/callback?x=1", "http://[::1]/oauth_callback", "http://localhost.example.com/callback",
		"http://localhost:51234/callback#f", "http://user@localhost/callback", "cursor://anysphere.cursor-retrieval/oauth/callback", "",
	} {
		f.Add(uri, listed)
	}
	s := &Server{cfg: Config{Issuer: fuzzIssuer}}
	f.Fuzz(func(t *testing.T, requested, list string) {
		l := strings.Split(list, "\n")
		host, loop := returnHost(requested)
		if !matchRedirect(requested, l) {
			return
		}
		accepted, ok := redirectURI(requested)
		if !ok || accepted != loop || loop && host != "" {
			t.Fatalf("%q matched %q but is not a redirect accepted", requested, l)
		}
		if !loop {
			found := false
			for _, x := range l {
				found = found || x == requested
			}
			if !found {
				t.Fatalf("%q matched %q but is not on it", requested, l)
			}
		}
		back, err := url.Parse(s.callback(requested, url.Values{"code": {"c"}}))
		if err != nil || back.Query().Get("iss") != fuzzIssuer || back.Query().Get("code") != "c" {
			t.Fatalf("%q answered at %v (%v)", requested, back, err)
		}
	})
}

// FuzzClientDocument: a client ID and the metadata document fetched from
// it never panic; a client ID read as one is https, by a name, on 443,
// with a path and no query; a document read names that client ID exactly,
// a name of 1 to 100 characters with no control character, and 1 to 10
// redirect URIs the game accepts.
func FuzzClientDocument(f *testing.F) {
	for _, c := range []struct{ id, doc string }{
		{fuzzDocument, `{"client_id":"` + fuzzDocument + `","client_name":"An app","redirect_uris":["https://app.example/callback"]}`},
		{fuzzDocument, `{"client_id":"` + fuzzDocument + `","client_name":"An app","redirect_uris":["https://app.example/callback"],"token_endpoint_auth_method":"private_key_jwt"}`},
		{fuzzDocument, `{"client_id":"` + fuzzDocument + `","client_name":"An app","redirect_uris":["https://app.example/callback"],"token_endpoint_auth_method":"client_secret_basic"}`},
		{fuzzDocument, `{"client_id":"https://app.example/other.json","client_name":"An app","redirect_uris":["https://app.example/callback"]}`},
		{fuzzDocument, `{"client_id":"` + fuzzDocument + `","client_name":"","redirect_uris":[]}`},
		{"https://app.example:8443/client.json", `{}`},
		{"https://192.0.2.1/client.json", `{}`},
		{"https://app.example/", `{}`},
		{"https://app.example/a/../client.json", `{}`},
		{"https://user@app.example/client.json?x=1", `null`},
	} {
		f.Add(c.id, []byte(c.doc))
	}
	fetcher := NewFetcher(FetcherOptions{})
	f.Fuzz(func(t *testing.T, id string, doc []byte) {
		if u, ok := fetcher.clientIDURL(id); ok {
			if u.Scheme != "https" || isIP(u.Hostname()) || u.Port() != "" && u.Port() != "443" || u.RawQuery != "" ||
				u.Path == "" || u.Path == "/" || len(id) > MaxClientID {
				t.Fatalf("%q read as a client ID", id)
			}
		}
		cl, err := parseDocument(id, "app.example", doc)
		if err != nil {
			if _, ok := errors.AsType[*clientError](err); !ok {
				t.Fatalf("a document refused, but not as the client's fault: %v", err)
			}
			return
		}
		n := utf8.RuneCountInString(cl.Name)
		if cl.ID != id || n == 0 || n > MaxClientName || !redirectList(cl.RedirectURIs) || cl.Registered ||
			strings.ContainsFunc(cl.Name, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
			t.Fatalf("%q read as %+v", doc, cl)
		}
	})
}

// FuzzParseToken: a token as an app presents it, a connection token
// among them, never panics; one read has the game's shape, a kind of the
// three, and a checksum of all before it, its hash that of the whole
// string; a code read is 32 bytes.
func FuzzParseToken(f *testing.F) {
	for _, kind := range []string{KindAccess, KindRefresh, KindConnection} {
		tok, _ := NewToken(kind)
		f.Add(tok)
		f.Add(tok[:len(tok)-1] + "0")
		f.Add(strings.ToUpper(tok))
	}
	f.Add(NewClientID())
	f.Add("keelote_xx_" + strings.Repeat("0", 49))
	f.Add("")
	code, _ := newCode()
	f.Add(code)
	f.Fuzz(func(t *testing.T, tok string) {
		if kind, hash, ok := ParseToken(tok); ok {
			body := tok[:len(tok)-checkChars]
			if len(tok) != TokenLen || !strings.HasPrefix(tok, tokenPrefix+kind+"_") || checksum(body) != tok[len(body):] ||
				kind != KindAccess && kind != KindRefresh && kind != KindConnection {
				t.Fatalf("%q read as a token of kind %q", tok, kind)
			}
			if h, ok := codeHash(tok); ok || h != [32]byte{} || hash == [32]byte{} {
				t.Fatalf("%q read as a code too", tok)
			}
		}
		if _, ok := codeHash(tok); ok && len(tok) != 43 {
			t.Fatalf("%q read as a code", tok)
		}
		if Registered(tok) && !strings.HasPrefix(tok, tokenPrefix+KindClient+"_") {
			t.Fatalf("%q read as a client ID", tok)
		}
	})
}
