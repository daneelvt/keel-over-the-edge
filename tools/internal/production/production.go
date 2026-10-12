// SPDX-License-Identifier: AGPL-3.0-only

// Package production reads infra/production.yaml: the identifiers of
// production's machine, tailnet, secrets store, Cloudflare zone, state
// bucket and backups' buckets that the workflows' tools need, none of them
// secret.
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

	// Cloudflare is the account and zone the accounts workflow manages.
	Cloudflare struct {
		Account string `yaml:"account"`
		Zone    string `yaml:"zone"`
	} `yaml:"cloudflare"`

	// State is where OpenTofu keeps the accounts workflow's state: a B2
	// bucket, through B2's S3 API at Endpoint, in Region.
	State struct {
		Bucket   string `yaml:"bucket"`
		Endpoint string `yaml:"endpoint"`
		Region   string `yaml:"region"`
	} `yaml:"state"`

	// Backups is where the database's backups go: B2's S3 API at Endpoint,
	// in Region, and the buckets made by hand for them.
	Backups Backups `yaml:"backups"`
}

// Backups are the database's backups' buckets, each with a key of its own
// that no workflow holds.
type Backups struct {
	Endpoint string `yaml:"endpoint"`
	Region   string `yaml:"region"`
	// Bucket holds production's WAL and base backups; Dumps, its weekly
	// dumps; Local, the local cluster's WAL and base backups.
	Bucket string `yaml:"bucket"`
	Dumps  string `yaml:"dumps"`
	Local  string `yaml:"local"`
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

	// Accounts is where the accounts workflow reads its credentials: the
	// identity it signs in as, with the same audience, and its project.
	Accounts struct {
		IdentityID string `yaml:"identityID"`
		Project    string `yaml:"project"`
	} `yaml:"accounts"`

	// Cluster is the project the cluster's External Secrets reads, and the
	// accounts workflow writes the secrets it makes into: by ID for
	// OpenTofu, by slug for External Secrets' store.
	Cluster struct {
		Project string `yaml:"project"`
		Slug    string `yaml:"slug"`
	} `yaml:"cluster"`

	// Backups is the project that holds the backups' keys, which the
	// cluster's External Secrets alone reads: by its slug, for its store.
	Backups struct {
		Slug string `yaml:"slug"`
	} `yaml:"backups"`
}

