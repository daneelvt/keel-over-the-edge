// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

// fluxFile is Flux's own manifests in a release, for one of production's
// two forms: its controllers, and what production follows. appsFile is the
// game's, with its database.
const (
	fluxFile = "flux-system/manifests.yaml"
	appsFile = "apps/manifests.yaml"
)

// The two forms of production a release holds: as it runs, and as it is
// rebuilt, its database recovered from the backups.
const (
	liveForm    = "prod"
	rebuildForm = manifests.Rebuild
)

// released is what the playbook needs of the release production follows.
type released struct {
	// flux is the path of Flux's own manifests, of the form asked for.
	flux string
	// live and rebuilt are the archives the database writes in each form;
	// "" in a release from before the database was backed up.
	live, rebuilt string
}

// mainRevision is how a release says which commit on main it was made
// from (flux push artifact's --revision).
var mainRevision = regexp.MustCompile(`^main@sha1:[0-9a-f]{40}$`)

// release pulls the release production follows, the manifests the tag
// prod names, once its signature is checked as Flux checks it, and
// returns Flux's own manifests in it, of the live form or the rebuild's:
// what the playbook bootstraps Flux from. The tag is read once, and
// everything after works on the digest it named, so a promotion meanwhile
// cannot change what was checked.
func (m *machine) release(ctx context.Context, rebuild bool) (released, error) {
	file, err := m.pull(ctx)
	if err != nil {
		return released{}, err
	}
	dir := filepath.Dir(filepath.Dir(filepath.Dir(file)))
	r := released{flux: file}
	if r.live, err = archiveOf(filepath.Join(dir, liveForm, filepath.FromSlash(appsFile))); err != nil {
		return released{}, err
	}
	if r.rebuilt, err = archiveOf(filepath.Join(dir, rebuildForm, filepath.FromSlash(appsFile))); err != nil {
		return released{}, err
	}
	if rebuild {
		r.flux = filepath.Join(dir, rebuildForm, filepath.FromSlash(fluxFile))
		if _, err := os.Stat(r.flux); err != nil || r.rebuilt == "" {
			return released{}, fmt.Errorf("the release production follows has no rebuild form (%s): promote a build that has one first", path.Join(rebuildForm, fluxFile))
		}
	}
	return r, nil
}

// archiveOf is the archive the game's database writes its WAL under, in a
// form's manifests: its Barman Cloud plugin's server name. "" when the file
// is not there, or the database archives nowhere.
func archiveOf(file string) (string, error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	for {
		var doc map[string]any
		if err := dec.Decode(&doc); errors.Is(err, io.EOF) {
			return "", nil
		} else if err != nil {
			return "", fmt.Errorf("%s: %w", file, err)
		}
		o := manifests.Object(doc)
		if o.Kind() != "Cluster" || o.Name() != "keel-db" {
			continue
		}
		for _, p := range manifests.List(o, "spec", "plugins") {
			if manifests.Str(p, "name") == manifests.BarmanPlugin {
				return manifests.Str(p, "parameters", "serverName"), nil
			}
		}
		return "", nil
	}
}

// pull pulls the release and returns the path of the live form's Flux
// manifests in it.
func (m *machine) pull(ctx context.Context) (string, error) {
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
	file := filepath.Join(dir, liveForm, filepath.FromSlash(fluxFile))
	if _, err := os.Stat(file); err != nil {
		return "", fmt.Errorf("the release %s holds no %s", ref, path.Join(liveForm, fluxFile))
	}
	m.logf("production follows %s (%s), signed by the release workflow on main", ref, revision)
	fmt.Fprintf(m.summary, "Flux is bootstrapped from the release production follows: `%s`, %s, signature verified.\n\n", a.Digest, revision)
	return file, nil
}
