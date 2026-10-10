// SPDX-License-Identifier: AGPL-3.0-only

// Package production reads infra/production.yaml: the identifiers of
// production's machine, tailnet and secrets store that the workflows'
// tools need, none of them secret.
package production

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"
)

// File is where the identifiers are kept, from the repository's root.
const File = "infra/production.yaml"

// Production is infra/production.yaml.
type Production struct {
	// Machine is the machine's name on the tailnet; Tailnet, the tailnet's
	// MagicDNS suffix, as tail1234.ts.net.
	Machine string `yaml:"machine"`
	Tailnet string `yaml:"tailnet"`

	Tailscale struct {
		// Join is the identity the machine workflow joins the tailnet
		// with; Policy, the one the tailnet workflow writes the policy
		// with.
		Join   Identity `yaml:"join"`
		Policy Identity `yaml:"policy"`
	} `yaml:"tailscale"`

	Infisical Infisical `yaml:"infisical"`
}

// Identity is a Tailscale federated identity: a workflow exchanges a token
// GitHub issued it, for the audience, for one of Tailscale's.
type Identity struct {
	ClientID string `yaml:"clientID"`
	Audience string `yaml:"audience"`
}

// Infisical is where the machine workflow reads its credentials.
type Infisical struct {
	// Host is the region's, as https://us.infisical.com.
	Host string `yaml:"host"`
	// IdentityID is the machine identity the workflow signs in as, with
	// GitHub's OIDC token for Audience.
	IdentityID string `yaml:"identityID"`
	Audience   string `yaml:"audience"`
	// Project and Environment hold the workflows' credentials.
	Project     string `yaml:"project"`
	Environment string `yaml:"environment"`
}

var (
	hostName = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
	// Tailscale's MagicDNS suffixes are tailnet names under ts.net.
	magicDNS = regexp.MustCompile(`^[a-z0-9-]+\.ts\.net$`)
	// An identifier as the services show them: letters, digits, dashes.
	identifier = regexp.MustCompile(`^[A-Za-z0-9-]+$`)
)

// Read reads file, checking what it holds is well formed. An empty value
// is allowed: it is an account not made yet, which the tool that needs it
// reports (Need).
func Read(file string) (Production, error) {
	var p Production
	data, err := os.ReadFile(file)
	if err != nil {
		return p, err
	}
	dec := yaml.NewDecoder(strings.NewReader(string(data)))
	dec.KnownFields(true)
	if err := dec.Decode(&p); err != nil {
		return p, fmt.Errorf("%s: %w", file, err)
	}
	if err := p.check(); err != nil {
		return p, fmt.Errorf("%s: %w", file, err)
	}
	return p, nil
}

func (p Production) check() error {
	var errs []error
	fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }
	if !hostName.MatchString(p.Machine) {
		fail("machine %q is not a host name", p.Machine)
	}
	if p.Tailnet != "" && !magicDNS.MatchString(p.Tailnet) {
		fail("tailnet %q is not a MagicDNS suffix, as tail1234.ts.net", p.Tailnet)
	}
	for name, id := range map[string]Identity{"join": p.Tailscale.Join, "policy": p.Tailscale.Policy} {
		if id.ClientID != "" && !identifier.MatchString(id.ClientID) {
			fail("tailscale.%s.clientID %q is not a client ID", name, id.ClientID)
		}
		// Tailscale's audience for a federated identity names its client.
		if id.Audience != "" && (id.ClientID == "" || !strings.HasSuffix(id.Audience, "/"+id.ClientID)) {
			fail("tailscale.%s.audience %q does not name its client ID, as api.tailscale.com/<client ID>", name, id.Audience)
		}
	}
	if p.Tailscale.Join.ClientID != "" && p.Tailscale.Join.ClientID == p.Tailscale.Policy.ClientID {
		fail("tailscale.join and tailscale.policy are the same identity: each workflow has its own")
	}
	in := p.Infisical
	if in.Host != "" {
		if u, err := url.Parse(in.Host); err != nil || u.Scheme != "https" || u.Host == "" || (u.Path != "" && u.Path != "/") {
			fail("infisical.host %q is not https://<host>", in.Host)
		}
	}
	for name, v := range map[string]string{"identityID": in.IdentityID, "project": in.Project} {
		if v != "" && !identifier.MatchString(v) {
			fail("infisical.%s %q is not an ID", name, v)
		}
	}
	if in.Audience == "" || in.Environment == "" {
		fail("infisical.audience and infisical.environment are set from the start")
	}
	return errors.Join(errs...)
}

// Need fails, naming each, unless every value is set: what a tool cannot
// run without, before the account that gives it has been made.
func Need(values map[string]string) error {
	var missing []string
	for name, v := range values {
		if v == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	slices.Sort(missing)
	return fmt.Errorf("%s has no %s yet: the account that gives it is made by hand, as infra/MANUAL-STEPS.md says, and its value written there", File, strings.Join(missing, ", "))
}

// MagicDNS is the machine's full name on the tailnet.
func (p Production) MagicDNS() string {
	if p.Tailnet == "" {
		return ""
	}
	return p.Machine + "." + p.Tailnet
}
