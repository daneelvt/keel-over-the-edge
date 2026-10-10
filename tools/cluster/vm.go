// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/devcert"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

const (
	// vmName is the Lima VM's, and the kubeconfig context's.
	vmName   = "keel-local"
	limaFile = "infra/local/lima.yaml"
	// apiAddr is where Lima forwards the Kubernetes API, on the Mac's
	// loopback alone; not 6443, which another cluster may hold.
	apiAddr = "127.0.0.1:16443"
	// stateDir holds the kubeconfig, the certificate and what was deployed.
	stateDir   = ".dev/cluster"
	clusterDir = "infra/cluster"
	// schemasDir holds the schemas of the custom resources the manifests
	// use, and schemaCache those of Kubernetes' own kinds once downloaded.
	schemasDir  = "infra/schemas"
	schemaCache = ".dev/schemas"
)

// guestFiles are k3s's files in the VM, from the repository: written
// before k3s is installed, and again whenever they change.
var guestFiles = []struct {
	src, dst, mode string
	restartsK3s    bool
}{
	{"infra/k3s/sysctl.conf", "/etc/sysctl.d/90-k3s.conf", "644", false},
	{"infra/k3s/config.yaml", "/etc/rancher/k3s/config.yaml", "600", true},
	{"infra/local/k3s-local.yaml", "/etc/rancher/k3s/config.yaml.d/50-local.yaml", "600", true},
	{"infra/k3s/psa.yaml", "/var/lib/rancher/k3s/server/psa.yaml", "600", true},
	{"infra/k3s/audit.yaml", "/var/lib/rancher/k3s/server/audit.yaml", "600", true},
}

// guestDirs are k3s's folders that hold its settings and its API
// server's audit log, made root's alone before k3s first starts.
var guestDirs = []string{"/var/lib/rancher/k3s/server", "/var/lib/rancher/k3s/server/logs"}

// cluster is the local cluster, driven through c.
type cluster struct {
	cmd commands
	out io.Writer
	// state is stateDir; kubeconfig is its kubeconfig.
	state, kubeconfig string
	// installer fetches k3s's install.sh from its address.
	installer func(ctx context.Context, url string) ([]byte, error)
	// certificate makes, or reuses, the certificate for the players' hosts
	// in a folder.
	certificate func(ctx context.Context, dir string, hosts []string) (devcert.Certs, error)
	// poll is how long a wait for the cluster rests between two looks.
	poll time.Duration
}

func newCluster(c commands, out io.Writer) *cluster {
	return &cluster{
		cmd: c, out: out, state: stateDir, kubeconfig: filepath.Join(stateDir, "kubeconfig"),
		installer: fetchInstaller, poll: 2 * time.Second,
		certificate: func(ctx context.Context, dir string, hosts []string) (devcert.Certs, error) {
			return devcert.Make(ctx, out, dir, hosts, true)
		},
	}
}

func (c *cluster) logf(format string, a ...any) { fmt.Fprintf(c.out, "cluster: "+format+"\n", a...) }

// required are the programs tools/cluster needs, and how to get each.
var required = []struct{ name, install string }{
	{"limactl", "Lima: brew install lima"},
	{"docker", "Docker Desktop, or another Docker with buildx"},
	{"kubectl", "kubectl: brew install kubectl (Docker Desktop ships one)"},
}

// checkTools fails, naming what to install, unless every program is there.
func (c *cluster) checkTools() error {
	var missing []string
	for _, r := range required {
		if _, err := c.cmd.lookPath(r.name); err != nil {
			missing = append(missing, fmt.Sprintf("%s is not installed: install %s", r.name, r.install))
		}
	}
	if len(missing) > 0 {
		return errors.New(strings.Join(missing, "; "))
	}
	return nil
}

func (c *cluster) run(ctx context.Context, argv ...string) ([]byte, error) {
	return c.cmd.run(ctx, cmd{argv: argv})
}

// stream runs argv with its output shown as it runs.
func (c *cluster) stream(ctx context.Context, argv ...string) error {
	_, err := c.cmd.run(ctx, cmd{argv: argv, out: c.out})
	return err
}

