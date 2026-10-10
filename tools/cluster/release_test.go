// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
)

const (
	testCommit = "0123456789abcdef0123456789abcdef01234567"
	testBuild  = "0123456789ab"
)

// flux is a cluster as kubectl shows it to tools/cluster: this Mac's name,
// the Secrets a deploy made, and Flux's objects, each answering with the
// next of its states until the last, which it keeps.
type flux struct {
	host string
	// installed is whether the cluster has Flux's kinds at all.
	installed bool
	// states are an object's successive answers to kubectl get, by
	// "<kind>/<name>"; gets counts them.
	states map[string][]string
	gets   map[string]int
	// asked is the reconcile the tool asked the source for.
	asked string
}

func newFlux() *flux {
	return &flux{host: "macbook", installed: true, states: map[string][]string{}, gets: map[string]int{}}
}

// object is a Flux object's JSON: its deletionPolicy, the tag it follows,
// its conditions as "Type=Status reason: message", and its revisions.
// "{asked}" stands for the reconcile the tool asked for.
func object(generation, observed int, handled, applied, artifact, commit string, conditions ...string) string {
	o := map[string]any{
		"metadata": map[string]any{"generation": generation},
		"spec":     map[string]any{"deletionPolicy": "Orphan", "ref": map[string]any{"tag": testBuild}},
	}
	status := map[string]any{"observedGeneration": observed, "lastHandledReconcileAt": handled, "lastAppliedRevision": applied}
	var conds []any
	for _, c := range conditions {
		kind, rest, _ := strings.Cut(c, "=")
		state, why, _ := strings.Cut(rest, " ")
		reason, message, _ := strings.Cut(why, ": ")
		conds = append(conds, map[string]any{"type": kind, "status": state, "reason": reason, "message": message})
	}
	status["conditions"] = conds
	if artifact != "" {
		status["artifact"] = map[string]any{
			"revision": artifact, "digest": artifact[strings.Index(artifact, "@")+1:],
			"metadata": map[string]any{revisionAnnotation: "main@sha1:" + commit},
		}
	}
	o["status"] = status
	b, _ := json.Marshal(o)
	return string(b)
}

func (f *flux) answer(argv []string, _ string) (string, error) {
	joined := strings.Join(argv, " ")
	has := func(words ...string) bool {
		for _, w := range words {
			if !slices.Contains(argv, w) {
				return false
			}
		}
		return true
	}
	switch {
	case has("scutil"):
		return f.host + "\n", nil
	case has("rev-parse"):
		return testBuild + "\n", nil
	case has("docker", "save"):
		// docker save writes the archive the import reads.
		return "", os.WriteFile(argv[slices.Index(argv, "--output")+1], []byte("image"), 0o600)
	case has("get", "crd"):
		if !f.installed {
			return "", nil
		}
		return "customresourcedefinition.apiextensions.k8s.io/" + sourceKind + "\ncustomresourcedefinition.apiextensions.k8s.io/" + layerKind + "\n", nil
	case has("get", "secret", "keel-db-app"):
		return "secret/keel-db-app\n", nil
	case has("get", "secret", "keel-tls"):
		return base64.StdEncoding.EncodeToString([]byte("CERT")), nil
	case has("annotate"):
		_, f.asked, _ = strings.Cut(argv[len(argv)-2], "=")
		return "", nil
	case has("get", sourceKind), has("get", layerKind):
		key := argv[slices.Index(argv, "get")+1] + "/" + argv[slices.Index(argv, "get")+2]
		states := f.states[key]
		if len(states) == 0 {
			return "", nil
		}
		n := min(f.gets[key], len(states)-1)
		f.gets[key]++
		return strings.ReplaceAll(states[n], "{asked}", f.asked), nil
	case strings.Contains(joined, "jsonpath={.spec.template.spec.containers"):
		return "keel:" + testBuild, nil
	}
	return "", nil
}

