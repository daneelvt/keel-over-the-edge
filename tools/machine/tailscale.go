// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/production"
)

// The tags of the tailnet policy: the node a workflow joins as, and the
// machine.
const (
	ciTag      = "tag:ci-prod"
	machineTag = "tag:keel-prod"
)

// The files -join writes: tailscaled's socket and log, the machine's host
// keys as the tailnet holds them, and its address on the tailnet.
func (m *machine) socket() string     { return m.path(stateDir, "tailscaled.sock") }
func (m *machine) knownHosts() string { return m.path(stateDir, "known_hosts") }
func (m *machine) hostFile() string   { return m.path(stateDir, "host") }

// tailscale runs Tailscale's client as root, against the tool's own
// tailscaled.
func (m *machine) tailscale(ctx context.Context, bin string, args ...string) ([]byte, error) {
	return m.cmd.run(ctx, cmd{argv: append([]string{"sudo", bin, "--socket=" + m.socket()}, args...)})
}

// join starts tailscaled, its state in memory, and joins the tailnet as
// an ephemeral node tagged tag:ci-prod: the identity infra/production.yaml
// names (tailscale.join) mints the key, from the job's OIDC token, which
// Tailscale accepts only from the machine workflow on main, approved in
// the production environment. Then it waits for the machine to be seen,
// and writes the host keys the tailnet holds for it into a known_hosts of
// its own, so SSH checks the machine's key strictly.
//
// tailscale up would fetch the job's token itself, but under sudo the
// variables it needs are gone; the token is handed to it in a file, the
// job's alone, removed at once.
func (m *machine) join(ctx context.Context) error {
	id := m.prod.Tailscale.Join
	if err := production.Need(map[string]string{"tailscale.join.clientID": id.ClientID, "tailscale.join.audience": id.Audience, "tailnet": m.prod.Tailnet}); err != nil {
		return err
	}
	bin, err := m.tool(ctx, pinned.Tailscale)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(m.path(stateDir), 0o700); err != nil {
		return err
	}
	m.logf("starting tailscaled %s", pinned.Tailscale.Version())
	if err := m.cmd.start(cmd{argv: []string{"sudo", filepath.Join(filepath.Dir(bin), "tailscaled"), "--state=mem:", "--socket=" + m.socket()}, log: m.path(stateDir, "tailscaled.log")}); err != nil {
		return err
	}
	if err := m.wait(ctx, "tailscaled", time.Minute, func() (bool, error) {
		_, err := m.tailscale(ctx, bin, "status", "--json")
		return err == nil, nil
	}); err != nil {
		return err
	}

	jwt, err := m.idToken(ctx, id.Audience)
	if err != nil {
		return err
	}
	tokenFile := m.path(stateDir, "id-token")
	if err := os.WriteFile(tokenFile, []byte(jwt), 0o600); err != nil {
		return err
	}
	defer os.Remove(tokenFile)
	name := "ci-" + os.Getenv("GITHUB_RUN_ID") + "-" + os.Getenv("GITHUB_RUN_ATTEMPT")
	m.logf("joining the tailnet as %s, %s", name, ciTag)
	if _, err := m.tailscale(ctx, bin, "up",
		"--client-id="+id.ClientID+"?ephemeral=true&preauthorized=true",
		"--id-token=file:"+tokenFile,
		"--advertise-tags="+ciTag,
		"--hostname="+name,
		"--accept-dns=false", "--accept-routes=false", "--timeout=2m"); err != nil {
		return err
	}
	os.Remove(tokenFile)

	var peer peerStatus
	if err := m.wait(ctx, "the machine "+m.prod.Machine+" on the tailnet", 2*time.Minute, func() (bool, error) {
		out, err := m.tailscale(ctx, bin, "status", "--json")
		if err != nil {
			return false, nil
		}
		p, err := findMachine(out, m.prod.MagicDNS())
		if err != nil {
			return false, err
		}
		peer = p
		return p.Online && len(p.SSHHostKeys) > 0, nil
	}); err != nil {
		return err
	}
	hosts, err := knownHosts(peer, m.prod.MagicDNS())
	if err != nil {
		return err
	}
	if err := os.WriteFile(m.knownHosts(), hosts, 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(m.hostFile(), []byte(peer.TailscaleIPs[0]+"\n"), 0o600); err != nil {
		return err
	}
	if out, err := m.tailscale(ctx, bin, "ping", "--c=1", "--timeout=10s", peer.TailscaleIPs[0]); err == nil {
		m.logf("%s", strings.TrimSpace(string(out)))
		fmt.Fprintf(m.summary, "The runner reached `%s` over the tailnet: `%s`\n\n", m.prod.Machine, strings.TrimSpace(string(out)))
	}
	m.logf("the machine is %s at %s; its host keys are in %s", m.prod.MagicDNS(), peer.TailscaleIPs[0], m.knownHosts())
	return nil
}

// leave logs the node out, which removes an ephemeral node from the
// tailnet at once, and stops tailscaled. It is run whatever happened
// before it, so a step that already ended it is no failure.
func (m *machine) leave(ctx context.Context) error {
	bin, err := m.tool(ctx, pinned.Tailscale)
	if err != nil {
		return err
	}
	if _, err := m.tailscale(ctx, bin, "logout"); err != nil {
		m.logf("logging out: %v", err)
	}
	if _, err := m.cmd.run(ctx, cmd{argv: []string{"sudo", "pkill", "--exact", "tailscaled"}}); err != nil {
		m.logf("stopping tailscaled: %v", err)
	}
	m.logf("left the tailnet")
	return nil
}

// peerStatus is what tailscale status --json says of a peer (Tailscale's
// ipnstate.PeerStatus).
type peerStatus struct {
	HostName     string   `json:"HostName"`
	DNSName      string   `json:"DNSName"`
	TailscaleIPs []string `json:"TailscaleIPs"`
	Online       bool     `json:"Online"`
	Tags         []string `json:"Tags"`
	SSHHostKeys  []string `json:"sshHostKeys"`
}

// findMachine finds the machine among the peers status lists, by its full
// name on the tailnet, and checks it is tagged as the machine: a node of
// another tag that took its name is not it.
func findMachine(status []byte, magicDNS string) (peerStatus, error) {
	var s struct {
		Peer map[string]peerStatus `json:"Peer"`
	}
	if err := json.Unmarshal(status, &s); err != nil {
		return peerStatus{}, fmt.Errorf("tailscale status: %w", err)
	}
	for _, p := range s.Peer {
		if strings.TrimSuffix(p.DNSName, ".") != magicDNS {
			continue
		}
		if !slices.Contains(p.Tags, machineTag) {
			return p, fmt.Errorf("%s is on the tailnet, but not tagged %s: not trusting it", magicDNS, machineTag)
		}
		if len(p.TailscaleIPs) == 0 {
			return p, fmt.Errorf("%s has no address on the tailnet", magicDNS)
		}
		return p, nil
	}
	return peerStatus{}, nil
}

// knownHosts is an OpenSSH known_hosts holding the peer's host keys, as
// the tailnet holds them, under its address and its names.
func knownHosts(p peerStatus, magicDNS string) ([]byte, error) {
	if len(p.SSHHostKeys) == 0 {
		return nil, fmt.Errorf("the tailnet holds no SSH host key for %s: is Tailscale SSH on there (tailscale set --ssh)?", magicDNS)
	}
	names := strings.Join(slices.Concat(p.TailscaleIPs, []string{magicDNS, p.HostName}), ",")
	var b bytes.Buffer
	for _, k := range p.SSHHostKeys {
		if f := strings.Fields(k); len(f) < 2 || strings.ContainsAny(k, "\n,") {
			return nil, fmt.Errorf("%q is not an SSH public key", k)
		}
		fmt.Fprintf(&b, "%s %s\n", names, strings.TrimSpace(k))
	}
	return b.Bytes(), nil
}

// wait calls done until it says so, it fails, or timeout passes.
func (m *machine) wait(ctx context.Context, what string, timeout time.Duration, done func() (bool, error)) error {
	deadline := time.Now().Add(timeout)
	for {
		ok, err := done()
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New(what + ": not within " + timeout.String())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(m.poll):
		}
	}
}
