// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
	"sigs.k8s.io/kustomize/api/krusty"
	"sigs.k8s.io/kustomize/api/resmap"
	"sigs.k8s.io/kustomize/kyaml/filesys"
)

// The entry points of the local cluster, applied in this order, each once
// the one before it has settled: Flux's controllers, the charts they
// install, the configuration of those and of k3s's own, and the game.
var entryPoints = []string{"flux-system", "clusters/local/controllers", "clusters/local/configs", "clusters/local/apps"}

// The names the manifests give the game's parts.
const (
	gameImage   = "ghcr.io/daneelvt/keel"
	localImage  = "keel"
	namespace   = "keel"
	deployment  = "keel"
	gatewayName = "keel"
	// defaultHost is the players' host clusters/local names; a deploy
	// replaces it with the Mac's own.
	defaultHost = "macbook.local"
)

// deployment is what a deploy puts into the local entry point: the image's
// tag, the players' host, and keel's scripted sailors, if any.
type deploy struct {
	build, host, sailors string
}

// tree is infra/cluster read into memory, beside the entry points a deploy
// adds, so kustomize renders without writing into the repository.
type tree struct {
	fs filesys.FileSystem
}

// treeRoot is where infra/cluster sits in the tree.
const treeRoot = "/repo/infra/cluster"

// readTree reads dir (infra/cluster) into a tree.
func readTree(dir string) (*tree, error) {
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
	return &tree{fs: mem}, nil
}

// render builds an entry point, a directory under infra/cluster, as Flux's
// kustomize-controller would.
func (t *tree) render(entry string) (resmap.ResMap, error) {
	k := krusty.MakeKustomizer(krusty.MakeDefaultOptions())
	rm, err := k.Run(t.fs, path.Join(treeRoot, entry))
	if err != nil {
		return nil, fmt.Errorf("rendering %s: %w", entry, err)
	}
	return rm, nil
}

// renderApps builds the local game for a deploy: clusters/local/apps with
// the build's image, the players' host and keel's scripted sailors.
func (t *tree) renderApps(d deploy) (resmap.ResMap, error) {
	literals := []string{"KEEL_PLAY_ORIGIN=https://" + d.host}
	if d.sailors != "" {
		literals = append(literals, "KEEL_DEV_SAILORS="+d.sailors)
	}
	k := map[string]any{
		"apiVersion": "kustomize.config.k8s.io/v1beta1",
		"kind":       "Kustomization",
		"resources":  []string{".." + path.Join(treeRoot, "clusters/local/apps")},
		"images":     []map[string]string{{"name": localImage, "newTag": d.build}},
		"configMapGenerator": []map[string]any{{
			"name": "keel", "namespace": namespace, "behavior": "merge", "literals": literals,
		}},
	}
	data, err := yaml.Marshal(k)
	if err != nil {
		return nil, err
	}
	if err := t.fs.WriteFile("/deploy/kustomization.yaml", data); err != nil {
		return nil, err
	}
	k2 := krusty.MakeKustomizer(krusty.MakeDefaultOptions())
	rm, err := k2.Run(t.fs, "/deploy")
	if err != nil {
		return nil, fmt.Errorf("rendering the game for %s: %w", d.build, err)
	}
	return rm, nil
}

// object is one rendered resource, as plain maps.
type object map[string]any

func (o object) kind() string { return str(o, "kind") }
func (o object) name() string { return str(o, "metadata", "name") }
func (o object) id() string   { return o.kind() + "/" + o.name() }

// objects turns a rendered entry point into plain maps.
func objects(rm resmap.ResMap) ([]object, error) {
	var objs []object
	for _, r := range rm.Resources() {
		m, err := r.Map()
		if err != nil {
			return nil, err
		}
		objs = append(objs, m)
	}
	return objs, nil
}

