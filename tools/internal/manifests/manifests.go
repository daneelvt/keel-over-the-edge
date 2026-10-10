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
// they apply, in order: each once the one before it is ready.
var Layers = []string{"flux-system", "controllers", "configs", "apps"}

// Cluster is a cluster a release holds manifests for.
type Cluster struct {
	Name string
	// Entries are its entry points, folders of infra/cluster/clusters/<Name>,
	// in the order they are applied.
	Entries []string
}

// Clusters are the clusters of a release. The local one has no flux-system:
// tools/cluster installs Flux's controllers there itself.
var Clusters = []Cluster{
	{"local", []string{"controllers", "configs", "apps"}},
	{"prod", []string{"flux-system", "controllers", "configs", "apps"}},
}

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
// cluster's game: the image's tag, the players' host, and keel's scripted
// sailors, if any.
type Deploy struct {
	Build, Host, Sailors string
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
// written beside the tree.
func (t *Tree) over(entry string, k map[string]any) (resmap.ResMap, error) {
	k["apiVersion"] = "kustomize.config.k8s.io/v1beta1"
	k["kind"] = "Kustomization"
	k["resources"] = []string{".." + path.Join(treeRoot, entry)}
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

// RenderDeploy builds the local game for a deploy from the working tree:
// clusters/local/apps with the image tools/cluster built and imported, the
// players' host and keel's scripted sailors.
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
	return t.over(Clusters[0].Entry("apps"), map[string]any{
		"images": []map[string]string{{"name": GameImage, "newName": LocalImage, "newTag": d.Build}},
		"configMapGenerator": []map[string]any{{
			"name": "keel", "namespace": Namespace, "behavior": "merge", "literals": literals,
		}},
		"patches": []map[string]any{{"patch": string(patch)}},
	})
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
	// Cluster is the cluster's name, "local" or "prod".
	Cluster string
	// Deploy is whether tools/cluster rendered it from the working tree,
	// with the game's image built and imported rather than pulled.
	Deploy bool
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
	{"routes on the Gateway's listeners", routesOnListeners},
	{"the database's access and locale", databaseCluster},
	{"the database's restarts", databaseRestarts},
	{"keel's time to stop", stopTime},
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

// pinnedImages: every image a workload, the database or a chart names is
// pinned by digest, the game's own included; only a deploy from the
// working tree names it by a tag the node already holds.
func pinnedImages(objs []Object, t Target) error {
	var errs []error
	for _, o := range objs {
		if spec := PodSpec(o); spec != nil {
			for _, c := range Containers(spec) {
				img, _ := c["image"].(string)
				if t.Deploy && o.ID() == "Deployment/"+Deployment && strings.HasPrefix(img, LocalImage+":") {
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
		switch o.Kind() {
		case "Cluster":
			if img := Str(o, "spec", "imageName"); !byDigest(img) {
				errs = append(errs, fmt.Errorf("%s: %q is not pinned by digest", o.ID(), img))
			}
		case "HelmRelease":
			if tag := Str(o, "spec", "values", "image", "tag"); !byDigest(tag) {
				errs = append(errs, fmt.Errorf("%s: the chart's image tag %q is not pinned by digest", o.ID(), tag))
			}
		case "OCIRepository":
			if d := Str(o, "spec", "ref", "digest"); !isRelease(o) && (!strings.HasPrefix(d, "sha256:") || len(d) != 71) {
				errs = append(errs, fmt.Errorf("%s: not pinned by digest", o.ID()))
			}
		}
	}
	return errors.Join(errs...)
}

// verifiedSources: Flux fetches from an OCI repository only what its
// signature allows: checked with cosign, keyless, against identities whose
// patterns match the certificate's issuer and subject whole. The release's
// own source follows a build or the tag production follows, and accepts
// the release workflow alone.
func verifiedSources(objs []Object, _ Target) error {
	var errs []error
	for _, o := range objs {
		if o.Kind() != "OCIRepository" {
			continue
		}
		fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(o.ID()+": "+format, a...)) }
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
// cluster, each named after its layer, each once the layer before it is
// ready, and wait until what they applied is healthy. They remove what a
// release no longer holds, and nothing at all when one of them is deleted.
// The first of production's holds the others, so waits for Flux's
// controllers alone, each by name.
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
	before := ""
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
		if want := strings.Fields(before); !slices.Equal(deps, want) {
			fail("dependsOn %v, want %v, the layer before it", deps, want)
		}
		before = layer
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
		case t.Cluster == "prod" && strings.HasSuffix(host, localSuffix):
			errs = append(errs, fmt.Errorf("%s names %s, a local host, in production", o.ID(), host))
		case t.Cluster != "prod" && (host == prodDomain || strings.HasSuffix(host, "."+prodDomain)):
			errs = append(errs, fmt.Errorf("%s names %s, production's, outside production", o.ID(), host))
		}
	}
	for _, o := range objs {
		switch o.Kind() {
		case "ConfigMap":
			origin := Str(o, "data", "KEEL_PLAY_ORIGIN")
			if strings.HasPrefix(o.Name(), "keel") && !strings.HasPrefix(origin, "https://") {
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

// PlayOrigin is the origin players reach the game at, from keel's
// ConfigMap, or "".
func PlayOrigin(objs []Object) string {
	for _, o := range objs {
		if o.Kind() == "ConfigMap" && strings.HasPrefix(o.Name(), "keel") {
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
		if o.Kind() != "ConfigMap" || !strings.HasPrefix(o.Name(), "keel") {
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
// changes under an index.
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
		if p := Str(o, "spec", "bootstrap", "initdb", "localeProvider"); p != "builtin" {
			errs = append(errs, fmt.Errorf("%s: locale provider %q, want builtin", o.ID(), p))
		}
	}
	return errors.Join(errs...)
}

// databaseRestarts: a restart of the database takes seconds, not the
// smart shutdown's default of 180 s that keel, always connected, can never
// end; and clients' keepalives free the lease of a keel that vanished.
func databaseRestarts(objs []Object, _ Target) error {
	var errs []error
	for _, o := range objs {
		if o.Kind() != "Cluster" {
			continue
		}
		if t, ok := Get(o, "spec", "smartShutdownTimeout").(int); !ok || t > 30 {
			errs = append(errs, fmt.Errorf("%s: smartShutdownTimeout %v, want 30 s at most", o.ID(), Get(o, "spec", "smartShutdownTimeout")))
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
		if c.Kind() != "ConfigMap" || !strings.HasPrefix(c.Name(), "keel") {
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
