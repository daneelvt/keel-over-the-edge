// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/infisical"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/production"
)

// secretPath is the folder of the workflows' credentials in Infisical's
// project, and secrets the ones the playbook needs: External Secrets'
// credential, which the cluster reads its own secrets with.
const secretPath = "/machine"

var secrets = []string{"ESO_CLIENT_ID", "ESO_CLIENT_SECRET"}

// infisical signs in to Infisical as the identity infra/production.yaml
// names, with the job's OIDC token, and reads the playbook's secrets,
// each masked in the log before anything else happens.
func (m *machine) infisical(ctx context.Context) (map[string]string, error) {
	in := m.prod.Infisical
	if err := production.Need(map[string]string{"infisical.host": in.Host, "infisical.identityID": in.IdentityID, "infisical.project": in.Project}); err != nil {
		return nil, err
	}
	jwt, err := m.idToken(ctx, in.Audience)
	if err != nil {
		return nil, err
	}
	c := &infisical.Client{Host: in.Host, HC: m.hc, Log: m.out}
	s, err := c.Login(ctx, in.IdentityID, jwt)
	if err != nil {
		return nil, err
	}
	values, err := s.Read(ctx, in.Project, in.Environment, secretPath, secrets...)
	if err != nil {
		return nil, err
	}
	m.logf("read %s from Infisical", strings.Join(secrets, " and "))
	return values, nil
}
