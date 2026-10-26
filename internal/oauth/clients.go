// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Clients. Every AI app is a public client, holding no secret: it is a
// client ID that is an https URL, whose metadata document the game fetches
// (the OAuth client ID metadata document draft, -02), or a client ID the
// game issued when the app registered itself (RFC 7591). No client is
// registered beforehand.

// Client is an AI app as an authorization request names it.
type Client struct {
	ID   string
	Name string
	// RedirectURIs are where its sign-ins may return.
	RedirectURIs []string
	// Registered is a client that registered itself: its name is only
	// what it calls itself. Otherwise Host, its client ID's host, vouches
	// for its document.
	Registered bool
	Host       string
}

// MaxClientID is the longest client ID read.
const MaxClientID = 512

// MaxClientName is the most characters of a client's name.
const MaxClientName = 100

// MaxRedirectURIs is the most redirect URIs a client may list.
const MaxRedirectURIs = 10

// A client refused, in words for the approval page: the request is never
// sent back to a redirect URI the game cannot trust.
type clientError struct{ words string }

func (e *clientError) Error() string { return "oauth: " + e.words }

var (
	errUnknownClient = &clientError{"The app is not one Keel Over the Edge knows: it may have registered with another server. Try connecting again from the app."}
	errClientID      = &clientError{"The app named itself by an address Keel Over the Edge does not accept."}
	errDocument      = &clientError{"The app's description of itself could not be read, so it cannot be trusted. Try again later."}
)

// clientIDURL checks a client ID that is a URL as the draft (-02, 3) and
// the game require: https, a host that is a name, no userinfo, no port but
// 443, a path other than /, no dot segments, no query and no fragment. In
// tests, a loopback address on any port, over http too, is allowed.
func (f *Fetcher) clientIDURL(id string) (*url.URL, bool) {
	if len(id) > MaxClientID || strings.ContainsAny(id, " \t\r\n#") {
		return nil, false
	}
	u, err := url.Parse(id)
	if err != nil || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return nil, false
	}
	if f.allowsLoopback(u) && (u.Scheme == "https" || u.Scheme == "http") {
		return u, u.Path != "" && u.Path != "/"
	}
	if u.Scheme != "https" || u.Hostname() == "" || isIP(u.Hostname()) || (u.Port() != "" && u.Port() != "443") {
		return nil, false
	}
	if u.Path == "" || u.Path == "/" || u.RawPath != "" && u.RawPath != u.EscapedPath() {
		return nil, false
	}
	for _, seg := range strings.Split(u.Path, "/") {
		if seg == "." || seg == ".." {
			return nil, false
		}
	}
	return u, true
}

// document is a client metadata document, as far as the game reads it.
type document struct {
	ClientID                string   `json:"client_id"`
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	TokenEndpointAuthMethod *string  `json:"token_endpoint_auth_method"`
}

// parseDocument reads a client's document, checked as the draft and MCP
// require: its client_id the URL it was fetched from, character for
// character; a name; 1 to MaxRedirectURIs redirect URIs the game accepts;
// and no authentication method based on a shared secret. A document that
// asks for private_key_jwt is held to none, as every client is.
func parseDocument(id string, host string, body []byte) (Client, error) {
	var d document
	if err := json.Unmarshal(body, &d); err != nil {
		return Client{}, fmt.Errorf("%w: %v", errDocument, err)
	}
	if d.ClientID != id {
		return Client{}, fmt.Errorf("%w: its client_id is %q", errDocument, d.ClientID)
	}
	name, ok := clientName(d.ClientName)
	if !ok {
		return Client{}, fmt.Errorf("%w: its client_name", errDocument)
	}
	if !redirectList(d.RedirectURIs) {
		return Client{}, fmt.Errorf("%w: its redirect_uris", errDocument)
	}
	if m := d.TokenEndpointAuthMethod; m != nil && *m != "none" && *m != "private_key_jwt" {
		return Client{}, fmt.Errorf("%w: its token_endpoint_auth_method %q", errDocument, *m)
	}
	return Client{ID: id, Name: name, RedirectURIs: d.RedirectURIs, Host: host}, nil
}

// clientName is a client's name as shown: trimmed, 1 to MaxClientName
// characters, no control characters.
func clientName(s string) (string, bool) {
	s = strings.TrimSpace(s)
	n := utf8.RuneCountInString(s)
	if n == 0 || n > MaxClientName || !utf8.ValidString(s) {
		return "", false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return "", false
		}
	}
	return s, true
}

func redirectList(uris []string) bool {
	if len(uris) == 0 || len(uris) > MaxRedirectURIs {
		return false
	}
	for _, u := range uris {
		if _, ok := redirectURI(u); !ok {
			return false
		}
	}
	return true
}

// Clients finds the client an authorization request names.
type clients struct {
	store   Store
	fetcher *Fetcher
	cache   documentCache
	now     func() time.Time
	counted func(result string)
	took    func(time.Duration)
}

// resolve finds a client by its ID: one registered in the store, or one
// whose document is cached or fetched now. A *clientError is the client's
// fault; ErrBusy, too many fetches lately; anything else, the store's.
func (c *clients) resolve(ctx context.Context, id string) (Client, error) {
	if Registered(id) {
		cl, err := c.store.Client(ctx, id)
		if errors.Is(err, store.ErrNotFound) {
			return Client{}, errUnknownClient
		}
		if err != nil {
			return Client{}, err
		}
		return Client{ID: cl.ID, Name: cl.Name, RedirectURIs: cl.RedirectURIs, Registered: true}, nil
	}
	u, ok := c.fetcher.clientIDURL(id)
	if !ok {
		return Client{}, errClientID
	}
	now := c.now()
	if cl, ok := c.cache.get(id, now); ok {
		c.counted("cached")
		return cl, nil
	}
	start := time.Now()
	f, err := c.fetcher.fetch(ctx, id)
	c.took(time.Since(start))
	if errors.Is(err, ErrBusy) {
		c.counted("refused")
		return Client{}, err
	}
	if err != nil {
		c.counted("failed")
		return Client{}, fmt.Errorf("%w (%v)", errDocument, err)
	}
	cl, err := parseDocument(id, u.Hostname(), f.body)
	if err != nil {
		c.counted("failed")
		return Client{}, err
	}
	c.counted("fetched")
	c.cache.put(id, cl, f.maxAge, now)
	return cl, nil
}
