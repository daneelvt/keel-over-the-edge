// SPDX-License-Identifier: AGPL-3.0-only

// Package manifests renders the cluster's manifests, infra/cluster, with
// kustomize, and checks the rules they keep. A release renders every
// cluster's entry points with the game's image by digest (tools/release);
// the local cluster's tool renders its own with the image it built
// (tools/cluster).
package manifests

import (
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"net"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
	"sigs.k8s.io/kustomize/api/krusty"
	"sigs.k8s.io/kustomize/api/resmap"
	"sigs.k8s.io/kustomize/kyaml/filesys"

	"github.com/daneelvt/keel-over-the-edge/internal/config"
)

// The names the manifests give the game's parts.
const (
	Namespace   = "keel"
	Deployment  = "keel"
	gatewayName = "keel"
	database    = "keel-db"
	// GameImage is the game's image in the registry; a release names it by
	// digest. LocalImage is the image tools/cluster builds and imports into
	// the local cluster's node, never pulled.
	GameImage  = "ghcr.io/daneelvt/keel"
	LocalImage = "keel"
	// ManifestsRepo is where a release's manifests are published, as an OCI
	// artifact tagged with the build; ProdTag is the tag production
	// follows.
	ManifestsRepo = "ghcr.io/daneelvt/keel-manifests"
	ProdTag       = "prod"
	// FluxNamespace holds Flux's controllers and what they follow; Source
	// is the release they follow.
	FluxNamespace = "flux-system"
	Source        = "keel"
)

// The signer of a release, as Flux and cosign match it against the
// certificate Sigstore issued for the signature: GitHub's OIDC issuer, and
// the release workflow of this repository on main (Fulcio's Build Signer
// URI, the workflow's path and ref). Anchored at both ends: not a pull
// request's ref, another branch, another workflow, or a fork.
const (
	ReleaseIssuer  = `^https://token\.actions\.githubusercontent\.com$`
	ReleaseSubject = `^https://github\.com/daneelvt/keel-over-the-edge/\.github/workflows/release\.yaml@refs/heads/main$`
)

// Layers are the names of Flux's Kustomizations and of the entry points
// they apply, in order. Each waits for the layer it follows (After):
// monitoring follows configs, beside apps, so neither waits for the other.
var Layers = []string{"flux-system", "controllers", "configs", "apps", "monitoring"}

// After is the layer each layer waits for; flux-system waits for none.
var After = map[string]string{
	"controllers": "flux-system",
	"configs":     "controllers",
	"apps":        "configs",
	"monitoring":  "configs",
}

// Cluster is a cluster a release holds manifests for.
type Cluster struct {
	Name string
	// Entries are its entry points, folders of infra/cluster/clusters/<Name>,
	// in the order they are applied.
	Entries []string
}

// Clusters are the clusters of a release. The local one has no flux-system:
// tools/cluster installs Flux's controllers there itself. prod-rebuild is
// production rebuilt from its backups: production in every way but the
// database, which it recovers, and the layers' folders.
var Clusters = []Cluster{
	{"local", []string{"controllers", "configs", "apps", "monitoring"}},
	{"prod", []string{"flux-system", "controllers", "configs", "apps", "monitoring"}},
	{"prod-rebuild", []string{"flux-system", "controllers", "configs", "apps", "monitoring"}},
}

// Rebuild is the name of production's rebuild form.
const Rebuild = "prod-rebuild"

// Entry is an entry point's folder under infra/cluster.
func (c Cluster) Entry(name string) string { return path.Join("clusters", c.Name, name) }

// FluxEntry is Flux's controllers alone, as tools/cluster applies them to
// the local cluster; LocalRelease is what it applies there to follow a
// release.
const (
	FluxEntry    = "flux-system"
	LocalRelease = "clusters/local/release"
)

// Deploy is what a deploy from the working tree puts into the local
// cluster's game: the image's tag, the players' host, keel's scripted
// sailors, if any, and whether the database is the rebuild form's,
// recovered from its backups.
type Deploy struct {
	Build, Host, Sailors string
	Rebuild              bool
	// NoBackups leaves the backups out: the database archives nowhere,
	// and there is no object store, scheduled backup or restore test. For
	// a Mac that has no key to the local cluster's bucket.
	NoBackups bool
}

// Tree is infra/cluster read into memory, beside the entry points a
// rendering adds, so kustomize renders without writing into the
// repository.
type Tree struct {
	fs filesys.FileSystem
}

// treeRoot is where infra/cluster sits in the tree.
const treeRoot = "/repo/infra/cluster"

// ReadTree reads dir (infra/cluster) into a tree.
func ReadTree(dir string) (*Tree, error) {
	mem := filesys.MakeFsInMemory()
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return mem.WriteFile(path.Join(treeRoot, filepath.ToSlash(rel)), data)
	})
	if err != nil {
		return nil, err
	}
	return &Tree{fs: mem}, nil
}

// Render builds an entry point, a directory under infra/cluster, as it is
// written.
func (t *Tree) Render(entry string) (resmap.ResMap, error) {
	k := krusty.MakeKustomizer(krusty.MakeDefaultOptions())
	rm, err := k.Run(t.fs, path.Join(treeRoot, entry))
	if err != nil {
		return nil, fmt.Errorf("rendering %s: %w", entry, err)
	}
	return rm, nil
}

// over builds an entry point under a kustomization of the rendering's own,
// written beside the tree, with the components named, folders under
// infra/cluster.
func (t *Tree) over(entry string, k map[string]any, components ...string) (resmap.ResMap, error) {
	k["apiVersion"] = "kustomize.config.k8s.io/v1beta1"
	k["kind"] = "Kustomization"
	k["resources"] = []string{".." + path.Join(treeRoot, entry)}
	if len(components) > 0 {
		var cs []string
		for _, c := range components {
			cs = append(cs, ".."+path.Join(treeRoot, c))
		}
		k["components"] = cs
	}
	data, err := yaml.Marshal(k)
	if err != nil {
		return nil, err
	}
	if err := t.fs.WriteFile("/over/kustomization.yaml", data); err != nil {
		return nil, err
	}
	rm, err := krusty.MakeKustomizer(krusty.MakeDefaultOptions()).Run(t.fs, "/over")
	if err != nil {
		return nil, fmt.Errorf("rendering %s: %w", entry, err)
	}
	return rm, nil
}

var (
	imageRef = regexp.MustCompile(`^` + regexp.QuoteMeta(GameImage) + `@(sha256:[0-9a-f]{64})$`)
	// BuildID is a release's build: the first 12 characters of its commit.
	BuildID = regexp.MustCompile(`^[0-9a-f]{12}$`)
)

// RenderRelease builds an entry point for a release: wherever it names the
// game's image, by the digest of image, which is GameImage@sha256:….
func (t *Tree) RenderRelease(entry, image string) (resmap.ResMap, error) {
	m := imageRef.FindStringSubmatch(image)
	if m == nil {
		return nil, fmt.Errorf("the image %q is not %s@sha256:<digest>", image, GameImage)
	}
	return t.over(entry, map[string]any{
		"images": []map[string]string{{"name": GameImage, "digest": m[1]}},
	})
}

// RebuildComponent is the component that makes the database the rebuild
// form's.
const RebuildComponent = "apps/rebuild"

