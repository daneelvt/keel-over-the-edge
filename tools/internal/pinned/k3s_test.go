// SPDX-License-Identifier: AGPL-3.0-only

package pinned

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestK3sPin(t *testing.T) {
	k, err := ReadK3s(filepath.Join("..", "..", "..", K3sFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(k.Version, "v"+k.Kubernetes()+"+k3s") {
		t.Errorf("version %s, Kubernetes %s", k.Version, k.Kubernetes())
	}
	// The installer by the commit, never by the tag, which could be moved.
	if u := k.InstallerURL(); u != "https://raw.githubusercontent.com/k3s-io/k3s/"+k.Commit+"/install.sh" || strings.Contains(u, "k3s1") {
		t.Errorf("the installer's address %s", u)
	}
}

func TestK3sPinRefused(t *testing.T) {
	for name, body := range map[string]string{
		"a version without k3s's own part": "version: v1.36.5\ncommit: 3dd98cc58ec34991e7e59b93663eee2e26fc1f65\n",
		"a short commit":                   "version: v1.36.5+k3s1\ncommit: 3dd98cc58ec3\n",
		"a branch for a commit":            "version: v1.36.5+k3s1\ncommit: master\n",
		"no commit":                        "version: v1.36.5+k3s1\n",
		"not YAML":                         "version: [\n",
	} {
		file := filepath.Join(t.TempDir(), "release.yaml")
		if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadK3s(file); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}
