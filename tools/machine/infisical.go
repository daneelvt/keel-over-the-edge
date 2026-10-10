// SPDX-License-Identifier: AGPL-3.0-only

package main

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
	"github.com/daneelvt/keel-over-the-edge/tools/internal/production"
)

// secretPath is the folder of the workflows' credentials in Infisical's
// project, and secrets the ones the playbook needs: External Secrets'
// credential, which the cluster reads its own secrets with.
const secretPath = "/machine"

var secrets = []string{"ESO_CLIENT_ID", "ESO_CLIENT_SECRET"}

// infisical signs in to Infisical as the identity infra/production.yaml
// names, with the job's OIDC token, and reads the playbook's secrets.
// Each is masked in the log before anything else happens (Infisical's API
// reference: "OIDC Auth: Login"; "Secrets: Get secret by name").
func (m *machine) infisical(ctx context.Context) (map[string]string, error) {
	in := m.prod.Infisical
	if err := production.Need(map[string]string{"infisical.host": in.Host, "infisical.identityID": in.IdentityID, "infisical.project": in.Project}); err != nil {
		return nil, err
	}
	jwt, err := m.idToken(ctx, in.Audience)
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]string{"identityId": in.IdentityID, "jwt": jwt})
	var login struct {
		AccessToken string `json:"accessToken"`
	}
	if err := m.infisicalCall(ctx, http.MethodPost, "/api/v1/auth/oidc-auth/login", "", body, &login); err != nil {
		return nil, fmt.Errorf("signing in to Infisical as %s: %w", in.IdentityID, err)
	}
	if login.AccessToken == "" {
		return nil, fmt.Errorf("signing in to Infisical as %s: no token in the answer", in.IdentityID)
	}
	actions.Mask(m.out, login.AccessToken)

	values := map[string]string{}
	for _, name := range secrets {
		q := url.Values{"projectId": {in.Project}, "environment": {in.Environment}, "secretPath": {secretPath}}
		var s struct {
			Secret struct {
				SecretValue string `json:"secretValue"`
			} `json:"secret"`
		}
		if err := m.infisicalCall(ctx, http.MethodGet, "/api/v4/secrets/"+url.PathEscape(name)+"?"+q.Encode(), login.AccessToken, nil, &s); err != nil {
			return nil, fmt.Errorf("reading %s%s/%s from Infisical: %w", in.Environment, secretPath, name, err)
		}
		if s.Secret.SecretValue == "" {
			return nil, fmt.Errorf("%s%s/%s is empty in Infisical", in.Environment, secretPath, name)
		}
		actions.Mask(m.out, s.Secret.SecretValue)
		values[name] = s.Secret.SecretValue
	}
	m.logf("read %s from Infisical", strings.Join(secrets, " and "))
	return values, nil
}

func (m *machine) infisicalCall(ctx context.Context, method, path, token string, body []byte, v any) error {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(m.prod.Infisical.Host, "/")+path, r)
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
	res, err := m.hc.Do(req)
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