// RenderDeploy builds the local game for a deploy from the working tree:
// clusters/local/apps with the image tools/cluster built and imported,
// wherever the game's image runs, the players' host and keel's scripted
// sailors; and, for a rebuild, the database recovered from its backups.
func (t *Tree) RenderDeploy(d Deploy) (resmap.ResMap, error) {
	literals := []string{"KEEL_PLAY_ORIGIN=https://" + d.Host}
	if d.Sailors != "" {
		literals = append(literals, "KEEL_DEV_SAILORS="+d.Sailors)
	}
	imported := map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata":   map[string]any{"name": Deployment, "namespace": Namespace},
		"spec": map[string]any{"template": map[string]any{"spec": map[string]any{
			"initContainers": []map[string]any{{"name": "migrate", "imagePullPolicy": "Never"}},
			"containers":     []map[string]any{{"name": "keel", "imagePullPolicy": "Never"}},
		}}},
	}
	patch, err := yaml.Marshal(imported)
	if err != nil {
		return nil, err
	}
	restore, err := yaml.Marshal(map[string]any{
		"apiVersion": "batch/v1",
		"kind":       "CronJob",
		"metadata":   map[string]any{"name": RestoreTest, "namespace": RestoreNamespace},
		"spec": map[string]any{"jobTemplate": map[string]any{"spec": map[string]any{"template": map[string]any{"spec": map[string]any{
			"containers": []map[string]any{{"name": "restore-test", "imagePullPolicy": "Never"}},
		}}}}},
	})
	if err != nil {
		return nil, err
	}
	var components []string
	if d.Rebuild {
		if d.NoBackups {
			return nil, errors.New("a rebuild recovers the database from its backups, and this deploy has none")
		}
		components = append(components, RebuildComponent)
	}
	patches := []map[string]any{{"patch": string(patch)}}
	if d.NoBackups {
		for _, gone := range [][4]string{
			{"barmancloud.cnpg.io/v1", "ObjectStore", ObjectStore, Namespace},
			{"barmancloud.cnpg.io/v1", "ObjectStore", RestoreStore, RestoreNamespace},
			{"postgresql.cnpg.io/v1", "ScheduledBackup", "keel-db-daily", Namespace},
			{"batch/v1", "CronJob", RestoreTest, RestoreNamespace},
		} {
			patches = append(patches, map[string]any{"patch": fmt.Sprintf(
				"$patch: delete\napiVersion: %s\nkind: %s\nmetadata:\n  name: %s\n  namespace: %s\n", gone[0], gone[1], gone[2], gone[3])})
		}
		patches = append(patches, map[string]any{
			"target": map[string]string{"kind": "Cluster", "name": database},
			"patch":  "- op: remove\n  path: /spec/plugins\n",
		})
	} else {
		patches = append(patches, map[string]any{"patch": string(restore)})
	}
	return t.over(Clusters[0].Entry("apps"), map[string]any{
		"images": []map[string]string{{"name": GameImage, "newName": LocalImage, "newTag": d.Build}},
		"configMapGenerator": []map[string]any{{
			"name": "keel", "namespace": Namespace, "behavior": "merge", "literals": literals,
		}},
		"patches": patches,
	}, components...)
}

// RenderSync builds what the local cluster applies to follow a release:
// clusters/local/release at tag, a build or ProdTag.
func (t *Tree) RenderSync(tag string) (resmap.ResMap, error) {
	if tag != ProdTag && !BuildID.MatchString(tag) {
		return nil, fmt.Errorf("%q is neither a build, the first 12 characters of its commit, nor %s", tag, ProdTag)
	}
	return t.over(LocalRelease, map[string]any{
		"patches": []map[string]any{{
			"target": map[string]string{"kind": "OCIRepository", "name": Source},
			"patch":  "- op: replace\n  path: /spec/ref/tag\n  value: " + strconv.Quote(tag) + "\n",
		}},
	})
}

// Object is one rendered resource, as plain maps.
type Object map[string]any

func (o Object) Kind() string { return Str(o, "kind") }
func (o Object) Name() string { return Str(o, "metadata", "name") }
func (o Object) ID() string   { return o.Kind() + "/" + o.Name() }

// group is the API group of the object's kind; "" for the core group.
func (o Object) group() string {
	g, _, ok := strings.Cut(Str(o, "apiVersion"), "/")
	if !ok {
		return ""
	}
	return g
}

// Objects turns a rendered entry point into plain maps.
func Objects(rm resmap.ResMap) ([]Object, error) {
	var objs []Object
	for _, r := range rm.Resources() {
		m, err := r.Map()
		if err != nil {
			return nil, err
		}
		objs = append(objs, m)
	}
	return objs, nil
}

// Get walks keys through nested maps; a number walks into a list.
func Get(v any, keys ...any) any {
	if o, ok := v.(Object); ok {
		v = map[string]any(o)
	}
	for _, k := range keys {
		switch k := k.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				return nil
			}
			v = m[k]
		case int:
			l, ok := v.([]any)
			if !ok || k >= len(l) {
				return nil
			}
			v = l[k]
		}
	}
	return v
}

// Str is the string Get finds, or "".
func Str(v any, keys ...any) string {
	s, _ := Get(v, keys...).(string)
	return s
}

// List is the list Get finds, or none.
func List(v any, keys ...any) []any {
	l, _ := Get(v, keys...).([]any)
	return l
}

// Target is what a rendering is for.
type Target struct {
	// Cluster is the cluster's name: "local", "prod" or "prod-rebuild".
	Cluster string
	// Deploy is whether tools/cluster rendered it from the working tree,
	// with the game's image built and imported rather than pulled.
	Deploy bool
	// Rebuild is whether the database is the rebuild form's, recovered
	// from the backups: a deploy's with -rebuild, or prod-rebuild's.
	Rebuild bool
	// K3s is the k3s release the machines run, infra/k3s/release.yaml's
	// version, which the upgrade plan must name.
	K3s string
	// NoBackups is whether a deploy left the backups out, for a Mac with
	// no key to the local cluster's bucket.
	NoBackups bool
}

// Production is whether the rendering is production's, as it runs or as
// it is rebuilt.
func (t Target) Production() bool { return t.Cluster == "prod" || t.Cluster == Rebuild }

// TargetOf is what a cluster's entry points are rendered for, by a
// release, with the k3s release the machines run.
func TargetOf(c Cluster, k3s string) Target {
	return Target{Cluster: c.Name, Rebuild: c.Name == Rebuild, K3s: k3s}
}

// rule is one thing every rendered entry point must keep.
type rule struct {
	name  string
	check func(objs []Object, t Target) error
}

// rules are checked on every entry point before it is released or applied,
// and by the tests on every entry point.
var rules = []rule{
	{"no Secret in the manifests", noSecrets},
	{"every image pinned by digest", pinnedImages},
	{"every source's signature checked", verifiedSources},
	{"Flux's layers", fluxLayers},
	{"the database never pruned", neverPruned},
	{"the players' host", playersHost},
	{"keel's Deployment", gameDeployment},
	{"GOMEMLIMIT within the memory limit", memoryLimit},
	{"no route to the internal listener", noInternalRoute},
	{"nothing exposed on production's node", noNodePorts},
	{"routes on the Gateway's listeners", routesOnListeners},
	{"the database's access and locale", databaseCluster},
	{"the database's restarts", databaseRestarts},
	{"keel's time to stop", stopTime},
	{"every namespace enforces restricted", namespacesRestricted},
	{"every namespace fenced for ingress", namespacesFenced},
	{"no address range but the internet", ipBlocks},
	{"production's Secrets from Infisical", secretsFromInfisical},
	{"every Secret a workload needs is made", secretsMade},
	{"the game's routes limited per address", routesLimited},
	{"production's host on its Gateway and routes", productionHost},
	{"the database's archive", databaseArchive},
	{"the object stores", objectStores},
	{"nothing fetched at deploy time", nothingFetched},
	{"no route to monitoring", noMonitoringRoute},
	{"the k3s upgrade plan", k3sPlan},
	{"fixed addresses for the forwards alone", fixedAddresses},
}

