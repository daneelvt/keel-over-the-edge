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