var (
	hostName = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
	// Tailscale's MagicDNS suffixes are tailnet names under ts.net.
	magicDNS = regexp.MustCompile(`^[a-z0-9-]+\.ts\.net$`)
	// An identifier as the services show them: letters, digits, dashes.
	identifier = regexp.MustCompile(`^[A-Za-z0-9-]+$`)
	// Cloudflare's account and zone IDs are 32 hexadecimal digits.
	cloudflareID = regexp.MustCompile(`^[0-9a-f]{32}$`)
	// B2's bucket names: 6 to 63 letters, digits and dashes (Backblaze's
	// documentation, "Buckets"); its regions, as us-west-004.
	bucketName = regexp.MustCompile(`^[A-Za-z0-9-]{6,63}$`)
	b2Region   = regexp.MustCompile(`^[a-z]+-[a-z]+-[0-9]{3}$`)
	// A project's slug in Infisical.
	slug = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
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
	for name, v := range map[string]string{"identityID": in.IdentityID, "project": in.Project,
		"accounts.identityID": in.Accounts.IdentityID, "accounts.project": in.Accounts.Project, "cluster.project": in.Cluster.Project} {
		if v != "" && !identifier.MatchString(v) {
			fail("infisical.%s %q is not an ID", name, v)
		}
	}
	if in.Audience == "" || in.Environment == "" {
		fail("infisical.audience and infisical.environment are set from the start")
	}
	// Each workflow and the cluster have their own identity and project:
	// a project is the only fence Infisical's free plan has.
	if in.Accounts.IdentityID != "" && in.Accounts.IdentityID == in.IdentityID {
		fail("infisical.accounts.identityID is the machine workflow's identity: each workflow has its own")
	}
	projects := map[string]string{}
	for name, v := range map[string]string{"infisical.project": in.Project, "infisical.accounts.project": in.Accounts.Project, "infisical.cluster.project": in.Cluster.Project} {
		if other, ok := projects[v]; ok && v != "" {
			fail("%s and %s are the same project: each reader has its own", min(name, other), max(name, other))
		}
		projects[v] = name
	}
	if in.Cluster.Slug != "" && !slug.MatchString(in.Cluster.Slug) {
		fail("infisical.cluster.slug %q is not a project's slug", in.Cluster.Slug)
	}
	for name, v := range map[string]string{"account": p.Cloudflare.Account, "zone": p.Cloudflare.Zone} {
		if v != "" && !cloudflareID.MatchString(v) {
			fail("cloudflare.%s %q is not a Cloudflare ID, 32 hexadecimal digits", name, v)
		}
	}
	st := p.State
	if st.Bucket != "" && !bucketName.MatchString(st.Bucket) {
		fail("state.bucket %q is not a B2 bucket's name", st.Bucket)
	}
	if st.Endpoint != "" {
		if u, err := url.Parse(st.Endpoint); err != nil || u.Scheme != "https" || u.Host == "" || (u.Path != "" && u.Path != "/") {
			fail("state.endpoint %q is not https://<host>", st.Endpoint)
		}
	}
	if st.Region != "" && !b2Region.MatchString(st.Region) {
		fail("state.region %q is not a B2 region, as us-west-004", st.Region)
	}
	if st.Region != "" && st.Endpoint != "" && !strings.Contains(st.Endpoint, "."+st.Region+".") {
		fail("state.endpoint %q is not in state.region %s", st.Endpoint, st.Region)
	}
	if in.Backups.Slug != "" && (!slug.MatchString(in.Backups.Slug) || in.Backups.Slug == in.Cluster.Slug) {
		fail("infisical.backups.slug %q is not a project's slug of its own: the backups' keys are in a project no workflow reads", in.Backups.Slug)
	}
	b := p.Backups
	if b.Endpoint != "" {
		if u, err := url.Parse(b.Endpoint); err != nil || u.Scheme != "https" || u.Host == "" || (u.Path != "" && u.Path != "/") {
			fail("backups.endpoint %q is not https://<host>", b.Endpoint)
		}
	}
	if b.Region != "" && !b2Region.MatchString(b.Region) {
		fail("backups.region %q is not a B2 region, as us-west-004", b.Region)
	}
	if b.Region != "" && b.Endpoint != "" && !strings.Contains(b.Endpoint, "."+b.Region+".") {
		fail("backups.endpoint %q is not in backups.region %s", b.Endpoint, b.Region)
	}
	buckets := map[string]string{st.Bucket: "state.bucket"}
	for _, bk := range []struct{ name, v string }{{"backups.bucket", b.Bucket}, {"backups.dumps", b.Dumps}, {"backups.local", b.Local}} {
		if bk.v == "" {
			continue
		}
		if !bucketName.MatchString(bk.v) {
			fail("%s %q is not a B2 bucket's name", bk.name, bk.v)
		}
		if other, ok := buckets[bk.v]; ok {
			fail("%s and %s are the same bucket: each has a key of its own", other, bk.name)
		}
		buckets[bk.v] = bk.name
	}
	return errors.Join(errs...)
}

// BackupsMade fails, naming what is missing, until the backups' buckets
// and the project that holds their keys are made by hand and written
// down: a release's manifests name them, and would archive nowhere.
func (p Production) BackupsMade() error {
	return Need(map[string]string{
		"backups.endpoint": p.Backups.Endpoint, "backups.region": p.Backups.Region,
		"backups.bucket": p.Backups.Bucket, "backups.dumps": p.Backups.Dumps, "backups.local": p.Backups.Local,
		"infisical.backups.slug": p.Infisical.Backups.Slug,
	})
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
