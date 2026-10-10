// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
)

const image = manifests.GameImage + "@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// chdirRoot runs the test from the repository's root, as the tool runs.
func chdirRoot(t *testing.T) {
	t.Helper()
	t.Chdir("../..")
}

// TestRenderWritesTheRelease: every cluster's entry points, one file each,
// with the game and its migration running the image given, by digest.
func TestRenderWritesTheRelease(t *testing.T) {
	chdirRoot(t)
	dir := filepath.Join(t.TempDir(), "manifests")
	var out bytes.Buffer
	if err := render(context.Background(), &out, dir, image); err != nil {
		t.Fatal(err)
	}
	var got []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(dir, p)
			got = append(got, filepath.ToSlash(rel))
		}
		return err
	})
	want := []string{
		"local/apps/manifests.yaml", "local/configs/manifests.yaml", "local/controllers/manifests.yaml",
		"prod/apps/manifests.yaml", "prod/configs/manifests.yaml", "prod/controllers/manifests.yaml", "prod/flux-system/manifests.yaml",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("rendered %v, want %v", got, want)
	}
	for _, cluster := range []string{"local", "prod"} {
		docs := documents(t, filepath.Join(dir, cluster, "apps", "manifests.yaml"))
		images := 0
		for _, d := range docs {
			if d.Kind() != "Deployment" {
				continue
			}
			for _, c := range manifests.Containers(manifests.PodSpec(d)) {
				images++
				if c["image"] != image {
					t.Errorf("%s: container %s runs %v", cluster, c["name"], c["image"])
				}
			}
		}
		if images != 2 {
			t.Errorf("%s: %d containers of the game's, want keel and its migration", cluster, images)
		}
	}
	// Production's first layer holds what Flux follows; the local cluster
	// has none, and the hosts are each cluster's own.
	sync := documents(t, filepath.Join(dir, "prod", "flux-system", "manifests.yaml"))
	if s := manifests.Find(sync, "OCIRepository", manifests.Source); manifests.Str(s, "spec", "ref", "tag") != manifests.ProdTag {
		t.Errorf("production follows %v", manifests.Get(s, "spec", "ref"))
	}
	if o := manifests.PlayOrigin(documents(t, filepath.Join(dir, "prod", "apps", "manifests.yaml"))); o != "https://play.keelovertheedge.com" {
		t.Errorf("production's origin %q", o)
	}
	if o := manifests.PlayOrigin(documents(t, filepath.Join(dir, "local", "apps", "manifests.yaml"))); o != "https://macbook.local" {
		t.Errorf("the local cluster's origin %q", o)
	}
	if !strings.Contains(out.String(), "every object keeps the rules and its schema") {
		t.Errorf("render said:\n%s", out.String())
	}

	// Into a folder that holds anything, nothing is rendered.
	if err := render(context.Background(), io.Discard, dir, image); err == nil || !strings.Contains(err.Error(), "not empty") {
		t.Errorf("rendering over a release: %v", err)
	}
}

func documents(t *testing.T, file string) []manifests.Object {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var docs []manifests.Object
	dec := yaml.NewDecoder(bytes.NewReader(data))
	for {
		var d map[string]any
		if err := dec.Decode(&d); errors.Is(err, io.EOF) {
			return docs
		} else if err != nil {
			t.Fatal(err)
		}
		docs = append(docs, d)
	}
}

// TestRenderLeavesNothingThatFailed: with an image that is no digest, or
// none, nothing is written to publish.
func TestRenderLeavesNothingThatFailed(t *testing.T) {
	chdirRoot(t)
	for _, bad := range []string{"", manifests.GameImage + ":0123456789ab", manifests.GameImage + ":latest", "ghcr.io/someone/keel@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"} {
		dir := t.TempDir()
		if err := render(context.Background(), io.Discard, dir, bad); err == nil {
			t.Errorf("rendered with the image %q", bad)
		}
		if left, _ := os.ReadDir(dir); len(left) != 0 {
			t.Errorf("the image %q left %v", bad, left)
		}
	}
}

