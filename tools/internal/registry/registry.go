// SPDX-License-Identifier: AGPL-3.0-only

// Package registry reads an OCI registry over its HTTP API: what a tag or a
// digest names in a repository, and the manifest's annotations.
package registry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// Registry reads an OCI registry over its HTTP API (the OCI Distribution
// Specification, "Pulling manifests"), with a token from the registry's
// own token service (the Docker Registry v2 token authentication
// specification).
type Registry struct {
	// Base is the registry's address, as https://ghcr.io.
	Base string
	// User and Password are sent to the token service; none, to read as
	// anyone may.
	User, Password string
	HC             *http.Client
}

// Artifact is what a tag or a digest names in a repository.
type Artifact struct {
	// Digest is the manifest's, as sha256:….
	Digest string
	// Annotations are the manifest's.
	Annotations map[string]string
}

// manifestTypes are the manifests a release's repositories hold.
const manifestTypes = "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, " +
	"application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json"

// maxManifest bounds a manifest read; they are a few kilobytes.
const maxManifest = 4 << 20

// Resolve reads the manifest ref, a tag or a digest, names in repo. found
// is false when the registry has no such manifest, or no such repository
// for this reader: GHCR answers a missing package as it does one the
// reader may not see.
func (r *Registry) Resolve(ctx context.Context, repo, ref string) (a Artifact, found bool, err error) {
	u := r.Base + "/v2/" + repo + "/manifests/" + ref
	get := func(token string) (*http.Response, []byte, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, nil, err
		}
		req.Header.Set("Accept", manifestTypes)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := r.HC.Do(req)
		if err != nil {
			return nil, nil, fmt.Errorf("the registry: %w", err)
		}
		defer res.Body.Close()
		body, err := io.ReadAll(io.LimitReader(res.Body, maxManifest))
		return res, body, err
	}
	res, body, err := get("")
	if err != nil {
		return a, false, err
	}
	if res.StatusCode == http.StatusUnauthorized {
		token, ok, err := r.token(ctx, res.Header.Get("WWW-Authenticate"), repo)
		if err != nil || !ok {
			return a, false, err
		}
		if res, body, err = get(token); err != nil {
			return a, false, err
		}
	}
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound, http.StatusUnauthorized, http.StatusForbidden:
		return a, false, nil
	default:
		return a, false, fmt.Errorf("the registry answered %s for %s", res.Status, u)
	}
	sum := sha256.Sum256(body)
	a.Digest = "sha256:" + hex.EncodeToString(sum[:])
	if said := res.Header.Get("Docker-Content-Digest"); said != "" && said != a.Digest {
		return a, false, fmt.Errorf("the registry says %s is %s, but what it sent is %s", u, said, a.Digest)
	}
	if strings.HasPrefix(ref, "sha256:") && ref != a.Digest {
		return a, false, fmt.Errorf("the registry sent %s for %s", a.Digest, u)
	}
	var m struct {
		Annotations map[string]string `json:"annotations"`
	}
	if err := json.Unmarshal(body, &m); err != nil {
		return a, false, fmt.Errorf("the manifest at %s: %w", u, err)
	}
	a.Annotations = m.Annotations
	return a, true, nil
}

var challengeParam = regexp.MustCompile(`(realm|service|scope)="([^"]*)"`)

// token asks the token service a registry's challenge names for a token
// to pull from repo. ok is false when the service refuses one.
func (r *Registry) token(ctx context.Context, challenge, repo string) (token string, ok bool, err error) {
	params := map[string]string{}
	for _, m := range challengeParam.FindAllStringSubmatch(challenge, -1) {
		params[m[1]] = m[2]
	}
	if !strings.HasPrefix(challenge, "Bearer ") || params["realm"] == "" {
		return "", false, fmt.Errorf("the registry asks for credentials in a way not understood: %q", challenge)
	}
	// The token service is the registry's own: credentials go nowhere else.
	realm, err := url.Parse(params["realm"])
	if base, _ := url.Parse(r.Base); err != nil || realm.Scheme != base.Scheme || realm.Host != base.Host {
		return "", false, fmt.Errorf("the registry %s names a token service elsewhere, %q: not sending credentials there", r.Base, params["realm"])
	}
	q := realm.Query()
	q.Set("service", params["service"])
	q.Set("scope", "repository:"+repo+":pull")
	realm.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, realm.String(), nil)
	if err != nil {
		return "", false, err
	}
	if r.Password != "" {
		req.SetBasicAuth(r.User, r.Password)
	}
	res, err := r.HC.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("the registry's token service: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxManifest))
	if err != nil {
		return "", false, err
	}
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
		return "", false, nil
	default:
		return "", false, fmt.Errorf("the registry's token service answered %s", res.Status)
	}
	var t struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &t); err != nil {
		return "", false, fmt.Errorf("the registry's token service: %w", err)
	}
	if t.Token == "" {
		t.Token = t.AccessToken
	}
	return t.Token, t.Token != "", nil
}
