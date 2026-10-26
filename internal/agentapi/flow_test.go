// SPDX-License-Identifier: AGPL-3.0-only

package agentapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/modelcontextprotocol/go-sdk/oauthex"

	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// pageData is what the approval page reads, as far as the tests need.
type pageData struct {
	SignedIn *struct {
		Name     string
		Machines []struct {
			ID, Name string
			Apps     []struct{ ID, Name string }
		}
		Cap int
	}
}

// approvedFor runs an authorization request through the approval page,
// choosing what to approve from the page as signed in.
func (b *browser) approvedFor(authorize string, choose func(pageData) string) *url.URL {
	b.t.Helper()
	status, body, _ := b.do("GET", authorize, "")
	if status != 200 || body != "the approval page" {
		b.t.Fatalf("authorize: %d %s", status, body)
	}
	status, body = b.passkey()
	if status != 200 {
		b.t.Fatalf("the approval's passkey: %d %s", status, body)
	}
	var page pageData
	if err := json.Unmarshal([]byte(body), &page); err != nil || page.SignedIn == nil {
		b.t.Fatalf("signed in: %s %v", body, err)
	}
	status, body = b.post("/oauth/approve", choose(page))
	if status != 200 {
		b.t.Fatalf("approve: %d %s", status, body)
	}
	var out struct{ Redirect string }
	_ = json.Unmarshal([]byte(body), &out)
	u, err := url.Parse(out.Redirect)
	if err != nil {
		b.t.Fatal(err)
	}
	return u
}

// fetcherFor is an AI app's browser step: the player approves on the
// page, and the app reads the code from the redirect.
func fetcherFor(b *browser, choose func(pageData) string) auth.AuthorizationCodeFetcher {
	return func(_ context.Context, args *auth.AuthorizationArgs) (*auth.AuthorizationResult, error) {
		u := b.approvedFor(args.URL, choose)
		q := u.Query()
		return &auth.AuthorizationResult{Code: q.Get("code"), State: q.Get("state"), Iss: q.Get("iss")}, nil
	}
}

func handbook(t *testing.T, ctx context.Context, transport mcp.Transport) (string, error) {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	s, err := c.Connect(ctx, transport, nil)
	if err != nil {
		return "", err
	}
	defer s.Close()
	res, err := s.CallTool(ctx, &mcp.CallToolParams{Name: "handbook"})
	if err != nil {
		return "", err
	}
	var text []string
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			text = append(text, tc.Text)
		}
	}
	return strings.Join(text, "\n"), nil
}

// bearer adds a header to every request, as a program that takes a
// connection token does.
type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

// mcpCall posts one JSON-RPC call to the MCP address with a token, as an
// app's next call does, and returns the status, its challenge and body.
func (h *harness) mcpCall(token string) (int, string, string) {
	h.t.Helper()
	return h.mcpCallAs(token, "application/json")
}