// TestWorkflowsVerifyAsFluxDoes: the release and promote workflows check a
// signature against the very patterns Flux matches, the manifests' own.
func TestWorkflowsVerifyAsFluxDoes(t *testing.T) {
	data, err := os.ReadFile("../../.github/workflows/release.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var w struct {
		Env map[string]string `yaml:"env"`
	}
	if err := yaml.Unmarshal(data, &w); err != nil {
		t.Fatal(err)
	}
	if w.Env["SIGNER_ISSUER"] != manifests.ReleaseIssuer || w.Env["SIGNER_IDENTITY"] != manifests.ReleaseSubject {
		t.Errorf("release.yaml verifies with issuer %q and identity %q, Flux with %q and %q", w.Env["SIGNER_ISSUER"], w.Env["SIGNER_IDENTITY"], manifests.ReleaseIssuer, manifests.ReleaseSubject)
	}
	if w.Env["IMAGE"] != manifests.GameImage || w.Env["MANIFESTS"] != manifests.ManifestsRepo {
		t.Errorf("release.yaml publishes %q and %q, the manifests name %q and %q", w.Env["IMAGE"], w.Env["MANIFESTS"], manifests.GameImage, manifests.ManifestsRepo)
	}
	// The identity is this workflow's own file, on main.
	if !strings.Contains(manifests.ReleaseSubject, `/\.github/workflows/release\.yaml@refs/heads/main$`) {
		t.Errorf("the signer %s is not release.yaml on main", manifests.ReleaseSubject)
	}
}

// fakeRegistry is a registry with a token service, as GHCR is: a manifest
// is served only with the token the service gives.
type fakeRegistry struct {
	*httptest.Server
	// manifests are the bodies served, by "<repo>:<tag>".
	manifests map[string][]byte
	// refuse makes the token service refuse a token, as GHCR does for a
	// package that is not there.
	refuse bool
	// auth is the Authorization header the token service last saw.
	auth string
}

