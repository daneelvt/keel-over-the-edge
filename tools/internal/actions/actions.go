// SPDX-License-Identifier: AGPL-3.0-only

// Package actions is what the workflows' tools need of GitHub Actions: the
// job's OIDC token, masking a secret in the log, and the run's summary.
package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// IDToken asks GitHub for the job's OIDC token for audience, and masks it
// in the log before returning it. The job needs the id-token: write
// permission, which gives it ACTIONS_ID_TOKEN_REQUEST_URL and _TOKEN
// (GitHub's documentation, "OpenID Connect").
func IDToken(ctx context.Context, hc *http.Client, log io.Writer, audience string) (string, error) {
	reqURL, reqToken := os.Getenv("ACTIONS_ID_TOKEN_REQUEST_URL"), os.Getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
	if reqURL == "" || reqToken == "" {
		return "", errors.New("no OIDC token to be had: this runs in a workflow's job with the id-token: write permission")
	}
	u, err := url.Parse(reqURL)
	if err != nil {
		return "", fmt.Errorf("ACTIONS_ID_TOKEN_REQUEST_URL: %w", err)
	}
	q := u.Query()
	q.Set("audience", audience)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+reqToken)
	req.Header.Set("Accept", "application/json")
	res, err := hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("GitHub's OIDC token: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub's OIDC token: GitHub answered %s", res.Status)
	}
	var body struct {
		Value string `json:"value"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil || body.Value == "" {
		return "", errors.New("GitHub's OIDC token: the answer holds no token")
	}
	Mask(log, body.Value)
	return body.Value, nil
}

// Mask tells the runner to hide secret wherever it appears in the log
// from now on (GitHub's workflow commands, "Masking a value in a log").
// Each line is masked on its own, as the runner matches line by line.
func Mask(log io.Writer, secret string) {
	for line := range strings.SplitSeq(secret, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			fmt.Fprintf(log, "::add-mask::%s\n", line)
		}
	}
}

// Summary is the run's summary, to append Markdown to; outside a workflow,
// nothing.
func Summary() (io.WriteCloser, error) {
	file := os.Getenv("GITHUB_STEP_SUMMARY")
	if file == "" {
		return nopCloser{io.Discard}, nil
	}
	return os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
}

type nopCloser struct{ io.Writer }

func (nopCloser) Close() error { return nil }

// InWorkflow is whether this runs in a workflow's job.
func InWorkflow() bool { return os.Getenv("GITHUB_ACTIONS") == "true" }
