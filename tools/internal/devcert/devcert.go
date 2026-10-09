// SPDX-License-Identifier: AGPL-3.0-only

// Package devcert makes the local HTTPS certificates the development tools
// serve the game with, signed by mkcert's local root, and serves the page
// that walks a phone through trusting that root. tools/dev and
// tools/cluster share the root, so a phone trusts both once it trusts one.
package devcert

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Certs are the paths of a certificate, its key, and the root it chains to.
type Certs struct {
	Cert, Key, Root string
}

// Make makes, or reuses, a certificate in dir for hosts, signed by
// mkcert's local root. It is made again only when the hosts change. With
// trust, the root is also added to this computer's trust stores (asking
// for its password once).
func Make(ctx context.Context, out io.Writer, dir string, hosts []string, trust bool) (Certs, error) {
	root, err := Root(ctx)
	if err != nil {
		return Certs{}, err
	}
	c := Certs{Cert: filepath.Join(dir, "cert.pem"), Key: filepath.Join(dir, "key.pem"), Root: root}
	if trust {
		// Idempotent: it changes nothing when the root is already trusted.
		if err := run(ctx, out, "go", "tool", "mkcert", "-install"); err != nil {
			return Certs{}, fmt.Errorf("trusting the local root: %w", err)
		}
	}
	if Current(dir, hosts) && exists(c.Root) {
		return c, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Certs{}, err
	}
	args := append([]string{"tool", "mkcert", "-cert-file", c.Cert, "-key-file", c.Key}, hosts...)
	if err := run(ctx, out, "go", args...); err != nil {
		return Certs{}, fmt.Errorf("making the certificate: %w", err)
	}
	return c, os.WriteFile(filepath.Join(dir, "hosts.txt"), []byte(hostList(hosts)), 0o600)
}

// Root is the path of mkcert's local root certificate.
func Root(ctx context.Context) (string, error) {
	caroot, err := output(ctx, "go", "tool", "mkcert", "-CAROOT")
	if err != nil {
		return "", err
	}
	return filepath.Join(caroot, "rootCA.pem"), nil
}

// Current reports whether dir holds a certificate and key made for hosts.
func Current(dir string, hosts []string) bool {
	old, err := os.ReadFile(filepath.Join(dir, "hosts.txt"))
	return err == nil && string(old) == hostList(hosts) &&
		exists(filepath.Join(dir, "cert.pem")) && exists(filepath.Join(dir, "key.pem"))
}

func hostList(hosts []string) string { return strings.Join(hosts, "\n") + "\n" }

// LANAddresses returns this computer's private IPv4 addresses, those of
// Wi-Fi and Ethernet interfaces first.
func LANAddresses() []net.IP {
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

// ClientTrusting is an HTTP client that trusts the root at rootPath alone.
func ClientTrusting(rootPath string) (*http.Client, error) {
	pem, err := os.ReadFile(rootPath)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("the local root is not a PEM certificate")
	}
	return &http.Client{
		Timeout:   5 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}},
	}, nil
}

func run(ctx context.Context, out io.Writer, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
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
