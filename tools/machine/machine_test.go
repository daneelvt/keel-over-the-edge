// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/production"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/registry"
)

const (
	commit   = "240a02be2e1e1a0cc7651ca49dd62b3437d3a94e"
	digest   = "sha256:1adaefc1b11c98c8572732d7ce6ce884defc05232cbe7ec10afa023a67db04f8"
	clientID = "made-up-eso-client"
	secret   = "made-up-eso-secret-value"
	jwt      = "eyJ.job.token"
	recap    = "PLAY RECAP *********************************************************************\nkeel-prod-1                : ok=90   changed=%d    unreachable=0    failed=0    skipped=12   rescued=0    ignored=0\n"
)

// call is a program the tool ran, with what it saw when it ran.
type call struct {
	argv []string
	env  []string
	dir  string
	// logged is what the tool had logged before the program ran.
	logged string
}

// fakeCommands plays the programs the tool drives.
type fakeCommands struct {
	mu      sync.Mutex
	calls   []call
	started [][]string
	log     *bytes.Buffer
	// cosignFails makes cosign verify fail; changed is what the playbook
	// changes.
	cosignFails bool
	changed     int
	// status is tailscale status --json's answer.
	status string
}

func (f *fakeCommands) run(_ context.Context, c cmd) ([]byte, error) {
	f.mu.Lock()
	f.calls = append(f.calls, call{argv: c.argv, env: c.env, dir: c.dir, logged: f.log.String()})
	f.mu.Unlock()
	name := filepath.Base(c.argv[0])
	args := c.argv[1:]
	if name == "sudo" {
		name, args = filepath.Base(c.argv[1]), c.argv[2:]
		if name == "env" {
			for len(args) > 0 && strings.Contains(args[0], "=") {
				args = args[1:]
			}
			name, args = filepath.Base(args[0]), args[1:]
		}
	}
	switch name {
	case "cosign":
		if f.cosignFails {
			return nil, errors.New("cosign verify: no matching signatures: expected SAN value to match regex")
		}
	case "flux":
		out := args[slices.Index(args, "--output")+1]
		file := filepath.Join(out, "prod", "flux-system", "manifests.yaml")
		os.MkdirAll(filepath.Dir(file), 0o755)
		os.WriteFile(file, []byte("kind: Namespace\n"), 0o644)
	case "ansible-playbook":
		out := "TASK [base : Name the machine] ***\nok: [keel-prod-1]\n"
		if f.changed > 0 {
			out += "TASK [firewall : Write the table] ***\nchanged: [keel-prod-1]\n"
		}
		out += "TASK [Say a reboot is due] ***\nok: [keel-prod-1] => {\n    \"msg\": \"A reboot is due: the kernel booted without audit=1. Run apply again with reboot ticked.\"\n}\n\n"
		out += strings.Replace(recap, "%d", string(rune('0'+f.changed)), 1)
		if c.out != nil {
			io.WriteString(c.out, out)
		}
		return []byte(out), nil
	case "tailscale":
		if slices.Contains(args, "status") {
			return []byte(f.status), nil
		}
	}
	return nil, nil
}

func (f *fakeCommands) start(c cmd) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started = append(f.started, c.argv)
	return nil
}

// ran is the calls of a program, by name.
func (f *fakeCommands) ran(name string) []call {
	var cs []call
	for _, c := range f.calls {
		for _, a := range c.argv {
			if filepath.Base(a) == name {
				cs = append(cs, c)
				break
			}
			if !strings.Contains(a, "=") && a != "sudo" && a != "env" {
				break
			}
		}
	}
	return cs
}

// position is where the first call of a program is among the calls.
func (f *fakeCommands) position(name string) int {
	for i, c := range f.calls {
		if len(f.ranOf(c, name)) > 0 {
			return i
		}
	}
	return -1
}

func (f *fakeCommands) ranOf(c call, name string) []call {
	g := &fakeCommands{calls: []call{c}}
	return g.ran(name)
}