// CheckRules checks objs, one rendered entry point, against every rule.
func CheckRules(objs []Object, t Target) error {
	var errs []error
	for _, r := range rules {
		if err := r.check(objs, t); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", r.name, err))
		}
	}
	return errors.Join(errs...)
}

func noSecrets(objs []Object, _ Target) error {
	for _, o := range objs {
		if o.Kind() == "Secret" {
			return fmt.Errorf("%s: Secrets are made in the cluster, never kept in the repository", o.ID())
		}
	}
	return nil
}

// PodSpec is the pod template of a workload, if o is one.
func PodSpec(o Object) map[string]any {
	switch o.Kind() {
	case "Deployment", "StatefulSet", "DaemonSet", "Job", "ReplicaSet":
		s, _ := Get(o, "spec", "template", "spec").(map[string]any)
		return s
	case "CronJob":
		s, _ := Get(o, "spec", "jobTemplate", "spec", "template", "spec").(map[string]any)
		return s
	case "Pod":
		s, _ := Get(o, "spec").(map[string]any)
		return s
	}
	return nil
}

// Containers are a pod's containers, its init containers first.
func Containers(spec map[string]any) []map[string]any {
	var cs []map[string]any
	for _, key := range []string{"initContainers", "containers"} {
		for _, c := range List(spec, key) {
			if m, ok := c.(map[string]any); ok {
				cs = append(cs, m)
			}
		}
	}
	return cs
}

func byDigest(image string) bool {
	_, digest, ok := strings.Cut(image, "@sha256:")
	return ok && len(digest) == 64
}

// isRelease is whether o is the source of the release itself: the one
// source that follows a tag, which the promote workflow moves.
func isRelease(o Object) bool {
	return o.Kind() == "OCIRepository" && Str(o, "spec", "url") == "oci://"+ManifestsRepo
}

// pinnedImages: every image a workload, the database, a chart, the
// monitoring operator's objects or the upgrade plan names is pinned by
// digest, the game's own included; only a deploy from the working tree
// names it by a tag the node already holds.
func pinnedImages(objs []Object, t Target) error {
	var errs []error
	for _, o := range objs {
		if spec := PodSpec(o); spec != nil {
			for _, c := range Containers(spec) {
				img, _ := c["image"].(string)
				if t.Deploy && strings.HasPrefix(img, LocalImage+":") {
					if c["imagePullPolicy"] != "Never" {
						errs = append(errs, fmt.Errorf("%s: %s is imported, so imagePullPolicy must be Never", o.ID(), img))
					}
					continue
				}
				if !byDigest(img) {
					errs = append(errs, fmt.Errorf("%s: %q is not pinned by digest", o.ID(), img))
				}
			}
		}
		switch {
		case o.Kind() == "Cluster":
			if img := Str(o, "spec", "imageName"); !byDigest(img) {
				errs = append(errs, fmt.Errorf("%s: %q is not pinned by digest", o.ID(), img))
			}
		case o.Kind() == "HelmRelease":
			values, _ := Get(o, "spec", "values").(map[string]any)
			if len(values) == 0 {
				errs = append(errs, fmt.Errorf("%s: no values, so the chart's images are its own tags", o.ID()))
			}
			for _, p := range unpinnedValues(values, "values") {
				errs = append(errs, fmt.Errorf("%s: the chart's %s is not pinned by digest", o.ID(), p))
			}
		case o.Kind() == "OCIRepository":
			if d := Str(o, "spec", "ref", "digest"); !isRelease(o) && (!strings.HasPrefix(d, "sha256:") || len(d) != 71) {
				errs = append(errs, fmt.Errorf("%s: not pinned by digest", o.ID()))
			}
		case o.group() == "operator.victoriametrics.com" && Get(o, "spec", "image") != nil:
			if tag := Str(o, "spec", "image", "tag"); !strings.Contains(tag, "@sha256:") || len(tag[strings.Index(tag, "@sha256:")+8:]) != 64 {
				errs = append(errs, fmt.Errorf("%s: the image tag %q is not pinned by digest", o.ID(), tag))
			}
		case o.Kind() == "Plan" && o.group() == "upgrade.cattle.io":
			if img := Str(o, "spec", "upgrade", "image"); !byDigest(img) {
				errs = append(errs, fmt.Errorf("%s: the upgrade image %q is not pinned by digest", o.ID(), img))
			}
		case o.Kind() == "ConfigMap":
			data, _ := Get(o, "data").(map[string]any)
			for k, v := range data {
				if img, _ := v.(string); strings.HasSuffix(k, "_IMAGE") && img != "" && !byDigest(img) {
					errs = append(errs, fmt.Errorf("%s: %s %q is not pinned by digest", o.ID(), k, img))
				}
			}
		}
	}
	return errors.Join(errs...)
}

// imageKey is a chart value that names an image: image, sidecarImage and
// the like.
func imageKey(k string) bool { return strings.HasSuffix(strings.ToLower(k), "image") }

// pinnedImageValue is whether a chart's image value names a digest: as an
// image's whole reference, a tag holding one (tag@sha256:…), or a digest
// beside the tag, with or without its sha256: (charts differ).
func pinnedImageValue(v any) bool {
	switch v := v.(type) {
	case string:
		return byDigest(v)
	case map[string]any:
		hex := regexp.MustCompile(`^(sha256:)?[0-9a-f]{64}$`)
		tag, _ := v["tag"].(string)
		digest, _ := v["digest"].(string)
		sha, _ := v["sha"].(string)
		return byDigest(tag) || (strings.HasPrefix(digest, "sha256:") && hex.MatchString(digest)) || hex.MatchString(sha)
	}
	return false
}

// unpinnedValues are the paths of the image values under v that name no
// digest, as values.a.b.
func unpinnedValues(v any, path string) []string {
	var out []string
	switch v := v.(type) {
	case map[string]any:
		for _, k := range slices.Sorted(maps.Keys(v)) {
			p := path + "." + k
			if imageKey(k) {
				if !pinnedImageValue(v[k]) {
					out = append(out, p)
				}
				continue
			}
			out = append(out, unpinnedValues(v[k], p)...)
		}
	case []any:
		for i, e := range v {
			out = append(out, unpinnedValues(e, fmt.Sprintf("%s[%d]", path, i))...)
		}
	}
	return out
}

// Keyed is a source Flux cannot verify, whose signature the release and
// pull request workflows check instead, against its publisher's key kept
// in the repository (go run ./tools/release -verify-keyed).
type Keyed struct {
	// Name and URL are its OCIRepository's.
	Name, URL string
	// Key is the publisher's public key, from the repository's root.
	Key string
	// Images are the images its chart runs, each checked against the same
	// key: the image's name, by where its HelmRelease's values pin its
	// digest (a.b.digest).
	Images map[string]string
	// Why Flux cannot verify it.
	Why string
}

// KeyedSources are the sources Flux cannot verify, and how they are
// checked instead. Every other source is verified by Flux.
var KeyedSources = []Keyed{{
	Name: "cert-manager",
	URL:  "oci://quay.io/jetstack/charts/cert-manager",
	Key:  "infra/keys/cert-manager.pem",
	Images: map[string]string{
		"image":            "quay.io/jetstack/cert-manager-controller",
		"webhook.image":    "quay.io/jetstack/cert-manager-webhook",
		"cainjector.image": "quay.io/jetstack/cert-manager-cainjector",
		"acmesolver.image": "quay.io/jetstack/cert-manager-acmesolver",
	},
	Why: "cert-manager signs with an RSA key and SHA-512; Flux verifies a key's signature with SHA-256 alone",
}}

