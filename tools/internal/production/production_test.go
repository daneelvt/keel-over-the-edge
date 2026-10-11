// SPDX-License-Identifier: AGPL-3.0-only

package production

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRepositoryFile(t *testing.T) {
	p, err := Read("../../../" + File)
	if err != nil {
		t.Fatal(err)
	}
	if p.Machine != "keel-prod-1" || p.Infisical.Environment != "prod" {
		t.Errorf("%+v", p)
	}
}

// valid is a complete file, filled in as the repository's is once the
// accounts exist; each case below breaks it one way.
const valid = `machine: keel-prod-1
tailnet: tail1234.ts.net
tailscale:
  join:
    clientID: kJoin1CNTRL-abc
    audience: api.tailscale.com/kJoin1CNTRL-abc
  policy:
    clientID: kPolicy1CNTRL-def
    audience: api.tailscale.com/kPolicy1CNTRL-def
infisical:
  host: https://us.infisical.com
  identityID: 5546676b-0000-4000-8000-000000000000
  audience: https://github.com/daneelvt
  project: 09d6ca0c-0000-4000-8000-000000000000
  environment: prod
  accounts:
    identityID: 7a1f0000-0000-4000-8000-000000000000
    project: 3b2e0000-0000-4000-8000-000000000000
  cluster:
    project: 4c3d0000-0000-4000-8000-000000000000
    slug: keel-cluster-ab12
cloudflare:
  account: 0123456789abcdef0123456789abcdef
  zone: fedcba9876543210fedcba9876543210
state:
  bucket: keel-state-example
  endpoint: https://s3.us-west-004.backblazeb2.com
  region: us-west-004
`

func readText(t *testing.T, text string) error {
	t.Helper()
	file := filepath.Join(t.TempDir(), "production.yaml")
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Read(file)
	return err
}

func TestReadRefuses(t *testing.T) {
	if err := readText(t, valid); err != nil {
		t.Fatalf("the valid file: %v", err)
	}
	cases := []struct{ name, old, new, want string }{
		{"a public name", `machine: keel-prod-1`, `machine: keel-prod-1.example.com`, "not a host name"},
		{"another suffix", `tailnet: tail1234.ts.net`, `tailnet: example.com`, "not a MagicDNS suffix"},
		{"an audience for another client", `audience: api.tailscale.com/kJoin1CNTRL-abc`, `audience: api.tailscale.com/kOther`, "does not name its client ID"},
		{"one identity for both", "clientID: kPolicy1CNTRL-def\n    audience: api.tailscale.com/kPolicy1CNTRL-def",
			"clientID: kJoin1CNTRL-abc\n    audience: api.tailscale.com/kJoin1CNTRL-abc", "the same identity"},
		{"plain HTTP", `host: https://us.infisical.com`, `host: http://us.infisical.com`, "not https://<host>"},
		{"a path on the host", `host: https://us.infisical.com`, `host: https://us.infisical.com/api`, "not https://<host>"},
		{"no environment", `  environment: prod`, `  environment: ""`, "set from the start"},
		{"an unknown key", `machine: keel-prod-1`, "machine: keel-prod-1\naddress: 192.0.2.1", "not found"},
		{"the machine's identity for accounts", `identityID: 7a1f0000-0000-4000-8000-000000000000`, `identityID: 5546676b-0000-4000-8000-000000000000`, "each workflow has its own"},
		{"one project for two readers", `project: 4c3d0000-0000-4000-8000-000000000000`, `project: 3b2e0000-0000-4000-8000-000000000000`, "infisical.accounts.project and infisical.cluster.project are the same project"},
		{"a slug with capitals", `slug: keel-cluster-ab12`, `slug: Keel-Cluster`, "not a project's slug"},
		{"a zone's name for its ID", `zone: fedcba9876543210fedcba9876543210`, `zone: keelovertheedge.com`, "not a Cloudflare ID"},
		{"a bucket's URL", `bucket: keel-state-example`, `bucket: s3://keel-state-example`, "not a B2 bucket's name"},
		{"plain HTTP to B2", `endpoint: https://s3.us-west-004.backblazeb2.com`, `endpoint: http://s3.us-west-004.backblazeb2.com`, "not https://<host>"},
		{"an AWS region", `region: us-west-004`, `region: us-west-2`, "not a B2 region"},
		{"an endpoint in another region", `endpoint: https://s3.us-west-004.backblazeb2.com`, `endpoint: https://s3.eu-central-003.backblazeb2.com`, "not in state.region"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if !strings.Contains(valid, c.old) {
				t.Fatalf("no %q to change", c.old)
			}
			if err := readText(t, strings.Replace(valid, c.old, c.new, 1)); err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("got %v, want %q", err, c.want)
			}
		})
	}
}

