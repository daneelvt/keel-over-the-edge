// SPDX-License-Identifier: AGPL-3.0-only

// Package access checks that a request came through Cloudflare Access: the
// token Access signs every request it lets through with, in the
// Cf-Access-Jwt-Assertion header. The token is RS256, signed by one of the
// team's keys (https://<team>/cdn-cgi/access/certs), issued by the team's
// domain, for the application's audience tag, and in date. A route behind
// Access is then refused to anyone who reaches the origin some other way,
// or through an application of the team that is not its own.
//
// The keys are fetched when a token names one not held, and kept: Access
// rotates them every six weeks and keeps an old one valid for seven days
// after. A token naming a key the team does not have makes no more than
// one fetch every RefetchEvery, so forged tokens cannot make the server
// call Cloudflare at their own pace.
package access

import (
	"context"
	"crypto"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// Header is the header Access puts its token in.
const Header = "Cf-Access-Jwt-Assertion"

// RefetchEvery is the least time between two fetches of the keys.
const RefetchEvery = 10 * time.Second

// fetchTimeout bounds one fetch of the keys.
const fetchTimeout = 10 * time.Second

// keysLimit is the most of a key list read, bytes.
const keysLimit = 1 << 20

// Config is a team's Access application.
type Config struct {
	// Issuer is the team's domain as tokens name it: https://<team>.
	Issuer string
	// Audience is the application's audience tag.
	Audience string
	// Client fetches the keys; http.DefaultClient's transport, with a
	// timeout, if nil.
	Client *http.Client
	// Now is the time tokens are checked at; time.Now if nil.
	Now func() time.Time
}

// Checker checks requests' Access tokens.
type Checker struct {
	verifier *oidc.IDTokenVerifier
	keys     *keySet
}

// Issuer is the issuer of a team's tokens: its domain, as
// keel.cloudflareaccess.com, over HTTPS.
func Issuer(team string) string { return "https://" + team }

// New is a checker of tokens for one application of one team.
func New(cfg Config) *Checker {
	client := cfg.Client
	if client == nil {
		client = &http.Client{Timeout: fetchTimeout}
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	keys := &keySet{url: strings.TrimSuffix(cfg.Issuer, "/") + "/cdn-cgi/access/certs", client: client, now: now, held: map[string]crypto.PublicKey{}}
	v := oidc.NewVerifier(cfg.Issuer, keys, &oidc.Config{
		ClientID:             cfg.Audience,
		SupportedSigningAlgs: []string{oidc.RS256},
		Now:                  now,
	})
	return &Checker{verifier: v, keys: keys}
}

// ErrNoToken is a request with no token.
var ErrNoToken = errors.New("access: no token")

// Check reports whether r carries a token Access signed for the
// application: nil if it does, why not if it does not.
func (c *Checker) Check(r *http.Request) error {
	token := r.Header.Get(Header)
	if token == "" {
		return ErrNoToken
	}
	_, err := c.verifier.Verify(r.Context(), token)
	return err
}

// keySet is the team's keys, by their IDs, fetched when a token names one
// not held: go-oidc's KeySet.
type keySet struct {
	url    string
	client *http.Client
	now    func() time.Time

	mu      sync.Mutex
	held    map[string]crypto.PublicKey
	fetched time.Time
}

var errUnknownKey = errors.New("access: a key the team does not have")

// VerifySignature checks a token's signature with the key it names, and
// returns its payload.
func (k *keySet) VerifySignature(ctx context.Context, jwt string) ([]byte, error) {
	kid, err := keyID(jwt)
	if err != nil {
		return nil, err
	}
	pub, err := k.key(ctx, kid)
	if err != nil {
		return nil, err
	}
	return (&oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{pub}}).VerifySignature(ctx, jwt)
}

// key is the key of an ID, fetched again if it is not held and the last
// fetch was RefetchEvery ago or more.
func (k *keySet) key(ctx context.Context, kid string) (crypto.PublicKey, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if pub, ok := k.held[kid]; ok {
		return pub, nil
	}
	now := k.now()
	if !k.fetched.IsZero() && now.Sub(k.fetched) < RefetchEvery {
		return nil, errUnknownKey
	}
	k.fetched = now
	held, err := k.fetch(ctx)
	if err != nil {
		return nil, err
	}
	k.held = held
	if pub, ok := held[kid]; ok {
		return pub, nil
	}
	return nil, errUnknownKey
}

// fetch reads the team's keys: its RSA keys, by their IDs.
func (k *keySet) fetch(ctx context.Context) (map[string]crypto.PublicKey, error) {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, k.url, nil)
	if err != nil {
		return nil, err
	}
	res, err := k.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("access: the keys: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("access: the keys: %s", res.Status)
	}
	var set struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, keysLimit)).Decode(&set); err != nil {
		return nil, fmt.Errorf("access: the keys: %w", err)
	}
	out := map[string]crypto.PublicKey{}
	for _, j := range set.Keys {
		if j.Kty != "RSA" || j.Kid == "" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(j.N)
		e, err2 := base64.RawURLEncoding.DecodeString(j.E)
		if err1 != nil || err2 != nil || len(e) == 0 || len(e) > 4 {
			continue
		}
		exp := 0
		for _, b := range e {
			exp = exp<<8 | int(b)
		}
		out[j.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: exp}
	}
	return out, nil
}

// keyID is the ID of the key a token says it is signed with.
func keyID(jwt string) (string, error) {
	head, _, ok := strings.Cut(jwt, ".")
	if !ok {
		return "", errors.New("access: not a token")
	}
	raw, err := base64.RawURLEncoding.DecodeString(head)
	if err != nil {
		return "", errors.New("access: not a token")
	}
	var h struct {
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(raw, &h); err != nil || h.Kid == "" {
		return "", errors.New("access: a token naming no key")
	}
	return h.Kid, nil
}