// SignedImage is an image a vendored manifest runs, which no source of
// Flux's covers: CI checks its keyless signature instead, the signer its
// project's release workflow at the image's own tag.
type SignedImage struct {
	// Image is its name, without tag or digest.
	Image string
	// Subject is the signer's pattern, with %s for the tag, quoted.
	Subject string
}

// SignedImages are the images checked so.
var SignedImages = []SignedImage{{
	Image:   "ghcr.io/kubereboot/kured",
	Subject: `^https://github\.com/kubereboot/kured/\.github/workflows/on-tag\.yaml@refs/tags/%s$`,
}}

// ImageValues are the paths of every image value under a chart's values,
// as a.b, without the leading values.
func ImageValues(values any) []string {
	var out []string
	var walk func(v any, path string)
	walk = func(v any, path string) {
		switch v := v.(type) {
		case map[string]any:
			for _, k := range slices.Sorted(maps.Keys(v)) {
				p := strings.TrimPrefix(path+"."+k, ".")
				if imageKey(k) {
					out = append(out, p)
					continue
				}
				walk(v[k], p)
			}
		case []any:
			for i, e := range v {
				walk(e, fmt.Sprintf("%s[%d]", path, i))
			}
		}
	}
	walk(values, "")
	return out
}

// keyed is the listed source o is, if it is one.
func keyed(o Object) *Keyed {
	for i, k := range KeyedSources {
		if o.Kind() == "OCIRepository" && o.Name() == k.Name && Str(o, "spec", "url") == k.URL {
			return &KeyedSources[i]
		}
	}
	return nil
}

// verifiedSources: Flux fetches from an OCI repository only what its
// signature allows: checked with cosign, keyless, against identities whose
// patterns match the certificate's issuer and subject whole. The release's
// own source follows a build or the tag production follows, and accepts
// the release workflow alone. A source Flux cannot verify has no verify,
// and is one of KeyedSources, which CI checks against its key.
func verifiedSources(objs []Object, _ Target) error {
	var errs []error
	for _, o := range objs {
		if o.Kind() != "OCIRepository" {
			continue
		}
		fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(o.ID()+": "+format, a...)) }
		if k := keyed(o); k != nil {
			if Get(o, "spec", "verify") != nil {
				fail("listed as checked in CI against %s, yet Flux is asked to verify it too", k.Key)
			}
			continue
		}
		if p := Str(o, "spec", "verify", "provider"); p != "cosign" {
			fail("verify's provider is %q, want cosign", p)
		}
		if Get(o, "spec", "verify", "secretRef") != nil {
			fail("verify names a key: the signer is an identity, not a key kept somewhere")
		}
		identities := List(o, "spec", "verify", "matchOIDCIdentity")
		if len(identities) == 0 {
			fail("verify matches no identity: any signer would do")
		}
		for _, id := range identities {
			for _, field := range []string{"issuer", "subject"} {
				p := Str(id, field)
				if _, err := regexp.Compile(p); err != nil || len(p) < 3 || !strings.HasPrefix(p, "^") || !strings.HasSuffix(p, "$") || strings.HasSuffix(p, `\$`) {
					fail("the %s pattern %q is not a regular expression anchored at both ends", field, p)
				}
			}
		}
		if !isRelease(o) {
			continue
		}
		if len(identities) != 1 || Str(identities[0], "issuer") != ReleaseIssuer || Str(identities[0], "subject") != ReleaseSubject {
			fail("the release's signer must be the release workflow on main alone, issuer %s and subject %s", ReleaseIssuer, ReleaseSubject)
		}
		ref, _ := Get(o, "spec", "ref").(map[string]any)
		if tag := Str(ref, "tag"); o.Name() != Source || (tag != ProdTag && !BuildID.MatchString(tag)) || len(ref) != 1 {
			fail("the release's source must be %s, following a build or %s by tag alone", Source, ProdTag)
		}
	}
	return errors.Join(errs...)
}

// fluxLayers: Flux's Kustomizations apply the release's folders for this
// cluster, each named after its layer, each once the layer it follows is
// ready (After; the local cluster has no flux-system layer to follow), and
// wait until what they applied is healthy. They remove what a release no
// longer holds, and nothing at all when one of them is deleted. The first
// of production's holds the others, so waits for Flux's controllers alone,
// each by name.
func fluxLayers(objs []Object, t Target) error {
	var errs []error
	have := map[string]Object{}
	for _, o := range objs {
		if o.Kind() != "Kustomization" || o.group() != "kustomize.toolkit.fluxcd.io" {
			continue
		}
		if !slices.Contains(Layers, o.Name()) || Str(o, "metadata", "namespace") != FluxNamespace {
			errs = append(errs, fmt.Errorf("%s: not one of the layers %v in %s", o.ID(), Layers, FluxNamespace))
			continue
		}
		have[o.Name()] = o
	}
	for _, layer := range Layers {
		o, ok := have[layer]
		if !ok {
			continue
		}
		fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(o.ID()+": "+format, a...)) }
		if Str(o, "spec", "sourceRef", "kind") != "OCIRepository" || Str(o, "spec", "sourceRef", "name") != Source {
			fail("its source is not the release, OCIRepository %s", Source)
		}
		if want := "./" + t.Cluster + "/" + layer; Str(o, "spec", "path") != want {
			fail("path %q, want %s", Str(o, "spec", "path"), want)
		}
		if Get(o, "spec", "prune") != true {
			fail("prune is not on")
		}
		if p := Str(o, "spec", "deletionPolicy"); p != "Orphan" {
			fail("deletionPolicy %q, want Orphan: deleting it must delete nothing it applied", p)
		}
		var deps []string
		for _, d := range List(o, "spec", "dependsOn") {
			deps = append(deps, Str(d, "name"))
		}
		var want []string
		if _, ok := have[After[layer]]; ok {
			want = []string{After[layer]}
		}
		if !slices.Equal(deps, want) {
			fail("dependsOn %v, want %v, the layer it follows", deps, want)
		}
		if layer != Layers[0] {
			if Get(o, "spec", "wait") != true {
				fail("wait is not on")
			}
			continue
		}
		if Get(o, "spec", "wait") == true {
			fail("wait is on, but it applies the layers that wait for it")
		}
		checked := map[string]bool{}
		for _, h := range List(o, "spec", "healthChecks") {
			if Str(h, "kind") == "Deployment" && Str(h, "namespace") == FluxNamespace {
				checked[Str(h, "name")] = true
			}
		}
		controllers := 0
		for _, d := range objs {
			if d.Kind() != "Deployment" || Str(d, "metadata", "namespace") != FluxNamespace {
				continue
			}
			controllers++
			if !checked[d.Name()] {
				fail("no health check of %s", d.ID())
			}
		}
		if controllers == 0 {
			fail("it holds none of Flux's controllers")
		}
	}
	return errors.Join(errs...)
}

// pruneDisabled is the annotation that keeps Flux from ever deleting an
// object, whatever a release holds (Flux's Kustomization documentation).
const pruneDisabled = "kustomize.toolkit.fluxcd.io/prune"

