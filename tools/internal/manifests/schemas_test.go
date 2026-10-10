// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sigs.k8s.io/kustomize/api/resmap"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

// repoSchemas checks against the repository's schemas, for the Kubernetes
// its k3s pin holds, keeping what it downloads where the tools do.
func repoSchemas(t *testing.T) Schemas {
	t.Helper()
	k3s, err := pinned.ReadK3s(filepath.Join("..", "..", "..", pinned.K3sFile))
	if err != nil {
		t.Fatal(err)
	}
	return Schemas{CRDs: "../../../infra/schemas", Cache: "../../../.dev/schemas", Kubernetes: k3s.Kubernetes()}
}

func writeYAML(t *testing.T, dir, name string, rm resmap.ResMap, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	data, err := rm.AsYaml()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".yaml"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestEveryEntryPointPassesItsSchemas: every object of every entry point,
// as a release renders it and as tools/cluster applies it, has a schema
// and keeps it, with no field the schema does not know.
func TestEveryEntryPointPassesItsSchemas(t *testing.T) {
	tr := readRepoTree(t)
	dir := t.TempDir()
	for _, c := range Clusters {
		for _, e := range c.Entries {
			rm, err := tr.RenderRelease(c.Entry(e), released)
			writeYAML(t, dir, c.Name+"-"+e, rm, err)
		}
	}
	rm, err := tr.Render(FluxEntry)
	writeYAML(t, dir, "flux", rm, err)
	rm, err = tr.RenderSync("0123456789ab")
	writeYAML(t, dir, "sync", rm, err)
	rm, err = tr.RenderDeploy(Deploy{Build: "0123456789ab", Host: "harbour.local", Sailors: "40"})
	writeYAML(t, dir, "deploy", rm, err)
	if err := repoSchemas(t).Validate(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
}

// TestSchemasRefuse: what a schema does not allow fails, and so does a
// kind with no schema at all.
func TestSchemasRefuse(t *testing.T) {
	s := repoSchemas(t)
	valid := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: keel\ndata:\n  KEEL_LOG_LEVEL: info\n"
	file := filepath.Join(t.TempDir(), "valid.yaml")
	if err := os.WriteFile(file, []byte(valid), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.Validate(context.Background(), file); err != nil {
		t.Fatalf("a ConfigMap: %v", err)
	}
	for name, tc := range map[string]struct{ manifest, want string }{
		"a field Kubernetes does not know": {
			"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: keel\nspec:\n  replicsa: 1\n  selector:\n    matchLabels: {app: keel}\n  template:\n    metadata:\n      labels: {app: keel}\n    spec:\n      containers:\n        - name: keel\n          image: keel\n",
			"replicsa",
		},
		"a key twice": {
			"apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: keel\ndata:\n  KEEL_LOG_LEVEL: info\n  KEEL_LOG_LEVEL: debug\n",
			"KEEL_LOG_LEVEL",
		},
		"a field Flux's source does not know": {
			"apiVersion: source.toolkit.fluxcd.io/v1\nkind: OCIRepository\nmetadata:\n  name: keel\nspec:\n  interval: 1m\n  url: oci://ghcr.io/daneelvt/keel-manifests\n  verify:\n    provider: cosign\n    matchOIDCIdentities: []\n",
			"matchOIDCIdentities",
		},
		"a deletion policy Flux does not have": {
			"apiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization\nmetadata:\n  name: apps\nspec:\n  interval: 10m\n  prune: true\n  deletionPolicy: Orphaned\n  sourceRef:\n    kind: OCIRepository\n    name: keel\n",
			"deletionPolicy",
		},
		"a Flux layer without what it must have": {
			"apiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization\nmetadata:\n  name: apps\nspec:\n  interval: 10m\n  sourceRef:\n    kind: OCIRepository\n    name: keel\n",
			"prune",
		},
		"a database with a word for a number": {
			"apiVersion: postgresql.cnpg.io/v1\nkind: Cluster\nmetadata:\n  name: keel-db\nspec:\n  instances: one\n  storage:\n    size: 1Gi\n",
			"instances",
		},
		"a route with a field the Gateway API does not know": {
			"apiVersion: gateway.networking.k8s.io/v1\nkind: HTTPRoute\nmetadata:\n  name: play\nspec:\n  parentRef:\n    name: keel\n",
			"parentRef",
		},
		"a definition with a field Kubernetes does not know": {
			"apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: boats.example.org\nspec:\n  group: example.org\n  scope: Namespaced\n  rigging: sloop\n  names: {kind: Boat, plural: boats}\n  versions:\n    - name: v1\n      served: true\n      storage: true\n      schema:\n        openAPIV3Schema: {type: object}\n",
			"rigging",
		},
		"a kind with no schema": {
			"apiVersion: example.org/v1\nkind: Boat\nmetadata:\n  name: jolly\n",
			"could not find schema for Boat",
		},
		"a version of a kind with no schema": {
			"apiVersion: source.toolkit.fluxcd.io/v1beta2\nkind: OCIRepository\nmetadata:\n  name: keel\nspec:\n  interval: 1m\n  url: oci://ghcr.io/daneelvt/keel-manifests\n",
			"could not find schema for OCIRepository",
		},
	} {
		t.Run(name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "manifest.yaml")
			if err := os.WriteFile(file, []byte(tc.manifest), 0o644); err != nil {
				t.Fatal(err)
			}
			err := s.Validate(context.Background(), file)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("validated: %v", err)
			}
		})
	}
}

// TestSchemasFromTheCache: the schemas of Kubernetes' kinds are downloaded
// once; after that, a check needs no network.
func TestSchemasFromTheCache(t *testing.T) {
	s := repoSchemas(t)
	s.Cache = filepath.Join(t.TempDir(), "schemas")
	write := func(name, manifest string) string {
		file := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(file, []byte(manifest), 0o644); err != nil {
			t.Fatal(err)
		}
		return file
	}
	configMap := write("configmap.yaml", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: keel\n")
	source := write("source.yaml", "apiVersion: source.toolkit.fluxcd.io/v1\nkind: OCIRepository\nmetadata:\n  name: keel\nspec:\n  interval: 1m\n  url: oci://ghcr.io/daneelvt/keel-manifests\n")
	service := write("service.yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: keel\nspec:\n  ports:\n    - port: 8080\n")
	if err := s.Validate(context.Background(), configMap); err != nil {
		t.Fatal(err)
	}
	if kept, err := os.ReadDir(s.Cache); err != nil || len(kept) != 1 {
		t.Fatalf("the cache holds %d schemas after one kind, %v", len(kept), err)
	}
	// No network from here: every request would go to a proxy that is not
	// there.
	for _, v := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		t.Setenv(v, "http://127.0.0.1:1")
	}
	for _, v := range []string{"NO_PROXY", "no_proxy"} {
		t.Setenv(v, "")
	}
	if err := s.Validate(context.Background(), configMap, source); err != nil {
		t.Fatalf("with the schema downloaded before, and a custom resource's from the repository: %v", err)
	}
	// And that is why it passed: a kind not downloaded yet cannot be.
	if err := s.Validate(context.Background(), service); err == nil || !strings.Contains(err.Error(), "failed downloading schema") {
		t.Fatalf("a kind never downloaded, with no network: %v", err)
	}
}
