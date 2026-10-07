// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

const stopTimeout = 5 * time.Second

// prepare does what every mode needs before anything starts.
func prepare(ctx context.Context, out io.Writer) error {
	if err := checkToolchain(ctx); err != nil {
		return err
	}
	if err := installClient(ctx, out); err != nil {
		return err
	}
	return generateCatalog(ctx, out)
}

// stack is keel serve and Vite, running.
type stack struct {
	mu     sync.Mutex
	out    io.Writer
	origin string
	certs  certs
	keel   *proc
	vite   *proc
}

func (s *stack) buildKeel(ctx context.Context) error {
	w := newPrefixed(&s.mu, s.out, "keel")
	return runIn(ctx, ".", w, "go", "build", "-o", filepath.Join(stateDir, "keel"), "./cmd/keel")
}

func (s *stack) startKeel() error {
	p, err := startProc("keel", ".", []string{
		"KEEL_PLAY_ADDR=" + playAddr,
		"KEEL_PLAY_ORIGIN=" + s.origin,
	}, newPrefixed(&s.mu, s.out, "keel"), filepath.Join(stateDir, "keel"), "serve")
	s.keel = p
	return err
}

func (s *stack) startVite() error {
	cert, err := filepath.Abs(s.certs.cert)
	if err != nil {
		return err
	}
	key, err := filepath.Abs(s.certs.key)
	if err != nil {
		return err
	}
	p, err := startProc("vite", clientDir, []string{
		"KEEL_DEV_CERT=" + cert,
		"KEEL_DEV_KEY=" + key,
		"KEEL_PLAY_ADDR=" + playAddr,
		"FORCE_COLOR=1",
	}, newPrefixed(&s.mu, s.out, "vite"), filepath.Join("node_modules", ".bin", "vite"))
	s.vite = p
	return err
}

func (s *stack) start(ctx context.Context) error {
	if err := s.buildKeel(ctx); err != nil {
		return err
	}
	if err := s.startKeel(); err != nil {
		return err
	}
	if err := s.startVite(); err != nil {
		s.keel.stop(stopTimeout)
		return err
	}
	return nil
}

func (s *stack) stop() {
	if s.vite != nil {
		s.vite.stop(stopTimeout)
	}
	if s.keel != nil {
		s.keel.stop(stopTimeout)
	}
}

// runDev runs the game until interrupted, restarting keel serve when Go
// source changes. Vite reloads the client by itself.
func runDev(ctx context.Context, out io.Writer) error {
	if err := prepare(ctx, out); err != nil {
		return err
	}
	lan := lanAddresses()
	c, err := makeCerts(ctx, out, certHosts(lan), true)
	if err != nil {
		return err
	}
	s := &stack{out: out, origin: playOrigin(lan), certs: c}
	if err := s.start(ctx); err != nil {
		return err
	}
	defer s.stop()

	caSrv, err := servePhoneSetup(c.root, s.origin)
	if err != nil {
		return err
	}
	defer caSrv.Close()
	printAddresses(&s.mu, out, s.origin, lan)

	snap, err := goSnapshot(".")
	if err != nil {
		return err
	}
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-s.vite.done:
			return s.vite.exitErr()
		case <-s.keel.done:
			return s.keel.exitErr()
		case <-tick.C:
			next, err := goSnapshot(".")
			if err != nil || next == snap {
				continue
			}
			snap = next
			fmt.Fprintln(newPrefixed(&s.mu, out, "dev"), "Go source changed: rebuilding keel")
			if err := s.buildKeel(ctx); err != nil {
				fmt.Fprintln(newPrefixed(&s.mu, out, "dev"), "build failed; the running keel is kept")
				continue
			}
			s.keel.stop(stopTimeout)
			if err := s.startKeel(); err != nil {
				return err
			}
		}
	}
}

// runSmoke starts everything, checks the page and /api/version over HTTPS
// trusting only the local root, and stops. CI runs it on every push.
func runSmoke(ctx context.Context, out io.Writer) error {
	if err := prepare(ctx, out); err != nil {
		return err
	}
	c, err := makeCerts(ctx, out, certHosts(lanAddresses()), false)
	if err != nil {
		return err
	}
	base := fmt.Sprintf("https://127.0.0.1:%d", vitePort)
	s := &stack{out: out, origin: base, certs: c}
	if err := s.start(ctx); err != nil {
		return err
	}
	defer s.stop()

	client, err := clientTrusting(c.root)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	page, err := getWhenUp(ctx, client, base+"/", s)
	if err != nil {
		return err
	}
	if !strings.Contains(page, "<title>Keel Over the Edge</title>") {
		return errors.New("smoke: the page has no game title")
	}
	body, err := getWhenUp(ctx, client, base+"/api/version", s)
	if err != nil {
		return err
	}
	var v struct{ Build, Catalog string }
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return fmt.Errorf("smoke: /api/version: %w", err)
	}
	if v.Catalog != catalog.Version {
		return fmt.Errorf("smoke: server catalog %s, want %s", v.Catalog, catalog.Version)
	}
	fmt.Fprintf(out, "smoke: ok: page and /api/version over HTTPS (build %s, catalog %s)\n", v.Build, v.Catalog)
	return nil
}

func clientTrusting(rootPath string) (*http.Client, error) {
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

// getWhenUp retries url until it answers 200, a process dies or ctx ends.
func getWhenUp(ctx context.Context, client *http.Client, url string, s *stack) (string, error) {
	var last error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return "", err
		}
		res, err := client.Do(req)
		if err == nil {
			body, rerr := io.ReadAll(res.Body)
			res.Body.Close()
			if res.StatusCode == http.StatusOK && rerr == nil {
				return string(body), nil
			}
			err = fmt.Errorf("%s answered %d", url, res.StatusCode)
		}
		last = err
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("smoke: %s never answered: %w", url, last)
		case <-s.keel.done:
			return "", s.keel.exitErr()
		case <-s.vite.done:
			return "", s.vite.exitErr()
		case <-time.After(300 * time.Millisecond):
		}
	}
}

// runLint runs the same linters as the pull-request checks.
func runLint(ctx context.Context, out io.Writer) error {
	steps := []struct {
		dir  string
		argv []string
	}{
		{".", []string{"go", "vet", "./..."}},
		{".", []string{"go", "tool", "staticcheck", "./..."}},
		{clientDir, []string{"npx", "--no-install", "biome", "ci", "."}},
		{clientDir, []string{"npx", "--no-install", "tsc", "--noEmit"}},
	}
	var failed []string
	unformatted, err := output(ctx, "gofmt", "-l", "cmd", "internal", "tools")
	if err != nil || unformatted != "" {
		fmt.Fprintf(out, "gofmt: not formatted:\n%s\n", unformatted)
		failed = append(failed, "gofmt")
	}
	for _, st := range steps {
		fmt.Fprintf(out, "lint: %s\n", strings.Join(st.argv, " "))
		if err := runIn(ctx, st.dir, out, st.argv[0], st.argv[1:]...); err != nil {
			failed = append(failed, strings.Join(st.argv, " "))
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("lint failed: %s", strings.Join(failed, "; "))
	}
	fmt.Fprintln(out, "lint: ok")
	return nil
}
