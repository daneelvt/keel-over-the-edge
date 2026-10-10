// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// The script that joins the machine to the tailnet, by hand, once; and
// what the access role keeps after it.
const (
	joinScript = "../../infra/bootstrap/join.sh"
	roleDir    = "../../infra/ansible/roles/access"
)

// bash runs a snippet with join.sh sourced, its functions defined and
// nothing run, and a PATH whose first folder holds fakes.
func bash(t *testing.T, fakes map[string]string, env []string, snippet string) (string, error) {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("no bash")
	}
	bin := t.TempDir()
	for name, body := range fakes {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	script, _ := filepath.Abs(joinScript)
	c := exec.Command("bash", "-c", "source "+script+"\n"+snippet)
	c.Env = append([]string{"PATH=" + bin + ":" + os.Getenv("PATH")}, env...)
	out, err := c.CombinedOutput()
	return string(out), err
}

func TestJoinRefusesAnyoneButRoot(t *testing.T) {
	out, err := bash(t, map[string]string{"id": "echo 1000"}, nil, "join")
	if err == nil || !strings.Contains(out, "run as root") {
		t.Errorf("as another user: %v %s", err, out)
	}
}

func TestJoinStopsOnAKeyringItDoesNotKnow(t *testing.T) {
	f := filepath.Join(t.TempDir(), "keyring.gpg")
	os.WriteFile(f, []byte("not Tailscale's key"), 0o644)
	out, err := bash(t, nil, nil, `check_sha256 "`+f+`" "$keyring_sha256"; echo trusted`)
	if err == nil || strings.Contains(out, "trusted") || !strings.Contains(out, "not trusting it") {
		t.Errorf("another keyring: %v %s", err, out)
	}
}

func TestTailscaleAddresses(t *testing.T) {
	for addr, want := range map[string]bool{
		"100.64.0.1": true, "100.101.102.103": true, "100.127.255.254": true, "fd7a:115c:a1e0::1": true, "FD7A:115C:A1E0:ab12::7": true,
		"100.63.255.255": false, "100.128.0.1": false, "203.0.113.5": false, "10.0.0.1": false, "fd7a:115c:a1e1::1": false, "": false, "100": false,
	} {
		out, err := bash(t, nil, nil, `from_tailscale "`+addr+`"`)
		if (err == nil) != want {
			t.Errorf("%q: from the tailnet %v, want %v %s", addr, err == nil, want, out)
		}
	}
}

// TestCloseOpenSSHOnlyFromTheTailnet: a session from anywhere else keeps
// OpenSSH, which would otherwise be the only way in.
func TestCloseOpenSSHOnlyFromTheTailnet(t *testing.T) {
	calls := filepath.Join(t.TempDir(), "calls")
	fakes := map[string]string{
		"id":        "echo 0",
		"systemctl": `echo "systemctl $*" >> ` + calls,
		"ss":        "true",
	}
	for _, conn := range []string{"203.0.113.5 50122 198.51.100.7 22", ""} {
		out, err := bash(t, fakes, []string{"SSH_CONNECTION=" + conn}, "close_openssh")
		if err == nil || !strings.Contains(out, "does not come over the tailnet") {
			t.Errorf("from %q: %v %s", conn, err, out)
		}
		if b, _ := os.ReadFile(calls); len(b) > 0 {
			t.Fatalf("from %q, OpenSSH was touched: %s", conn, b)
		}
	}
	out, err := bash(t, fakes, []string{"SSH_CONNECTION=100.101.102.103 50122 100.100.1.2 22"}, "close_openssh")
	if err != nil {
		t.Fatalf("from the tailnet: %v %s", err, out)
	}
	b, _ := os.ReadFile(calls)
	if !strings.Contains(string(b), "systemctl mask ssh.socket ssh.service") {
		t.Errorf("OpenSSH not masked: %s", b)
	}
	fakes["ss"] = `echo 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))'`
	if out, err := bash(t, fakes, []string{"SSH_CONNECTION=100.101.102.103 50122 100.100.1.2 22"}, "close_openssh"); err == nil || !strings.Contains(out, "still listens on port 22") {
		t.Errorf("with sshd still there: %v %s", err, out)
	}
}

// TestJoinKeepsWhatTheRoleKeeps: join.sh writes the same repository, with
// the same key, as the access role keeps.
func TestJoinKeepsWhatTheRoleKeeps(t *testing.T) {
	script, err := os.ReadFile(joinScript)
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?s)<<-'SOURCES'\n(.*?)\n\tSOURCES\n`).FindSubmatch(script)
	if m == nil {
		t.Fatal("join.sh writes no sources file")
	}
	var lines []string
	for _, l := range strings.Split(string(m[1]), "\n") {
		lines = append(lines, strings.TrimLeft(l, "\t"))
	}
	role, err := os.ReadFile(filepath.Join(roleDir, "files", "tailscale.sources"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(lines, "\n")+"\n" != string(role) {
		t.Errorf("join.sh's sources:\n%s\nthe role's:\n%s", strings.Join(lines, "\n"), role)
	}
	var defaults map[string]string
	data, _ := os.ReadFile(filepath.Join(roleDir, "defaults", "main.yaml"))
	if err := yaml.Unmarshal(data, &defaults); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{"keyring_url": defaults["access_tailscale_keyring_url"], "keyring_sha256": defaults["access_tailscale_keyring_sha256"], "keyring": defaults["access_tailscale_keyring"]} {
		if !strings.Contains(string(script), "readonly "+key+"="+want+"\n") {
			t.Errorf("join.sh's %s is not the role's %s", key, want)
		}
	}
}