// get walks keys through nested maps; a number walks into a list.
func get(v any, keys ...any) any {
	if o, ok := v.(object); ok {
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

func str(v any, keys ...any) string {
	s, _ := get(v, keys...).(string)
	return s
}

func list(v any, keys ...any) []any {
	l, _ := get(v, keys...).([]any)
	return l
}

// rule is one thing every rendered entry point must keep.
type rule struct {
	name  string
	check func(objs []object, local bool) error
}

// rules are checked on every entry point a deploy applies, and by the
// tests on every entry point.
var rules = []rule{
	{"no Secret in the manifests", noSecrets},
	{"every image pinned by digest", pinnedImages},
	{"keel's Deployment", gameDeployment},
	{"GOMEMLIMIT within the memory limit", memoryLimit},
	{"no route to the internal listener", noInternalRoute},
	{"routes on the Gateway's listeners", routesOnListeners},
	{"the database's access and locale", databaseCluster},
}

// checkRules checks objs against every rule. local is whether they are the
// local cluster's, whose game image is imported rather than pulled.
func checkRules(objs []object, local bool) error {
	var errs []error
	for _, r := range rules {
		if err := r.check(objs, local); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", r.name, err))
		}
	}
	return errors.Join(errs...)
}

func noSecrets(objs []object, _ bool) error {
	for _, o := range objs {
		if o.kind() == "Secret" {
			return fmt.Errorf("%s: Secrets are made in the cluster, never kept in the repository", o.id())
		}
	}
	return nil
}

// podSpec is the pod template of a workload, if o is one.
func podSpec(o object) map[string]any {
	switch o.kind() {
	case "Deployment", "StatefulSet", "DaemonSet", "Job", "ReplicaSet":
		s, _ := get(o, "spec", "template", "spec").(map[string]any)
		return s
	case "Pod":
		s, _ := get(o, "spec").(map[string]any)
		return s
	}
	return nil
}

func containers(spec map[string]any) []map[string]any {
	var cs []map[string]any
	for _, key := range []string{"initContainers", "containers"} {
		for _, c := range list(spec, key) {
			if m, ok := c.(map[string]any); ok {
				cs = append(cs, m)
			}
		}
	}
	return cs
}

func pinned(image string) bool {
	_, digest, ok := strings.Cut(image, "@sha256:")
	return ok && len(digest) == 64
}

// pinnedImages: every image a workload, the database or a chart names is
// pinned by digest; only the game's own, on the local cluster, is a tag the
// node already holds.
func pinnedImages(objs []object, local bool) error {
	var errs []error
	for _, o := range objs {
		if spec := podSpec(o); spec != nil {
			for _, c := range containers(spec) {
				img, _ := c["image"].(string)
				if local && o.id() == "Deployment/"+deployment && strings.HasPrefix(img, localImage+":") {
					if c["imagePullPolicy"] != "Never" {
						errs = append(errs, fmt.Errorf("%s: %s is imported, so imagePullPolicy must be Never", o.id(), img))
					}
					continue
				}
				if !pinned(img) {
					errs = append(errs, fmt.Errorf("%s: %q is not pinned by digest", o.id(), img))
				}
			}
		}
		switch o.kind() {
		case "Cluster":
			if img := str(o, "spec", "imageName"); !pinned(img) {
				errs = append(errs, fmt.Errorf("%s: %q is not pinned by digest", o.id(), img))
			}
		case "HelmRelease":
			if tag := str(o, "spec", "values", "image", "tag"); !pinned(tag) {
				errs = append(errs, fmt.Errorf("%s: the chart's image tag %q is not pinned by digest", o.id(), tag))
			}
		case "OCIRepository":
			if d := str(o, "spec", "ref", "digest"); !strings.HasPrefix(d, "sha256:") || len(d) != 71 {
				errs = append(errs, fmt.Errorf("%s: not pinned by digest", o.id()))
			}
		}
	}
	return errors.Join(errs...)
}

func find(objs []object, kind, name string) object {
	for _, o := range objs {
		if o.kind() == kind && o.name() == name {
			return o
		}
	}
	return nil
}

func container(spec map[string]any, key, name string) map[string]any {
	for _, c := range list(spec, key) {
		if m, ok := c.(map[string]any); ok && m["name"] == name {
			return m
		}
	}
	return nil
}

// internalPort is the port KEEL_INTERNAL_ADDR names, from keel's
// ConfigMap.
func internalPort(objs []object) (int, error) {
	for _, o := range objs {
		if o.kind() != "ConfigMap" || !strings.HasPrefix(o.name(), "keel") {
			continue
		}
		if addr := str(o, "data", "KEEL_INTERNAL_ADDR"); addr != "" {
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
		for _, cp := range list(c, "ports") {
			if get(cp, "name") == p {
				n, _ := get(cp, "containerPort").(int)
				return n
			}
		}
	}
	return 0
}

// gameDeployment: one replica replaced, not rolled; the schema migrated
// first; probes on the internal listener; the restricted security context.
func gameDeployment(objs []object, _ bool) error {
	o := find(objs, "Deployment", deployment)
	if o == nil {
		return nil
	}
	var errs []error
	fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }
	if r, _ := get(o, "spec", "replicas").(int); r != 1 {
		fail("replicas %v, want 1: one process holds the world", get(o, "spec", "replicas"))
	}
	if s := str(o, "spec", "strategy", "type"); s != "Recreate" {
		fail("strategy %q, want Recreate", s)
	}
	spec := podSpec(o)
	if get(spec, "automountServiceAccountToken") != false {
		fail("automountServiceAccountToken is not false")
	}
	pod, _ := get(spec, "securityContext").(map[string]any)
	if get(pod, "runAsNonRoot") != true || get(pod, "runAsUser") != 65532 || str(pod, "seccompProfile", "type") != "RuntimeDefault" {
		fail("the pod's security context %v: want runAsNonRoot, runAsUser 65532, seccomp RuntimeDefault", pod)
	}
	migrate := container(spec, "initContainers", "migrate")
	if migrate == nil || !slices.Equal(list(migrate, "args"), []any{"migrate"}) {
		fail("no init container running keel migrate")
	}
	game := container(spec, "containers", "keel")
	if game == nil {
		fail("no container keel")
		return errors.Join(errs...)
	}
	internal, err := internalPort(objs)
	if err != nil {
		fail("%v", err)
	}
	for probe, want := range map[string]string{"livenessProbe": "/livez", "readinessProbe": "/readyz"} {
		p := str(game, probe, "httpGet", "path")
		port := containerPort(game, get(game, probe, "httpGet", "port"))
		if p != want || port != internal {
			fail("%s is %s on port %d, want %s on the internal listener's %d", probe, p, port, want, internal)
		}
	}
	for _, c := range []map[string]any{migrate, game} {
		if c == nil {
			continue
		}
		sc, _ := c["securityContext"].(map[string]any)
		if get(sc, "allowPrivilegeEscalation") != false || get(sc, "readOnlyRootFilesystem") != true ||
			!slices.Equal(list(sc, "capabilities", "drop"), []any{"ALL"}) {
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
func memoryLimit(objs []object, _ bool) error {
	o := find(objs, "Deployment", deployment)
	if o == nil {
		return nil
	}
	game := container(podSpec(o), "containers", "keel")
	limit, err := quantity(str(game, "resources", "limits", "memory"))
	if err != nil || limit == 0 {
		return fmt.Errorf("no memory limit (%v)", err)
	}
	for _, e := range list(game, "env") {
		if get(e, "name") != "GOMEMLIMIT" {
			continue
		}
		v := str(e, "value")
		goLimit, err := quantity(v)
		if err != nil {
			return fmt.Errorf("GOMEMLIMIT %q: %w", v, err)
		}
		if share := float64(goLimit) / float64(limit); share < 0.80 || share > 0.95 {
			return fmt.Errorf("GOMEMLIMIT %s is %.0f%% of the limit %s, want 80%% to 95%%", v, share*100, str(game, "resources", "limits", "memory"))
		}
		return nil
	}
	return errors.New("no GOMEMLIMIT")
}

// noInternalRoute: no route reaches keel's internal listener, through any
// port of its Service.
func noInternalRoute(objs []object, _ bool) error {
	internal, err := internalPort(objs)
	if err != nil {
		return nil // no game in this entry point
	}
	game := container(podSpec(find(objs, "Deployment", deployment)), "containers", "keel")
	var errs []error
	for _, o := range objs {
		if o.kind() != "HTTPRoute" {
			continue
		}
		for _, rule := range list(o, "spec", "rules") {
			for _, b := range list(rule, "backendRefs") {
				port, _ := get(b, "port").(int)
				svc := find(objs, "Service", str(b, "name"))
				target := port
				for _, sp := range list(svc, "spec", "ports") {
					if get(sp, "port") == port {
						target = containerPort(game, get(sp, "targetPort"))
					}
				}
				if port == internal || target == internal {
					errs = append(errs, fmt.Errorf("%s reaches %s:%d, the internal listener", o.id(), str(b, "name"), port))
				}
			}
		}
	}
	return errors.Join(errs...)
}

// routesOnListeners: each route names a listener of the game's Gateway, an
// HTTPS listener has a certificate, and a route's hostnames are its
// listener's.
func routesOnListeners(objs []object, _ bool) error {
	gw := find(objs, "Gateway", gatewayName)
	var errs []error
	listeners := map[string]map[string]any{}
	for _, l := range list(gw, "spec", "listeners") {
		m, _ := l.(map[string]any)
		listeners[str(m, "name")] = m
		if str(m, "protocol") == "HTTPS" && len(list(m, "tls", "certificateRefs")) == 0 {
			errs = append(errs, fmt.Errorf("listener %s is HTTPS with no certificate", str(m, "name")))
		}
	}
	for _, o := range objs {
		if o.kind() != "HTTPRoute" {
			continue
		}
		parents := list(o, "spec", "parentRefs")
		if len(parents) == 0 {
			errs = append(errs, fmt.Errorf("%s has no parent", o.id()))
		}
		for _, p := range parents {
			l, ok := listeners[str(p, "sectionName")]
			if str(p, "name") != gatewayName || !ok {
				errs = append(errs, fmt.Errorf("%s names %s/%s, not a listener of the Gateway %s", o.id(), str(p, "name"), str(p, "sectionName"), gatewayName))
				continue
			}
			want := str(l, "hostname")
			for _, h := range list(o, "spec", "hostnames") {
				if want != "" && h != want {
					errs = append(errs, fmt.Errorf("%s: hostname %v is not its listener's %s", o.id(), h, want))
				}
			}
		}
	}
	return errors.Join(errs...)
}

// databaseCluster: only TLS connections, no superuser, a locale that never
// changes under an index.
func databaseCluster(objs []object, _ bool) error {
	var errs []error
	for _, o := range objs {
		if o.kind() != "Cluster" {
			continue
		}
		if !slices.Contains(list(o, "spec", "postgresql", "pg_hba"), any("hostnossl all all all reject")) {
			errs = append(errs, fmt.Errorf("%s: pg_hba does not refuse connections without TLS", o.id()))
		}
		if get(o, "spec", "enableSuperuserAccess") != false {
			errs = append(errs, fmt.Errorf("%s: superuser access is not off", o.id()))
		}
		if p := str(o, "spec", "bootstrap", "initdb", "localeProvider"); p != "builtin" {
			errs = append(errs, fmt.Errorf("%s: locale provider %q, want builtin", o.id(), p))
		}
	}
	return errors.Join(errs...)
}