// neverPruned: the database, and the namespace whose deletion would take
// it along, are never deleted by Flux.
func neverPruned(objs []Object, _ Target) error {
	var errs []error
	for _, o := range objs {
		if o.Kind() != "Cluster" {
			continue
		}
		for _, keep := range []Object{o, Find(objs, "Namespace", Str(o, "metadata", "namespace"))} {
			if keep != nil && Str(keep, "metadata", "annotations", pruneDisabled) != "disabled" {
				errs = append(errs, fmt.Errorf("%s: not annotated %s: disabled", keep.ID(), pruneDisabled))
			}
		}
	}
	return errors.Join(errs...)
}

// The players' hosts: the local cluster is reached by a Mac's Bonjour
// name, production at the game's domain.
const (
	localSuffix = ".local"
	prodDomain  = "keelovertheedge.com"
)

// playersHost: a cluster names only its own players' host, in keel's
// origin, the Gateway's listeners and the routes.
func playersHost(objs []Object, t Target) error {
	var errs []error
	check := func(o Object, host string) {
		host = strings.TrimPrefix(host, "https://")
		switch {
		case t.Production() && strings.HasSuffix(host, localSuffix):
			errs = append(errs, fmt.Errorf("%s names %s, a local host, in production", o.ID(), host))
		case !t.Production() && (host == prodDomain || strings.HasSuffix(host, "."+prodDomain)):
			errs = append(errs, fmt.Errorf("%s names %s, production's, outside production", o.ID(), host))
		}
	}
	for _, o := range objs {
		switch o.Kind() {
		case "ConfigMap":
			origin := Str(o, "data", "KEEL_PLAY_ORIGIN")
			if isGameConfig(o) && !strings.HasPrefix(origin, "https://") {
				errs = append(errs, fmt.Errorf("%s: KEEL_PLAY_ORIGIN is %q, not an https origin", o.ID(), origin))
			}
			check(o, origin)
		case "Gateway":
			for _, l := range List(o, "spec", "listeners") {
				check(o, Str(l, "hostname"))
			}
		case "HTTPRoute":
			for _, h := range List(o, "spec", "hostnames") {
				host, _ := h.(string)
				check(o, host)
			}
		}
	}
	return errors.Join(errs...)
}

// gameConfig is the name of keel's ConfigMap, as its generator makes it:
// keel, and the hash of its contents kustomize adds.
var gameConfig = regexp.MustCompile(`^keel(-[a-z0-9]{10})?$`)

// isGameConfig is whether o is keel's ConfigMap.
func isGameConfig(o Object) bool { return o.Kind() == "ConfigMap" && gameConfig.MatchString(o.Name()) }

// PlayOrigin is the origin players reach the game at, from keel's
// ConfigMap, or "".
func PlayOrigin(objs []Object) string {
	for _, o := range objs {
		if o.Kind() == "ConfigMap" && isGameConfig(o) {
			if origin := Str(o, "data", "KEEL_PLAY_ORIGIN"); origin != "" {
				return origin
			}
		}
	}
	return ""
}

// Find is the object of a kind and name, or nil.
func Find(objs []Object, kind, name string) Object {
	for _, o := range objs {
		if o.Kind() == kind && o.Name() == name {
			return o
		}
	}
	return nil
}

// Container is the container called name under key, "containers" or
// "initContainers", of a pod.
func Container(spec map[string]any, key, name string) map[string]any {
	for _, c := range List(spec, key) {
		if m, ok := c.(map[string]any); ok && m["name"] == name {
			return m
		}
	}
	return nil
}

// internalPort is the port KEEL_INTERNAL_ADDR names, from keel's
// ConfigMap.
func internalPort(objs []Object) (int, error) {
	for _, o := range objs {
		if o.Kind() != "ConfigMap" || !isGameConfig(o) {
			continue
		}
		if addr := Str(o, "data", "KEEL_INTERNAL_ADDR"); addr != "" {
			_, port, err := net.SplitHostPort(addr)
			if err != nil {
				return 0, fmt.Errorf("KEEL_INTERNAL_ADDR %q: %w", addr, err)
			}
			return strconv.Atoi(port)
		}
	}
	return 0, errors.New("no ConfigMap sets KEEL_INTERNAL_ADDR")
}

// containerPort resolves a probe's or a Service's target port, a number or
// a container port's name.
func containerPort(c map[string]any, port any) int {
	switch p := port.(type) {
	case int:
		return p
	case string:
		for _, cp := range List(c, "ports") {
			if Get(cp, "name") == p {
				n, _ := Get(cp, "containerPort").(int)
				return n
			}
		}
	}
	return 0
}

// gameDeployment: one replica replaced, not rolled; the schema migrated
// first; probes on the internal listener; the restricted security context.
func gameDeployment(objs []Object, _ Target) error {
	o := Find(objs, "Deployment", Deployment)
	if o == nil {
		return nil
	}
	var errs []error
	fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }
	if r, _ := Get(o, "spec", "replicas").(int); r != 1 {
		fail("replicas %v, want 1: one process holds the world", Get(o, "spec", "replicas"))
	}
	if s := Str(o, "spec", "strategy", "type"); s != "Recreate" {
		fail("strategy %q, want Recreate", s)
	}
	spec := PodSpec(o)
	if Get(spec, "automountServiceAccountToken") != false {
		fail("automountServiceAccountToken is not false")
	}
	pod, _ := Get(spec, "securityContext").(map[string]any)
	if Get(pod, "runAsNonRoot") != true || Get(pod, "runAsUser") != 65532 || Str(pod, "seccompProfile", "type") != "RuntimeDefault" {
		fail("the pod's security context %v: want runAsNonRoot, runAsUser 65532, seccomp RuntimeDefault", pod)
	}
	migrate := Container(spec, "initContainers", "migrate")
	if migrate == nil || !slices.Equal(List(migrate, "args"), []any{"migrate"}) {
		fail("no init container running keel migrate")
	}
	game := Container(spec, "containers", "keel")
	if game == nil {
		fail("no container keel")
		return errors.Join(errs...)
	}
	internal, err := internalPort(objs)
	if err != nil {
		fail("%v", err)
	}
	for probe, want := range map[string]string{"livenessProbe": "/livez", "readinessProbe": "/readyz"} {
		p := Str(game, probe, "httpGet", "path")
		port := containerPort(game, Get(game, probe, "httpGet", "port"))
		if p != want || port != internal {
			fail("%s is %s on port %d, want %s on the internal listener's %d", probe, p, port, want, internal)
		}
	}
	for _, c := range []map[string]any{migrate, game} {
		if c == nil {
			continue
		}
		sc, _ := c["securityContext"].(map[string]any)
		if Get(sc, "allowPrivilegeEscalation") != false || Get(sc, "readOnlyRootFilesystem") != true ||
			!slices.Equal(List(sc, "capabilities", "drop"), []any{"ALL"}) {
			fail("container %s's security context %v: want no privilege escalation, a read-only root, every capability dropped", c["name"], sc)
		}
	}
	return errors.Join(errs...)
}

// quantity reads a memory quantity in bytes: Mi and Gi, as the manifests
// write them.
func quantity(s string) (int64, error) {
	for suffix, unit := range map[string]int64{"Ki": 1 << 10, "Mi": 1 << 20, "Gi": 1 << 30, "KiB": 1 << 10, "MiB": 1 << 20, "GiB": 1 << 30} {
		if n, ok := strings.CutSuffix(s, suffix); ok {
			v, err := strconv.ParseInt(n, 10, 64)
			return v * unit, err
		}
	}
	return strconv.ParseInt(s, 10, 64)
}