// fakeServices are GHCR and Infisical, as far as the tool reads them.
func fakeServices(t *testing.T, revision string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/daneelvt/keel-manifests/manifests/prod":
			body, _ := json.Marshal(map[string]any{"schemaVersion": 2, "annotations": map[string]string{"org.opencontainers.image.revision": revision}})
			w.Write(body)
		case "/api/v1/auth/oidc-auth/login":
			var in map[string]string
			json.NewDecoder(r.Body).Decode(&in)
			if in["identityId"] != "gha-prod-id" || in["jwt"] != jwt {
				http.Error(w, `{"message":"refused"}`, http.StatusUnauthorized)
				return
			}
			io.WriteString(w, `{"accessToken":"infisical-access-token","expiresIn":600,"tokenType":"Bearer"}`)
		case "/api/v4/secrets/ESO_CLIENT_ID", "/api/v4/secrets/ESO_CLIENT_SECRET":
			q := r.URL.Query()
			if r.Header.Get("Authorization") != "Bearer infisical-access-token" || q.Get("projectId") != "keel-ops-id" || q.Get("environment") != "prod" || q.Get("secretPath") != "/machine" {
				http.Error(w, `{"message":"forbidden"}`, http.StatusForbidden)
				return
			}
			v := clientID
			if strings.HasSuffix(r.URL.Path, "SECRET") {
				v = secret
			}
			json.NewEncoder(w).Encode(map[string]any{"secret": map[string]string{"secretKey": filepath.Base(r.URL.Path), "secretValue": v}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func testMachine(t *testing.T, revision string) (*machine, *fakeCommands, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	srv := fakeServices(t, revision)
	root := t.TempDir()
	var log, summary bytes.Buffer
	f := &fakeCommands{log: &log}
	p := production.Production{Machine: "keel-prod-1", Tailnet: "tail1234.ts.net"}
	p.Tailscale.Join = production.Identity{ClientID: "kJoin", Audience: "api.tailscale.com/kJoin"}
	p.Infisical = production.Infisical{Host: srv.URL, IdentityID: "gha-prod-id", Audience: "https://github.com/daneelvt", Project: "keel-ops-id", Environment: "prod"}
	m := &machine{
		out: &log, summary: nopCloser{&summary}, cmd: f, hc: srv.Client(), prod: p, root: root,
		idToken: func(_ context.Context, audience string) (string, error) { return jwt, nil },
		reg:     &registry.Registry{Base: srv.URL, HC: srv.Client()},
		tool: func(_ context.Context, tool pinned.Tool) (string, error) {
			return filepath.Join("/pinned", tool.Name, tool.Name), nil
		},
		poll: time.Millisecond,
	}
	if err := os.MkdirAll(filepath.Join(root, stateDir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.hostFile(), []byte("100.101.102.103\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return m, f, &log, &summary
}

type nopCloser struct{ io.Writer }

func (nopCloser) Close() error { return nil }

// TestRunGivesTheCredentialOnlyToThePlaybook: the credential read from
// Infisical is masked before anything else runs, reaches the playbook in
// its environment alone, and is never on a command line or in the
// summary.
func TestRunGivesTheCredentialOnlyToThePlaybook(t *testing.T) {
	m, f, log, summary := testMachine(t, "main@sha1:"+commit)
	if err := m.run(context.Background(), runOptions{mode: "apply"}); err != nil {
		t.Fatal(err)
	}
	plays := f.ran("ansible-playbook")
	if len(plays) != 1 {
		t.Fatalf("ansible-playbook ran %d times", len(plays))
	}
	p := plays[0]
	for _, s := range []string{clientID, secret} {
		if !strings.Contains(p.logged, "::add-mask::"+s+"\n") {
			t.Errorf("%s was not masked before the playbook ran", s)
		}
		if strings.Contains(strings.Join(p.argv, " "), s) || strings.Contains(summary.String(), s) {
			t.Errorf("%s is on the command line or in the summary", s)
		}
		if strings.Count(log.String(), s) != 1 {
			t.Errorf("%s is in the log other than to mask it", s)
		}
	}
	if !strings.Contains(log.String(), "::add-mask::infisical-access-token") {
		t.Error("Infisical's token was not masked")
	}
	for _, e := range []string{"ESO_CLIENT_ID=" + clientID, "ESO_CLIENT_SECRET=" + secret} {
		if !slices.Contains(p.env, e) {
			t.Errorf("the playbook's environment has no %s", strings.SplitN(e, "=", 2)[0])
		}
	}
	args := strings.Join(p.argv, " ")
	for _, want := range []string{
		"site.yaml", "--inventory inventory/production.yaml", "ansible_host=100.101.102.103",
		"machine_flux_manifests=" + filepath.Join(m.root, stateDir, "release", "prod", "flux-system", "manifests.yaml"),
		`{"machine_reboot": false}`, "-o UserKnownHostsFile=" + m.knownHosts() + " -o StrictHostKeyChecking=yes",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("the playbook's arguments have no %q: %s", want, args)
		}
	}
	if strings.Contains(args, "--check") || p.argv[0] == "sudo" || p.dir != m.path(ansibleDir) {
		t.Errorf("apply ran as %s in %s", args, p.dir)
	}
	// The release is checked before it is pulled, by its digest.
	cosign, flux := f.ran("cosign"), f.ran("flux")
	if len(cosign) != 1 || len(flux) != 1 || !strings.HasSuffix(strings.Join(cosign[0].argv, " "), "ghcr.io/daneelvt/keel-manifests@"+digestOf(t, m)) ||
		!slices.Contains(flux[0].argv, "oci://ghcr.io/daneelvt/keel-manifests@"+digestOf(t, m)) || f.position("cosign") > f.position("flux") {
		t.Errorf("cosign %v, then flux %v", cosign, flux)
	}
	for _, want := range []string{"Applied the playbook on keel-prod-1", "| 90 | 0 | 0 | 0 | 12 |", "A reboot is due: the kernel booted without audit=1"} {
		if !strings.Contains(summary.String(), want) {
			t.Errorf("the summary has no %q:\n%s", want, summary)
		}
	}
}

// digestOf is the digest the fake registry serves for prod.
func digestOf(t *testing.T, m *machine) string {
	t.Helper()
	a, _, err := m.reg.Resolve(context.Background(), "daneelvt/keel-manifests", "prod")
	if err != nil {
		t.Fatal(err)
	}
	return a.Digest
}

func TestCheckIsADryRun(t *testing.T) {
	m, f, _, _ := testMachine(t, "main@sha1:"+commit)
	if err := m.run(context.Background(), runOptions{mode: "check"}); err != nil {
		t.Fatal(err)
	}
	args := strings.Join(f.ran("ansible-playbook")[0].argv, " ")
	if !strings.Contains(args, "--check --diff") {
		t.Errorf("check ran %s", args)
	}
}

func TestRunRefusesAReleaseNotSignedByTheReleaseWorkflow(t *testing.T) {
	m, f, _, _ := testMachine(t, "main@sha1:"+commit)
	f.cosignFails = true
	err := m.run(context.Background(), runOptions{mode: "apply"})
	if err == nil || !strings.Contains(err.Error(), "not signed by the release workflow on main") {
		t.Fatalf("got %v", err)
	}
	if len(f.ran("flux")) != 0 || len(f.ran("ansible-playbook")) != 0 {
		t.Error("an unverified release was pulled or applied")
	}
}

func TestRunRefusesAReleaseNotFromMain(t *testing.T) {
	m, f, _, _ := testMachine(t, "feature@sha1:"+commit)
	err := m.run(context.Background(), runOptions{mode: "apply"})
	if err == nil || !strings.Contains(err.Error(), "not say it was made from a commit on main") {
		t.Fatalf("got %v", err)
	}
	if len(f.calls) != 0 {
		t.Errorf("ran %v", f.calls)
	}
}

func TestRunRefusesWithoutTheAccounts(t *testing.T) {
	m, f, _, _ := testMachine(t, "main@sha1:"+commit)
	m.prod.Infisical.IdentityID = ""
	err := m.run(context.Background(), runOptions{mode: "apply"})
	if err == nil || !strings.Contains(err.Error(), "infisical.identityID") {
		t.Fatalf("got %v", err)
	}
	if len(f.ran("ansible-playbook")) != 0 {
		t.Error("the playbook ran")
	}
}

func TestRunOnTheRunner(t *testing.T) {
	m, f, _, _ := testMachine(t, "main@sha1:"+commit)
	m.prod.Infisical.Host = "http://127.0.0.1:1" // never asked
	if err := m.run(context.Background(), runOptions{mode: "apply", local: true}); err != nil {
		t.Fatal(err)
	}
	p := f.ran("ansible-playbook")[0]
	args := strings.Join(p.argv, " ")
	if p.argv[0] != "sudo" || p.argv[1] != "env" || !strings.Contains(args, "--inventory inventory/runner.yaml") || strings.Contains(args, "ansible_host") ||
		!strings.Contains(args, "ESO_CLIENT_ID=made-up-for-a-test") {
		t.Errorf("on the runner: %s", args)
	}
}

func TestUnchangedFailsOnAChange(t *testing.T) {
	m, f, _, _ := testMachine(t, "main@sha1:"+commit)
	f.changed = 1
	err := m.run(context.Background(), runOptions{mode: "apply", local: true, unchanged: true})
	if err == nil || !strings.Contains(err.Error(), "firewall : Write the table") {
		t.Fatalf("got %v", err)
	}
	f.changed = 0
	if err := m.run(context.Background(), runOptions{mode: "apply", local: true, unchanged: true}); err != nil {
		t.Fatal(err)
	}
}

func TestRunRefusesARebootItCannotMake(t *testing.T) {
	m, _, _, _ := testMachine(t, "main@sha1:"+commit)
	for _, o := range []runOptions{{mode: "check", reboot: true}, {mode: "apply", reboot: true, local: true}, {mode: "plan"}} {
		if err := m.run(context.Background(), o); err == nil {
			t.Errorf("%+v ran", o)
		}
	}
}

func TestRoleTimes(t *testing.T) {
	dir := t.TempDir()
	xml := `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="site.yaml" tests="3">
<testcase classname="/repo/infra/ansible/roles/base/tasks/main.yaml:5" name="[keel-prod-1] Production's machine: base : Name the machine" time="1.5"/>
<testcase classname="/repo/infra/ansible/roles/base/tasks/main.yaml:20" name="[keel-prod-1] Production's machine: base : Bring every package up to date" time="60.25"/>
<testcase classname="/repo/infra/ansible/roles/k3s/tasks/main.yaml:70" name="[keel-prod-1] Production's machine: k3s : Install k3s" time="30"/>
<testcase classname="/repo/infra/ansible/site.yaml:3" name="[keel-prod-1] Production's machine: Gathering Facts" time="2"/>
</testsuite></testsuites>`
	os.WriteFile(filepath.Join(dir, "site-1.xml"), []byte(xml), 0o644)
	got, err := roleTimes(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]time.Duration{"base": 61750 * time.Millisecond, "k3s": 30 * time.Second, "(the playbook)": 2 * time.Second}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %v, want %v", k, got[k], v)
		}
	}
}

const status = `{"Peer":{
 "nodekey:a":{"HostName":"keel-prod-1","DNSName":"keel-prod-1.tail1234.ts.net.","TailscaleIPs":["100.101.102.103","fd7a:115c:a1e0::1"],"Online":true,"Tags":["tag:keel-prod"],
   "sshHostKeys":["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample","ecdsa-sha2-nistp256 AAAAE2VjZHNhExample"]},
 "nodekey:b":{"HostName":"laptop","DNSName":"laptop.tail1234.ts.net.","TailscaleIPs":["100.64.0.2"],"Online":true}}}`

func TestKnownHostsFromTheTailnet(t *testing.T) {
	p, err := findMachine([]byte(status), "keel-prod-1.tail1234.ts.net")
	if err != nil {
		t.Fatal(err)
	}
	got, err := knownHosts(p, "keel-prod-1.tail1234.ts.net")
	if err != nil {
		t.Fatal(err)
	}
	want := "100.101.102.103,fd7a:115c:a1e0::1,keel-prod-1.tail1234.ts.net,keel-prod-1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n" +
		"100.101.102.103,fd7a:115c:a1e0::1,keel-prod-1.tail1234.ts.net,keel-prod-1 ecdsa-sha2-nistp256 AAAAE2VjZHNhExample\n"
	if string(got) != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}

	noKeys := strings.Replace(status, `"sshHostKeys":["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample","ecdsa-sha2-nistp256 AAAAE2VjZHNhExample"]`, `"sshHostKeys":[]`, 1)
	p, _ = findMachine([]byte(noKeys), "keel-prod-1.tail1234.ts.net")
	if _, err := knownHosts(p, "keel-prod-1.tail1234.ts.net"); err == nil || !strings.Contains(err.Error(), "no SSH host key") {
		t.Errorf("without host keys: %v", err)
	}
	if p, err := findMachine([]byte(status), "keel-prod-2.tail1234.ts.net"); err != nil || p.DNSName != "" {
		t.Errorf("a machine not there: %+v, %v", p, err)
	}
	other := strings.Replace(status, `"Tags":["tag:keel-prod"]`, `"Tags":["tag:ci-prod"]`, 1)
	if _, err := findMachine([]byte(other), "keel-prod-1.tail1234.ts.net"); err == nil || !strings.Contains(err.Error(), "not tagged tag:keel-prod") {
		t.Errorf("another tag: %v", err)
	}
}

func TestJoin(t *testing.T) {
	m, f, log, _ := testMachine(t, "main@sha1:"+commit)
	f.status = status
	t.Setenv("GITHUB_RUN_ID", "42")
	t.Setenv("GITHUB_RUN_ATTEMPT", "1")
	if err := m.join(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.started) != 1 || !slices.Contains(f.started[0], "--state=mem:") || f.started[0][0] != "sudo" {
		t.Errorf("started %v", f.started)
	}
	var up []string
	for _, c := range f.ran("tailscale") {
		if slices.Contains(c.argv, "up") {
			up = c.argv
		}
	}
	tokenFile := filepath.Join(m.root, stateDir, "id-token")
	for _, want := range []string{"--client-id=kJoin?ephemeral=true&preauthorized=true", "--id-token=file:" + tokenFile, "--advertise-tags=tag:ci-prod", "--hostname=ci-42-1", "--accept-dns=false"} {
		if !slices.Contains(up, want) {
			t.Errorf("tailscale up has no %s: %v", want, up)
		}
	}
	if strings.Contains(strings.Join(up, " ")+log.String(), jwt) {
		t.Error("the job's token is on the command line or in the log")
	}
	if _, err := os.Stat(tokenFile); err == nil {
		t.Error("the token's file is left behind")
	}
	hosts, _ := os.ReadFile(m.knownHosts())
	if !strings.Contains(string(hosts), "keel-prod-1.tail1234.ts.net,keel-prod-1 ssh-ed25519") {
		t.Errorf("known_hosts: %s", hosts)
	}
}

func TestLynisReport(t *testing.T) {
	r := parseLynis("report_version=1.0\nhardening_index=78\nwarning[]=FIRE-4512|iptables module(s) loaded, but no rules active|-|-|\nsuggestion[]=SSH-7408|Consider hardening SSH configuration|AllowTcpForwarding (set YES to NO)|-|\n")
	if r.index != "78" || len(r.warnings) != 1 || r.warnings[0].id != "FIRE-4512" || len(r.suggestions) != 1 || !strings.Contains(r.suggestions[0].text, "AllowTcpForwarding") {
		t.Errorf("%+v", r)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "accepted.txt")
	os.WriteFile(file, []byte("# comment\nFIRE-4512 k3s's own rules are in other tables\n"), 0o644)
	if a, err := readAccepted(file); err != nil || a["FIRE-4512"] == "" {
		t.Errorf("%v %v", a, err)
	}
	os.WriteFile(file, []byte("FIRE-4512\n"), 0o644)
	if _, err := readAccepted(file); err == nil {
		t.Error("a warning accepted with no reason")
	}
	for _, f := range []string{acceptedFile, runnerAcceptedFile} {
		if _, err := readAccepted("../../" + f); err != nil {
			t.Error(err)
		}
	}
}

func TestKubeBenchReport(t *testing.T) {
	r, err := parseKubeBench([]byte(`{"Controls":[{"tests":[{"results":[
		{"test_number":"1.1.1","test_desc":"Ensure that the API server pod specification file permissions are set","status":"PASS"},
		{"test_number":"4.2.6","test_desc":"Ensure that the --make-iptables-util-chains argument is set to true","status":"FAIL"}]}]}],
		"Totals":{"total_pass":1,"total_fail":1,"total_warn":0,"total_info":0}}`))
	if err != nil || r.pass != 1 || r.fail != 1 || len(r.failed) != 1 || r.failed[0].id != "4.2.6" {
		t.Errorf("%+v %v", r, err)
	}
}
