// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/devcert"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

// fakeCommands answers commands as the programs would, and records them.
type fakeCommands struct {
	missing map[string]bool
	answer  func(argv []string, stdin string) (string, error)
	calls   []call
}

type call struct {
	argv  []string
	stdin string
}

func (f *fakeCommands) lookPath(name string) (string, error) {
	if f.missing[name] {
		return "", errors.New("not found")
	}
	return "/usr/local/bin/" + name, nil
}

func (f *fakeCommands) run(_ context.Context, c cmd) ([]byte, error) {
	var stdin string
	if c.stdin != nil {
		b, _ := io.ReadAll(c.stdin)
		stdin = string(b)
	}
	f.calls = append(f.calls, call{c.argv, stdin})
	if f.answer == nil {
		return nil, nil
	}
	out, err := f.answer(c.argv, stdin)
	return []byte(out), err
}

// ran is whether a call's command line holds every word of want, in order.
func (f *fakeCommands) ran(want ...string) *call {
	for i, c := range f.calls {
		j := 0
		for _, a := range c.argv {
			if j < len(want) && a == want[j] {
				j++
			}
		}
		if j == len(want) {
			return &f.calls[i]
		}
	}
	return nil
}

func testCluster(t *testing.T, f *fakeCommands) *cluster {
	t.Helper()
	state := t.TempDir()
	c := newCluster(f, io.Discard)
	c.state, c.kubeconfig = state, filepath.Join(state, "kubeconfig")
	c.poll = time.Millisecond
	// A certificate made here, not by mkcert with the developer's root.
	c.certificate = func(_ context.Context, dir string, _ []string) (devcert.Certs, error) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return devcert.Certs{}, err
		}
		certs := devcert.Certs{Cert: filepath.Join(dir, "cert.pem"), Key: filepath.Join(dir, "key.pem")}
		if err := os.WriteFile(certs.Cert, []byte("CERT"), 0o600); err != nil {
			return certs, err
		}
		return certs, os.WriteFile(certs.Key, []byte("KEY"), 0o600)
	}
	return c
}

func TestToolsMissing(t *testing.T) {
	c := testCluster(t, &fakeCommands{missing: map[string]bool{"limactl": true, "kubectl": true}})
	err := c.checkTools()
	if err == nil || !strings.Contains(err.Error(), "brew install lima") || !strings.Contains(err.Error(), "kubectl is not installed") || strings.Contains(err.Error(), "docker is not") {
		t.Fatalf("checkTools: %v", err)
	}
	for _, step := range []func() error{
		func() error { return c.up(context.Background()) },
		func() error { return c.deployGame(context.Background()) },
		func() error { return c.smoke(context.Background()) },
	} {
		if err := step(); err == nil || !strings.Contains(err.Error(), "brew install lima") {
			t.Errorf("a step went on without limactl: %v", err)
		}
	}
	if c := testCluster(t, &fakeCommands{}); c.checkTools() != nil {
		t.Error("checkTools failed with everything there")
	}
}

// TestInstallerPinnedByCommit: k3s's installer is fetched at the commit
// the repository pins, never at a tag or a branch, and run as root only if
// it came.
func TestInstallerPinnedByCommit(t *testing.T) {
	chdirRoot(t)
	k3s, err := pinned.ReadK3s(pinned.K3sFile)
	if err != nil {
		t.Fatal(err)
	}
	notInstalled := func(argv []string, _ string) (string, error) {
		if slices.Contains(argv, "cat") {
			return "", errors.New("no such file")
		}
		return "", nil
	}
	f := &fakeCommands{answer: notInstalled}
	c := testCluster(t, f)
	var fetched string
	c.installer = func(_ context.Context, url string) ([]byte, error) {
		fetched = url
		return []byte("#!/bin/sh\necho k3s\n"), nil
	}
	if err := c.installK3s(context.Background()); err != nil {
		t.Fatal(err)
	}
	if want := "https://raw.githubusercontent.com/k3s-io/k3s/" + k3s.Commit + "/install.sh"; fetched != want {
		t.Errorf("the installer was fetched from %s, want %s", fetched, want)
	}
	ran := f.ran("limactl", "shell", "sudo", "env", "INSTALL_K3S_VERSION="+k3s.Version, "sh", "-s", "-")
	if ran == nil || ran.stdin != "#!/bin/sh\necho k3s\n" {
		t.Fatalf("the installer did not run with the pinned version: %+v", f.calls)
	}

	// What is not a shell script, or did not come, is never run as root.
	for name, handler := range map[string]http.HandlerFunc{
		"a page":   func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "<html>Not the installer</html>") },
		"no file":  func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) },
		"an empty": func(http.ResponseWriter, *http.Request) {},
	} {
		srv := httptest.NewServer(handler)
		f := &fakeCommands{answer: notInstalled}
		c := testCluster(t, f)
		c.installer = func(ctx context.Context, _ string) ([]byte, error) { return fetchInstaller(ctx, srv.URL) }
		if err := c.installK3s(context.Background()); err == nil || !strings.Contains(err.Error(), "installer") {
			t.Errorf("%s for an installer: %v", name, err)
		}
		if f.ran("sh", "-s", "-") != nil {
			t.Errorf("%s ran as the installer", name)
		}
		srv.Close()
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "#!/bin/sh\nset -e\n") }))
	defer srv.Close()
	if script, err := fetchInstaller(context.Background(), srv.URL); err != nil || string(script) != "#!/bin/sh\nset -e\n" {
		t.Errorf("a shell script: %q, %v", script, err)
	}
}