func fluxCluster(t *testing.T, f *flux) (*cluster, *fakeCommands) {
	t.Helper()
	// From the repository's root, once for a test that makes several.
	if _, err := os.Stat("go.mod"); err != nil {
		chdirRoot(t)
	}
	cmds := &fakeCommands{answer: f.answer}
	return testCluster(t, cmds), cmds
}

// index is the place of the first call holding every word of want, in
// order; -1 if there is none.
func (f *fakeCommands) index(want ...string) int {
	if c := f.ran(want...); c != nil {
		for i := range f.calls {
			if &f.calls[i] == c {
				return i
			}
		}
	}
	return -1
}

// TestFollowRefusesAnotherMac: a release's manifests name one Mac; on
// another, nothing is applied.
func TestFollowRefusesAnotherMac(t *testing.T) {
	f := newFlux()
	f.host = "harbour"
	c, cmds := fluxCluster(t, f)
	_, err := c.follow(t.Context(), testBuild)
	if err == nil || !strings.Contains(err.Error(), "https://macbook.local") || !strings.Contains(err.Error(), "https://harbour.local") {
		t.Fatalf("a release on a Mac named harbour: %v", err)
	}
	if cmds.ran("kubectl") != nil {
		t.Errorf("the cluster was touched: %+v", cmds.calls)
	}
	for _, tag := range []string{"latest", "main", "0123", ""} {
		if _, err := c.follow(t.Context(), tag); err == nil {
			t.Errorf("following the tag %q was accepted", tag)
		}
	}
}

// TestFollowWaitsForEachCondition: the sync is applied with the build as
// its tag, Flux is asked to look, and the tool waits for the source to be
// verified and for each layer, in order, to have applied that release.
// What Flux said before it was asked, or of another release, is not taken
// for an answer.
func TestFollowWaitsForEachCondition(t *testing.T) {
	f := newFlux()
	const old, revision = "prod@sha256:0000", testBuild + "@sha256:abcd"
	f.states[sourceKind+"/"+manifests.Source] = []string{
		// As the last release left it: ready and verified, but another's.
		object(1, 1, "earlier", "", old, testCommit, "Ready=True Succeeded: stored", "SourceVerified=True Succeeded: verified"),
		// The new tag seen, not yet looked at.
		object(2, 1, "earlier", "", old, testCommit, "Ready=True Succeeded: stored", "SourceVerified=True Succeeded: verified"),
		// Looked at, still fetching.
		object(2, 2, "{asked}", "", old, testCommit, "Ready=Unknown Progressing: building artifact", "Reconciling=True Progressing: building artifact"),
		object(2, 2, "{asked}", "", revision, testCommit, "Ready=True Succeeded: stored artifact", "SourceVerified=True Succeeded: verified signature of revision"),
	}
	f.states[layerKind+"/controllers"] = []string{
		object(1, 1, "", old, "", "", "Ready=True ReconciliationSucceeded: applied "+old),
		object(1, 1, "", revision, "", "", "Ready=Unknown Progressing: running health checks"),
		object(1, 1, "", revision, "", "", "Ready=True ReconciliationSucceeded: applied "+revision),
	}
	f.states[layerKind+"/configs"] = []string{
		object(1, 1, "", old, "", "", "Ready=False DependencyNotReady: dependency 'flux-system/controllers' is not ready"),
		object(1, 1, "", revision, "", "", "Ready=True ReconciliationSucceeded: applied "+revision),
	}
	f.states[layerKind+"/apps"] = []string{
		"", // not made yet
		object(1, 0, "", "", "", ""),
		object(2, 1, "", revision, "", "", "Ready=True ReconciliationSucceeded: applied "+revision),
		object(2, 2, "", revision, "", "", "Ready=True ReconciliationSucceeded: applied "+revision),
	}
	c, cmds := fluxCluster(t, f)
	build, err := c.follow(t.Context(), testBuild)
	if err != nil {
		t.Fatal(err)
	}
	if build != testBuild {
		t.Errorf("followed build %q", build)
	}
	for key, states := range f.states {
		if f.gets[key] != len(states) {
			t.Errorf("%s was read %d times, want %d: a state was taken for the answer too soon", key, f.gets[key], len(states))
		}
	}
	applied := cmds.ran("kubectl", "apply", "--server-side", "--field-manager=tools-cluster")
	sync := -1
	for i, call := range cmds.calls {
		if strings.Contains(call.stdin, "kind: OCIRepository") {
			sync = i
			for _, want := range []string{"tag: " + testBuild, "url: oci://" + manifests.ManifestsRepo, "provider: cosign", "name: controllers", "name: configs", "name: apps", "deletionPolicy: Orphan"} {
				if !strings.Contains(call.stdin, want) {
					t.Errorf("the sync applied lacks %q:\n%s", want, call.stdin)
				}
			}
			if strings.Contains(call.stdin, "kind: Deployment") || strings.Contains(call.stdin, "./prod/") {
				t.Errorf("the sync applied holds more than the source and the local layers:\n%s", call.stdin)
			}
		}
	}
	if applied == nil || sync < 0 {
		t.Fatalf("no sync applied: %+v", cmds.calls)
	}
	order := []int{
		sync,
		cmds.index("annotate", sourceKind, manifests.Source, "--overwrite"),
		cmds.index("get", sourceKind, manifests.Source),
		cmds.index("get", layerKind, "controllers"),
		cmds.index("get", layerKind, "configs"),
		cmds.index("get", layerKind, "apps"),
	}
	if slices.Contains(order, -1) || !slices.IsSorted(order) {
		t.Errorf("applied, asked and waited at calls %v, want each after the one before", order)
	}
	if f.asked == "" {
		t.Error("Flux was not asked to look at the source")
	}
	// The game's own manifests come from the artifact, through Flux: the
	// tool applies none of them, nor deletes anything.
	for _, call := range cmds.calls {
		if strings.Contains(call.stdin, "kind: Deployment") || slices.Contains(call.argv, "delete") {
			t.Errorf("the tool ran %v", call.argv)
		}
	}
}

