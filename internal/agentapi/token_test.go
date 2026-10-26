// SPDX-License-Identifier: AGPL-3.0-only

package agentapi_test

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
)

func errorOf(out map[string]any) (string, string) {
	code, _ := out["error"].(string)
	words, _ := out["error_description"].(string)
	return code, words
}

// TestCodeExchange: a code is exchanged once, by the client and redirect
// it was given for, with the verifier its challenge was made from, and the
// resource absent, the MCP address, or it with one slash; a code used
// twice ends its grant; a client that sends a secret is refused.
func TestCodeExchange(t *testing.T) {
	h := newHarness(t)
	b := h.browser()
	b.sailor("Ann Bonny")
	b.signOut()
	a := h.register("https://app.example/cb")
	verifier, challenge := pkcePair("v3rifier")
	approve := makeAnn
	code := func() string {
		u := b.approved(h.authorizeURL(a.id, a.redirect, "s", challenge, nil), approve)
		approve = `{"machine":"` + machineOf(t, h) + `"}`
		return u.Query().Get("code")
	}
	exchange := func(v url.Values) (int, map[string]any) {
		base := url.Values{"grant_type": {"authorization_code"}, "client_id": {a.id}, "redirect_uri": {a.redirect}, "code_verifier": {verifier}}
		for k, x := range v {
			if len(x) == 0 {
				delete(base, k)
			} else {
				base[k] = x
			}
		}
		return h.form("/oauth/token", base)
	}
	c := code()
	for name, v := range map[string]url.Values{
		"another client":   {"code": {c}, "client_id": {"keelote_cl_0000000000000000000000"}},
		"another redirect": {"code": {c}, "redirect_uri": {"https://app.example/other"}},
		"a wrong verifier": {"code": {c}, "code_verifier": {strings.Repeat("x", 43)}},
		"no verifier":      {"code": {c}, "code_verifier": nil},
	} {
		// Each refusal spends the code: a new one for the next.
		status, out := exchange(v)
		if code, words := errorOf(out); status != 400 || code != "invalid_grant" || words == "" {
			t.Errorf("%s: %d %v", name, status, out)
		}
		c = code()
	}
	for name, v := range map[string]url.Values{
		"a secret":         {"code": {c}, "client_secret": {"s"}},
		"an assertion":     {"code": {c}, "client_assertion": {"jwt"}},
		"no client":        {"code": {c}, "client_id": nil},
		"another resource": {"code": {c}, "resource": {"https://other.example/mcp"}},
		"a grant type":     {"code": {c}, "grant_type": {"client_credentials"}},
	} {
		status, out := exchange(v)
		code, _ := errorOf(out)
		want := map[string]string{"a secret": "invalid_client", "an assertion": "invalid_client", "no client": "invalid_client",
			"another resource": "invalid_target", "a grant type": "unsupported_grant_type"}[name]
		if code != want || status/100 != 4 {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
	// The resource with a trailing slash is the MCP address.
	status, tok := exchange(url.Values{"code": {c}, "resource": {h.resource + "/"}})
	if status != 200 || tok["token_type"] != "Bearer" || tok["scope"] != "sail" || tok["expires_in"].(float64) != 3600 ||
		!strings.HasPrefix(tok["access_token"].(string), "keelote_at_") || !strings.HasPrefix(tok["refresh_token"].(string), "keelote_rt_") {
		t.Fatalf("exchanged: %d %v", status, tok)
	}
	if code, _, _ := h.mcpCall(tok["access_token"].(string)); code != 200 {
		t.Fatalf("the access token: %d", code)
	}
	// The same code again: refused, and its grant ends with the tokens
	// first issued for it.
	status, out := exchange(url.Values{"code": {c}})
	if code, words := errorOf(out); status != 400 || code != "invalid_grant" || !strings.Contains(words, "used twice") {
		t.Fatalf("a code twice: %d %v", status, out)
	}
	if code, challenge, _ := h.mcpCall(tok["access_token"].(string)); code != 401 || !strings.Contains(challenge, "used twice") {
		t.Fatalf("its token after: %d %q", code, challenge)
	}
	// A code expires a minute after it was given.
	c = code()
	h.later(oauth.CodeFor + time.Second)
	if status, out := exchange(url.Values{"code": {c}}); status != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("an expired code: %d %v", status, out)
	}
}

// TestRefresh: a refresh rotates the pair; the token just replaced is
// accepted once more within thirty seconds, ending the pair issued in
// between; used again otherwise, or later, it ends the grant; a refresh by
// another client is refused.
func TestRefresh(t *testing.T) {
	h := newHarness(t)
	b := h.browser()
	b.sailor("Ann Bonny")
	b.signOut()
	a := h.register("https://app.example/cb")
	access, refresh := h.grant(b, a, makeAnn)
	refreshWith := func(token, client string) (int, map[string]any) {
		return h.form("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {token}, "client_id": {client}})
	}
	if status, out := refreshWith(refresh, "keelote_cl_0000000000000000000000"); status != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("another client: %d %v", status, out)
	}
	status, first := refreshWith(refresh, a.id)
	if status != 200 || first["refresh_token"] == refresh {
		t.Fatalf("rotated: %d %v", status, first)
	}
	// The app did not get the answer, and tries again at once: a new pair,
	// and the one in between ends.
	status, second := refreshWith(refresh, a.id)
	if status != 200 || second["refresh_token"] == first["refresh_token"] {
		t.Fatalf("within the grace: %d %v", status, second)
	}
	if testutil.ToFloat64(h.metrics.OAuthReuse.WithLabelValues("grace")) != 1 {
		t.Fatal("the grace not counted")
	}
	if code, _, _ := h.mcpCall(first["access_token"].(string)); code != 401 {
		t.Fatalf("the pair in between: %d", code)
	}
	if code, _, _ := h.mcpCall(second["access_token"].(string)); code != 200 {
		t.Fatalf("the newest pair: %d", code)
	}
	if code, _, _ := h.mcpCall(access); code != 200 {
		t.Fatalf("the first access token, unexpired: %d", code)
	}
	// The newest refresh token, used: then the first one again is a reuse.
	status, third := refreshWith(second["refresh_token"].(string), a.id)
	if status != 200 {
		t.Fatalf("the third: %d %v", status, third)
	}
	status, out := refreshWith(refresh, a.id)
	if code, words := errorOf(out); status != 400 || code != "invalid_grant" || !strings.Contains(words, "used twice") {
		t.Fatalf("a reuse: %d %v", status, out)
	}
	if testutil.ToFloat64(h.metrics.OAuthReuse.WithLabelValues("revoked")) != 1 {
		t.Fatal("the reuse not counted")
	}
	if code, challenge, _ := h.mcpCall(third["access_token"].(string)); code != 401 || !strings.Contains(challenge, "used twice") {
		t.Fatalf("after the reuse: %d %q", code, challenge)
	}
	// After the grace, the token just replaced is a reuse too.
	access, refresh = h.grant(b, a, `{"machine":"`+machineOf(t, h)+`"}`)
	if status, _ := refreshWith(refresh, a.id); status != 200 {
		t.Fatal("refresh")
	}
	h.later(oauth.RefreshGrace + time.Second)
	if status, out := refreshWith(refresh, a.id); status != 400 || !strings.Contains(out["error_description"].(string), "used twice") {
		t.Fatalf("after the grace: %d %v", status, out)
	}
	if code, _, _ := h.mcpCall(access); code != 401 {
		t.Fatalf("after the grace, its grant: %d", code)
	}
	// An unknown or malformed token.
	for _, tok := range []string{"nonsense", strings.Replace(refresh, "_rt_", "_at_", 1)} {
		if status, out := refreshWith(tok, a.id); status != 400 || out["error"] != "invalid_grant" {
			t.Errorf("%q: %d %v", tok, status, out)
		}
	}
}

func machineOf(t *testing.T, h *harness) string {
	t.Helper()
	var id [16]byte
	if err := poolQuery(t, h, "SELECT id FROM account WHERE kind = 'ai' ORDER BY created_at LIMIT 1", &id); err != nil {
		t.Fatal(err)
	}
	return uuid(id)
}

// TestRevoke: a refresh token revoked ends its grant; an access token
// revoked ends itself; anything else, or nothing, is answered 200.
func TestRevoke(t *testing.T) {
	h := newHarness(t)
	b := h.browser()
	b.sailor("Ann Bonny")
	b.signOut()
	a := h.register("https://app.example/cb")
	access, refresh := h.grant(b, a, makeAnn)
	for _, tok := range []string{"", "nonsense", "keelote_rt_" + strings.Repeat("0", 49)} {
		if status, _ := h.form("/oauth/revoke", url.Values{"token": {tok}, "client_id": {a.id}}); status != 200 {
			t.Errorf("%q: %d", tok, status)
		}
	}
	// Another client's revocation is answered 200 and changes nothing.
	if status, _ := h.form("/oauth/revoke", url.Values{"token": {refresh}, "client_id": {"keelote_cl_0000000000000000000000"}}); status != 200 {
		t.Fatal("another's")
	}
	if code, _, _ := h.mcpCall(access); code != 200 {
		t.Fatalf("revoked by another: %d", code)
	}
	if status, _ := h.form("/oauth/revoke", url.Values{"token": {access}, "client_id": {a.id}}); status != 200 {
		t.Fatal("the access token")
	}
	if code, _, _ := h.mcpCall(access); code != 401 {
		t.Fatalf("an access token revoked: %d", code)
	}
	status, tok := h.form("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {a.id}})
	if status != 200 {
		t.Fatalf("the grant lives on: %d %v", status, tok)
	}
	if status, _ := h.form("/oauth/revoke", url.Values{"token": {tok["refresh_token"].(string)}, "client_id": {a.id}}); status != 200 {
		t.Fatal("the refresh token")
	}
	if code, challenge, _ := h.mcpCall(tok["access_token"].(string)); code != 401 || !strings.Contains(challenge, "revoked by the app") {
		t.Fatalf("its grant: %d %q", code, challenge)
	}
	res, err := http.Post(h.origin+"/oauth/revoke", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 400 || res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("JSON: %d", res.StatusCode)
	}
}