// chdirRoot runs the test from the repository's root, as tools/cluster runs.
func chdirRoot(t *testing.T) {
	t.Helper()
	t.Chdir("../..")
}

func TestInstallWritesFilesAndRestarts(t *testing.T) {
	chdirRoot(t)
	k3s, err := pinned.ReadK3s(pinned.K3sFile)
	if err != nil {
		t.Fatal(err)
	}
	config, _ := os.ReadFile("infra/k3s/config.yaml")
	guest := map[string]string{"/etc/rancher/k3s/config.yaml": "old settings"}
	for _, f := range guestFiles[:1] {
		data, _ := os.ReadFile(f.src)
		guest[f.dst] = string(data)
	}
	local, _ := os.ReadFile("infra/local/k3s-local.yaml")
	guest["/etc/rancher/k3s/config.yaml.d/50-local.yaml"] = string(local)
	f := &fakeCommands{answer: func(argv []string, _ string) (string, error) {
		switch {
		case slices.Contains(argv, "cat"):
			return guest[argv[len(argv)-1]], nil
		case slices.Contains(argv, "--version"):
			return "k3s version " + k3s.Version + " (abc)\n", nil
		}
		return "", nil
	}}
	c := testCluster(t, f)
	c.installer = func(context.Context, string) ([]byte, error) { t.Fatal("installed again"); return nil, nil }
	if err := c.installK3s(context.Background()); err != nil {
		t.Fatal(err)
	}
	w := f.ran("install", "/dev/stdin", "/etc/rancher/k3s/config.yaml")
	if w == nil || w.stdin != string(config) {
		t.Fatalf("config.yaml not written: %+v", f.calls)
	}
	if f.ran("50-local.yaml") != nil && f.ran("install", "/dev/stdin", "/etc/rancher/k3s/config.yaml.d/50-local.yaml") != nil {
		t.Error("an unchanged file was written")
	}
	if f.ran("systemctl", "restart", "k3s") == nil {
		t.Error("k3s not restarted for its new settings")
	}
}

const k3sKubeconfig = `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: Q0E=
    server: https://127.0.0.1:6443
  name: default
contexts:
- context:
    cluster: default
    user: default
  name: default
current-context: default
kind: Config
preferences: {}
users:
- name: default
  user:
    client-certificate-data: Q0VSVA==
    client-key-data: S0VZ
`