// TestFollowStopsWhenFluxRefuses: a source Flux refuses or cannot fetch
// stops the release at once, with what Flux said. Flux leaves such a
// source marked as never observed (observedGeneration -1), whatever it
// fetched before.
func TestFollowStopsWhenFluxRefuses(t *testing.T) {
	for name, tc := range map[string]struct {
		source, want string
	}{
		"an unsigned artifact": {
			object(1, -1, "{asked}", "", "", "", "Ready=False VerificationError: failed to verify the signature using provider 'cosign keyless': no signatures found", "SourceVerified=False VerificationError: failed to verify the signature using provider 'cosign keyless': no signatures found"),
			"the release was refused by Flux, and nothing of it applied: VerificationError: failed to verify the signature",
		},
		// Refused now, with the release fetched before still on its books.
		"another signer, after a good release": {
			object(2, -1, "{asked}", "", "prod@sha256:0000", testCommit, "Ready=False VerificationError: no matching signatures", "SourceVerified=False VerificationError: no matching signatures"),
			"the release was refused by Flux",
		},
		"a build never released": {
			object(1, -1, "{asked}", "", "", "", "Ready=False OCIArtifactPullFailed: failed to determine artifact digest: MANIFEST_UNKNOWN"),
			"the release could not be fetched by Flux: OCIArtifactPullFailed",
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFlux()
			f.states[sourceKind+"/"+manifests.Source] = []string{tc.source}
			c, cmds := fluxCluster(t, f)
			_, err := c.follow(t.Context(), testBuild)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("follow: %v", err)
			}
			if cmds.ran("-n", manifests.FluxNamespace, "get", layerKind) != nil {
				t.Error("a layer was waited for after the source was refused")
			}
		})
	}
	// A build's tag on an artifact made from another commit.
	f := newFlux()
	f.states[sourceKind+"/"+manifests.Source] = []string{
		object(1, 1, "{asked}", "", testBuild+"@sha256:abcd", "fedcba9876543210fedcba9876543210fedcba98", "Ready=True Succeeded: stored", "SourceVerified=True Succeeded: verified"),
	}
	c, _ := fluxCluster(t, f)
	if _, err := c.follow(t.Context(), testBuild); err == nil || !strings.Contains(err.Error(), "made from build fedcba987654") {
		t.Fatalf("a tag on another commit's artifact: %v", err)
	}
	// What production follows is whatever build it is.
	for _, layer := range localCluster.Entries {
		f.states[layerKind+"/"+layer] = []string{object(1, 1, "", testBuild+"@sha256:abcd", "", "", "Ready=True ReconciliationSucceeded: applied")}
	}
	if build, err := c.follow(t.Context(), manifests.ProdTag); err != nil || build != "fedcba987654" {
		t.Errorf("following prod: %q, %v", build, err)
	}
	// Without Flux, nothing to follow with.
	f = newFlux()
	f.installed = false
	c, cmds := fluxCluster(t, f)
	if _, err := c.follow(t.Context(), testBuild); err == nil || !strings.Contains(err.Error(), "-up first") {
		t.Fatalf("without Flux: %v", err)
	}
	if cmds.ran("apply") != nil {
		t.Error("something was applied without Flux")
	}
}