// guest runs argv in the VM.
func (c *cluster) guest(ctx context.Context, stdin io.Reader, argv ...string) ([]byte, error) {
	return c.cmd.run(ctx, cmd{argv: append([]string{"limactl", "shell", "--workdir", "/", vmName}, argv...), stdin: stdin})
}

// kubectl runs kubectl against the local cluster alone.
func (c *cluster) kubectl(ctx context.Context, stdin io.Reader, args ...string) ([]byte, error) {
	return c.cmd.run(ctx, cmd{argv: append([]string{"kubectl", "--kubeconfig", c.kubeconfig, "--context", vmName}, args...), stdin: stdin})
}

// vmStatus is the VM's status as Lima reports it, or "" if there is none.
func (c *cluster) vmStatus(ctx context.Context) (string, error) {
	out, err := c.run(ctx, "limactl", "list", "--json")
	if err != nil {
		return "", err
	}
	dec := json.NewDecoder(bytes.NewReader(out))
	for {
		var vm struct{ Name, Status string }
		if err := dec.Decode(&vm); err == io.EOF {
			return "", nil
		} else if err != nil {
			return "", fmt.Errorf("reading limactl list: %w", err)
		}
		if vm.Name == vmName {
			return vm.Status, nil
		}
	}
}

// startVM makes the VM from infra/local/lima.yaml, or starts it.
func (c *cluster) startVM(ctx context.Context) error {
	status, err := c.vmStatus(ctx)
	if err != nil {
		return err
	}
	switch status {
	case "Running":
		return nil
	case "":
		c.logf("making the VM %s from %s (the first time, Lima downloads Ubuntu's image)", vmName, limaFile)
		if err := c.stream(ctx, "limactl", "create", "--name="+vmName, "--tty=false", limaFile); err != nil {
			return err
		}
	}
	c.logf("starting the VM %s", vmName)
	return c.stream(ctx, "limactl", "start", "--tty=false", vmName)
}

// installK3s writes k3s's files into the VM and installs k3s at the pinned
// version, unless it is there; when a setting changed under a running k3s,
// k3s is restarted.
func (c *cluster) installK3s(ctx context.Context) error {
	k3s, err := pinned.ReadK3s(pinned.K3sFile)
	if err != nil {
		return err
	}
	for _, d := range guestDirs {
		if _, err := c.guest(ctx, nil, "sudo", "install", "-d", "-m", "700", d); err != nil {
			return err
		}
	}
	restart := false
	for _, f := range guestFiles {
		want, err := os.ReadFile(f.src)
		if err != nil {
			return err
		}
		have, _ := c.guest(ctx, nil, "sudo", "cat", f.dst)
		if bytes.Equal(have, want) {
			continue
		}
		c.logf("writing %s to %s in the VM", f.src, f.dst)
		if _, err := c.guest(ctx, bytes.NewReader(want), "sudo", "install", "-D", "-m", f.mode, "/dev/stdin", f.dst); err != nil {
			return err
		}
		if f.dst == guestFiles[0].dst {
			if _, err := c.guest(ctx, nil, "sudo", "sysctl", "--quiet", "--system"); err != nil {
				return err
			}
		}
		restart = restart || f.restartsK3s
	}
	version, _ := c.guest(ctx, nil, "k3s", "--version")
	if strings.Contains(string(version), k3s.Version) {
		if restart {
			c.logf("k3s's settings changed: restarting k3s")
			_, err := c.guest(ctx, nil, "sudo", "systemctl", "restart", "k3s")
			return err
		}
		return nil
	}
	script, err := c.installer(ctx, k3s.InstallerURL())
	if err != nil {
		return err
	}
	c.logf("installing k3s %s", k3s.Version)
	_, err = c.cmd.run(ctx, cmd{
		argv:  []string{"limactl", "shell", "--workdir", "/", vmName, "sudo", "env", "INSTALL_K3S_VERSION=" + k3s.Version, "sh", "-s", "-"},
		stdin: bytes.NewReader(script),
		out:   c.out,
	})
	return err
}