// memoryLimit: Go's GOMEMLIMIT leaves room under the container's limit,
// and not so much that the memory goes unused.
func memoryLimit(objs []Object, _ Target) error {
	o := Find(objs, "Deployment", Deployment)
	if o == nil {
		return nil
	}
	game := Container(PodSpec(o), "containers", "keel")
	limit, err := quantity(Str(game, "resources", "limits", "memory"))
	if err != nil || limit == 0 {
		return fmt.Errorf("no memory limit (%v)", err)
	}
	for _, e := range List(game, "env") {
		if Get(e, "name") != "GOMEMLIMIT" {
			continue
		}
		v := Str(e, "value")
		goLimit, err := quantity(v)
		if err != nil {
			return fmt.Errorf("GOMEMLIMIT %q: %w", v, err)
		}
		if share := float64(goLimit) / float64(limit); share < 0.80 || share > 0.95 {
			return fmt.Errorf("GOMEMLIMIT %s is %.0f%% of the limit %s, want 80%% to 95%%", v, share*100, Str(game, "resources", "limits", "memory"))
		}
		return nil
	}
	return errors.New("no GOMEMLIMIT")
}

// TraefikValues are the values of k3s's Traefik chart a HelmChartConfig
// sets, if o is Traefik's.
func TraefikValues(o Object) (map[string]any, error) {
	if o.Kind() != "HelmChartConfig" || o.Name() != "traefik" || Str(o, "metadata", "namespace") != "kube-system" {
		return nil, nil
	}
	var v map[string]any
	if err := yaml.Unmarshal([]byte(Str(o, "spec", "valuesContent")), &v); err != nil {
		return nil, fmt.Errorf("%s: its valuesContent: %w", o.ID(), err)
	}
	return v, nil
}

// noNodePorts: production's node is on the internet, so no Service there
// is a LoadBalancer or a NodePort, which Kubernetes opens on every address
// of the node, Traefik's included (the chart's service.spec.type defaults
// to LoadBalancer, and k3s's ServiceLB is off there). The local cluster's
// Traefik is a LoadBalancer on purpose: ServiceLB holds its ports and Lima
// forwards them.
func noNodePorts(objs []Object, t Target) error {
	if !t.Production() {
		return nil
	}
	var errs []error
	for _, o := range objs {
		switch o.Kind() {
		case "Service":
			if typ := Str(o, "spec", "type"); typ == "LoadBalancer" || typ == "NodePort" {
				errs = append(errs, fmt.Errorf("%s is a %s Service", o.ID(), typ))
			}
		case "HelmChartConfig":
			v, err := TraefikValues(o)
			if err != nil {
				errs = append(errs, err)
			} else if v != nil && Str(v, "service", "spec", "type") != "ClusterIP" {
				errs = append(errs, fmt.Errorf("%s: Traefik's service.spec.type is %q, want ClusterIP", o.ID(), Str(v, "service", "spec", "type")))
			}
		}
	}
	return errors.Join(errs...)
}

// noInternalRoute: no route reaches keel's internal listener, through any
// port of its Service.
func noInternalRoute(objs []Object, _ Target) error {
	internal, err := internalPort(objs)
	if err != nil {
		return nil // no game in this entry point
	}
	game := Container(PodSpec(Find(objs, "Deployment", Deployment)), "containers", "keel")
	var errs []error
	for _, o := range objs {
		if o.Kind() != "HTTPRoute" {
			continue
		}
		for _, rule := range List(o, "spec", "rules") {
			for _, b := range List(rule, "backendRefs") {
				port, _ := Get(b, "port").(int)
				svc := Find(objs, "Service", Str(b, "name"))
				target := port
				for _, sp := range List(svc, "spec", "ports") {
					if Get(sp, "port") == port {
						target = containerPort(game, Get(sp, "targetPort"))
					}
				}
				if port == internal || target == internal {
					errs = append(errs, fmt.Errorf("%s reaches %s:%d, the internal listener", o.ID(), Str(b, "name"), port))
				}
			}
		}
	}
	return errors.Join(errs...)
}

// routesOnListeners: each route names a listener of the game's Gateway, an
// HTTPS listener has a certificate, and a route's hostnames are its
// listener's.
func routesOnListeners(objs []Object, _ Target) error {
	gw := Find(objs, "Gateway", gatewayName)
	var errs []error
	listeners := map[string]map[string]any{}
	for _, l := range List(gw, "spec", "listeners") {
		m, _ := l.(map[string]any)
		listeners[Str(m, "name")] = m
		if Str(m, "protocol") == "HTTPS" && len(List(m, "tls", "certificateRefs")) == 0 {
			errs = append(errs, fmt.Errorf("listener %s is HTTPS with no certificate", Str(m, "name")))
		}
	}
	for _, o := range objs {
		if o.Kind() != "HTTPRoute" {
			continue
		}
		parents := List(o, "spec", "parentRefs")
		if len(parents) == 0 {
			errs = append(errs, fmt.Errorf("%s has no parent", o.ID()))
		}
		for _, p := range parents {
			l, ok := listeners[Str(p, "sectionName")]
			if Str(p, "name") != gatewayName || !ok {
				errs = append(errs, fmt.Errorf("%s names %s/%s, not a listener of the Gateway %s", o.ID(), Str(p, "name"), Str(p, "sectionName"), gatewayName))
				continue
			}
			want := Str(l, "hostname")
			for _, h := range List(o, "spec", "hostnames") {
				if want != "" && h != want {
					errs = append(errs, fmt.Errorf("%s: hostname %v is not its listener's %s", o.ID(), h, want))
				}
			}
		}
	}
	return errors.Join(errs...)
}

// databaseCluster: only TLS connections, no superuser, a locale that never
// changes under an index. A database recovered from its backups keeps the
// locale it was made with.
func databaseCluster(objs []Object, _ Target) error {
	var errs []error
	for _, o := range objs {
		if o.Kind() != "Cluster" {
			continue
		}
		if !slices.Contains(List(o, "spec", "postgresql", "pg_hba"), any("hostnossl all all all reject")) {
			errs = append(errs, fmt.Errorf("%s: pg_hba does not refuse connections without TLS", o.ID()))
		}
		if Get(o, "spec", "enableSuperuserAccess") != false {
			errs = append(errs, fmt.Errorf("%s: superuser access is not off", o.ID()))
		}
		switch {
		case Get(o, "spec", "bootstrap", "initdb") != nil:
			if p := Str(o, "spec", "bootstrap", "initdb", "localeProvider"); p != "builtin" {
				errs = append(errs, fmt.Errorf("%s: locale provider %q, want builtin", o.ID(), p))
			}
		case Get(o, "spec", "bootstrap", "recovery") == nil:
			errs = append(errs, fmt.Errorf("%s: made neither with initdb nor by recovery", o.ID()))
		}
	}
	return errors.Join(errs...)
}

// databaseRestarts: a restart of the database takes seconds, not the
// smart shutdown's default of 180 s that keel, always connected, can never
// end; clients' keepalives free the lease of a keel that vanished; and a
// single instance has no disruption budget, which would forbid draining
// its node for ever (CloudNativePG's "Kubernetes upgrade and
// maintenance").
func databaseRestarts(objs []Object, _ Target) error {
	var errs []error
	for _, o := range objs {
		if o.Kind() != "Cluster" {
			continue
		}
		if t, ok := Get(o, "spec", "smartShutdownTimeout").(int); !ok || t > 30 {
			errs = append(errs, fmt.Errorf("%s: smartShutdownTimeout %v, want 30 s at most", o.ID(), Get(o, "spec", "smartShutdownTimeout")))
		}
		if n, _ := Get(o, "spec", "instances").(int); n <= 1 && Get(o, "spec", "enablePDB") != false {
			errs = append(errs, fmt.Errorf("%s: one instance, and enablePDB is not false: its node could never be drained", o.ID()))
		}
		for _, p := range []string{"tcp_keepalives_idle", "tcp_keepalives_interval", "tcp_keepalives_count"} {
			if Str(o, "spec", "postgresql", "parameters", p) == "" {
				errs = append(errs, fmt.Errorf("%s: %s is not set", o.ID(), p))
			}
		}
	}
	return errors.Join(errs...)
}