// followedRelease is a cluster following a release: its source and layers.
func followedRelease() *flux {
	f := newFlux()
	revision := testBuild + "@sha256:abcd"
	f.states[sourceKind+"/"+manifests.Source] = []string{object(1, 1, "t", "", revision, testCommit, "Ready=True Succeeded: stored", "SourceVerified=True Succeeded: verified")}
	for _, layer := range localCluster.Entries {
		f.states[layerKind+"/"+layer] = []string{object(1, 1, "", revision, "", "", "Ready=True ReconciliationSucceeded: applied")}
	}
	return f
}

// TestDeployLetsGoOfTheRelease: a deploy from the working tree deletes
// what -release applied, the layers and then their source, before it
// applies anything, and deletes nothing else.
func TestDeployLetsGoOfTheRelease(t *testing.T) {
	f := followedRelease()
	c, cmds := fluxCluster(t, f)
	if err := c.deployGame(t.Context()); err != nil {
		t.Fatal(err)
	}
	var deleted []string
	firstApply, lastDelete := -1, -1
	for i, call := range cmds.calls {
		switch {
		case slices.Contains(call.argv, "delete"):
			at := slices.Index(call.argv, "delete")
			deleted = append(deleted, strings.Join(call.argv[at+1:at+3], "/"))
			lastDelete = i
			if !slices.Contains(call.argv, manifests.FluxNamespace) {
				t.Errorf("a delete outside %s: %v", manifests.FluxNamespace, call.argv)
			}
		case slices.Contains(call.argv, "apply") && firstApply < 0:
			firstApply = i
		}
	}
	want := []string{layerKind + "/apps", layerKind + "/configs", layerKind + "/controllers", sourceKind + "/" + manifests.Source}
	if !slices.Equal(deleted, want) {
		t.Errorf("deleted %v, want %v", deleted, want)
	}
	if firstApply < 0 || lastDelete > firstApply {
		t.Errorf("the last delete is call %d, the first apply call %d", lastDelete, firstApply)
	}
	game := false
	for _, call := range cmds.calls {
		if strings.Contains(call.stdin, "kind: Deployment") {
			game = strings.Contains(call.stdin, "image: keel:"+testBuild) && strings.Contains(call.stdin, "imagePullPolicy: Never")
		}
	}
	if !game {
		t.Error("the working tree's game was not applied")
	}

	// With no release followed, or no Flux yet, nothing is deleted.
	for _, f := range []*flux{newFlux(), {host: "macbook", states: map[string][]string{}, gets: map[string]int{}}} {
		c, cmds := fluxCluster(t, f)
		if err := c.endRelease(t.Context()); err != nil {
			t.Fatal(err)
		}
		if cmds.ran("delete") != nil {
			t.Errorf("deleted with nothing followed: %+v", cmds.calls)
		}
	}
}