func TestKubeconfig(t *testing.T) {
	f := &fakeCommands{answer: func(argv []string, _ string) (string, error) {
		if slices.Contains(argv, "/etc/rancher/k3s/k3s.yaml") {
			return k3sKubeconfig, nil
		}
		return "", errors.New("unexpected")
	}}
	c := testCluster(t, f)
	if err := c.writeKubeconfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(c.kubeconfig)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", info.Mode().Perm())
	}
	data, _ := os.ReadFile(c.kubeconfig)
	var k struct {
		Clusters []struct {
			Name    string
			Cluster struct{ Server string }
		}
		Users    []struct{ Name string }
		Contexts []struct {
			Name    string
			Context struct{ Cluster, User string }
		}
		Current string `yaml:"current-context"`
	}
	if err := yaml.Unmarshal(data, &k); err != nil {
		t.Fatal(err)
	}
	if len(k.Clusters) != 1 || k.Clusters[0].Name != vmName || k.Clusters[0].Cluster.Server != "https://127.0.0.1:16443" ||
		len(k.Users) != 1 || k.Users[0].Name != vmName || len(k.Contexts) != 1 || k.Contexts[0].Name != vmName ||
		k.Contexts[0].Context.Cluster != vmName || k.Contexts[0].Context.User != vmName || k.Current != vmName {
		t.Errorf("kubeconfig:\n%s", data)
	}
	if strings.Contains(string(data), "default") || !strings.Contains(string(data), "client-key-data: S0VZ") {
		t.Errorf("kubeconfig:\n%s", data)
	}
	// Every kubectl names it and the context.
	_, _ = c.kubectl(context.Background(), nil, "get", "nodes")
	if f.ran("kubectl", "--kubeconfig", c.kubeconfig, "--context", vmName, "get", "nodes") == nil {
		t.Errorf("kubectl ran as %v", f.calls[len(f.calls)-1].argv)
	}
}

