// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
	"sigs.k8s.io/kustomize/api/resmap"
)

const repoCluster = "../../../infra/cluster"

// The digests pinned in the manifests: the chart Flux fetches, and
// PostgreSQL's image.
const (
	chartDigest    = "sha256:3245fa051bb21d0dd9246272f57a2760b4234817a164a3167d2a1e7fb9f63fd9"
	postgresDigest = "sha256:37ade18dbdddba430858c72725aceeec66f33fa5333e82ea1df4942f6c1c83a3"
)

// released is a game's image as a release names it.
const (
	releasedDigest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	released       = GameImage + "@" + releasedDigest
)

var (
	local = Clusters[0]
	prod  = Clusters[1]
)

func readRepoTree(t *testing.T) *Tree {
	t.Helper()
	tr, err := ReadTree(repoCluster)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func objectsOf(t *testing.T, rm resmap.ResMap, err error) []Object {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	objs, err := Objects(rm)
	if err != nil {
		t.Fatal(err)
	}
	return objs
}

// release renders an entry point of a cluster as a release does.
func release(t *testing.T, c Cluster, entry string) []Object {
	t.Helper()
	rm, err := readRepoTree(t).RenderRelease(c.Entry(entry), released)
	return objectsOf(t, rm, err)
}

// deployed renders the local game as a deploy from the working tree does.
func deployed(t *testing.T) []Object {
	t.Helper()
	rm, err := readRepoTree(t).RenderDeploy(Deploy{Build: "0123456789ab", Host: "harbour.local"})
	return objectsOf(t, rm, err)
}

// synced renders what the local cluster applies to follow a release.
func synced(t *testing.T, tag string) []Object {
	t.Helper()
	rm, err := readRepoTree(t).RenderSync(tag)
	return objectsOf(t, rm, err)
}

func TestClusters(t *testing.T) {
	if len(Clusters) != 2 || local.Name != "local" || prod.Name != "prod" {
		t.Fatalf("clusters %v", Clusters)
	}
	// Every folder under clusters/ is a cluster's entry point, or what the
	// local cluster applies to follow a release: none goes unrendered.
	for _, c := range Clusters {
		entries, err := os.ReadDir(filepath.Join(repoCluster, "clusters", c.Name))
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			if !slices.Contains(c.Entries, e.Name()) && c.Entry(e.Name()) != LocalRelease {
				t.Errorf("%s is no entry point of %s", e.Name(), c.Name)
			}
		}
		for _, e := range c.Entries {
			if !slices.Contains(Layers, e) {
				t.Errorf("%s's entry point %s is no layer", c.Name, e)
			}
		}
	}
}

func TestEntryPointsKeepTheRules(t *testing.T) {
	tr := readRepoTree(t)
	for _, c := range Clusters {
		for _, e := range c.Entries {
			objs := release(t, c, e)
			if len(objs) == 0 {
				t.Errorf("%s renders nothing", c.Entry(e))
			}
			if err := CheckRules(objs, Target{Cluster: c.Name}); err != nil {
				t.Errorf("%s: %v", c.Entry(e), err)
			}
		}
	}
	rm, err := tr.Render(FluxEntry)
	if err := CheckRules(objectsOf(t, rm, err), Target{Cluster: local.Name}); err != nil {
		t.Errorf("%s: %v", FluxEntry, err)
	}
	for _, tag := range []string{ProdTag, "0123456789ab"} {
		if err := CheckRules(synced(t, tag), Target{Cluster: local.Name}); err != nil {
			t.Errorf("%s at %s: %v", LocalRelease, tag, err)
		}
	}
	if err := CheckRules(deployed(t), Target{Cluster: local.Name, Deploy: true}); err != nil {
		t.Errorf("a deploy: %v", err)
	}
}