// TestDeployLeavesALayerThatWouldDelete: a layer whose deletion would
// delete what it applied is not deleted, and the deploy stops.
func TestDeployLeavesALayerThatWouldDelete(t *testing.T) {
	f := followedRelease()
	f.states[layerKind+"/apps"] = []string{strings.Replace(f.states[layerKind+"/apps"][0], `"deletionPolicy":"Orphan"`, `"deletionPolicy":"MirrorPrune"`, 1)}
	c, cmds := fluxCluster(t, f)
	err := c.deployGame(t.Context())
	if err == nil || !strings.Contains(err.Error(), "MirrorPrune") || !strings.Contains(err.Error(), "the database") {
		t.Fatalf("a deploy over a layer that prunes: %v", err)
	}
	if cmds.ran("delete") != nil {
		t.Errorf("something was deleted: %+v", cmds.calls)
	}
	for _, call := range cmds.calls {
		if strings.Contains(call.stdin, "kind: Deployment") {
			t.Error("the game was applied over a release still followed")
		}
	}
}

func TestRunning(t *testing.T) {
	ctx := context.Background()
	image := manifests.GameImage + "@sha256:" + strings.Repeat("ab", 32)
	deployment := func(f *flux, image string) func([]string, string) (string, error) {
		return func(argv []string, stdin string) (string, error) {
			if strings.Contains(strings.Join(argv, " "), "jsonpath={.spec.template.spec.containers") {
				return image + "\n", nil
			}
			return f.answer(argv, stdin)
		}
	}
	// A deploy's image says its build.
	c := testCluster(t, &fakeCommands{answer: deployment(newFlux(), "keel:0123456789ab-dirty-20261010T120000Z")})
	if got, err := c.running(ctx); err != nil || got != (running{image: "keel:0123456789ab-dirty-20261010T120000Z", build: "0123456789ab-dirty-20261010T120000Z"}) {
		t.Errorf("a deploy: %+v, %v", got, err)
	}
	// A release's does not: the release followed does.
	c = testCluster(t, &fakeCommands{answer: deployment(followedRelease(), image)})
	if got, err := c.running(ctx); err != nil || got != (running{image: image, build: testBuild, released: true}) {
		t.Errorf("a release: %+v, %v", got, err)
	}
	c = testCluster(t, &fakeCommands{answer: deployment(newFlux(), image)})
	if _, err := c.running(ctx); err == nil || !strings.Contains(err.Error(), "follows no release") {
		t.Errorf("a release's image with no release followed: %v", err)
	}
	for _, other := range []string{"nginx:1.29", "ghcr.io/someone/keel@sha256:" + strings.Repeat("ab", 32), ""} {
		c = testCluster(t, &fakeCommands{answer: deployment(newFlux(), other)})
		if _, err := c.running(ctx); err == nil || !strings.Contains(err.Error(), "not a build of keel") {
			t.Errorf("the image %q: %v", other, err)
		}
	}
}