// stopTime: the time Kubernetes gives keel's pod to stop leaves room for the
// bell, the final checkpoint, the game connections' closes, and 10 s more.
func stopTime(objs []Object, _ Target) error {
	o := Find(objs, "Deployment", Deployment)
	if o == nil {
		return nil
	}
	bell := config.DefaultBell
	for _, c := range objs {
		if c.Kind() != "ConfigMap" || !isGameConfig(c) {
			continue
		}
		if v := Str(c, "data", "KEEL_BELL"); v != "" {
			d, err := time.ParseDuration(v)
			if err != nil {
				return fmt.Errorf("KEEL_BELL %q: %w", v, err)
			}
			bell = d
		}
	}
	need := bell + config.FinalCheckpointTimeout + config.CloseTimeout + 10*time.Second
	grace, ok := Get(PodSpec(o), "terminationGracePeriodSeconds").(int)
	if !ok || time.Duration(grace)*time.Second < need {
		return fmt.Errorf("terminationGracePeriodSeconds %v, want at least %v: the bell, the final checkpoint, the closes and 10 s",
			Get(PodSpec(o), "terminationGracePeriodSeconds"), need)
	}
	return nil
}

// Privileged are the namespaces whose pods need more than Pod Security's
// restricted profile allows, and the one workload each may hold, of those
// the manifests render: node-exporter (from the monitoring stack's chart)
// and vlagent read the host; Kured reboots it; the upgrade controller's
// jobs replace k3s's binary.
var Privileged = map[string][]string{
	"monitoring-node": {"VLAgent/keel"},
	"kured":           {"DaemonSet/kured"},
	"system-upgrade":  {"Deployment/system-upgrade-controller"},
}

// privilegedBecause is the annotation a privileged namespace says why with.
const privilegedBecause = "keel/privileged-because"

// namespacesRestricted: every namespace the manifests hold enforces Pod
// Security's restricted profile, as the API server's defaults do already:
// the intent is written where the namespace is. Only those of Privileged
// enforce privileged, each saying why, and each holds its own workload
// alone.
func namespacesRestricted(objs []Object, _ Target) error {
	var errs []error
	for _, o := range objs {
		if o.Kind() != "Namespace" {
			continue
		}
		level := Str(o, "metadata", "labels", "pod-security.kubernetes.io/enforce")
		_, may := Privileged[o.Name()]
		switch {
		case may && level == "privileged":
			if Str(o, "metadata", "annotations", privilegedBecause) == "" {
				errs = append(errs, fmt.Errorf("%s is privileged without saying why (%s)", o.ID(), privilegedBecause))
			}
		case level != "restricted":
			errs = append(errs, fmt.Errorf("%s does not enforce pod-security.kubernetes.io/enforce: restricted", o.ID()))
		}
	}
	for _, o := range objs {
		allowed, ok := Privileged[Str(o, "metadata", "namespace")]
		if !ok || (PodSpec(o) == nil && o.Kind() != "VLAgent") || slices.Contains(allowed, o.ID()) {
			continue
		}
		errs = append(errs, fmt.Errorf("%s is in %s, which is privileged for %v alone", o.ID(), Str(o, "metadata", "namespace"), allowed))
	}
	return errors.Join(errs...)
}

// selectsAll is whether a NetworkPolicy selects every pod of its namespace
// for ingress: what no rule of it, or of another, lets in is refused.
func selectsAll(o Object) bool {
	sel, ok := Get(o, "spec", "podSelector").(map[string]any)
	return ok && len(sel) == 0 && slices.Contains(List(o, "spec", "policyTypes"), any("Ingress"))
}

// namespacesFenced: every namespace the manifests hold has, beside it, a
// NetworkPolicy selecting all its pods for ingress.
func namespacesFenced(objs []Object, _ Target) error {
	fenced := map[string]bool{}
	for _, o := range objs {
		if o.Kind() == "NetworkPolicy" && selectsAll(o) {
			fenced[Str(o, "metadata", "namespace")] = true
		}
	}
	var errs []error
	for _, o := range objs {
		if o.Kind() == "Namespace" && !fenced[o.Name()] {
			errs = append(errs, fmt.Errorf("%s has no NetworkPolicy selecting all its pods for ingress", o.ID()))
		}
	}
	return errors.Join(errs...)
}

// internet is the one address range a NetworkPolicy may name: the node's
// own address, the machine's public one, never belongs in the manifests,
// and the cluster's own ranges are named as exceptions to it.
const internet = "0.0.0.0/0"

// ipBlocks: no NetworkPolicy names an address range but the whole
// internet, less exceptions.
func ipBlocks(objs []Object, _ Target) error {
	var errs []error
	for _, o := range objs {
		if o.Kind() != "NetworkPolicy" {
			continue
		}
		for _, dir := range [][2]string{{"ingress", "from"}, {"egress", "to"}} {
			for _, r := range List(o, "spec", dir[0]) {
				for _, peer := range List(r, dir[1]) {
					if b := Get(peer, "ipBlock"); b != nil && Str(b, "cidr") != internet {
						errs = append(errs, fmt.Errorf("%s names the range %s: only %s, with exceptions, is allowed", o.ID(), Str(b, "cidr"), internet))
					}
				}
			}
		}
	}
	return errors.Join(errs...)
}

// The stores production's Secrets come from, and the namespaces that may
// use each: infisical reads keel-cluster, what the accounts workflow
// writes; infisical-backups reads keel-backups, the backups' keys, which
// no workflow may read.
const (
	SecretStore  = "infisical"
	BackupsStore = "infisical-backups"
)

// StoreNamespaces are the namespaces each store serves.
var StoreNamespaces = map[string][]string{
	SecretStore:  {"keel", "cloudflared", "monitoring"},
	BackupsStore: {"keel", "keel-restore"},
}

// secretsFromInfisical: in production, every ExternalSecret reads one of
// the two stores, in a namespace that store serves, and each store serves
// exactly its namespaces; elsewhere there is no store and no
// ExternalSecret.
func secretsFromInfisical(objs []Object, t Target) error {
	var errs []error
	for _, o := range objs {
		switch o.Kind() {
		case "ExternalSecret":
			if !t.Production() {
				errs = append(errs, fmt.Errorf("%s outside production, which alone has a store", o.ID()))
				continue
			}
			store := Str(o, "spec", "secretStoreRef", "name")
			served, ok := StoreNamespaces[store]
			if Str(o, "spec", "secretStoreRef", "kind") != "ClusterSecretStore" || !ok {
				errs = append(errs, fmt.Errorf("%s reads %s/%s, not one of the ClusterSecretStores %s and %s", o.ID(), Str(o, "spec", "secretStoreRef", "kind"), store, SecretStore, BackupsStore))
				continue
			}
			if ns := Str(o, "metadata", "namespace"); !slices.Contains(served, ns) {
				errs = append(errs, fmt.Errorf("%s is in %s, which the store %s does not serve", o.ID(), ns, store))
			}
		case "ClusterSecretStore", "SecretStore":
			want, ok := StoreNamespaces[o.Name()]
			if !t.Production() || o.Kind() != "ClusterSecretStore" || !ok {
				errs = append(errs, fmt.Errorf("%s: production has the ClusterSecretStores %s and %s, and no other cluster any", o.ID(), SecretStore, BackupsStore))
				continue
			}
			conds := List(o, "spec", "conditions")
			var names []string
			for _, n := range List(conds, 0, "namespaces") {
				name, _ := n.(string)
				names = append(names, name)
			}
			slices.Sort(names)
			want = slices.Sorted(slices.Values(want))
			if len(conds) != 1 || len(conds[0].(map[string]any)) != 1 || !slices.Equal(names, want) {
				errs = append(errs, fmt.Errorf("%s: its conditions must name exactly the namespaces %v, by name", o.ID(), want))
			}
		}
	}
	return errors.Join(errs...)
}

