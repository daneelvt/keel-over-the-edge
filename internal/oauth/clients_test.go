// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"errors"
	"strings"
	"testing"
)

// TestRedirects: an https redirect is matched character for character; a
// loopback one on any port, its host name, path and query exactly; nothing
// else is accepted.
func TestRedirects(t *testing.T) {
	listed := []string{
		"https://claude.ai/api/mcp/auth_callback",
		"http://localhost/callback", "http://127.0.0.1/callback?x=1", "http://[::1]:9000/oauth_callback",
	}
	for _, c := range []struct {
		uri  string
		want bool
	}{
		{"https://claude.ai/api/mcp/auth_callback", true},
		{"https://claude.ai/api/mcp/auth_callback/", false},
		{"https://claude.ai/api/mcp/auth_callback?a=b", false},
		{"https://Claude.ai/api/mcp/auth_callback", false},
		{"https://claude.ai:443/api/mcp/auth_callback", false},
		{"http://claude.ai/api/mcp/auth_callback", false},
		{"http://localhost/callback", true},
		{"http://localhost:51234/callback", true},
		{"http://LOCALHOST:51234/callback", true},
		{"http://localhost:51234/callback/", false},
		{"http://localhost:51234/Callback", false},
		{"http://127.0.0.1:8080/callback?x=1", true},
		{"http://127.0.0.1:8080/callback", false},
		{"http://127.0.0.1:8080/callback?x=2", false},
		{"http://localhost:8080/callback?x=1", false},
		{"http://[::1]/oauth_callback", true},
		{"http://[::1]:1/oauth_callback", true},
		{"http://127.0.0.2/callback", false},
		{"http://localhost.example.com/callback", false},
		{"http://localhost:51234/callback#f", false},
		{"http://user@localhost/callback", false},
		{"cursor://anysphere.cursor-retrieval/oauth/callback", false},
		{"", false},
	} {
		if got := matchRedirect(c.uri, listed); got != c.want {
			t.Errorf("%q: %v, want %v", c.uri, got, c.want)
		}
	}
	for _, c := range []struct {
		uri, host string
		loop      bool
	}{
		{"https://claude.ai/api/mcp/auth_callback", "claude.ai", false},
		{"http://127.0.0.1:5555/cb", "", true},
	} {
		if host, loop := returnHost(c.uri); host != c.host || loop != c.loop {
			t.Errorf("%q: %q %v", c.uri, host, loop)
		}
	}
}

// TestClientIDs: a client ID that is a URL is https, a host that is a
// name, no userinfo, port or query, a path other than /, no dot segments,
// no fragment and at most 512 bytes.
func TestClientIDs(t *testing.T) {
	f := NewFetcher(FetcherOptions{})
	for _, c := range []struct {
		id   string
		want bool
	}{
		{"https://claude.ai/oauth/mcp-oauth-client-metadata", true},
		{"https://chatgpt.com/oauth/client.json", true},
		{"https://example.com:443/client.json", true},
		{"https://example.com/", false},
		{"https://example.com", false},
		{"http://example.com/client.json", false},
		{"https://example.com:8443/client.json", false},
		{"https://user@example.com/client.json", false},
		{"https://example.com/client.json?v=1", false},
		{"https://example.com/client.json?", false},
		{"https://example.com/client.json#a", false},
		{"https://example.com/a/../client.json", false},
		{"https://example.com/./client.json", false},
		{"https://203.0.113.9/client.json", false},
		{"https://[2001:db8::1]/client.json", false},
		{"https://127.0.0.1:8443/client.json", false},
		{"https://example.com/" + strings.Repeat("a", 500), false},
		{"urn:client:1", false},
	} {
		if _, got := f.clientIDURL(c.id); got != c.want {
			t.Errorf("%q: %v, want %v", c.id, got, c.want)
		}
	}
	// The test option reaches a loopback address on any port.
	loop := NewFetcher(FetcherOptions{Loopback: true})
	if _, ok := loop.clientIDURL("https://127.0.0.1:8443/client.json"); !ok {
		t.Error("the test option refuses a loopback client ID")
	}
	if _, ok := loop.clientIDURL("https://10.0.0.1:8443/client.json"); ok {
		t.Error("the test option accepts a private address")
	}
}

// TestDocuments: a document names its client ID exactly, has a name and
// one to ten redirect URIs the game accepts, and no shared secret; one
// asking for private_key_jwt is held to none.
func TestDocuments(t *testing.T) {
	id := "https://example.com/client.json"
	good := `{"client_id":"` + id + `","client_name":"  Claude  ","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"logo_uri":"https://x/l.png"}`
	c, err := parseDocument(id, "example.com", []byte(good))
	if err != nil || c.Name != "Claude" || c.Host != "example.com" || len(c.RedirectURIs) != 1 || c.Registered {
		t.Fatalf("a good document: %+v, %v", c, err)
	}
	if _, err := parseDocument(id, "example.com", []byte(strings.Replace(good, `,"logo`, `,"token_endpoint_auth_method":"private_key_jwt","logo`, 1))); err != nil {
		t.Errorf("private_key_jwt: %v", err)
	}
	many := `["https://a.example/1","https://a.example/2","https://a.example/3","https://a.example/4","https://a.example/5",` +
		`"https://a.example/6","https://a.example/7","https://a.example/8","https://a.example/9","https://a.example/10","https://a.example/11"]`
	for name, body := range map[string]string{
		"not JSON":            `{"client_id":`,
		"another client ID":   strings.Replace(good, id, id+"/", 1),
		"the ID's case":       strings.Replace(good, "example.com", "Example.com", 1),
		"no name":             strings.Replace(good, `"  Claude  "`, `"  "`, 1),
		"a long name":         strings.Replace(good, "Claude", strings.Repeat("x", 101), 1),
		"a control in a name": strings.Replace(good, "Claude", `Cla\u0007ude`, 1),
		"no redirects":        strings.Replace(good, `["https://claude.ai/api/mcp/auth_callback"]`, `[]`, 1),
		"eleven redirects":    strings.Replace(good, `["https://claude.ai/api/mcp/auth_callback"]`, many, 1),
		"a custom scheme":     strings.Replace(good, "https://claude.ai/api/mcp/auth_callback", "myapp://callback", 1),
		"plain http":          strings.Replace(good, "https://claude.ai/api/mcp/auth_callback", "http://claude.ai/cb", 1),
		"a shared secret":     strings.Replace(good, `,"logo`, `,"token_endpoint_auth_method":"client_secret_basic","logo`, 1),
	} {
		if _, err := parseDocument(id, "example.com", []byte(body)); !errors.Is(err, errDocument) {
			t.Errorf("%s: %v", name, err)
		}
	}
}
