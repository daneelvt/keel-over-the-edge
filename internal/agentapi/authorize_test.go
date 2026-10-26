// SPDX-License-Identifier: AGPL-3.0-only

package agentapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// app is an AI app registered with the game.
type app struct{ id, redirect string }

func (h *harness) register(redirect string) app {
	h.t.Helper()
	res, err := http.Post(h.origin+"/oauth/register", "application/json",
		strings.NewReader(`{"client_name":"Registered","redirect_uris":["`+redirect+`"]}`))
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	var out struct {
		ClientID string `json:"client_id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil || res.StatusCode != 201 {
		h.t.Fatalf("register: %d %v", res.StatusCode, err)
	}
	return app{out.ClientID, redirect}
}

// grant approves an app for the player on the approval page and exchanges
// the code, returning the access and refresh tokens.
func (h *harness) grant(b *browser, a app, approve string) (access, refresh string) {
	h.t.Helper()
	verifier, challenge := pkcePair("v3rifier")
	u := b.approved(h.authorizeURL(a.id, a.redirect, "s", challenge, nil), approve)
	status, tok := h.form("/oauth/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {u.Query().Get("code")}, "client_id": {a.id},
		"redirect_uri": {a.redirect}, "code_verifier": {verifier}, "resource": {h.resource},
	})
	if status != 200 {
		h.t.Fatalf("token: %d %v", status, tok)
	}
	return tok["access_token"].(string), tok["refresh_token"].(string)
}

// TestMetadata: the authorization server's metadata, as MCP's apps read
// it, and the resource's, at its path-inserted address and the root.
func TestMetadata(t *testing.T) {
	h := newHarness(t)
	res, err := http.Get(h.origin + "/.well-known/oauth-authorization-server")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.NewDecoder(res.Body).Decode(&m)
	res.Body.Close()
	want := map[string]any{
		"issuer": h.origin, "authorization_endpoint": h.origin + "/oauth/authorize", "token_endpoint": h.origin + "/oauth/token",
		"revocation_endpoint": h.origin + "/oauth/revoke", "registration_endpoint": h.origin + "/oauth/register",
		"client_id_metadata_document_supported": true, "authorization_response_iss_parameter_supported": true,
	}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("%s: %v, want %v", k, m[k], v)
		}
	}
	for k, v := range map[string]string{
		"response_types_supported": "code", "grant_types_supported": "authorization_code refresh_token",
		"code_challenge_methods_supported": "S256", "token_endpoint_auth_methods_supported": "none",
		"revocation_endpoint_auth_methods_supported": "none", "scopes_supported": "sail",
	} {
		var got []string
		for _, x := range m[k].([]any) {
			got = append(got, x.(string))
		}
		if strings.Join(got, " ") != v {
			t.Errorf("%s: %v", k, got)
		}
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "*" || res.Header.Get("Cache-Control") != "public, max-age=300" {
		t.Errorf("headers: %v", res.Header)
	}
	for _, path := range []string{"/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"} {
		u, _ := url.Parse(h.resource)
		res, err := http.Get(u.Scheme + "://" + u.Host + path)
		if err != nil {
			t.Fatal(err)
		}
		var r map[string]any
		_ = json.NewDecoder(res.Body).Decode(&r)
		res.Body.Close()
		if res.StatusCode != 200 || r["resource"] != h.resource || r["authorization_servers"].([]any)[0] != h.origin ||
			r["scopes_supported"].([]any)[0] != "sail" || r["bearer_methods_supported"].([]any)[0] != "header" ||
			res.Header.Get("Access-Control-Allow-Origin") != "*" {
			t.Errorf("%s: %d %v", path, res.StatusCode, r)
		}
	}
}

// TestAuthorizeRefusals: a request the game cannot send back to its app
// is refused on the page, never redirected; once the redirect is the
// app's own, every refusal returns to it with the state and the issuer.
func TestAuthorizeRefusals(t *testing.T) {
	h := newHarness(t)
	a := h.register("https://app.example/cb")
	b := h.browser()
	_, challenge := pkcePair("abc")
	for name, c := range map[string]struct {
		client, redirect string
		extra            url.Values
	}{
		"an unknown client":       {"keelote_cl_0000000000000000000000", a.redirect, nil},
		"a client ID not https":   {"http://app.example/client.json", a.redirect, nil},
		"a document not there":    {h.docs.URL + "/none.json", a.redirect, nil},
		"a redirect not listed":   {a.id, "https://evil.example/cb", nil},
		"no redirect":             {a.id, "", nil},
		"no client":               {"", a.redirect, nil},
		"two client IDs":          {a.id, a.redirect, url.Values{"client_id": {a.id, a.id}}},
		"a redirect with a slash": {a.id, a.redirect + "/", nil},
	} {
		status, body, hdr := b.do("GET", h.authorizeURL(c.client, c.redirect, "s", challenge, c.extra), "")
		if status < 400 || hdr.Get("Location") != "" || !strings.Contains(body, "Keel Over the Edge") || hdr.Get("Content-Security-Policy") == "" {
			t.Errorf("%s: %d %q %s", name, status, hdr.Get("Location"), body)
		}
	}
	for name, c := range map[string]struct {
		extra url.Values
		code  string
	}{
		"no PKCE":              {url.Values{"code_challenge": nil, "code_challenge_method": nil}, "invalid_request"},
		"plain PKCE":           {url.Values{"code_challenge_method": {"plain"}}, "invalid_request"},
		"a short challenge":    {url.Values{"code_challenge": {"abc"}}, "invalid_request"},
		"a token response":     {url.Values{"response_type": {"token"}}, "unsupported_response_type"},
		"another resource":     {url.Values{"resource": {"https://other.example/mcp"}}, "invalid_target"},
		"two resources":        {url.Values{"resource": {h.resource, h.resource}}, "invalid_request"},
		"a state too long":     {url.Values{"state": {strings.Repeat("s", 513)}}, "invalid_request"},
		"two scopes parameter": {url.Values{"scope": {"sail", "sail"}}, "invalid_request"},
	} {
		status, _, hdr := b.do("GET", h.authorizeURL(a.id, a.redirect, "s", challenge, c.extra), "")
		u, _ := url.Parse(hdr.Get("Location"))
		q := u.Query()
		wantState := "s"
		if name == "a state too long" {
			wantState = ""
		}
		if status != 302 || !strings.HasPrefix(u.String(), a.redirect+"?") || q.Get("error") != c.code || q.Get("iss") != h.origin ||
			q.Get("state") != wantState || q.Get("error_description") == "" {
			t.Errorf("%s: %d %s", name, status, u)
		}
	}
	// The resource absent, or with one trailing slash, is the MCP address.
	for _, r := range []url.Values{{"resource": nil}, {"resource": {h.resource + "/"}}} {
		if status, body, _ := b.do("GET", h.authorizeURL(a.id, a.redirect, "s", challenge, r), ""); status != 200 || body != "the approval page" {
			t.Errorf("resource %v: %d %s", r, status, body)
		}
	}
	if testutil.ToFloat64(h.metrics.OAuthAuthorize.WithLabelValues("refused")) != 16 || testutil.ToFloat64(h.metrics.OAuthAuthorize.WithLabelValues("shown")) != 2 {
		t.Errorf("counted: %v refused, %v shown", testutil.ToFloat64(h.metrics.OAuthAuthorize.WithLabelValues("refused")),
			testutil.ToFloat64(h.metrics.OAuthAuthorize.WithLabelValues("shown")))
	}
}

// TestApprovalPage: the page's request is held under its cookie; its
// passkey names the account with no game session made; the page shows the
// app, where it returns, the account's machine sailors; approving gives a
// code with the state and issuer, denying access_denied with both; the
// request is used once.
func TestApprovalPage(t *testing.T) {
	h := newHarness(t)
	b := h.browser()
	b.sailor("Ann Bonny")
	b.signOut()
	doc := h.document("/claude.json", docAnswer{body: clientDoc(h.docs.URL+"/claude.json", "https://claude.ai/api/mcp/auth_callback")})
	_, challenge := pkcePair("xyz")
	status, body, hdr := b.do("GET", h.authorizeURL(doc, "https://claude.ai/api/mcp/auth_callback", "st", challenge, nil), "")
	if status != 200 || !strings.Contains(hdr.Get("Content-Security-Policy"), "frame-ancestors 'none'") || hdr.Get("X-Frame-Options") != "DENY" ||
		hdr.Get("Referrer-Policy") != "no-referrer" || hdr.Get("Cache-Control") != "no-store" {
		t.Fatalf("the page: %d %s %v", status, body, hdr)
	}
	if !strings.Contains(hdr.Get("Set-Cookie"), oauth.RequestCookie) || !strings.Contains(hdr.Get("Set-Cookie"), "SameSite=Strict") ||
		!strings.Contains(hdr.Get("Set-Cookie"), "HttpOnly") {
		t.Fatalf("its cookie: %s", hdr.Get("Set-Cookie"))
	}
	_, req, _ := b.do("GET", "/oauth/request", "")
	var page map[string]any
	_ = json.Unmarshal([]byte(req), &page)
	client := page["client"].(map[string]any)
	if client["name"] != "Test App" || client["vouchedBy"] != "127.0.0.1" || client["registered"] != false ||
		page["returnHost"] != "claude.ai" || page["loopback"] != false || page["signedIn"] != nil {
		t.Fatalf("the request: %s", req)
	}
	// Approving before the passkey is refused.
	if status, body := b.post("/oauth/approve", makeAnn); status != 403 || body != `{"error":"confirm"}` {
		t.Fatalf("approve unconfirmed: %d %s", status, body)
	}
	status, signed := b.passkey()
	if status != 200 || !strings.Contains(signed, `"name":"Ann Bonny"`) || !strings.Contains(signed, `"machines":[]`) || !strings.Contains(signed, `"cap":1`) {
		t.Fatalf("signed in: %d %s", status, signed)
	}
	if b.jar.by["__Host-keel-session"] != nil {
		t.Fatal("the approval made a game session")
	}
	status, body = b.post("/oauth/approve", makeAnn)
	var out struct{ Redirect string }
	_ = json.Unmarshal([]byte(body), &out)
	u, _ := url.Parse(out.Redirect)
	q := u.Query()
	if status != 200 || !strings.HasPrefix(out.Redirect, "https://claude.ai/api/mcp/auth_callback?") || len(q.Get("code")) != 43 ||
		q.Get("state") != "st" || q.Get("iss") != h.origin {
		t.Fatalf("approved: %d %s", status, body)
	}
	// Used once.
	if status, body := b.post("/oauth/approve", makeAnn); status != 409 || body != `{"error":"again"}` {
		t.Fatalf("approved twice: %d %s", status, body)
	}
	// Denied: the app is told, with the state and issuer.
	_, _, _ = b.do("GET", h.authorizeURL(doc, "https://claude.ai/api/mcp/auth_callback", "st2", challenge, nil), "")
	status, body = b.post("/oauth/deny", "")
	_ = json.Unmarshal([]byte(body), &out)
	u, _ = url.Parse(out.Redirect)
	if status != 200 || u.Query().Get("error") != "access_denied" || u.Query().Get("state") != "st2" || u.Query().Get("iss") != h.origin {
		t.Fatalf("denied: %d %s", status, body)
	}
	if status, _ := b.post("/oauth/deny", ""); status != 409 {
		t.Fatalf("denied twice: %d", status)
	}
	// A registered app with a loopback redirect calls itself by its name,
	// and returns to this computer.
	a := h.register("http://127.0.0.1/callback")
	_, _, _ = b.do("GET", h.authorizeURL(a.id, "http://127.0.0.1:9999/callback", "s", challenge, nil), "")
	_, req, _ = b.do("GET", "/oauth/request", "")
	if !strings.Contains(req, `"registered":true`) || !strings.Contains(req, `"loopback":true`) || strings.Contains(req, "vouchedBy") {
		t.Fatalf("a registered app: %s", req)
	}
}

// TestApprovalRules: a confirmation older than five minutes approves
// nothing; an account whose recovery code was used and has added no
// passkey cannot approve; a second approval of one app for a machine
// sailor replaces the first; the eleventh app for one machine sailor is
// refused; a machine sailor not the account's is not found; the cap
// holds on the page too.
func TestApprovalRules(t *testing.T) {
	h := newHarness(t)
	b := h.browser()
	b.sailor("Ann Bonny")
	b.signOut()
	a := h.register("https://app.example/cb")
	_, challenge := pkcePair("xyz")
	authorize := h.authorizeURL(a.id, a.redirect, "s", challenge, nil)

	_, _, _ = b.do("GET", authorize, "")
	_, _ = b.passkey()
	h.later(oauth.ConfirmFor + time.Second)
	if status, body := b.post("/oauth/approve", makeAnn); status != 403 || body != `{"error":"confirm"}` {
		t.Fatalf("after five minutes: %d %s", status, body)
	}
	if status, body := b.passkey(); status != 200 {
		t.Fatalf("again: %d %s", status, body)
	}
	if status, _ := b.post("/oauth/approve", makeAnn); status != 200 {
		t.Fatalf("approve: %d", status)
	}
	machines, err := h.st.Machines(context.Background(), ownerOf(t, h))
	if err != nil || len(machines) != 1 {
		t.Fatalf("machines: %v %v", machines, err)
	}
	machine := `{"machine":"` + machines[0].ID.String() + `"}`
	// The cap: a second machine sailor is refused.
	_, _, _ = b.do("GET", authorize, "")
	_, _ = b.passkey()
	if status, body := b.post("/oauth/approve", strings.Replace(makeAnn, "Iron Mary", "Brass Bess", 1)); status != 409 || body != `{"error":"cap"}` {
		t.Fatalf("over the cap: %d %s", status, body)
	}
	// The same app approved again replaces its first approval.
	if status, _ := b.post("/oauth/approve", machine); status != 200 {
		t.Fatal("approved again")
	}
	if n := liveGrants(t, h); n != 1 {
		t.Fatalf("two approvals of one app: %d live", n)
	}
	// Ten apps, then the eleventh refused.
	for i := range 9 {
		other := h.register("https://app" + string(rune('a'+i)) + ".example/cb")
		_, _, _ = b.do("GET", h.authorizeURL(other.id, other.redirect, "s", challenge, nil), "")
		_, _ = b.passkey()
		if status, body := b.post("/oauth/approve", machine); status != 200 {
			t.Fatalf("app %d: %d %s", i+2, status, body)
		}
	}
	eleventh := h.register("https://eleventh.example/cb")
	_, _, _ = b.do("GET", h.authorizeURL(eleventh.id, eleventh.redirect, "s", challenge, nil), "")
	_, _ = b.passkey()
	if status, body := b.post("/oauth/approve", machine); status != 409 || body != `{"error":"too-many-apps"}` {
		t.Fatalf("the eleventh: %d %s", status, body)
	}
	if status, body := b.post("/oauth/approve", `{"machine":"01900000-0000-7000-8000-000000000000"}`); status != 404 {
		t.Fatalf("another's machine sailor: %d %s", status, body)
	}
	// Names are refused as every sailor's are, and looks not the catalog's.
	if status, body := b.post("/oauth/approve", `{"make":{"name":"x","version":"v1","finish":"f1","colour":"c1"}}`); status != 422 || body != `{"error":"short"}` {
		t.Fatalf("a short name: %d %s", status, body)
	}
	if status, body := b.post("/oauth/approve", `{"make":{"name":"Brass Bess","version":"v9","finish":"f1","colour":"c1"}}`); status != 400 || body != `{"error":"look"}` {
		t.Fatalf("a look not the catalog's: %d %s", status, body)
	}

	// After the recovery code, until a passkey is added, the account
	// cannot approve.
	pool := storetest.PoolOn(t, h.db)
	if _, err := pool.Exec(context.Background(), "INSERT INTO session (account_id, token_hash, held) VALUES ($1, $2, true)",
		ownerOf(t, h), make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	_, _, _ = b.do("GET", authorize, "")
	if status, body := b.passkey(); status != 403 || body != `{"error":"add-passkey"}` {
		t.Fatalf("held: %d %s", status, body)
	}
}

func ownerOf(t *testing.T, h *harness) [16]byte {
	t.Helper()
	var id [16]byte
	if err := storetest.PoolOn(t, h.db).QueryRow(context.Background(), "SELECT id FROM account WHERE kind = 'human' ORDER BY created_at LIMIT 1").Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func liveGrants(t *testing.T, h *harness) int {
	t.Helper()
	var n int
	if err := storetest.PoolOn(t, h.db).QueryRow(context.Background(), "SELECT count(*) FROM ai_grant WHERE revoked_at IS NULL").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// TestRegistration: an app registers with its redirect URIs and is issued
// a client ID and no secret, whatever it asks; a bad redirect is refused;
// past the hourly limit registration waits.
func TestRegistration(t *testing.T) {
	h := newHarness(t, harnessOptions{registrations: 3})
	post := func(body string) (int, map[string]any, http.Header) {
		res, err := http.Post(h.origin+"/oauth/register", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		out := map[string]any{}
		_ = json.Unmarshal(raw, &out)
		return res.StatusCode, out, res.Header
	}
	status, out, hdr := post(`{"redirect_uris":["https://oauth-redirect.googleusercontent.com/r/x"],"token_endpoint_auth_method":"client_secret_basic","scope":"x"}`)
	if status != 201 || !oauth.Registered(out["client_id"].(string)) || out["token_endpoint_auth_method"] != "none" || out["client_secret"] != nil ||
		out["client_name"] != "An app with no name" || hdr.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("registered: %d %v", status, out)
	}
	for name, body := range map[string]string{
		"no redirect":     `{"client_name":"x"}`,
		"a custom scheme": `{"redirect_uris":["cursor://x/cb"]}`,
		"plain http":      `{"redirect_uris":["http://app.example/cb"]}`,
		"implicit":        `{"redirect_uris":["https://a.example/cb"],"response_types":["token"]}`,
		"not JSON":        `redirect_uris=x`,
	} {
		if status, out, _ := post(body); status != 400 || out["error"] == nil {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
	for range 2 {
		if status, _, _ := post(`{"redirect_uris":["http://localhost/cb"],"client_name":"Gemini CLI"}`); status != 201 {
			t.Fatalf("within the limit: %d", status)
		}
	}
	status, out, hdr = post(`{"redirect_uris":["http://localhost/cb"]}`)
	if status != 429 || hdr.Get("Retry-After") == "" || out["error"] != "temporarily_unavailable" {
		t.Fatalf("past the limit: %d %v %v", status, out, hdr)
	}
	// A preflight from a browser-based app is answered.
	req, _ := http.NewRequest("OPTIONS", h.origin+"/oauth/register", nil)
	req.Header.Set("Origin", "http://localhost:6274")
	req.Header.Set("Access-Control-Request-Method", "POST")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 204 || res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("preflight: %d %v", res.StatusCode, res.Header)
	}
}