// fetchInstaller downloads k3s's install.sh from u, which names it by the
// pinned commit: the address is the check, as the commit is what the file
// was when it was pinned. Only a shell script is handed on to run as root.
func fetchInstaller(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("downloading k3s's installer: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("downloading k3s's installer: %s", res.Status)
	}
	script, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("downloading k3s's installer: %w", err)
	}
	if !bytes.HasPrefix(script, []byte("#!/bin/sh")) {
		return nil, fmt.Errorf("what %s holds is not k3s's installer, a shell script: not running it", u)
	}
	return script, nil
}

// kubeconfig is the parts of a kubeconfig tools/cluster rewrites.
type kubeconfig struct {
	APIVersion string `yaml:"apiVersion"`
	Kind       string `yaml:"kind"`
	Clusters   []struct {
		Name    string         `yaml:"name"`
		Cluster map[string]any `yaml:"cluster"`
	} `yaml:"clusters"`
	Users []struct {
		Name string         `yaml:"name"`
		User map[string]any `yaml:"user"`
	} `yaml:"users"`
	Contexts []struct {
		Name    string         `yaml:"name"`
		Context map[string]any `yaml:"context"`
	} `yaml:"contexts"`
	CurrentContext string `yaml:"current-context"`
}

// localKubeconfig rewrites k3s's kubeconfig for the Mac: the API at the
// port Lima forwards, and every name keel-local.
func localKubeconfig(k3s []byte) ([]byte, error) {
	var k kubeconfig
	if err := yaml.Unmarshal(k3s, &k); err != nil {
		return nil, fmt.Errorf("reading k3s's kubeconfig: %w", err)
	}
	if len(k.Clusters) != 1 || len(k.Users) != 1 || len(k.Contexts) != 1 {
		return nil, errors.New("k3s's kubeconfig does not hold one cluster, user and context")
	}
	k.Clusters[0].Name = vmName
	k.Clusters[0].Cluster["server"] = "https://" + apiAddr
	k.Users[0].Name = vmName
	k.Contexts[0].Name = vmName
	k.Contexts[0].Context = map[string]any{"cluster": vmName, "user": vmName}
	k.CurrentContext = vmName
	return yaml.Marshal(k)
}

// writeKubeconfig reads k3s's kubeconfig in the VM, root's alone, and
// writes the Mac's copy, the user's alone.
func (c *cluster) writeKubeconfig(ctx context.Context) error {
	k3s, err := c.guest(ctx, nil, "sudo", "cat", "/etc/rancher/k3s/k3s.yaml")
	if err != nil {
		return err
	}
	local, err := localKubeconfig(k3s)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(c.state, 0o700); err != nil {
		return err
	}
	tmp := c.kubeconfig + ".tmp"
	if err := os.WriteFile(tmp, local, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.kubeconfig)
}

// waitKubectl runs kubectl wait, or rollout status, until it succeeds or
// timeout passes: what it waits for may not exist yet.
func (c *cluster) waitKubectl(ctx context.Context, what string, timeout time.Duration, args ...string) error {
	c.logf("waiting for %s", what)
	deadline := time.Now().Add(timeout)
	for {
		_, err := c.kubectl(ctx, nil, append(args, "--timeout=30s")...)
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s: not within %v: %w", what, timeout, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

func (c *cluster) stopVM(ctx context.Context) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	return c.stream(ctx, "limactl", "stop", vmName)
}

// deleteVM deletes the VM, with the cluster in it, and the local state;
// Lima's cache of downloaded images stays.
func (c *cluster) deleteVM(ctx context.Context, in io.Reader) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	if !confirm(in, c.out, fmt.Sprintf("Delete the VM %s, its cluster and database, and %s?", vmName, c.state)) {
		return errors.New("not deleted")
	}
	status, err := c.vmStatus(ctx)
	if err != nil {
		return err
	}
	if status != "" {
		if err := c.stream(ctx, "limactl", "delete", "--force", vmName); err != nil {
			return err
		}
	}
	return os.RemoveAll(c.state)
}