// TestReleaseNamesTheImageByDigest: in a release, the game and the
// migration before it run the image the release built, by its digest.
func TestReleaseNamesTheImageByDigest(t *testing.T) {
	for _, c := range Clusters {
		cs := Containers(PodSpec(Find(release(t, c, "apps"), "Deployment", Deployment)))
		if len(cs) != 2 {
			t.Fatalf("%s: %d containers", c.Name, len(cs))
		}
		for _, k := range cs {
			if k["image"] != released {
				t.Errorf("%s: container %s runs %v", c.Name, k["name"], k["image"])
			}
			if k["imagePullPolicy"] == "Never" {
				t.Errorf("%s: container %s never pulls", c.Name, k["name"])
			}
		}
	}
	tr := readRepoTree(t)
	for _, image := range []string{GameImage + ":0123456789ab", "keel@" + releasedDigest, GameImage + "@sha256:0123", "ghcr.io/someone/keel@" + releasedDigest, ""} {
		if _, err := tr.RenderRelease(prod.Entry("apps"), image); err == nil {
			t.Errorf("a release rendered with the image %q", image)
		}
	}
	// As written, with no image given, the game's image is no release's.
	rm, err := tr.Render(prod.Entry("apps"))
	if err := CheckRules(objectsOf(t, rm, err), Target{Cluster: prod.Name}); err == nil || !strings.Contains(err.Error(), "not pinned by digest") {
		t.Errorf("the game's image with no digest: %v", err)
	}
}

// TestProductionSizes: production runs the base's sizes, within the rules.
func TestProductionSizes(t *testing.T) {
	objs := release(t, prod, "apps")
	game := Container(PodSpec(Find(objs, "Deployment", Deployment)), "containers", "keel")
	if Str(game, "resources", "limits", "cpu") != "3" || Str(game, "resources", "limits", "memory") != "4Gi" {
		t.Errorf("keel's limits %v", Get(game, "resources", "limits"))
	}
	if s := Str(Find(objs, "Cluster", database), "spec", "storage", "size"); s != "40Gi" {
		t.Errorf("the database's storage %s", s)
	}
	if o := PlayOrigin(objs); o != "https://play.keelovertheedge.com" {
		t.Errorf("production's origin %q", o)
	}
	// The players' route on plain HTTP, the Gateway with no other listener.
	if l := List(Find(objs, "Gateway", gatewayName), "spec", "listeners"); len(l) != 1 || Str(l[0], "name") != "http" {
		t.Errorf("production's listeners %v", l)
	}
	if s := Str(Find(objs, "HTTPRoute", "play"), "spec", "parentRefs", 0, "sectionName"); s != "http" {
		t.Errorf("the players' route is on %q", s)
	}
}