func newRegistry(t *testing.T) *fakeRegistry {
	t.Helper()
	f := &fakeRegistry{manifests: map[string][]byte{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /token", func(w http.ResponseWriter, r *http.Request) {
		f.auth = r.Header.Get("Authorization")
		if f.refuse || !strings.HasPrefix(r.URL.Query().Get("scope"), "repository:") || !strings.HasSuffix(r.URL.Query().Get("scope"), ":pull") {
			http.Error(w, `{"errors":[{"code":"DENIED"}]}`, http.StatusForbidden)
			return
		}
		fmt.Fprint(w, `{"token":"a-token"}`)
	})
	mux.HandleFunc("GET /v2/{owner}/{name}/manifests/{ref}", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer a-token" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="`+f.URL+`/token",service="registry.test",scope="repository:user/image:pull"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		repo, ref := r.PathValue("owner")+"/"+r.PathValue("name"), r.PathValue("ref")
		body, ok := f.manifests[repo+":"+ref]
		if !ok {
			for _, m := range f.manifests {
				if digestOf(m) == ref {
					body, ok = m, true
				}
			}
		}
		if !ok {
			http.Error(w, `{"errors":[{"code":"MANIFEST_UNKNOWN"}]}`, http.StatusNotFound)
			return
		}
		w.Header().Set("Docker-Content-Digest", digestOf(body))
		w.Write(body)
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

func digestOf(body []byte) string {
	sum := sha256.Sum256(body)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// put publishes a release's manifests made from commit under tag, and
// returns their digest. extra tells two artifacts of one commit apart.
func (f *fakeRegistry) put(repo, tag, commit, extra string) string {
	body, _ := json.Marshal(map[string]any{
		"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
		"annotations": map[string]string{revisionAnnotation: "main@sha1:" + commit, "org.opencontainers.image.source": "https://github.com/daneelvt/keel-over-the-edge", "extra": extra},
	})
	f.manifests[repo+":"+tag] = body
	return digestOf(body)
}

func TestRegistryResolves(t *testing.T) {
	f := newRegistry(t)
	const repo = "daneelvt/keel-manifests"
	digest := f.put(repo, "0123456789ab", commitA, "")
	r := &registry{base: f.URL, user: "someone", password: "a-password", hc: f.Client()}
	ctx := context.Background()

	a, found, err := r.resolve(ctx, repo, "0123456789ab")
	if err != nil || !found || a.digest != digest || a.annotations[revisionAnnotation] != "main@sha1:"+commitA {
		t.Fatalf("a tag: %+v, %v, %v", a, found, err)
	}
	if f.auth == "" || !strings.HasPrefix(f.auth, "Basic ") {
		t.Errorf("the token service saw the credentials %q", f.auth)
	}
	if a, found, err := r.resolve(ctx, repo, digest); err != nil || !found || a.digest != digest {
		t.Errorf("a digest: %+v, %v, %v", a, found, err)
	}
	if _, found, err := r.resolve(ctx, repo, "fedcba987654"); err != nil || found {
		t.Errorf("a tag that is not there: %v, %v", found, err)
	}
	// With no credentials, none are sent.
	anyone := &registry{base: f.URL, hc: f.Client()}
	if _, found, err := anyone.resolve(ctx, repo, "0123456789ab"); err != nil || !found || f.auth != "" {
		t.Errorf("as anyone: %v, %v, credentials %q", found, err, f.auth)
	}
	// A package that is not there: the token service refuses.
	f.refuse = true
	if _, found, err := r.resolve(ctx, "daneelvt/nothing", "0123456789ab"); err != nil || found {
		t.Errorf("a package that is not there: %v, %v", found, err)
	}
}

func TestRegistryRefuses(t *testing.T) {
	ctx := context.Background()
	for name, handler := range map[string]http.HandlerFunc{
		"an error of the registry's": func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
		},
		"a manifest that is not the digest it says": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Docker-Content-Digest", "sha256:"+strings.Repeat("0", 64))
			io.WriteString(w, `{"schemaVersion":2}`)
		},
		"what is not a manifest": func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "<html>") },
		"a token service elsewhere": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="https://tokens.example.org/token",service="registry.test"`)
			w.WriteHeader(http.StatusUnauthorized)
		},
		"a challenge that names no token service": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("WWW-Authenticate", `Basic realm="registry"`)
			w.WriteHeader(http.StatusUnauthorized)
		},
	} {
		srv := httptest.NewServer(handler)
		r := &registry{base: srv.URL, user: "someone", password: "a-password", hc: srv.Client()}
		if _, found, err := r.resolve(ctx, "daneelvt/keel-manifests", "0123456789ab"); err == nil || found {
			t.Errorf("%s: found %v, %v", name, found, err)
		}
		srv.Close()
	}
}

// reviewed is the production environment as GitHub shows it with its
// reviewer.
const reviewed = `{"name":"production","protection_rules":[{"type":"required_reviewers","prevent_self_review":false,"reviewers":[{"type":"User","reviewer":{"id":42}}]},{"type":"branch_policy"}]}`

// Three commits of main, each after the one before, and one not on it.
const (
	commitA = "aaaaaaaaaaaa0000000000000000000000000001"
	commitB = "bbbbbbbbbbbb0000000000000000000000000002"
	commitC = "cccccccccccc0000000000000000000000000003"
	offMain = "dddddddddddd0000000000000000000000000004"
	buildA  = "aaaaaaaaaaaa"
	buildB  = "bbbbbbbbbbbb"
	buildC  = "cccccccccccc"
)

// world is a registry of releases, GitHub's view of the commits, and
// cosign and flux as the promoter runs them.
type world struct {
	reg *fakeRegistry
	// unsigned are the digests cosign does not verify.
	unsigned map[string]bool
	// environment is GitHub's answer for the production environment; "",
	// that there is none.
	environment string
	ran         []string
	summary     bytes.Buffer
	p           *promoter
}

func newWorld(t *testing.T) *world {
	t.Helper()
	w := &world{reg: newRegistry(t), unsigned: map[string]bool{}, environment: reviewed}
	order := map[string]int{"main": 3, commitA: 1, commitB: 2, commitC: 3}
	github := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/daneelvt/keel-over-the-edge/environments/production" {
			if w.environment == "" {
				http.NotFound(rw, r)
				return
			}
			io.WriteString(rw, w.environment)
			return
		}
		spec, ok := strings.CutPrefix(r.URL.Path, "/repos/daneelvt/keel-over-the-edge/compare/")
		base, head, cut := strings.Cut(spec, "...")
		if !ok || !cut {
			http.NotFound(rw, r)
			return
		}
		b, okBase := order[base]
		h, okHead := order[head]
		status := "diverged"
		switch {
		case !okBase || !okHead:
		case h > b:
			status = "ahead"
		case h < b:
			status = "behind"
		default:
			status = "identical"
		}
		fmt.Fprintf(rw, `{"status":%q}`, status)
	}))
	t.Cleanup(github.Close)
	_, repo, _ := strings.Cut(manifests.ManifestsRepo, "/")
	w.p = &promoter{
		out: io.Discard, repo: repo, hc: http.DefaultClient,
		reg: &registry{base: w.reg.URL, hc: http.DefaultClient},
		api: github.URL, code: "daneelvt/keel-over-the-edge", summary: &w.summary,
		run: func(_ context.Context, name string, args ...string) ([]byte, error) {
			w.ran = append(w.ran, name+" "+strings.Join(args, " "))
			ref := args[len(args)-1]
			switch {
			case name == "cosign" && args[0] == "verify":
				_, digest, _ := strings.Cut(ref, "@")
				if w.unsigned[digest] {
					return nil, errors.New("cosign verify: no signatures found")
				}
				return nil, nil
			case name == "flux" && slices.Equal(args[:2], []string{"tag", "artifact"}):
				// flux tag artifact oci://<repo>@<digest> --tag <tag>
				_, digest, _ := strings.Cut(args[2], "@")
				for _, m := range w.reg.manifests {
					if digestOf(m) == digest {
						w.reg.manifests[repo+":"+args[4]] = m
						return nil, nil
					}
				}
				return nil, errors.New("flux tag artifact: not found")
			}
			return nil, fmt.Errorf("unexpected: %s %v", name, args)
		},
	}
	return w
}

// release publishes a signed release of commit, and returns its digest.
func (w *world) release(commit string) string {
	return w.reg.put(w.p.repo, commit[:12], commit, "")
}

// prod is the digest production follows; "" if none.
func (w *world) prod() string {
	if m, ok := w.reg.manifests[w.p.repo+":"+manifests.ProdTag]; ok {
		return digestOf(m)
	}
	return ""
}

func (w *world) tagged() bool {
	return slices.ContainsFunc(w.ran, func(c string) bool { return strings.HasPrefix(c, "flux tag") })
}

func TestPromote(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	a, b, c := w.release(commitA), w.release(commitB), w.release(commitC)

	// The first promotion: production follows nothing yet.
	if err := w.p.promote(ctx, buildB, false); err != nil {
		t.Fatal(err)
	}
	if w.prod() != b {
		t.Fatalf("production follows %s, want build B's %s", w.prod(), b)
	}
	verify := "cosign verify --certificate-oidc-issuer-regexp " + manifests.ReleaseIssuer + " --certificate-identity-regexp " + manifests.ReleaseSubject + " " + manifests.ManifestsRepo + "@" + b
	tag := "flux tag artifact oci://" + manifests.ManifestsRepo + "@" + b + " --tag prod"
	if !slices.Equal(w.ran, []string{verify, tag}) {
		t.Errorf("ran %q, want the signature checked as Flux checks it, then the tag moved by digest", w.ran)
	}
	if s := w.summary.String(); !strings.Contains(s, "Production follows build `"+buildB+"`") || !strings.Contains(s, "| Before | none") || !strings.Contains(s, b) {
		t.Errorf("the summary:\n%s", s)
	}

	// A newer build moves it on.
	w.summary.Reset()
	if err := w.p.promote(ctx, buildC, false); err != nil || w.prod() != c {
		t.Fatalf("a newer build: %v; production follows %s", err, w.prod())
	}
	if s := w.summary.String(); !strings.Contains(s, "| Before | `"+buildB+"` | "+commitB) || !strings.Contains(s, "| Now | `"+buildC+"` | "+commitC) {
		t.Errorf("the summary:\n%s", s)
	}

	// An older one is refused, unless a rollback is meant.
	w.ran = nil
	err := w.p.promote(ctx, buildA, false)
	if err == nil || !strings.Contains(err.Error(), "is older than build "+buildC) || !strings.Contains(err.Error(), "rollback") {
		t.Fatalf("an older build: %v", err)
	}
	if w.prod() != c || w.tagged() {
		t.Fatalf("an older build moved the tag: production follows %s; ran %q", w.prod(), w.ran)
	}
	w.summary.Reset()
	if err := w.p.promote(ctx, buildA, true); err != nil || w.prod() != a {
		t.Fatalf("a rollback: %v; production follows %s", err, w.prod())
	}
	if !strings.Contains(w.summary.String(), "A rollback, asked for.") {
		t.Errorf("the summary:\n%s", w.summary.String())
	}

	// The build production follows already: nothing moves.
	w.ran = nil
	if err := w.p.promote(ctx, buildA, false); err != nil || w.tagged() || w.prod() != a {
		t.Errorf("the same build again: %v; ran %q", err, w.ran)
	}
	// With rollback ticked, a newer build is promoted as any other.
	if err := w.p.promote(ctx, buildC, true); err != nil || w.prod() != c {
		t.Errorf("a newer build with rollback ticked: %v; production follows %s", err, w.prod())
	}
}

// TestPromoteRefuses: each refusal comes before anything is tagged.
func TestPromoteRefuses(t *testing.T) {
	ctx := context.Background()
	for name, tc := range map[string]struct {
		build    string
		rollback bool
		arrange  func(w *world)
		want     string
	}{
		"a build never released": {buildC, false, func(*world) {}, "there is no release of build " + buildC},
		"what is not a build":    {"main", false, func(*world) {}, "is not a build"},
		"a tag that is no build": {manifests.ProdTag, true, func(*world) {}, "is not a build"},
		"a short commit":         {"aaaaaaa", false, func(*world) {}, "is not a build"},
		"a release that is not signed": {buildC, false, func(w *world) {
			w.unsigned[w.release(commitC)] = true
		}, "is not signed by the release workflow on main: not promoted"},
		"a rollback to a release that is not signed": {buildA, true, func(w *world) {
			w.unsigned[w.release(commitA)] = true
		}, "not promoted"},
		"a release made from a commit not on main": {offMain[:12], false, func(w *world) {
			w.release(offMain)
		}, "is not on main"},
		"a tag on another build's manifests": {buildC, false, func(w *world) {
			w.reg.put(w.p.repo, buildC, commitA, "")
		}, "says it was made from build " + buildA},
		"manifests that do not say their commit": {buildC, false, func(w *world) {
			w.reg.manifests[w.p.repo+":"+buildC] = []byte(`{"schemaVersion":2,"annotations":{}}`)
		}, "does not say it was made from a commit on main"},
		"manifests made from another branch": {buildC, false, func(w *world) {
			w.reg.manifests[w.p.repo+":"+buildC] = []byte(`{"schemaVersion":2,"annotations":{"` + revisionAnnotation + `":"feature@sha1:` + commitC + `"}}`)
		}, "does not say it was made from a commit on main"},
		// An environment the workflow named and GitHub made, or one whose
		// reviewer was taken away: nobody would have approved this run.
		"no production environment": {buildC, false, func(w *world) {
			w.release(commitC)
			w.environment = ""
		}, "requires nobody's approval: not promoted"},
		"an environment with no reviewer": {buildC, false, func(w *world) {
			w.release(commitC)
			w.environment = `{"name":"production","protection_rules":[{"type":"branch_policy"},{"type":"required_reviewers","reviewers":[]}]}`
		}, "requires nobody's approval: not promoted"},
	} {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			before := w.release(commitB)
			w.reg.manifests[w.p.repo+":"+manifests.ProdTag] = w.reg.manifests[w.p.repo+":"+buildB]
			tc.arrange(w)
			err := w.p.promote(ctx, tc.build, tc.rollback)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("promote: %v", err)
			}
			if w.tagged() || w.prod() != before {
				t.Errorf("the tag moved: ran %q; production follows %s", w.ran, w.prod())
			}
			if w.summary.Len() != 0 {
				t.Errorf("a refusal wrote the summary:\n%s", w.summary.String())
			}
		})
	}
	// A tag that did not end where it was put is an error, not a success.
	w := newWorld(t)
	w.release(commitB)
	run := w.p.run
	w.p.run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "flux" {
			return nil, nil
		}
		return run(ctx, name, args...)
	}
	if err := w.p.promote(ctx, buildB, false); err == nil || !strings.Contains(err.Error(), "does not name the release promoted") {
		t.Errorf("a tag not moved: %v", err)
	}
}

func TestReleased(t *testing.T) {
	ctx := context.Background()
	w := newWorld(t)
	if done, err := w.p.released(ctx, buildA); err != nil || done {
		t.Errorf("a build never released: %v, %v", done, err)
	}
	// Before the first release there is no package at all.
	w.reg.refuse = true
	if done, err := w.p.released(ctx, buildA); err != nil || done {
		t.Errorf("with no package yet: %v, %v", done, err)
	}
	w.reg.refuse = false
	digest := w.release(commitA)
	if done, err := w.p.released(ctx, buildA); err != nil || !done {
		t.Errorf("a signed release: %v, %v", done, err)
	}
	if done, err := w.p.released(ctx, buildB); err != nil || done {
		t.Errorf("another build: %v, %v", done, err)
	}
	// Published, never signed: neither released nor to be replaced unseen.
	w.unsigned[digest] = true
	if done, err := w.p.released(ctx, buildA); err == nil || done || !strings.Contains(err.Error(), "its signature does not verify") {
		t.Errorf("published and not signed: %v, %v", done, err)
	}
	w.reg.put(w.p.repo, buildB, commitA, "")
	if _, err := w.p.released(ctx, buildB); err == nil || !strings.Contains(err.Error(), "made from build "+buildA) {
		t.Errorf("a tag on another build's manifests: %v", err)
	}
	if _, err := w.p.released(ctx, "main"); err == nil {
		t.Error("main was taken for a build")
	}
	if w.tagged() {
		t.Errorf("asking moved a tag: %q", w.ran)
	}
}