func TestDatabaseSecretNeverReplaced(t *testing.T) {
	exists := true
	f := &fakeCommands{answer: func(argv []string, _ string) (string, error) {
		if slices.Contains(argv, "get") && exists {
			return "secret/keel-db-app\n", nil
		}
		return "", nil
	}}
	c := testCluster(t, f)
	if err := c.databaseSecret(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.ran("create") != nil || f.ran("apply") != nil || f.ran("delete") != nil {
		t.Fatalf("an existing password was touched: %+v", f.calls)
	}

	exists = false
	if err := c.databaseSecret(context.Background()); err != nil {
		t.Fatal(err)
	}
	made := f.ran("kubectl", "create", "-f", "-")
	if made == nil {
		t.Fatal("no Secret made")
	}
	var s struct {
		Type       string
		Metadata   struct{ Name, Namespace string }
		StringData map[string]string `yaml:"stringData"`
	}
	if err := yaml.Unmarshal([]byte(made.stdin), &s); err != nil {
		t.Fatal(err)
	}
	pw := s.StringData["password"]
	if s.Type != "kubernetes.io/basic-auth" || s.Metadata.Name != "keel-db-app" || s.Metadata.Namespace != "keel" || s.StringData["username"] != "keel" || len(pw) != 43 {
		t.Fatalf("the Secret: %+v", s)
	}
	for _, c := range f.calls {
		if strings.Contains(strings.Join(c.argv, " "), pw) {
			t.Fatal("the password is on a command line")
		}
	}
}

func TestTLSSecretFollowsTheCertificate(t *testing.T) {
	dir := t.TempDir()
	certs := devcert.Certs{Cert: filepath.Join(dir, "cert.pem"), Key: filepath.Join(dir, "key.pem")}
	os.WriteFile(certs.Cert, []byte("CERT"), 0o600)
	os.WriteFile(certs.Key, []byte("KEY"), 0o600)
	have := base64.StdEncoding.EncodeToString([]byte("CERT"))
	f := &fakeCommands{answer: func(argv []string, _ string) (string, error) {
		if slices.Contains(argv, "get") {
			return have, nil
		}
		return "", nil
	}}
	c := testCluster(t, f)
	if err := c.tlsSecret(context.Background(), certs); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 1 {
		t.Fatalf("the same certificate was put again: %+v", f.calls)
	}
	have = base64.StdEncoding.EncodeToString([]byte("OLD CERT"))
	if err := c.tlsSecret(context.Background(), certs); err != nil {
		t.Fatal(err)
	}
	if f.ran("delete", "secret", "keel-tls") == nil {
		t.Fatal("the old certificate was kept")
	}
	made := f.ran("create", "-f", "-")
	if made == nil || !strings.Contains(made.stdin, `"tls.crt":"CERT"`) || !strings.Contains(made.stdin, `"kubernetes.io/tls"`) {
		t.Fatalf("made %+v", made)
	}
}

func TestBuildID(t *testing.T) {
	now := time.Date(2026, 10, 10, 7, 30, 5, 0, time.FixedZone("NZDT", 13*3600))
	for _, c := range []struct{ status, want string }{
		{"", "0123456789ab"},
		{" M internal/api/client.go\n", "0123456789ab-dirty-20261009T183005Z"},
	} {
		f := &fakeCommands{answer: func(argv []string, _ string) (string, error) {
			if slices.Contains(argv, "rev-parse") {
				return "0123456789ab\n", nil
			}
			return c.status, nil
		}}
		got, err := testCluster(t, f).buildID(context.Background(), now)
		if err != nil || got != c.want {
			t.Errorf("status %q: %q, %v; want %q", c.status, got, err, c.want)
		}
	}
}

func TestPruneImages(t *testing.T) {
	cases := []struct {
		history          []string
		build            string
		kept, removedOld []string
	}{
		{nil, "a", []string{"a"}, nil},
		{[]string{"a", "b"}, "c", []string{"a", "b", "c"}, nil},
		{[]string{"a", "b", "c"}, "d", []string{"b", "c", "d"}, []string{"a"}},
		{[]string{"a", "b", "c", "d", "e"}, "f", []string{"d", "e", "f"}, []string{"a", "b", "c"}},
		{[]string{"a", "b", "c"}, "a", []string{"b", "c", "a"}, nil},
	}
	for _, c := range cases {
		kept, removed := pruneImages(c.history, c.build, 3)
		if !slices.Equal(kept, c.kept) || !slices.Equal(removed, c.removedOld) {
			t.Errorf("%v + %s: kept %v, removed %v", c.history, c.build, kept, removed)
		}
	}
}

func TestCertHosts(t *testing.T) {
	got := certHosts("harbour.local", nil)
	if !slices.Equal(got, []string{"harbour.local", "localhost", "127.0.0.1"}) {
		t.Errorf("%v", got)
	}
}

// noSessions is a store that holds no sessions.
type noSessions struct{}

func (noSessions) Session(context.Context, [32]byte) (store.Session, error) {
	return store.Session{}, store.ErrNotFound
}
func (noSessions) Touch(context.Context, [32]byte) error { return nil }

// pageServer is keel's game listener serving a page laid out as the
// client's build is.
func pageServer(t *testing.T, build string) *httptest.Server {
	t.Helper()
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "assets"), 0o755)
	for name, body := range map[string]string{
		"index.html":                   `<title>Keel Over the Edge</title><script type="module" src="/assets/main-abc.js"></script><link rel="modulepreload" href="/assets/golden-def.js">`,
		"assets/main-abc.js":           "import './golden-def.js'",
		"assets/golden-def.js":         `new URL("/assets/physics-207F3rPv.wasm", import.meta.url)`,
		"assets/physics-207F3rPv.wasm": "\x00asm\x01\x00\x00\x00",
	} {
		os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644)
	}
	page, err := api.OpenPage(dir)
	if err != nil {
		t.Fatal(err)
	}
	m := obs.NewMetrics(build, catalog.Version)
	h := api.Handler(api.Config{
		Version:  api.Version{Build: build, Catalog: catalog.Version},
		Log:      obs.NewLogger(io.Discard, slog.LevelError, build),
		Metrics:  m,
		Sessions: auth.NewCache(noSessions{}, auth.CacheConfig{Lookups: m.SessionLookups}),
		Page:     page,
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func TestSmokeChecksThePage(t *testing.T) {
	srv := pageServer(t, "0123456789ab")
	ctx := context.Background()
	if err := checkPage(ctx, srv.Client(), srv.URL); err != nil {
		t.Fatal(err)
	}
	for _, catalogToo := range []bool{true, false} {
		if err := checkVersion(ctx, srv.Client(), srv.URL, "0123456789ab", catalogToo); err != nil {
			t.Fatal(err)
		}
		if err := checkVersion(ctx, srv.Client(), srv.URL, "fedcba987654", catalogToo); err == nil || !strings.Contains(err.Error(), "not \"fedcba987654\"") {
			t.Fatalf("another build passed: %v", err)
		}
	}

	// A page served without its caching, or as another type, fails.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		switch r.URL.Path {
		case "/":
			w.Header().Set("Cache-Control", "no-cache")
			io.WriteString(w, `<title>Keel Over the Edge</title><script src="/assets/main-abc.js"></script>`)
		default:
			w.Header().Set("Content-Type", "text/javascript")
			io.WriteString(w, "1")
		}
	}))
	defer bad.Close()
	if err := checkPage(ctx, bad.Client(), bad.URL); err == nil || !strings.Contains(err.Error(), "Cache-Control") {
		t.Fatalf("an asset without caching passed: %v", err)
	}
}

