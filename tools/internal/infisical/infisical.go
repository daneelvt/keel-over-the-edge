// SPDX-License-Identifier: AGPL-3.0-only

// Package infisical signs in to Infisical as a machine identity, with a
// workflow job's OIDC token, and reads secrets, each masked in the job's
// log before anything else sees it (Infisical's API reference: "OIDC Auth:
// Login"; "Secrets: Get secret by name").
package infisical

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/actions"
)

// Client talks to one Infisical region.
type Client struct {
	// Host is the region's, as https://us.infisical.com.
	Host string
	HC   *http.Client
	// Log is the job's log, where a token or a secret is masked.
	Log io.Writer
}

// Session is a signed-in identity.
type Session struct {
	c     *Client
	token string
}

// Login signs in as the identity with jwt, a GitHub OIDC token for the
// audience the identity expects. The access token is masked.
func (c *Client) Login(ctx context.Context, identityID, jwt string) (*Session, error) {
	body, _ := json.Marshal(map[string]string{"identityId": identityID, "jwt": jwt})
	var login struct {
		AccessToken string `json:"accessToken"`
	}
	if err := c.call(ctx, http.MethodPost, "/api/v1/auth/oidc-auth/login", "", body, &login); err != nil {
		return nil, fmt.Errorf("signing in to Infisical as %s: %w", identityID, err)
	}
	if login.AccessToken == "" {
		return nil, fmt.Errorf("signing in to Infisical as %s: no token in the answer", identityID)
	}
	actions.Mask(c.Log, login.AccessToken)
	return &Session{c: c, token: login.AccessToken}, nil
}

// Read reads each named secret from a folder of a project's environment.
// Every value is masked as soon as it is read; an empty one is an error.
func (s *Session) Read(ctx context.Context, project, environment, folder string, names ...string) (map[string]string, error) {
	values := map[string]string{}
	for _, name := range names {
		q := url.Values{"projectId": {project}, "environment": {environment}, "secretPath": {folder}}
		var res struct {
			Secret struct {
				SecretValue string `json:"secretValue"`
			} `json:"secret"`
		}
		if err := s.c.call(ctx, http.MethodGet, "/api/v4/secrets/"+url.PathEscape(name)+"?"+q.Encode(), s.token, nil, &res); err != nil {
			return nil, fmt.Errorf("reading %s%s/%s from Infisical: %w", environment, folder, name, err)
		}
		if res.Secret.SecretValue == "" {
			return nil, fmt.Errorf("%s%s/%s is empty in Infisical", environment, folder, name)
		}
		actions.Mask(s.c.Log, res.Secret.SecretValue)
		values[name] = res.Secret.SecretValue
	}
	return values, nil
}

func (c *Client) call(ctx context.Context, method, path, token string, body []byte, v any) error {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(c.Host, "/")+path, r)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := c.HC.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		// Infisical's errors say what was refused, never a secret.
		var e struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &e)
		return fmt.Errorf("the answer was %s: %s", res.Status, e.Message)
	}
	return json.Unmarshal(data, v)
}
