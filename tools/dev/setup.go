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
	"strconv"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/devcert"
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

// buildPhysics builds the client's physics module. The first time, it
// downloads the pinned TinyGo into .dev.
func buildPhysics(ctx context.Context, out io.Writer) error {
	return runIn(ctx, ".", out, "go", "run", "./tools/physics")
}

// certHosts are the names a phone or a browser on this computer may use.
func certHosts(lan []net.IP) []string {
	hosts := []string{"localhost", "127.0.0.1", "::1"}
	for _, ip := range lan {
		hosts = append(hosts, ip.String())
	}
	return hosts
}

// makeCerts makes, or reuses, tools/dev's certificate, signed by mkcert's
// local root; with trust, the root is trusted on this computer too.
func makeCerts(ctx context.Context, out io.Writer, hosts []string, trust bool) (devcert.Certs, error) {
	return devcert.Make(ctx, out, filepath.Join(stateDir, "certs"), hosts, trust)
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
