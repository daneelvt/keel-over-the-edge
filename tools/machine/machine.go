// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/actions"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/production"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/registry"
)

// The folders and files the tool works with, from the repository's root.
const (
	devDir     = ".dev"
	stateDir   = ".dev/machine"
	venvDir    = ".dev/ansible"
	ansibleDir = "infra/ansible"
)

// machine drives the playbook and what it needs: Tailscale, Infisical,
// the release, Ansible.
type machine struct {
	// out is the log, where workflow commands (::add-mask::) go too.
	out     io.Writer
	summary io.WriteCloser
	cmd     commands
	hc      *http.Client
	prod    production.Production
	// root is the repository's root, absolute: Ansible runs from its own
	// folder, as root.
	root string
	// idToken gets the job's OIDC token for an audience.
	idToken func(ctx context.Context, audience string) (string, error)
	reg     *registry.Registry
	// tool is the path of a pinned program, fetched when first needed.
	tool func(ctx context.Context, t pinned.Tool) (string, error)
	// poll is how long a wait rests between two looks.
	poll time.Duration
}

func newMachine() (*machine, error) {
	root, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	p, err := production.Read(production.File)
	if err != nil {
		return nil, err
	}
	summary, err := actions.Summary()
	if err != nil {
		return nil, err
	}
	hc := &http.Client{Timeout: time.Minute}
	return &machine{
		out: os.Stdout, summary: summary, cmd: execCommands{}, hc: hc, prod: p, root: root,
		idToken: func(ctx context.Context, audience string) (string, error) {
			return actions.IDToken(ctx, hc, os.Stdout, audience)
		},
		reg: &registry.Registry{Base: "https://ghcr.io", HC: hc},
		tool: func(ctx context.Context, t pinned.Tool) (string, error) {
			return t.Ensure(ctx, devDir, os.Stderr)
		},
		poll: 2 * time.Second,
	}, nil
}

func (m *machine) logf(format string, a ...any) { fmt.Fprintf(m.out, "machine: "+format+"\n", a...) }

// path is a path under the repository's root.
func (m *machine) path(p ...string) string { return filepath.Join(append([]string{m.root}, p...)...) }

// commands runs the programs the tool drives. Tests replace it.
type commands interface {
	// run runs c and returns its standard output. With c.out, its output
	// goes there as it runs, and is returned too. A failure's error holds
	// its standard error.
	run(ctx context.Context, c cmd) ([]byte, error)
	// start starts c and leaves it running, its output in c.log.
	start(c cmd) error
}

type cmd struct {
	argv []string
	// env is added to the tool's own environment.
	env   []string
	stdin io.Reader
	out   io.Writer
	dir   string
	// log is where a started program writes.
	log string
}

type execCommands struct{}

func (execCommands) run(ctx context.Context, c cmd) ([]byte, error) {
	x := exec.CommandContext(ctx, c.argv[0], c.argv[1:]...)
	x.Env = append(os.Environ(), c.env...)
	x.Stdin, x.Dir = c.stdin, c.dir
	var stdout, stderr strings.Builder
	if c.out != nil {
		x.Stdout = io.MultiWriter(c.out, &stdout)
		x.Stderr = c.out
	} else {
		x.Stdout, x.Stderr = &stdout, &stderr
	}
	if err := x.Run(); err != nil {
		name := strings.Join(c.argv[:min(len(c.argv), 3)], " ")
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return []byte(stdout.String()), fmt.Errorf("%s: %w: %s", name, err, msg)
		}
		return []byte(stdout.String()), fmt.Errorf("%s: %w", name, err)
	}
	return []byte(stdout.String()), nil
}

func (execCommands) start(c cmd) error {
	log, err := os.OpenFile(c.log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer log.Close()
	x := exec.Command(c.argv[0], c.argv[1:]...)
	x.Env = append(os.Environ(), c.env...)
	x.Stdout, x.Stderr = log, log
	if err := x.Start(); err != nil {
		return err
	}
	return x.Process.Release()
}

// ansible makes Ansible's venv from the runner's own Python, with
// exactly the packages, and the files, the requirements pin.
func (m *machine) ansible(ctx context.Context, lint bool) error {
	if _, err := os.Stat(filepath.Join(venvDir, "bin", "pip")); err != nil {
		m.logf("making the venv %s", venvDir)
		if err := os.RemoveAll(venvDir); err != nil {
			return err
		}
		if _, err := m.cmd.run(ctx, cmd{argv: []string{"python3", "-m", "venv", venvDir}}); err != nil {
			return fmt.Errorf("%w (Ubuntu's python3-venv makes venvs)", err)
		}
	}
	files := []string{"requirements.txt"}
	if lint {
		files = append(files, "lint-requirements.txt")
	}
	for _, f := range files {
		m.logf("installing %s", filepath.Join(ansibleDir, f))
		if _, err := m.cmd.run(ctx, cmd{argv: []string{filepath.Join(venvDir, "bin", "pip"), "install", "--quiet", "--disable-pip-version-check",
			"--require-hashes", "--no-deps", "--only-binary=:all:", "-r", filepath.Join(ansibleDir, f)}, out: m.out}); err != nil {
			return err
		}
	}
	out, err := m.cmd.run(ctx, cmd{argv: []string{filepath.Join(venvDir, "bin", "ansible-playbook"), "--version"}})
	if err != nil {
		return err
	}
	first, _, _ := strings.Cut(string(out), "\n")
	m.logf("%s", first)
	return nil
}
