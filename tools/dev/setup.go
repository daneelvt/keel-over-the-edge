// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// checkToolchain fails with what to install when Node or npm is missing or
// too old. Go fetches its own toolchain from go.mod.
func checkToolchain(ctx context.Context) error {
	want, err := os.ReadFile(".nvmrc")
	if err != nil {
		return err
	}
	wantNode := strings.TrimSpace(string(want))
	node, err := output(ctx, "node", "--version")
	if err != nil {
		return fmt.Errorf("node is not installed: install Node %s (nvm install)", wantNode)
	}
	if major(node) != major(wantNode) || compareVersions(node, wantNode) < 0 {
		return fmt.Errorf("node is %s; this repository needs %s (nvm install && nvm use)", node, wantNode)
	}
	npm, err := output(ctx, "npm", "--version")
	if err != nil {
		return errors.New("npm is not installed")
	}
	if major(npm) < 12 {
		return fmt.Errorf("npm is %s; this repository needs npm 12 (npm install -g npm@12)", npm)
	}
	return nil
}

// installClient runs npm ci when node_modules is missing or older than the
// lock file.
func installClient(ctx context.Context, out io.Writer) error {
	lock, err := os.Stat(filepath.Join(clientDir, "package-lock.json"))
	if err != nil {
		return err
	}
	marker, err := os.Stat(filepath.Join(clientDir, "node_modules", ".package-lock.json"))
	if err == nil && !marker.ModTime().Before(lock.ModTime()) {
		return nil
	}
	fmt.Fprintln(out, "dev: installing client packages (npm ci)")
	return runIn(ctx, clientDir, out, "npm", "ci")
}

func generateCatalog(ctx context.Context, out io.Writer) error {
	return runIn(ctx, ".", out, "go", "run", "./tools/catalog")
}

// certs are the paths of the local TLS certificate and the root it chains to.
type certs struct {
	cert, key, root string
}

// makeCerts makes, or reuses, a certificate for localhost and every local
// network address, signed by mkcert's local root. With trust, the root is
// also added to this computer's trust stores (asking for its password once).
func makeCerts(ctx context.Context, out io.Writer, hosts []string, trust bool) (certs, error) {
	caroot, err := output(ctx, "go", "tool", "mkcert", "-CAROOT")
	if err != nil {
		return certs{}, err
	}
	dir := filepath.Join(stateDir, "certs")
	c := certs{
		cert: filepath.Join(dir, "cert.pem"),
		key:  filepath.Join(dir, "key.pem"),
		root: filepath.Join(caroot, "rootCA.pem"),
	}
	if trust {
		// Idempotent: it changes nothing when the root is already trusted.
		if err := runIn(ctx, ".", out, "go", "tool", "mkcert", "-install"); err != nil {
			return certs{}, fmt.Errorf("trusting the local root: %w", err)
		}
	}

	hostsFile := filepath.Join(dir, "hosts.txt")
	want := strings.Join(hosts, "\n") + "\n"
	if old, err := os.ReadFile(hostsFile); err == nil && string(old) == want && exists(c.cert) && exists(c.key) && exists(c.root) {
		return c, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return certs{}, err
	}
	args := append([]string{"tool", "mkcert", "-cert-file", c.cert, "-key-file", c.key}, hosts...)
	if err := runIn(ctx, ".", out, "go", args...); err != nil {
		return certs{}, fmt.Errorf("making the certificate: %w", err)
	}
	return c, os.WriteFile(hostsFile, []byte(want), 0o600)
}

// certHosts are the names a phone or a browser on this computer may use.
func certHosts(lan []net.IP) []string {
	hosts := []string{"localhost", "127.0.0.1", "::1"}
	for _, ip := range lan {
		hosts = append(hosts, ip.String())
	}
	return hosts
}

// lanAddresses returns this computer's private IPv4 addresses, those of
// Wi-Fi and Ethernet interfaces first.
func lanAddresses() []net.IP {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	type found struct {
		ip    net.IP
		order int
	}
	var all []found
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		order := 1
		for _, p := range []string{"en", "eth", "wlan", "wl"} {
			if strings.HasPrefix(ifc.Name, p) {
				order = 0
			}
		}
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			if ip4 := ipn.IP.To4(); ip4 != nil && ip4.IsPrivate() {
				all = append(all, found{ip4, order})
			}
		}
	}
	slices.SortStableFunc(all, func(a, b found) int { return a.order - b.order })
	ips := make([]net.IP, len(all))
	for i, f := range all {
		ips[i] = f.ip
	}
	return ips
}

// playOrigin is the one address players use: the first local network
// address, so a phone and this computer share an origin, or localhost when
// there is no network.
func playOrigin(lan []net.IP) string {
	host := "localhost"
	if len(lan) > 0 {
		host = lan[0].String()
	}
	return fmt.Sprintf("https://%s", net.JoinHostPort(host, strconv.Itoa(vitePort)))
}

func runIn(ctx context.Context, dir string, out io.Writer, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Stdout = out
	cmd.Stderr = out
	return cmd.Run()
}

func output(ctx context.Context, name string, args ...string) (string, error) {
	var stdout bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return strings.TrimSpace(stdout.String()), nil
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// major is the first number of a version such as v24.21.0 or 12.2.0.
func major(v string) int {
	n, _ := strconv.Atoi(strings.SplitN(strings.TrimPrefix(v, "v"), ".", 2)[0])
	return n
}

// compareVersions compares dotted versions number by number.
func compareVersions(a, b string) int {
	pa := strings.Split(strings.TrimPrefix(a, "v"), ".")
	pb := strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := range max(len(pa), len(pb)) {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x - y
		}
	}
	return 0
}
