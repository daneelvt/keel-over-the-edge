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

func TestReadRefuses(t *testing.T) {
	base, err := os.ReadFile("../../../" + File)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, old, new, want string }{
		{"a public name", `machine: keel-prod-1`, `machine: keel-prod-1.example.com`, "not a host name"},
		{"another suffix", `tailnet: ""`, `tailnet: example.com`, "not a MagicDNS suffix"},
		{"an audience for another client", "join:\n    clientID: \"\"\n    audience: \"\"",
			"join:\n    clientID: kAbC\n    audience: api.tailscale.com/kXyZ", "does not name its client ID"},
		{"one identity for both", "join:\n    clientID: \"\"\n    audience: \"\"\n  # The federated identity the tailnet workflow writes the policy with\n  # (scope policy_file).\n  policy:\n    clientID: \"\"",
			"join:\n    clientID: kAbC\n    audience: \"\"\n  policy:\n    clientID: kAbC", "the same identity"},
		{"plain HTTP", `host: ""`, `host: http://us.infisical.com`, "not https://<host>"},
		{"an unknown key", `machine: keel-prod-1`, "machine: keel-prod-1\naddress: 192.0.2.1", "not found"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if !strings.Contains(string(base), c.old) {
				t.Fatalf("no %q to change", c.old)
			}
			file := filepath.Join(t.TempDir(), "production.yaml")
			if err := os.WriteFile(file, []byte(strings.Replace(string(base), c.old, c.new, 1)), 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err := Read(file); err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("got %v, want %q", err, c.want)
			}
		})
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