// mcpCallAs is mcpCall with a Content-Type, "" for none.
func (h *harness) mcpCallAs(token, contentType string) (int, string, string) {
	h.t.Helper()
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"handbook","arguments":{}}}`
	req, _ := http.NewRequest("POST", h.resource, strings.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Mcp-Protocol-Version", "2025-06-18")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header.Get("WWW-Authenticate"), string(out)
}

// TestTheSDKsClient: an AI app on the official Go SDK signs in as an app
// does: it is refused at the MCP address, finds the resource's metadata
// and the authorization server's, names itself by a metadata document,
// and sends the player to the approval page, where their passkey approves
// a machine sailor made there; it exchanges the code and calls handbook,
// which names the machine sailor. Then an app that registers itself is
// approved for the same machine sailor; a refresh rotates the tokens; the
// lifetime shortened to a minute ends the grant, and the next call and the
// next refresh are refused in words; a connection token sails a program
// that sends only the header, until a new one is made.
func TestTheSDKsClient(t *testing.T) {
	h := newHarness(t)
	game := h.browser()
	game.sailor("Ann Bonny")
	app := h.browser()
	app.keys = game.keys
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	clientID := h.document("/client.json", docAnswer{
		body: clientDoc(h.docs.URL+"/client.json", "http://127.0.0.1/callback"), header: map[string]string{"Cache-Control": "max-age=600"},
	})
	byDocument, err := auth.NewAuthorizationCodeHandler(&auth.AuthorizationCodeHandlerConfig{
		ClientIDMetadataDocumentConfig: &auth.ClientIDMetadataDocumentConfig{URL: clientID},
		RedirectURL:                    "http://127.0.0.1:43210/callback",
		AuthorizationCodeFetcher:       fetcherFor(app, func(pageData) string { return makeAnn }),
	})
	if err != nil {
		t.Fatal(err)
	}
	text, err := handbook(t, ctx, &mcp.StreamableClientTransport{Endpoint: h.resource, OAuthHandler: byDocument, DisableStandaloneSSE: true})
	if err != nil {
		t.Fatalf("the app by its document: %v\n%s", err, h.logs)
	}
	if !strings.Contains(text, "You sail as «Iron Mary», «Ann Bonny»'s machine sailor") {
		t.Fatalf("handbook: %q", text)
	}
	if h.fetchedCount("/client.json") != 1 {
		t.Errorf("the document fetched %d times", h.fetchedCount("/client.json"))
	}

	// An app that registers itself, approved for the machine sailor made.
	registered, err := auth.NewAuthorizationCodeHandler(&auth.AuthorizationCodeHandlerConfig{
		DynamicClientRegistrationConfig: &auth.DynamicClientRegistrationConfig{Metadata: &oauthex.ClientRegistrationMetadata{
			ClientName: "A registered app", RedirectURIs: []string{"http://localhost:7777/oauth/callback"},
		}},
		AuthorizationCodeFetcher: fetcherFor(app, func(p pageData) string {
			if len(p.SignedIn.Machines) != 1 || len(p.SignedIn.Machines[0].Apps) != 1 || p.SignedIn.Name != "Ann Bonny" {
				t.Errorf("the page signed in: %+v", p.SignedIn)
			}
			return `{"machine":"` + p.SignedIn.Machines[0].ID + `"}`
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if text, err := handbook(t, ctx, &mcp.StreamableClientTransport{Endpoint: h.resource, OAuthHandler: registered, DisableStandaloneSSE: true}); err != nil ||
		!strings.Contains(text, "Iron Mary") {
		t.Fatalf("the registered app: %q, %v\n%s", text, err, h.logs)
	}

	// A refresh rotates the pair: the new access token works.
	ts, _ := registered.TokenSource(ctx)
	tok, err := ts.Token()
	if err != nil || tok.RefreshToken == "" {
		t.Fatalf("the registered app's token: %+v %v", tok, err)
	}
	// The client ID the app was issued, which a refresh names.
	reg := registeredID(t, h)
	status, refreshed := h.form("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok.RefreshToken}, "client_id": {reg}})
	if status != 200 || refreshed["access_token"] == nil {
		t.Fatalf("refresh: %d %v", status, refreshed)
	}
	access := refreshed["access_token"].(string)
	if code, _, body := h.mcpCall(access); code != 200 || !strings.Contains(body, "Iron Mary") {
		t.Fatalf("the refreshed token: %d %s", code, body)
	}

	// The lifetime shortened to a minute, and a minute passes: the next
	// call is refused, and so is the next refresh, both in words.
	h.lifetime.Set(time.Minute)
	h.grants.ForgetAll()
	h.later(61 * time.Second)
	code, challenge, body := h.mcpCall(access)
	if code != 401 || !strings.Contains(challenge, `error="invalid_token"`) || !strings.Contains(challenge, "ended on") ||
		!strings.Contains(challenge, `resource_metadata="`) || !strings.Contains(body, "Approve the app again") {
		t.Fatalf("after the lifetime: %d %q %q", code, challenge, body)
	}
	status, refused := h.form("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refreshed["refresh_token"].(string)}, "client_id": {reg}})
	if status != 400 || refused["error"] != "invalid_grant" || !strings.Contains(fmt.Sprint(refused["error_description"]), "ended on") {
		t.Fatalf("the refresh after the lifetime: %d %v", status, refused)
	}
	h.lifetime.Set(24 * time.Hour)
	h.grants.ForgetAll()

	// A connection token, made on the account page after a passkey, sails
	// a program that sends only the header; a new one ends it.
	token := game.connectionToken()
	if text, err := handbook(t, ctx, &mcp.StreamableClientTransport{Endpoint: h.resource, HTTPClient: &http.Client{Transport: bearer{token}},
		DisableStandaloneSSE: true}); err != nil || !strings.Contains(text, "Iron Mary") {
		t.Fatalf("the connection token: %q %v", text, err)
	}
	newer := game.connectionToken()
	if code, challenge, _ := h.mcpCall(token); code != 401 || !strings.Contains(challenge, "replaced") {
		t.Fatalf("the old connection token: %d %q", code, challenge)
	}
	if code, _, _ := h.mcpCall(newer); code != 200 {
		t.Fatalf("the new connection token: %d", code)
	}
}

// registeredID is the one client registered in the test database.
func registeredID(t *testing.T, h *harness) string {
	t.Helper()
	var id string
	if err := storetest.PoolOn(t, h.db).QueryRow(context.Background(), "SELECT client_id FROM oauth_client ORDER BY created_at DESC LIMIT 1").Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// connectionToken makes a connection token for the player's machine
// sailor on the account page, after a passkey, and returns it.
func (b *browser) connectionToken() string {
	b.t.Helper()
	status, opts := b.post("/api/account/confirm/begin", "")
	if status != 200 {
		b.t.Fatalf("confirm: %d %s", status, opts)
	}
	answer, err := b.keys[len(b.keys)-1].Get([]byte(opts))
	if err != nil {
		b.t.Fatal(err)
	}
	if status, body := b.post("/api/account/confirm/finish", string(answer)); status != 200 {
		b.t.Fatalf("confirm: %d %s", status, body)
	}
	_, page, _ := b.do("GET", "/api/machines", "")
	var p struct{ Machines []struct{ ID string } }
	if err := json.Unmarshal([]byte(page), &p); err != nil || len(p.Machines) == 0 {
		b.t.Fatalf("machines: %s", page)
	}
	status, body := b.post("/api/machines/token", `{"machine":"`+p.Machines[0].ID+`"}`)
	var out struct{ Token string }
	if err := json.Unmarshal([]byte(body), &out); status != 201 || err != nil || !strings.HasPrefix(out.Token, "keelote_ct_") {
		b.t.Fatalf("token: %d %s", status, body)
	}
	return out.Token
}
