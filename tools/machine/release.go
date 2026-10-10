// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

// fluxFile is Flux's own manifests in a release: its controllers, and what
// production follows.
const fluxFile = "prod/flux-system/manifests.yaml"

// mainRevision is how a release says which commit on main it was made
// from (flux push artifact's --revision).
var mainRevision = regexp.MustCompile(`^main@sha1:[0-9a-f]{40}$`)

// release pulls the release production follows, the manifests the tag
// prod names, once its signature is checked as Flux checks it, and
// returns the path of Flux's own manifests in it: what the playbook
// bootstraps Flux from. The tag is read once, and everything after works
// on the digest it named, so a promotion meanwhile cannot change what was
// checked.
func (m *machine) release(ctx context.Context) (string, error) {
	_, repo, _ := strings.Cut(manifests.ManifestsRepo, "/")
	a, found, err := m.reg.Resolve(ctx, repo, manifests.ProdTag)
	if err != nil {
		return "", err
	}
	if !found {
		return "", fmt.Errorf("production follows no release yet: %s:%s is not there. Promote a build first", manifests.ManifestsRepo, manifests.ProdTag)
	}
	revision := a.Annotations["org.opencontainers.image.revision"]
	if !mainRevision.MatchString(revision) {
		return "", fmt.Errorf("%s:%s does not say it was made from a commit on main (%q)", manifests.ManifestsRepo, manifests.ProdTag, revision)
	}
	ref := manifests.ManifestsRepo + "@" + a.Digest
	cosign, err := m.tool(ctx, pinned.Cosign)
	if err != nil {
		return "", err
	}
	if _, err := m.cmd.run(ctx, cmd{argv: []string{cosign, "verify",
		"--certificate-oidc-issuer-regexp", manifests.ReleaseIssuer,
		"--certificate-identity-regexp", manifests.ReleaseSubject,
		ref}}); err != nil {
		return "", fmt.Errorf("the release production follows, %s, is not signed by the release workflow on main: not bootstrapping Flux from it\n%w", ref, err)
	}
	flux, err := m.tool(ctx, pinned.Flux)
	if err != nil {
		return "", err
	}
	dir := m.path(stateDir, "release")
	if err := os.RemoveAll(dir); err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if _, err := m.cmd.run(ctx, cmd{argv: []string{flux, "pull", "artifact", "oci://" + ref, "--output", dir}}); err != nil {
		return "", err
	}
	file := filepath.Join(dir, filepath.FromSlash(fluxFile))
	if _, err := os.Stat(file); err != nil {
		return "", fmt.Errorf("the release %s holds no %s", ref, fluxFile)
	}
	m.logf("production follows %s (%s), signed by the release workflow on main", ref, revision)
	fmt.Fprintf(m.summary, "Flux is bootstrapped from the release production follows: `%s`, %s, signature verified.\n\n", a.Digest, revision)
	return file, nil
}
