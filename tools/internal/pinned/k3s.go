// SPDX-License-Identifier: AGPL-3.0-only

package pinned

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

// K3sFile is where the repository pins k3s, from its root.
const K3sFile = "infra/k3s/release.yaml"

// K3s is the k3s release every machine that runs the game installs.
type K3s struct {
	// Version is the release's tag, as v1.36.5+k3s1.
	Version string `yaml:"version"`
	// Commit is the commit the tag names: the installer is fetched at it.
	Commit string `yaml:"commit"`
}

var (
	k3sVersion = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+$`)
	k3sCommit  = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// ReadK3s reads the pin from file.
func ReadK3s(file string) (K3s, error) {
	var k K3s
	data, err := os.ReadFile(file)
	if err != nil {
		return k, err
	}
	if err := yaml.Unmarshal(data, &k); err != nil {
		return k, fmt.Errorf("%s: %w", file, err)
	}
	if !k3sVersion.MatchString(k.Version) {
		return k, fmt.Errorf("%s: version %q is not a k3s release, as v1.36.5+k3s1", file, k.Version)
	}
	if !k3sCommit.MatchString(k.Commit) {
		return k, fmt.Errorf("%s: commit %q is not a whole commit ID", file, k.Commit)
	}
	return k, nil
}

// Kubernetes is the version of Kubernetes the release holds, as 1.36.5.
func (k K3s) Kubernetes() string {
	v, _, _ := strings.Cut(strings.TrimPrefix(k.Version, "v"), "+")
	return v
}

// InstallerURL is the release's install.sh, at the pinned commit: what a
// commit ID names never changes, unlike what a tag does.
func (k K3s) InstallerURL() string {
	return "https://raw.githubusercontent.com/k3s-io/k3s/" + k.Commit + "/install.sh"
}
