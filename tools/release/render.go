// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

// manifestsFile is the one file each entry point is rendered to. Flux
// applies every manifest in a folder that has no kustomization of its own
// (its Kustomization documentation, "Generate kustomization.yaml"), so
// what it applies is exactly what was rendered and checked here.
const manifestsFile = "manifests.yaml"

// render writes a release's manifests under dir: every entry point of
// every cluster, built with kustomize with the game's image by its digest,
// as <cluster>/<entry point>/manifests.yaml. Each keeps the manifests'
// rules, and every object passes its kind's schema, or nothing is left to
// publish.
func render(ctx context.Context, out io.Writer, dir, image string) (err error) {
	if image == "" {
		return errors.New("-render needs -image, the game's image by digest")
	}
	// The folder is published whole: nothing may be in it already.
	if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 {
		return fmt.Errorf("%s is not empty: a release holds what is rendered now, and nothing else", dir)
	}
	// Nor is anything left in it that failed a check.
	defer func() {
		if err != nil {
			for _, c := range manifests.Clusters {
				_ = os.RemoveAll(filepath.Join(dir, c.Name))
			}
		}
	}()
	t, err := manifests.ReadTree(clusterDir)
	if err != nil {
		return err
	}
	k3s, err := pinned.ReadK3s(pinned.K3sFile)
	if err != nil {
		return err
	}
	for _, c := range manifests.Clusters {
		for _, e := range c.Entries {
			entry := c.Entry(e)
			rm, err := t.RenderRelease(entry, image)
			if err != nil {
				return err
			}
			objs, err := manifests.Objects(rm)
			if err != nil {
				return err
			}
			if err := manifests.CheckRules(objs, manifests.Target{Cluster: c.Name}); err != nil {
				return fmt.Errorf("%s: %w", entry, err)
			}
			data, err := rm.AsYaml()
			if err != nil {
				return err
			}
			file := filepath.Join(dir, c.Name, e, manifestsFile)
			if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(file, data, 0o644); err != nil {
				return err
			}
			fmt.Fprintf(out, "release: rendered %s: %d objects, %d bytes\n", filepath.Join(c.Name, e, manifestsFile), len(objs), len(data))
		}
	}
	schemas := manifests.Schemas{CRDs: schemasDir, Cache: schemaCache, Kubernetes: k3s.Kubernetes()}
	if err := schemas.Validate(ctx, dir); err != nil {
		return err
	}
	fmt.Fprintf(out, "release: every object keeps the rules and its schema, for Kubernetes %s, with %s\n", k3s.Kubernetes(), image)
	return nil
}