func TestSmokeChecksTheInternalListener(t *testing.T) {
	mux := http.NewServeMux()
	ready := true
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !ready {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		for _, name := range []string{"keel_sim_ticks_total", "keel_sim_tick_duration_seconds_bucket", "keel_build_info", "keel_db_pool_max_connections", "keel_db_schema_version", "keel_edge_connections", "keel_edge_upgrades_total", "keel_sim_boat_limit", "keel_sim_queue_length", "keel_edge_encoders"} {
			fmt.Fprintf(w, "%s 1\n", name)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	if err := checkInternal(context.Background(), srv.URL); err != nil {
		t.Fatal(err)
	}
	ready = false
	if err := checkInternal(context.Background(), srv.URL); err == nil {
		t.Fatal("a server not ready passed")
	}
}

func TestPlainPod(t *testing.T) {
	p := plainPod("keel:abc")
	for _, want := range []string{`"image":"keel:abc"`, `"imagePullPolicy":"Never"`, "sslmode=disable", `"secretKeyRef":{"key":"password","name":"keel-db-app"}`, `"runAsNonRoot":true`} {
		if !strings.Contains(p, want) {
			t.Errorf("the pod lacks %s: %s", want, p)
		}
	}
	// A release's image is pulled by its digest, if the node lacks it.
	image := manifests.GameImage + "@sha256:" + strings.Repeat("ab", 32)
	if p := plainPod(image); !strings.Contains(p, `"image":"`+image+`"`) || !strings.Contains(p, `"imagePullPolicy":"IfNotPresent"`) {
		t.Errorf("the pod for a release's image: %s", p)
	}
}

func TestDeleteAsksFirst(t *testing.T) {
	f := &fakeCommands{answer: func(argv []string, _ string) (string, error) {
		if slices.Contains(argv, "list") {
			return `{"name":"keel-local","status":"Running"}` + "\n", nil
		}
		return "", nil
	}}
	c := testCluster(t, f)
	os.WriteFile(c.kubeconfig, []byte("x"), 0o600)
	if err := c.deleteVM(context.Background(), strings.NewReader("\n")); err == nil {
		t.Fatal("deleted without a yes")
	}
	if f.ran("delete") != nil {
		t.Fatal("limactl delete ran without a yes")
	}
	if err := c.deleteVM(context.Background(), strings.NewReader("yes\n")); err != nil {
		t.Fatal(err)
	}
	if f.ran("limactl", "delete", "--force", vmName) == nil {
		t.Fatal("the VM was not deleted")
	}
	if _, err := os.Stat(c.state); !os.IsNotExist(err) {
		t.Fatal("the state was left")
	}
}

// TestRestarts: each way of ending keel's pod runs what it should, and
// waits for keel to be ready again.
func TestRestarts(t *testing.T) {
	restarted := 0
	f := &fakeCommands{answer: func(argv []string, _ string) (string, error) {
		joined := strings.Join(argv, " ")
		switch {
		case strings.Contains(joined, "metadata.name"):
			return "keel-7d9f-abcde", nil
		case strings.Contains(joined, "restartCount"):
			restarted++
			return fmt.Sprint(restarted / 3), nil
		}
		return "", nil
	}}
	c := testCluster(t, f)
	if err := c.restartGame(t.Context()); err != nil {
		t.Fatal(err)
	}
	if f.ran("rollout", "restart", "deployment/keel") == nil || f.ran("rollout", "status", "deployment/keel") == nil {
		t.Fatalf("-restart ran %v", f.calls)
	}
	f.calls = nil
	if err := c.killPod(t.Context()); err != nil {
		t.Fatal(err)
	}
	if f.ran("delete", "pod", "keel-7d9f-abcde", "--grace-period=0", "--force") == nil || f.ran("rollout", "status") == nil {
		t.Fatalf("-kill ran %v", f.calls)
	}
	f.calls = nil
	if err := c.crash(t.Context()); err != nil {
		t.Fatal(err)
	}
	if f.ran("limactl", "shell", "sudo", "pkill", "-KILL", "-x", "keel") == nil || f.ran("wait", "--for=condition=Ready", "pod") == nil || restarted < 3 {
		t.Fatalf("-crash ran %v", f.calls)
	}
}