func TestStrictSchema(t *testing.T) {
	in := `{
	  "description": "A thing.",
	  "type": "object",
	  "properties": {
	    "description": {"type": "string", "description": "The thing's own description."},
	    "properties": {"type": "object", "properties": {"type": {"type": "string"}}},
	    "values": {"type": "object", "x-kubernetes-preserve-unknown-fields": true, "properties": {"known": {"type": "string"}}},
	    "labels": {"type": "object", "additionalProperties": {"type": "string", "description": "A label."}},
	    "open": {"type": "object"},
	    "port": {"anyOf": [{"type": "integer"}, {"type": "string"}], "x-kubernetes-int-or-string": true},
	    "weight": {"type": "integer", "nullable": true, "minimum": 0, "exclusiveMinimum": true, "maximum": 10, "exclusiveMaximum": false},
	    "rules": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
	    "either": {"oneOf": [{"type": "object", "properties": {"a": {"type": "string"}}}, {"type": "object", "properties": {"b": {"type": "string"}}}]}
	  }
	}`
	want := `{
	  "type": "object",
	  "additionalProperties": false,
	  "properties": {
	    "description": {"type": "string"},
	    "properties": {"type": "object", "additionalProperties": false, "properties": {"type": {"type": "string"}}},
	    "values": {"type": "object", "x-kubernetes-preserve-unknown-fields": true, "properties": {"known": {"type": "string"}}},
	    "labels": {"type": "object", "additionalProperties": {"type": "string"}},
	    "open": {"type": "object"},
	    "port": {"anyOf": [{"type": "integer"}, {"type": "string"}], "x-kubernetes-int-or-string": true},
	    "weight": {"type": ["integer", "null"], "exclusiveMinimum": 0, "maximum": 10},
	    "rules": {"type": "array", "items": {"type": "object", "additionalProperties": false, "properties": {"name": {"type": "string"}}, "required": ["name"]}},
	    "either": {"oneOf": [{"type": "object", "additionalProperties": false, "properties": {"a": {"type": "string"}}}, {"type": "object", "additionalProperties": false, "properties": {"b": {"type": "string"}}}]}
	  }
	}`
	var schema, wanted any
	if err := json.Unmarshal([]byte(in), &schema); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &wanted); err != nil {
		t.Fatal(err)
	}
	got, _ := json.MarshalIndent(strictSchema(schema), "", " ")
	exp, _ := json.MarshalIndent(wanted, "", " ")
	if string(got) != string(exp) {
		t.Errorf("the schema:\n%s\nwant:\n%s", got, exp)
	}
}

func TestSchemasWritten(t *testing.T) {
	definition := func(group, kind string, versions ...string) crd {
		var d crd
		d.Metadata.Name = strings.ToLower(kind) + "s." + group
		d.Spec.Group, d.Spec.Names.Kind = group, kind
		for _, v := range versions {
			d.Spec.Versions = append(d.Spec.Versions, struct {
				Name   string `json:"name"`
				Schema struct {
					OpenAPIV3Schema map[string]any `json:"openAPIV3Schema"`
				} `json:"schema"`
			}{Name: v, Schema: struct {
				OpenAPIV3Schema map[string]any `json:"openAPIV3Schema"`
			}{map[string]any{"type": "object", "description": kind + " at " + v, "properties": map[string]any{"spec": map[string]any{"type": "object"}}}}})
		}
		return d
	}
	kinds := []used{{"", "ConfigMap", "v1"}, {"apps", "Deployment", "v1"}, {"example.org", "Boat", "v1"}, {"example.org", "Harbour", "v1beta1"}}
	crds := []crd{definition("example.org", "Boat", "v1alpha1", "v1"), definition("example.org", "Harbour", "v1beta1"), definition("example.org", "Unused", "v1"), definition("other.org", "Boat", "v1")}
	files, err := crdSchemas(kinds, crds)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || files["example.org/boat_v1.json"] == nil || files["example.org/harbour_v1beta1.json"] == nil {
		t.Fatalf("schemas for %v", files)
	}
	boat := string(files["example.org/boat_v1.json"])
	for _, want := range []string{`"additionalProperties": false`, `"$comment": "The schema of Boat example.org/v1, from the definition boats.example.org`} {
		if !strings.Contains(boat, want) {
			t.Errorf("the schema lacks %s:\n%s", want, boat)
		}
	}
	if strings.Contains(boat, "Boat at v1") || !strings.HasSuffix(boat, "}\n") {
		t.Errorf("the schema:\n%s", boat)
	}
	// A version the cluster does not define is no schema at all.
	if _, err := crdSchemas([]used{{"example.org", "Boat", "v2"}}, crds); err == nil || !strings.Contains(err.Error(), "does not define") {
		t.Errorf("a version the cluster lacks: %v", err)
	}

	dir := filepath.Join(t.TempDir(), "schemas")
	written, removed, err := writeSchemas(dir, files)
	if err != nil || len(written) != 2 || len(removed) != 0 {
		t.Fatalf("the first time: wrote %v, removed %v, %v", written, removed, err)
	}
	// Again, nothing changes.
	if written, removed, err := writeSchemas(dir, files); err != nil || len(written)+len(removed) != 0 {
		t.Errorf("the second time: wrote %v, removed %v, %v", written, removed, err)
	}
	// A kind no longer used loses its schema, and a group its folder.
	stale := filepath.Join(dir, "gone.org", "ship_v1.json")
	os.MkdirAll(filepath.Dir(stale), 0o755)
	os.WriteFile(stale, []byte("{}\n"), 0o644)
	files["example.org/boat_v1.json"] = []byte("{}\n")
	written, removed, err = writeSchemas(dir, files)
	if err != nil || !slices.Equal(written, []string{"example.org/boat_v1.json"}) || !slices.Equal(removed, []string{"gone.org/ship_v1.json"}) {
		t.Errorf("after a change: wrote %v, removed %v, %v", written, removed, err)
	}
	if _, err := os.Stat(filepath.Dir(stale)); !os.IsNotExist(err) {
		t.Error("the empty group's folder was left")
	}
}