// secretNames are the Secrets a pod spec names: in its containers'
// environment and its volumes.
func secretNames(spec map[string]any) []string {
	var names []string
	for _, c := range Containers(spec) {
		for _, e := range List(c, "env") {
			if n := Str(e, "valueFrom", "secretKeyRef", "name"); n != "" {
				names = append(names, n)
			}
		}
		for _, e := range List(c, "envFrom") {
			if n := Str(e, "secretRef", "name"); n != "" {
				names = append(names, n)
			}
		}
	}
	for _, v := range List(spec, "volumes") {
		if n := Str(v, "secret", "secretName"); n != "" {
			names = append(names, n)
		}
	}
	return names
}

// secretsMade: in production, every Secret a workload, the database (its
// owner's and its roles' passwords), an object store or Grafana names is
// made in the cluster, by an ExternalSecret beside it or by CloudNativePG
// (a cluster's CA, <cluster>-ca). Nothing waits for a Secret that nothing
// makes.
func secretsMade(objs []Object, t Target) error {
	if !t.Production() {
		return nil
	}
	made := map[string]bool{}
	for _, o := range objs {
		ns := Str(o, "metadata", "namespace")
		switch o.Kind() {
		case "ExternalSecret":
			name := Str(o, "spec", "target", "name")
			if name == "" {
				name = o.Name()
			}
			made[ns+"/"+name] = true
		case "Cluster":
			made[ns+"/"+o.Name()+"-ca"] = true
		}
	}
	var errs []error
	for _, o := range objs {
		ns := Str(o, "metadata", "namespace")
		var names []string
		if spec := PodSpec(o); spec != nil {
			names = secretNames(spec)
		}
		switch o.Kind() {
		case "Cluster":
			names = append(names, Str(o, "spec", "bootstrap", "initdb", "secret", "name"), Str(o, "spec", "bootstrap", "recovery", "secret", "name"))
			for _, r := range List(o, "spec", "managed", "roles") {
				names = append(names, Str(r, "passwordSecret", "name"))
			}
		case "ObjectStore":
			names = append(names, Str(o, "spec", "configuration", "s3Credentials", "accessKeyId", "name"), Str(o, "spec", "configuration", "s3Credentials", "secretAccessKey", "name"))
		case "HelmRelease":
			grafana := Get(o, "spec", "values", "grafana")
			names = append(names, Str(grafana, "admin", "existingSecret"))
			if env, ok := Get(grafana, "envValueFrom").(map[string]any); ok {
				for _, k := range slices.Sorted(maps.Keys(env)) {
					names = append(names, Str(env[k], "secretKeyRef", "name"))
				}
			}
		}
		for _, n := range names {
			if n != "" && !made[ns+"/"+n] {
				errs = append(errs, fmt.Errorf("%s needs the Secret %s/%s, which no ExternalSecret or operator makes", o.ID(), ns, n))
			}
		}
	}
	return errors.Join(errs...)
}

// The middlewares that limit each player's address, and the header they
// read it from: the address Cloudflare saw.
const (
	rateMiddleware        = "per-address-rate"
	connectionsMiddleware = "per-address-connections"
	addressHeader         = "CF-Connecting-IP"
	gamePath              = "/ws"
)

// routesLimited: every rule of a route to the game's players' listener
// passes through one of the middlewares, keyed on the player's address:
// the game connection, /ws, through the connections one; the rest through
// the rate one. The route has a rule for /ws.
func routesLimited(objs []Object, _ Target) error {
	game := Container(PodSpec(Find(objs, "Deployment", Deployment)), "containers", "keel")
	play := containerPort(game, "play")
	if play == 0 {
		return nil // no game in this entry point
	}
	var errs []error
	for _, name := range []string{rateMiddleware, connectionsMiddleware} {
		m := Find(objs, "Middleware", name)
		crit := Str(m, "spec", "rateLimit", "sourceCriterion", "requestHeaderName") + Str(m, "spec", "inFlightReq", "sourceCriterion", "requestHeaderName")
		if m == nil || crit != addressHeader {
			errs = append(errs, fmt.Errorf("no Middleware %s keyed on %s", name, addressHeader))
		}
	}
	for _, o := range objs {
		if o.Kind() != "HTTPRoute" {
			continue
		}
		hasGame := false
		for i, rule := range List(o, "spec", "rules") {
			toGame := false
			for _, b := range List(rule, "backendRefs") {
				port, _ := Get(b, "port").(int)
				svc := Find(objs, "Service", Str(b, "name"))
				for _, sp := range List(svc, "spec", "ports") {
					if Get(sp, "port") == port && containerPort(game, Get(sp, "targetPort")) == play {
						toGame = true
					}
				}
			}
			if !toGame {
				continue
			}
			isGame := false
			for _, m := range List(rule, "matches") {
				if Str(m, "path", "type") == "Exact" && Str(m, "path", "value") == gamePath {
					isGame = true
				}
			}
			hasGame = hasGame || isGame
			want := rateMiddleware
			if isGame {
				want = connectionsMiddleware
			}
			var got []string
			for _, f := range List(rule, "filters") {
				if Str(f, "type") == "ExtensionRef" && Str(f, "extensionRef", "group") == "traefik.io" && Str(f, "extensionRef", "kind") == "Middleware" {
					got = append(got, Str(f, "extensionRef", "name"))
				}
			}
			if !slices.Equal(got, []string{want}) {
				errs = append(errs, fmt.Errorf("%s: rule %d to the game passes through %v, want %s", o.ID(), i, got, want))
			}
		}
		if o.Name() == "play" && !hasGame {
			errs = append(errs, fmt.Errorf("%s has no rule for %s, the game connection", o.ID(), gamePath))
		}
	}
	return errors.Join(errs...)
}

// PlayHost is the players' host in production.
const PlayHost = "play." + prodDomain

// productionHost: production's Gateway listens for the players' host
// alone, and its routes answer it alone: a request through the tunnel
// for any other host is refused.
func productionHost(objs []Object, t Target) error {
	if !t.Production() {
		return nil
	}
	var errs []error
	for _, o := range objs {
		switch o.Kind() {
		case "Gateway":
			for _, l := range List(o, "spec", "listeners") {
				if h := Str(l, "hostname"); h != PlayHost {
					errs = append(errs, fmt.Errorf("%s: listener %s's hostname is %q, want %s", o.ID(), Str(l, "name"), h, PlayHost))
				}
			}
		case "HTTPRoute":
			if hs := List(o, "spec", "hostnames"); !slices.Equal(hs, []any{PlayHost}) {
				errs = append(errs, fmt.Errorf("%s answers %v, want %s alone", o.ID(), hs, PlayHost))
			}
		}
	}
	return errors.Join(errs...)
}