// TestProductionTraefik: production's Traefik is reached only from inside
// the cluster, and is otherwise configured exactly as the local cluster's,
// whose values production's restate.
func TestProductionTraefik(t *testing.T) {
	values := func(c Cluster) map[string]any {
		t.Helper()
		o := Find(release(t, c, "configs"), "HelmChartConfig", "traefik")
		if o == nil {
			t.Fatalf("%s configures no Traefik", c.Entry("configs"))
		}
		v, err := TraefikValues(o)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	want, got := values(local), values(prod)
	if typ := Str(want, "service", "spec", "type"); typ != "" {
		t.Errorf("the local cluster's Traefik sets its Service's type, %q: ServiceLB needs the chart's LoadBalancer", typ)
	}
	if typ := Str(got, "service", "spec", "type"); typ != "ClusterIP" {
		t.Errorf("production's Traefik Service is %q, want ClusterIP", typ)
	}
	delete(got, "service")
	if a, b := mustYAML(t, want), mustYAML(t, got); a != b {
		t.Errorf("production's Traefik values differ from infrastructure/configs/traefik.yaml's by more than the Service:\n%s\nwant\n%s", b, a)
	}
}

func mustYAML(t *testing.T, v any) string {
	t.Helper()
	b, err := yaml.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestDeployPutsTheBuildAndHost(t *testing.T) {
	rm, err := readRepoTree(t).RenderDeploy(Deploy{Build: "0123456789ab-dirty-20261010T120000Z", Host: "harbour.local", Sailors: "40"})
	objs := objectsOf(t, rm, err)
	spec := PodSpec(Find(objs, "Deployment", Deployment))
	for _, c := range Containers(spec) {
		if c["image"] != "keel:0123456789ab-dirty-20261010T120000Z" || c["imagePullPolicy"] != "Never" {
			t.Errorf("container %s: %v, %v", c["name"], c["image"], c["imagePullPolicy"])
		}
	}
	var cms []Object
	for _, o := range objs {
		if o.Kind() == "ConfigMap" {
			cms = append(cms, o)
		}
	}
	if len(cms) != 1 {
		t.Fatalf("%d ConfigMaps", len(cms))
	}
	if o := PlayOrigin(objs); o != "https://harbour.local" {
		t.Errorf("KEEL_PLAY_ORIGIN %q", o)
	}
	if s := Str(cms[0], "data", "KEEL_DEV_SAILORS"); s != "40" {
		t.Errorf("KEEL_DEV_SAILORS %q", s)
	}
	if ref := Str(Container(spec, "containers", "keel"), "envFrom", 0, "configMapRef", "name"); ref != cms[0].Name() {
		t.Errorf("keel reads ConfigMap %q, not %q", ref, cms[0].Name())
	}
	// But for the image, its pull policy and what a deploy was given, a
	// deploy applies what a release holds for the local cluster.
	want := release(t, local, "apps")
	if len(objs) != len(want) {
		t.Fatalf("a deploy renders %d objects, a release %d", len(objs), len(want))
	}
	for i, o := range objs {
		if o.Kind() != want[i].Kind() || (o.Kind() != "ConfigMap" && o.Name() != want[i].Name()) {
			t.Errorf("a deploy's %s is a release's %s", o.ID(), want[i].ID())
		}
	}
}

// TestSyncFollowsATag: the local cluster follows the build it is given, or
// what production does, checking the signature as production does.
func TestSyncFollowsATag(t *testing.T) {
	prodSource := Find(release(t, prod, "flux-system"), "OCIRepository", Source)
	if prodSource == nil || Str(prodSource, "spec", "ref", "tag") != ProdTag {
		t.Fatalf("production follows %v", Get(prodSource, "spec", "ref"))
	}
	if i := Str(prodSource, "spec", "interval"); i != "1m" {
		t.Errorf("production looks for a release every %s", i)
	}
	want, err := yaml.Marshal(Get(prodSource, "spec", "verify"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tag := range []string{ProdTag, "0123456789ab"} {
		objs := synced(t, tag)
		source := Find(objs, "OCIRepository", Source)
		if got := Str(source, "spec", "ref", "tag"); got != tag {
			t.Errorf("following %s, the source's tag is %q", tag, got)
		}
		if got, _ := yaml.Marshal(Get(source, "spec", "verify")); !bytes.Equal(got, want) {
			t.Errorf("the local cluster verifies with\n%s, production with\n%s", got, want)
		}
		if Str(source, "spec", "url") != Str(prodSource, "spec", "url") {
			t.Errorf("the local cluster's source is %s", Str(source, "spec", "url"))
		}
		var layers []string
		for _, o := range objs {
			if o.Kind() == "Kustomization" {
				layers = append(layers, o.Name())
			}
		}
		if !slices.Equal(layers, local.Entries) {
			t.Errorf("the local cluster's layers %v, want %v", layers, local.Entries)
		}
	}
	tr := readRepoTree(t)
	for _, tag := range []string{"", "latest", "main", "0123456789a", "0123456789AB", "0123456789abc", "prod\n"} {
		if _, err := tr.RenderSync(tag); err == nil {
			t.Errorf("following the tag %q was accepted", tag)
		}
	}
	// Production's layers, and each one's folder in the artifact.
	var layers []string
	for _, o := range release(t, prod, "flux-system") {
		if o.Kind() == "Kustomization" {
			layers = append(layers, o.Name())
			if p := Str(o, "spec", "path"); p != "./prod/"+o.Name() {
				t.Errorf("%s applies %s", o.ID(), p)
			}
		}
	}
	if !slices.Equal(layers, prod.Entries) {
		t.Errorf("production's layers %v, want %v", layers, prod.Entries)
	}
}

// TestReleaseIdentity: the patterns accept the certificate of the release
// workflow on main of this repository, and no other signer's. Each is the
// subject alternative name Fulcio writes for a workflow run: the workflow's
// path and the ref it ran from.
func TestReleaseIdentity(t *testing.T) {
	subject, issuer := regexp.MustCompile(ReleaseSubject), regexp.MustCompile(ReleaseIssuer)
	const own = "https://github.com/daneelvt/keel-over-the-edge/.github/workflows/release.yaml@refs/heads/main"
	if !subject.MatchString(own) {
		t.Errorf("the release workflow on main is refused: %s", own)
	}
	for name, san := range map[string]string{
		"another branch":            "https://github.com/daneelvt/keel-over-the-edge/.github/workflows/release.yaml@refs/heads/release-gitops",
		"a branch named after main": "https://github.com/daneelvt/keel-over-the-edge/.github/workflows/release.yaml@refs/heads/main-2",
		"a pull request":            "https://github.com/daneelvt/keel-over-the-edge/.github/workflows/release.yaml@refs/pull/1/merge",
		"a tag":                     "https://github.com/daneelvt/keel-over-the-edge/.github/workflows/release.yaml@refs/tags/main",
		"another workflow":          "https://github.com/daneelvt/keel-over-the-edge/.github/workflows/ci.yaml@refs/heads/main",
		"a workflow named alike":    "https://github.com/daneelvt/keel-over-the-edge/.github/workflows/release.yml@refs/heads/main",
		"a fork":                    "https://github.com/someone/keel-over-the-edge/.github/workflows/release.yaml@refs/heads/main",
		"a repository named alike":  "https://github.com/daneelvt/keel-over-the-edge-2/.github/workflows/release.yaml@refs/heads/main",
		"another host":              "https://github.com.example.org/daneelvt/keel-over-the-edge/.github/workflows/release.yaml@refs/heads/main",
		"the chart's signer":        "https://github.com/cloudnative-pg/charts/.github/workflows/release-publish.yml@refs/heads/main",
		"the name inside another":   "https://example.org/?https://github.com/daneelvt/keel-over-the-edge/.github/workflows/release.yaml@refs/heads/main",
		"a dot that is not a dot":   "https://githubXcom/daneelvt/keel-over-the-edge/.github/workflows/release.yaml@refs/heads/main",
	} {
		if subject.MatchString(san) {
			t.Errorf("%s is accepted: %s", name, san)
		}
	}
	if !issuer.MatchString("https://token.actions.githubusercontent.com") {
		t.Error("GitHub's issuer is refused")
	}
	for _, iss := range []string{"https://token.actions.githubusercontent.com/enterprise", "https://accounts.google.com", "https://tokenXactions.githubusercontent.com", "x https://token.actions.githubusercontent.com"} {
		if issuer.MatchString(iss) {
			t.Errorf("the issuer %s is accepted", iss)
		}
	}
	// The chart's own signer, and no other, for the chart.
	chart := Find(release(t, prod, "controllers"), "OCIRepository", "cloudnative-pg")
	ids := List(chart, "spec", "verify", "matchOIDCIdentity")
	if len(ids) != 1 || Str(ids[0], "issuer") != ReleaseIssuer {
		t.Fatalf("the chart's signers %v", ids)
	}
	chartSubject := regexp.MustCompile(Str(ids[0], "subject"))
	if !chartSubject.MatchString("https://github.com/cloudnative-pg/charts/.github/workflows/release-publish.yml@refs/heads/main") || chartSubject.MatchString(own) {
		t.Errorf("the chart's subject pattern %s", chartSubject)
	}
}

func TestPinnedDigests(t *testing.T) {
	for _, c := range Clusters {
		repo := Find(release(t, c, "controllers"), "OCIRepository", "cloudnative-pg")
		if d := Str(repo, "spec", "ref", "digest"); d != chartDigest {
			t.Errorf("%s: the chart's digest %s, want %s", c.Name, d, chartDigest)
		}
		db := Find(release(t, c, "apps"), "Cluster", database)
		if img := Str(db, "spec", "imageName"); !strings.HasSuffix(img, "@"+postgresDigest) || !strings.Contains(img, ":18.6-minimal-trixie@") {
			t.Errorf("%s: PostgreSQL's image %s", c.Name, img)
		}
	}
}

// yamlFiles calls f with every YAML file under dir.
func yamlFiles(t *testing.T, dir string, f func(p string, data []byte)) {
	t.Helper()
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || (filepath.Ext(p) != ".yaml" && filepath.Ext(p) != ".yml") {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		f(p, data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// TestNoSecretInInfra reads every YAML document under infra/, rendered or
// not; a playbook's, a list, is no Kubernetes object.
func TestNoSecretInInfra(t *testing.T) {
	yamlFiles(t, "../../../infra", func(p string, data []byte) {
		dec := yaml.NewDecoder(bytes.NewReader(data))
		for {
			var doc any
			if err := dec.Decode(&doc); errors.Is(err, io.EOF) {
				return
			} else if err != nil {
				t.Fatalf("%s: %v", p, err)
			}
			if Str(doc, "kind") == "Secret" {
				t.Errorf("%s holds a Secret", p)
			}
		}
	})
}

// defaultHost is the players' host clusters/local names: a release is
// rendered for it, and a deploy replaces it with the Mac's own.
const defaultHost = "macbook.local"

// TestHostsWhereTheyBelong: only clusters/ names a players' host, and each
// cluster its own alone.
func TestHostsWhereTheyBelong(t *testing.T) {
	names := func(dir string, words ...string) {
		yamlFiles(t, filepath.Join(repoCluster, dir), func(p string, data []byte) {
			for _, w := range words {
				if bytes.Contains(data, []byte(w)) {
					t.Errorf("%s names %s", p, w)
				}
			}
		})
	}
	names("apps", defaultHost, localSuffix, prodDomain, "KEEL_PLAY_ORIGIN", "keel-tls")
	names("infrastructure", defaultHost, prodDomain)
	names("clusters/prod", defaultHost, localSuffix)
	names("clusters/local", prodDomain)
	if o := PlayOrigin(release(t, local, "apps")); o != "https://"+defaultHost {
		t.Errorf("a release's local origin %q", o)
	}
}

// TestEachRuleFails breaks the manifests one way at a time: the rule that
// guards against it must fail, say so, and fail alone.
func TestEachRuleFails(t *testing.T) {
	game := func(objs []Object) map[string]any {
		return Container(PodSpec(Find(objs, "Deployment", Deployment)), "containers", "keel")
	}
	spec := func(o Object) map[string]any { return o["spec"].(map[string]any) }
	inDeploy := func() ([]Object, Target) { return deployed(t), Target{Cluster: local.Name, Deploy: true} }
	inRelease := func(c Cluster, entry string) func() ([]Object, Target) {
		return func() ([]Object, Target) { return release(t, c, entry), Target{Cluster: c.Name} }
	}
	inSync := func() ([]Object, Target) { return synced(t, "0123456789ab"), Target{Cluster: local.Name} }
	identity := func(o Object) map[string]any {
		return Get(o, "spec", "verify", "matchOIDCIdentity", 0).(map[string]any)
	}
	cases := []struct {
		rule   string
		from   func() ([]Object, Target)
		mutate func(objs []Object) []Object
	}{
		{"no Secret in the manifests", inDeploy, func(objs []Object) []Object {
			return append(objs, Object{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]any{"name": "keel-db-app"}})
		}},
		{"every image pinned by digest", inDeploy, func(objs []Object) []Object {
			spec(Find(objs, "Cluster", database))["imageName"] = "ghcr.io/cloudnative-pg/postgresql:18.6-minimal-trixie"
			return objs
		}},
		{"every image pinned by digest", inDeploy, func(objs []Object) []Object {
			game(objs)["imagePullPolicy"] = "IfNotPresent"
			return objs
		}},
		{"every image pinned by digest", inDeploy, func(objs []Object) []Object {
			game(objs)["image"] = "ghcr.io/daneelvt/keel:latest"
			return objs
		}},
		// The image a deploy imports is no release's, on either cluster.
		{"every image pinned by digest", inRelease(local, "apps"), func(objs []Object) []Object {
			game(objs)["image"] = "keel:0123456789ab"
			game(objs)["imagePullPolicy"] = "Never"
			return objs
		}},
		{"every image pinned by digest", inRelease(prod, "apps"), func(objs []Object) []Object {
			Container(PodSpec(Find(objs, "Deployment", Deployment)), "initContainers", "migrate")["image"] = GameImage + ":0123456789ab"
			return objs
		}},
		{"every image pinned by digest", inRelease(prod, "controllers"), func(objs []Object) []Object {
			Get(Find(objs, "HelmRelease", "cloudnative-pg"), "spec", "values", "image").(map[string]any)["tag"] = "1.30.1"
			return objs
		}},
		{"every image pinned by digest", inRelease(prod, "controllers"), func(objs []Object) []Object {
			delete(Get(Find(objs, "OCIRepository", "cloudnative-pg"), "spec", "ref").(map[string]any), "digest")
			return objs
		}},
		{"every image pinned by digest", inRelease(prod, "flux-system"), func(objs []Object) []Object {
			Containers(PodSpec(Find(objs, "Deployment", "helm-controller")))[0]["image"] = "ghcr.io/fluxcd/helm-controller:v1.6.5"
			return objs
		}},
		{"every source's signature checked", inRelease(prod, "controllers"), func(objs []Object) []Object {
			delete(spec(Find(objs, "OCIRepository", "cloudnative-pg")), "verify")
			return objs
		}},
		{"every source's signature checked", inRelease(local, "controllers"), func(objs []Object) []Object {
			Get(Find(objs, "OCIRepository", "cloudnative-pg"), "spec", "verify").(map[string]any)["matchOIDCIdentity"] = []any{}
			return objs
		}},
		{"every source's signature checked", inRelease(prod, "controllers"), func(objs []Object) []Object {
			id := identity(Find(objs, "OCIRepository", "cloudnative-pg"))
			id["subject"] = strings.TrimSuffix(id["subject"].(string), "$")
			return objs
		}},
		{"every source's signature checked", inRelease(prod, "controllers"), func(objs []Object) []Object {
			id := identity(Find(objs, "OCIRepository", "cloudnative-pg"))
			id["issuer"] = strings.TrimPrefix(id["issuer"].(string), "^")
			return objs
		}},
		{"every source's signature checked", inRelease(prod, "controllers"), func(objs []Object) []Object {
			identity(Find(objs, "OCIRepository", "cloudnative-pg"))["subject"] = `^https://github\.com/cloudnative-pg/charts/.*\$`
			return objs
		}},
		{"every source's signature checked", inRelease(prod, "controllers"), func(objs []Object) []Object {
			Get(Find(objs, "OCIRepository", "cloudnative-pg"), "spec", "verify").(map[string]any)["provider"] = "notation"
			return objs
		}},
		{"every source's signature checked", inRelease(prod, "controllers"), func(objs []Object) []Object {
			Get(Find(objs, "OCIRepository", "cloudnative-pg"), "spec", "verify").(map[string]any)["secretRef"] = map[string]any{"name": "cosign-key"}
			return objs
		}},
		{"every source's signature checked", inRelease(prod, "flux-system"), func(objs []Object) []Object {
			identity(Find(objs, "OCIRepository", Source))["subject"] = `^https://github\.com/daneelvt/keel-over-the-edge/\.github/workflows/.*@refs/heads/main$`
			return objs
		}},
		{"every source's signature checked", inSync, func(objs []Object) []Object {
			identity(Find(objs, "OCIRepository", Source))["subject"] = `^https://github\.com/daneelvt/keel-over-the-edge/\.github/workflows/release\.yaml@refs/heads/.+$`
			return objs
		}},
		{"every source's signature checked", inSync, func(objs []Object) []Object {
			v := Get(Find(objs, "OCIRepository", Source), "spec", "verify").(map[string]any)
			v["matchOIDCIdentity"] = append(v["matchOIDCIdentity"].([]any), map[string]any{"issuer": ReleaseIssuer, "subject": `^https://github\.com/someone/else$`})
			return objs
		}},
		{"every source's signature checked", inRelease(prod, "flux-system"), func(objs []Object) []Object {
			Get(Find(objs, "OCIRepository", Source), "spec", "ref").(map[string]any)["tag"] = "latest"
			return objs
		}},
		{"every source's signature checked", inRelease(prod, "flux-system"), func(objs []Object) []Object {
			Get(Find(objs, "OCIRepository", Source), "spec", "ref").(map[string]any)["semver"] = "*"
			return objs
		}},
		{"Flux's layers", inRelease(prod, "flux-system"), func(objs []Object) []Object {
			spec(Find(objs, "Kustomization", "apps"))["prune"] = false
			return objs
		}},
		{"Flux's layers", inSync, func(objs []Object) []Object {
			delete(spec(Find(objs, "Kustomization", "apps")), "deletionPolicy")
			return objs
		}},
		{"Flux's layers", inRelease(prod, "flux-system"), func(objs []Object) []Object {
			spec(Find(objs, "Kustomization", "flux-system"))["deletionPolicy"] = "MirrorPrune"
			return objs
		}},
		{"Flux's layers", inSync, func(objs []Object) []Object {
			spec(Find(objs, "Kustomization", "controllers"))["wait"] = false
			return objs
		}},
		{"Flux's layers", inRelease(prod, "flux-system"), func(objs []Object) []Object {
			delete(spec(Find(objs, "Kustomization", "controllers")), "dependsOn")
			return objs
		}},
		{"Flux's layers", inSync, func(objs []Object) []Object {
			spec(Find(objs, "Kustomization", "apps"))["dependsOn"] = []any{map[string]any{"name": "controllers"}}
			return objs
		}},
		{"Flux's layers", inSync, func(objs []Object) []Object {
			spec(Find(objs, "Kustomization", "controllers"))["dependsOn"] = []any{map[string]any{"name": "flux-system"}}
			return objs
		}},
		{"Flux's layers", inSync, func(objs []Object) []Object {
			spec(Find(objs, "Kustomization", "apps"))["path"] = "./prod/apps"
			return objs
		}},
		{"Flux's layers", inRelease(prod, "flux-system"), func(objs []Object) []Object {
			Get(Find(objs, "Kustomization", "configs"), "spec", "sourceRef").(map[string]any)["name"] = "another"
			return objs
		}},
		{"Flux's layers", inRelease(prod, "flux-system"), func(objs []Object) []Object {
			Find(objs, "Kustomization", "apps")["metadata"].(map[string]any)["name"] = "game"
			return objs
		}},
		// The first layer waiting for all it applied would wait for the
		// layers that wait for it.
		{"Flux's layers", inRelease(prod, "flux-system"), func(objs []Object) []Object {
			spec(Find(objs, "Kustomization", "flux-system"))["wait"] = true
			return objs
		}},
		{"Flux's layers", inRelease(prod, "flux-system"), func(objs []Object) []Object {
			s := spec(Find(objs, "Kustomization", "flux-system"))
			s["healthChecks"] = s["healthChecks"].([]any)[1:]
			return objs
		}},
		{"the database never pruned", inRelease(prod, "apps"), func(objs []Object) []Object {
			delete(Find(objs, "Cluster", database)["metadata"].(map[string]any), "annotations")
			return objs
		}},
		{"the database never pruned", inDeploy, func(objs []Object) []Object {
			Get(Find(objs, "Namespace", Namespace), "metadata", "annotations").(map[string]any)[pruneDisabled] = "enabled"
			return objs
		}},
		{"the players' host", inRelease(prod, "apps"), func(objs []Object) []Object {
			for _, o := range objs {
				if o.Kind() == "ConfigMap" {
					o["data"].(map[string]any)["KEEL_PLAY_ORIGIN"] = "https://" + defaultHost
				}
			}
			return objs
		}},
		{"the players' host", inRelease(local, "apps"), func(objs []Object) []Object {
			spec(Find(objs, "HTTPRoute", "play"))["hostnames"] = []any{"play.keelovertheedge.com"}
			return objs
		}},
		{"the players' host", inDeploy, func(objs []Object) []Object {
			for _, o := range objs {
				if o.Kind() == "ConfigMap" {
					o["data"].(map[string]any)["KEEL_PLAY_ORIGIN"] = "https://keelovertheedge.com"
				}
			}
			return objs
		}},
		{"the players' host", inRelease(prod, "apps"), func(objs []Object) []Object {
			for _, o := range objs {
				if o.Kind() == "ConfigMap" {
					delete(o["data"].(map[string]any), "KEEL_PLAY_ORIGIN")
				}
			}
			return objs
		}},
		{"keel's Deployment", inDeploy, func(objs []Object) []Object {
			spec(Find(objs, "Deployment", Deployment))["replicas"] = 2
			return objs
		}},
		{"keel's Deployment", inDeploy, func(objs []Object) []Object {
			spec(Find(objs, "Deployment", Deployment))["strategy"] = map[string]any{"type": "RollingUpdate"}
			return objs
		}},
		{"keel's Deployment", inDeploy, func(objs []Object) []Object {
			PodSpec(Find(objs, "Deployment", Deployment))["initContainers"] = []any{}
			return objs
		}},
		{"keel's Deployment", inDeploy, func(objs []Object) []Object {
			game(objs)["readinessProbe"].(map[string]any)["httpGet"].(map[string]any)["port"] = "play"
			return objs
		}},
		{"keel's Deployment", inRelease(prod, "apps"), func(objs []Object) []Object {
			game(objs)["securityContext"].(map[string]any)["readOnlyRootFilesystem"] = false
			return objs
		}},
		{"keel's Deployment", inDeploy, func(objs []Object) []Object {
			PodSpec(Find(objs, "Deployment", Deployment))["automountServiceAccountToken"] = true
			return objs
		}},
		{"GOMEMLIMIT within the memory limit", inDeploy, func(objs []Object) []Object {
			game(objs)["resources"].(map[string]any)["limits"].(map[string]any)["memory"] = "4Gi"
			return objs
		}},
		{"no route to the internal listener", inRelease(prod, "apps"), func(objs []Object) []Object {
			route := Find(objs, "HTTPRoute", "play")
			Get(route, "spec", "rules", 0, "backendRefs", 0).(map[string]any)["port"] = 9090
			return objs
		}},
		{"nothing exposed on production's node", inRelease(prod, "configs"), func(objs []Object) []Object {
			o := Find(objs, "HelmChartConfig", "traefik")
			spec(o)["valuesContent"] = strings.Replace(Str(o, "spec", "valuesContent"), "type: ClusterIP", "type: LoadBalancer", 1)
			return objs
		}},
		{"nothing exposed on production's node", inRelease(prod, "configs"), func(objs []Object) []Object {
			o := Find(objs, "HelmChartConfig", "traefik")
			spec(o)["valuesContent"] = strings.Replace(Str(o, "spec", "valuesContent"), "type: ClusterIP", "loadBalancerClass: none", 1)
			return objs
		}},
		{"nothing exposed on production's node", inRelease(prod, "apps"), func(objs []Object) []Object {
			spec(Find(objs, "Service", "keel"))["type"] = "NodePort"
			return objs
		}},
		{"routes on the Gateway's listeners", inDeploy, func(objs []Object) []Object {
			Get(Find(objs, "HTTPRoute", "play"), "spec", "parentRefs", 0).(map[string]any)["sectionName"] = "websecure"
			return objs
		}},
		{"routes on the Gateway's listeners", inDeploy, func(objs []Object) []Object {
			delete(Get(Find(objs, "Gateway", gatewayName), "spec", "listeners", 1).(map[string]any), "tls")
			return objs
		}},
		{"routes on the Gateway's listeners", inDeploy, func(objs []Object) []Object {
			Get(Find(objs, "Gateway", gatewayName), "spec", "listeners", 1).(map[string]any)["hostname"] = "harbour.local"
			spec(Find(objs, "HTTPRoute", "play"))["hostnames"] = []any{"elsewhere.local"}
			return objs
		}},
		{"the database's access and locale", inDeploy, func(objs []Object) []Object {
			Get(Find(objs, "Cluster", database), "spec", "postgresql").(map[string]any)["pg_hba"] = []any{}
			return objs
		}},
		{"the database's access and locale", inDeploy, func(objs []Object) []Object {
			spec(Find(objs, "Cluster", database))["enableSuperuserAccess"] = true
			return objs
		}},
		{"the database's access and locale", inDeploy, func(objs []Object) []Object {
			Get(Find(objs, "Cluster", database), "spec", "bootstrap", "initdb").(map[string]any)["localeProvider"] = "libc"
			return objs
		}},
		{"the database's restarts", inDeploy, func(objs []Object) []Object {
			delete(spec(Find(objs, "Cluster", database)), "smartShutdownTimeout")
			return objs
		}},
		{"the database's restarts", inDeploy, func(objs []Object) []Object {
			delete(Get(Find(objs, "Cluster", database), "spec", "postgresql", "parameters").(map[string]any), "tcp_keepalives_count")
			return objs
		}},
		{"keel's time to stop", inDeploy, func(objs []Object) []Object {
			PodSpec(Find(objs, "Deployment", Deployment))["terminationGracePeriodSeconds"] = 20
			return objs
		}},
		{"keel's time to stop", inDeploy, func(objs []Object) []Object {
			for _, o := range objs {
				if o.Kind() == "ConfigMap" && strings.HasPrefix(o.Name(), "keel") {
					o["data"].(map[string]any)["KEEL_BELL"] = "15s"
				}
			}
			return objs
		}},
	}
	broken := map[string]bool{}
	for i, c := range cases {
		objs, target := c.from()
		if err := CheckRules(objs, target); err != nil {
			t.Fatalf("case %d, before it is broken: %v", i, err)
		}
		err := CheckRules(c.mutate(objs), target)
		if err == nil || !strings.Contains(err.Error(), c.rule+":") {
			t.Errorf("case %d, broken for %q: %v", i, c.rule, err)
		}
		for _, r := range rules {
			if r.name != c.rule && err != nil && strings.Contains(err.Error(), r.name+":") {
				t.Errorf("case %d, broken for %q, %q failed too: %v", i, c.rule, r.name, err)
			}
		}
		broken[c.rule] = true
	}
	for _, r := range rules {
		if !broken[r.name] {
			t.Errorf("no case breaks the rule %q", r.name)
		}
	}
}