// TestUsedKinds: the kinds the manifests use, with the custom resources a
// schema is kept for among them.
func TestUsedKinds(t *testing.T) {
	chdirRoot(t)
	tr, err := manifests.ReadTree(clusterDir)
	if err != nil {
		t.Fatal(err)
	}
	kinds, err := usedKinds(tr)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []used{
		{"", "Namespace", "v1"}, {"apps", "Deployment", "v1"},
		{"source.toolkit.fluxcd.io", "OCIRepository", "v1"}, {"kustomize.toolkit.fluxcd.io", "Kustomization", "v1"}, {"helm.toolkit.fluxcd.io", "HelmRelease", "v2"},
		{"postgresql.cnpg.io", "Cluster", "v1"}, {"gateway.networking.k8s.io", "Gateway", "v1"}, {"gateway.networking.k8s.io", "HTTPRoute", "v1"},
		{"traefik.io", "TLSStore", "v1alpha1"}, {"helm.cattle.io", "HelmChartConfig", "v1"},
	} {
		if !slices.Contains(kinds, want) {
			t.Errorf("the manifests' kinds lack %v", want)
		}
	}
	if !slices.IsSortedFunc(kinds, func(a, b used) int { return strings.Compare(fmt.Sprint(a), fmt.Sprint(b)) }) {
		t.Errorf("the kinds are not in order: %v", kinds)
	}
}

// TestRefusalFixtures: the two sources kept to show Flux refusing a
// release are checked exactly as production checks one, so what they show
// is what production would do; and neither can be taken for the release's
// own source, nor for a release.
func TestRefusalFixtures(t *testing.T) {
	for file, wantURL := range map[string]string{
		"refused-unsigned.yaml":     "oci://" + manifests.ManifestsRepo + "-check",
		"refused-other-signer.yaml": "oci://ghcr.io/cloudnative-pg/charts/cloudnative-pg",
	} {
		data, err := os.ReadFile(filepath.Join("testdata", file))
		if err != nil {
			t.Fatal(err)
		}
		var doc map[string]any
		if err := yaml.Unmarshal(data, &doc); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		o := manifests.Object(doc)
		if o.Kind() != "OCIRepository" || o.Name() != strings.TrimSuffix(file, ".yaml") || o.Name() == manifests.Source ||
			manifests.Str(o, "metadata", "namespace") != manifests.FluxNamespace || manifests.Str(o, "spec", "url") != wantURL {
			t.Errorf("%s is %s in %s, from %s", file, o.ID(), manifests.Str(o, "metadata", "namespace"), manifests.Str(o, "spec", "url"))
		}
		ids := manifests.List(o, "spec", "verify", "matchOIDCIdentity")
		if manifests.Str(o, "spec", "verify", "provider") != "cosign" || len(ids) != 1 ||
			manifests.Str(ids[0], "issuer") != manifests.ReleaseIssuer || manifests.Str(ids[0], "subject") != manifests.ReleaseSubject {
			t.Errorf("%s does not check its source as production checks a release: %v", file, manifests.Get(o, "spec", "verify"))
		}
	}
}
