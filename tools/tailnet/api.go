// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/tailscale/hujson"
)

// api is Tailscale's API, signed in as a federated identity (Tailscale's
// documentation, "Workload identity federation", and its API reference,
// "Policy File"). "-" is the tailnet the token belongs to.
type api struct {
	base  string // https://api.tailscale.com
	token string
	hc    *http.Client
}

// exchange trades a token GitHub issued the job for one of Tailscale's,
// as the identity clientID: Tailscale checks the token's issuer, subject
// and claims against what the identity was made to accept.
func exchange(ctx context.Context, hc *http.Client, base, clientID, idToken string) (string, error) {
	form := url.Values{"client_id": {clientID}, "jwt": {idToken}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v2/oauth/token-exchange", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("the token exchange with Tailscale: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the identity %s refused this job's token: %s %s", clientID, res.Status, oneLine(body))
	}
	var t struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &t); err != nil || t.AccessToken == "" {
		return "", errors.New("the token exchange with Tailscale answered no token")
	}
	return t.AccessToken, nil
}

func (a *api) do(ctx context.Context, method, path string, body []byte, header map[string]string) (*http.Response, []byte, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.base+"/api/v2/tailnet/-/"+path, r)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := a.hc.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("the API, %s %s: %w", method, path, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, nil, fmt.Errorf("the API, %s %s: %w", method, path, err)
	}
	return res, data, nil
}

// policyError is what Tailscale answers about a policy it refuses, its
// tests' failures included.
type policyError struct {
	Message string `json:"message"`
	Data    []struct {
		User     string   `json:"user"`
		Errors   []string `json:"errors"`
		Warnings []string `json:"warnings"`
	} `json:"data"`
}

func (e policyError) empty() bool { return e.Message == "" && len(e.Data) == 0 }

func (e policyError) Error() string {
	var b strings.Builder
	b.WriteString(e.Message)
	for _, d := range e.Data {
		if d.User != "" {
			fmt.Fprintf(&b, "\n%s:", d.User)
		}
		for _, s := range d.Errors {
			fmt.Fprintf(&b, "\n- %s", s)
		}
		for _, s := range d.Warnings {
			fmt.Fprintf(&b, "\n- (warning) %s", s)
		}
	}
	return b.String()
}

// validate has Tailscale check the policy, its tests included, without
// applying it.
func (a *api) validate(ctx context.Context, policy []byte) error {
	std, err := hujson.Standardize(bytes.Clone(policy))
	if err != nil {
		return err
	}
	res, body, err := a.do(ctx, http.MethodPost, "acl/validate", std, map[string]string{"Content-Type": "application/hujson"})
	if err != nil {
		return err
	}
	var pe policyError
	if len(bytes.TrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, &pe); err != nil {
			return fmt.Errorf("the answer to the validation: %s %s", res.Status, oneLine(body))
		}
	}
	if !pe.empty() {
		return fmt.Errorf("the policy is refused: %w", pe)
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("the validation was answered %s", res.Status)
	}
	return nil
}

// live is the policy Tailscale holds, as it was written, and its ETag.
func (a *api) live(ctx context.Context) (policy []byte, etag string, err error) {
	res, body, err := a.do(ctx, http.MethodGet, "acl", nil, map[string]string{"Accept": "application/hujson"})
	if err != nil {
		return nil, "", err
	}
	if res.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("reading the policy was answered %s: %s", res.Status, oneLine(body))
	}
	etag = res.Header.Get("ETag")
	if etag == "" {
		return nil, "", errors.New("the live policy came with no ETag")
	}
	return body, etag, nil
}

// errChanged is a write refused because the policy changed since it was
// read.
var errChanged = errors.New("the policy changed in Tailscale since it was read (412): nothing written; run again")

// write replaces the policy, only if it is still the one whose ETag was
// read.
func (a *api) write(ctx context.Context, policy []byte, etag string) error {
	res, body, err := a.do(ctx, http.MethodPost, "acl", policy, map[string]string{"Content-Type": "application/hujson", "If-Match": etag})
	if err != nil {
		return err
	}
	switch res.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusPreconditionFailed:
		return errChanged
	}
	var pe policyError
	if json.Unmarshal(body, &pe) == nil && !pe.empty() {
		return fmt.Errorf("the policy was refused (%s): %w", res.Status, pe)
	}
	return fmt.Errorf("writing the policy was answered %s: %s", res.Status, oneLine(body))
}

// oneLine is an answer's body, short and on one line, for an error.
func oneLine(b []byte) string {
	s := strings.Join(strings.Fields(string(b)), " ")
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}