// TestEmptyValuesAreAccounts: an empty value is an account not made yet,
// which Read accepts and Need reports.
func TestEmptyValuesAreAccounts(t *testing.T) {
	empty := strings.NewReplacer("tail1234.ts.net", `""`, "https://us.infisical.com", `""`).Replace(valid)
	if err := readText(t, empty); err != nil {
		t.Errorf("empty values: %v", err)
	}
}

func TestNeed(t *testing.T) {
	if err := Need(map[string]string{"a": "x"}); err != nil {
		t.Error(err)
	}
	err := Need(map[string]string{"b.id": "", "a.host": "", "c": "x"})
	if err == nil || !strings.Contains(err.Error(), "has no a.host, b.id yet") || !strings.Contains(err.Error(), "MANUAL-STEPS") {
		t.Errorf("got %v", err)
	}
}

// backups is valid's backups, filled in.
const backups = `backups:
  endpoint: https://s3.us-west-004.backblazeb2.com
  region: us-west-004
  bucket: keel-db-backups-example
  dumps: keel-db-dumps-example
  local: keel-db-backups-local-example
`

// TestBackups: the backups' buckets are three of their own, at an endpoint
// in their region, and the project that holds their keys is not the
// cluster's; until all are written down, BackupsMade says which is not.
func TestBackups(t *testing.T) {
	whole := strings.Replace(valid, "    slug: keel-cluster-ab12\n", "    slug: keel-cluster-ab12\n  backups:\n    slug: keel-backups-cd34\n", 1) + backups
	if err := readText(t, whole); err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct{ old, new, want string }{
		"the state's bucket":      {"bucket: keel-db-backups-example", "bucket: keel-state-example", "state.bucket and backups.bucket are the same bucket"},
		"one bucket for two":      {"dumps: keel-db-dumps-example", "dumps: keel-db-backups-example", "are the same bucket"},
		"the local as production": {"local: keel-db-backups-local-example", "local: keel-db-backups-example", "are the same bucket"},
		"a bucket's name":         {"dumps: keel-db-dumps-example", "dumps: keel_db_dumps", "not a B2 bucket's name"},
		"another region":          {"region: us-west-004\n  bucket: keel-db-backups-example", "region: eu-central-003\n  bucket: keel-db-backups-example", "is not in backups.region"},
		"plain http":              {"backups:\n  endpoint: https://", "backups:\n  endpoint: http://", "backups.endpoint"},
		"the cluster's project":   {"slug: keel-backups-cd34", "slug: keel-cluster-ab12", "a project's slug of its own"},
	} {
		if !strings.Contains(whole, tc.old) {
			t.Fatalf("%s: nothing to replace", name)
		}
		if err := readText(t, strings.Replace(whole, tc.old, tc.new, 1)); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v, want %q", name, err, tc.want)
		}
	}
	read := func(text string) Production {
		t.Helper()
		file := filepath.Join(t.TempDir(), "production.yaml")
		if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		p, err := Read(file)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	if err := read(whole).BackupsMade(); err != nil {
		t.Errorf("with everything written down: %v", err)
	}
	// Before the accounts are made, the file is still read; a release is not rendered.
	if err := read(valid).BackupsMade(); err == nil || !strings.Contains(err.Error(), "backups.bucket") || !strings.Contains(err.Error(), "infisical.backups.slug") {
		t.Errorf("with nothing written down: %v", err)
	}
	if err := read(valid + backups).BackupsMade(); err == nil || strings.Contains(err.Error(), "backups.bucket") || !strings.Contains(err.Error(), "infisical.backups.slug") {
		t.Errorf("with the project not yet made: %v", err)
	}
}
