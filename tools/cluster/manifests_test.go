// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

const repoCluster = "../../infra/cluster"

// The digests pinned in the manifests: the chart Flux fetches, and
// PostgreSQL's image.
const (
	chartDigest    = "sha256:3245fa051bb21d0dd9246272f57a2760b4234817a164a3167d2a1e7fb9f63fd9"
	postgresDigest = "sha256:37ade18dbdddba430858c72725aceeec66f33fa5333e82ea1df4942f6c1c83a3"
)

func readRepoTree(t *testing.T) *tree {
	t.Helper()
	tr, err := readTree(repoCluster)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func rendered(t *testing.T, tr *tree, entry string) []object {
	t.Helper()
	rm, err := tr.render(entry)
	if err != nil {
		t.Fatal(err)
	}
	objs, err := objects(rm)
	if err != nil {
		t.Fatal(err)
	}
	return objs
}

func renderedApps(t *testing.T) []object {
	t.Helper()
	rm, err := readRepoTree(t).renderApps(deploy{build: "0123456789ab", host: "harbour.local"})
	if err != nil {
		t.Fatal(err)
	}
	objs, err := objects(rm)
	if err != nil {
		t.Fatal(err)
	}
	return objs
}

func TestEntryPointsKeepTheRules(t *testing.T) {
	tr := readRepoTree(t)
	for _, e := range entryPoints {
		objs := rendered(t, tr, e)
		if len(objs) == 0 {
			t.Errorf("%s renders nothing", e)
		}
		if err := checkRules(objs, true); err != nil {
			t.Errorf("%s: %v", e, err)
		}
	}
	if err := checkRules(renderedApps(t), true); err != nil {
		t.Errorf("a deploy: %v", err)
	}
}

// TestProductionSizes: the game's base holds production's sizes, within
// the rules a deploy keeps.
func TestProductionSizes(t *testing.T) {
	objs := rendered(t, readRepoTree(t), "apps/keel")
	if err := memoryLimit(objs, false); err != nil {
		t.Error(err)
	}
	game := container(podSpec(find(objs, "Deployment", deployment)), "containers", "keel")
	if str(game, "resources", "limits", "cpu") != "3" || str(game, "resources", "limits", "memory") != "4Gi" {
		t.Errorf("keel's limits %v", get(game, "resources", "limits"))
	}
	if s := str(find(objs, "Cluster", "keel-db"), "spec", "storage", "size"); s != "40Gi" {
		t.Errorf("the database's storage %s", s)
	}
}

func TestDeployPutsTheBuildAndHost(t *testing.T) {
	rm, err := readRepoTree(t).renderApps(deploy{build: "0123456789ab-dirty-20261010T120000Z", host: "harbour.local", sailors: "40"})
	if err != nil {
		t.Fatal(err)
	}
	objs, err := objects(rm)
	if err != nil {
		t.Fatal(err)
	}
	spec := podSpec(find(objs, "Deployment", deployment))
	for _, c := range containers(spec) {
		if c["image"] != "keel:0123456789ab-dirty-20261010T120000Z" || c["imagePullPolicy"] != "Never" {
			t.Errorf("container %s: %v, %v", c["name"], c["image"], c["imagePullPolicy"])
		}
	}
	var cms []object
	for _, o := range objs {
		if o.kind() == "ConfigMap" {
			cms = append(cms, o)
		}
	}
	if len(cms) != 1 {
		t.Fatalf("%d ConfigMaps", len(cms))
	}
	if o := str(cms[0], "data", "KEEL_PLAY_ORIGIN"); o != "https://harbour.local" {
		t.Errorf("KEEL_PLAY_ORIGIN %q", o)
	}
	if s := str(cms[0], "data", "KEEL_DEV_SAILORS"); s != "40" {
		t.Errorf("KEEL_DEV_SAILORS %q", s)
	}
	if ref := str(container(spec, "containers", "keel"), "envFrom", 0, "configMapRef", "name"); ref != cms[0].name() {
		t.Errorf("keel reads ConfigMap %q, not %q", ref, cms[0].name())
	}
}

func TestPinnedDigests(t *testing.T) {
	tr := readRepoTree(t)
	repo := find(rendered(t, tr, "clusters/local/controllers"), "OCIRepository", "cloudnative-pg")
	if d := str(repo, "spec", "ref", "digest"); d != chartDigest {
		t.Errorf("the chart's digest %s, want %s", d, chartDigest)
	}
	db := find(renderedApps(t), "Cluster", "keel-db")
	if img := str(db, "spec", "imageName"); !strings.HasSuffix(img, "@"+postgresDigest) || !strings.Contains(img, ":18.6-minimal-trixie@") {
		t.Errorf("PostgreSQL's image %s", img)
	}
}

// TestNoSecretInInfra reads every YAML document under infra/, rendered or
// not.
func TestNoSecretInInfra(t *testing.T) {
	err := filepath.WalkDir("../../infra", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || (filepath.Ext(p) != ".yaml" && filepath.Ext(p) != ".yml") {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		dec := yaml.NewDecoder(bytes.NewReader(data))
		for {
			var doc struct{ Kind string }
			if err := dec.Decode(&doc); errors.Is(err, io.EOF) {
				return nil
			} else if err != nil {
				return err
			}
			if doc.Kind == "Secret" {
				t.Errorf("%s holds a Secret", p)
			}
		}
	})
	if err != nil {
		t.Fatal(err)
	}
}

// defaultHost is the players' host clusters/local names; a deploy replaces
// it with the Mac's own.
const defaultHost = "macbook.local"

// TestAppsNameNoHost: only clusters/ names the players' host.
func TestAppsNameNoHost(t *testing.T) {
	err := filepath.WalkDir(filepath.Join(repoCluster, "apps"), func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		for _, name := range []string{defaultHost, ".local", "KEEL_PLAY_ORIGIN", "keel-tls"} {
			if bytes.Contains(data, []byte(name)) {
				t.Errorf("%s names %s", p, name)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// TestEachRuleFails breaks a deploy's manifests one way at a time: the rule
// that guards against it must fail, and say so.
func TestEachRuleFails(t *testing.T) {
	game := func(objs []object) map[string]any {
		return container(podSpec(find(objs, "Deployment", deployment)), "containers", "keel")
	}
	cases := []struct {
		rule   string
		mutate func(objs []object) []object
	}{
		{"no Secret in the manifests", func(objs []object) []object {
			return append(objs, object{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]any{"name": "keel-db-app"}})
		}},
		{"every image pinned by digest", func(objs []object) []object {
			find(objs, "Cluster", "keel-db")["spec"].(map[string]any)["imageName"] = "ghcr.io/cloudnative-pg/postgresql:18.6-minimal-trixie"
			return objs
		}},
		{"every image pinned by digest", func(objs []object) []object {
			game(objs)["imagePullPolicy"] = "IfNotPresent"
			return objs
		}},
		{"every image pinned by digest", func(objs []object) []object {
			game(objs)["image"] = "ghcr.io/daneelvt/keel:latest"
			return objs
		}},
		{"keel's Deployment", func(objs []object) []object {
			find(objs, "Deployment", deployment)["spec"].(map[string]any)["replicas"] = 2
			return objs
		}},
		{"keel's Deployment", func(objs []object) []object {
			find(objs, "Deployment", deployment)["spec"].(map[string]any)["strategy"] = map[string]any{"type": "RollingUpdate"}
			return objs
		}},
		{"keel's Deployment", func(objs []object) []object {
			podSpec(find(objs, "Deployment", deployment))["initContainers"] = []any{}
			return objs
		}},
		{"keel's Deployment", func(objs []object) []object {
			game(objs)["readinessProbe"].(map[string]any)["httpGet"].(map[string]any)["port"] = "play"
			return objs
		}},
		{"keel's Deployment", func(objs []object) []object {
			game(objs)["securityContext"].(map[string]any)["readOnlyRootFilesystem"] = false
			return objs
		}},
		{"keel's Deployment", func(objs []object) []object {
			podSpec(find(objs, "Deployment", deployment))["automountServiceAccountToken"] = true
			return objs
		}},
		{"GOMEMLIMIT within the memory limit", func(objs []object) []object {
			game(objs)["resources"].(map[string]any)["limits"].(map[string]any)["memory"] = "4Gi"
			return objs
		}},
		{"no route to the internal listener", func(objs []object) []object {
			route := find(objs, "HTTPRoute", "play")
			get(route, "spec", "rules", 0, "backendRefs", 0).(map[string]any)["port"] = 9090
			return objs
		}},
		{"routes on the Gateway's listeners", func(objs []object) []object {
			get(find(objs, "HTTPRoute", "play"), "spec", "parentRefs", 0).(map[string]any)["sectionName"] = "websecure"
			return objs
		}},
		{"routes on the Gateway's listeners", func(objs []object) []object {
			delete(get(find(objs, "Gateway", gatewayName), "spec", "listeners", 1).(map[string]any), "tls")
			return objs
		}},
		{"routes on the Gateway's listeners", func(objs []object) []object {
			get(find(objs, "Gateway", gatewayName), "spec", "listeners", 1).(map[string]any)["hostname"] = "harbour.local"
			find(objs, "HTTPRoute", "play")["spec"].(map[string]any)["hostnames"] = []any{"elsewhere.local"}
			return objs
		}},
		{"the database's access and locale", func(objs []object) []object {
			get(find(objs, "Cluster", "keel-db"), "spec", "postgresql").(map[string]any)["pg_hba"] = []any{}
			return objs
		}},
		{"the database's access and locale", func(objs []object) []object {
			find(objs, "Cluster", "keel-db")["spec"].(map[string]any)["enableSuperuserAccess"] = true
			return objs
		}},
		{"the database's access and locale", func(objs []object) []object {
			get(find(objs, "Cluster", "keel-db"), "spec", "bootstrap", "initdb").(map[string]any)["localeProvider"] = "libc"
			return objs
		}},
		{"the database's restarts", func(objs []object) []object {
			delete(find(objs, "Cluster", "keel-db")["spec"].(map[string]any), "smartShutdownTimeout")
			return objs
		}},
		{"the database's restarts", func(objs []object) []object {
			delete(get(find(objs, "Cluster", "keel-db"), "spec", "postgresql", "parameters").(map[string]any), "tcp_keepalives_count")
			return objs
		}},
		{"keel's time to stop", func(objs []object) []object {
			podSpec(find(objs, "Deployment", deployment))["terminationGracePeriodSeconds"] = 20
			return objs
		}},
		{"keel's time to stop", func(objs []object) []object {
			for _, o := range objs {
				if o.kind() == "ConfigMap" && strings.HasPrefix(o.name(), "keel") {
					o["data"].(map[string]any)["KEEL_BELL"] = "15s"
				}
			}
			return objs
		}},
	}
	for _, c := range cases {
		err := checkRules(c.mutate(renderedApps(t)), true)
		if err == nil || !strings.Contains(err.Error(), c.rule+":") {
			t.Errorf("broken for %q: %v", c.rule, err)
		}
		for _, r := range rules {
			if r.name != c.rule && err != nil && strings.Contains(err.Error(), r.name+":") {
				t.Errorf("broken for %q, %q failed too: %v", c.rule, r.name, err)
			}
		}
	}
	// The chart's image, and Flux's own, pinned too.
	tr := readRepoTree(t)
	controllers := rendered(t, tr, "clusters/local/controllers")
	get(find(controllers, "HelmRelease", "cloudnative-pg"), "spec", "values", "image").(map[string]any)["tag"] = "1.30.1"
	if err := pinnedImages(controllers, true); err == nil {
		t.Error("a chart's image by tag passed")
	}
	flux := rendered(t, tr, "flux-system")
	c := containers(podSpec(find(flux, "Deployment", "helm-controller")))[0]
	c["image"] = "ghcr.io/fluxcd/helm-controller:v1.6.5"
	if err := pinnedImages(flux, true); err == nil {
		t.Error("Flux's image by tag passed")
	}
	// The game's image by tag is the local cluster's alone.
	if err := pinnedImages(renderedApps(t), false); err == nil {
		t.Error("the game's tag passed outside the local cluster")
	}
}
