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
	if err := generateCatalog(ctx, out); err != nil {
		return err
	}
	return buildPhysics(ctx, out)
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
	if err := pruneOlder(replayDir, replayKeep, time.Now()); err != nil {
		return err
	}
	env := []string{
		"KEEL_PLAY_ADDR=" + playAddr,
		"KEEL_PLAY_ORIGIN=" + s.origin,
		"KEEL_AGENTS_ADDR=" + agentsAddr,
		"KEEL_INTERNAL_ADDR=" + internalAddr,
		"KEEL_TRACE_DIR=" + traceDir,
		"KEEL_REPLAY_DIR=" + replayDir,
	}
	if n := os.Getenv("KEEL_DEV_SAILORS"); n != "" {
		env = append(env, "KEEL_DEV_SAILORS="+n)
	}
	p, err := startProc("keel", ".", env, newPrefixed(&s.mu, s.out, "keel"), filepath.Join(stateDir, "keel"), "serve")
	s.keel = p
	return err
}

// pruneOlder removes the files in dir last changed before keep ago.
func pruneOlder(dir string, keep time.Duration, now time.Time) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() || now.Sub(info.ModTime()) < keep {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

// printInternal prints keel's internal addresses.
func printInternal(mu *sync.Mutex, out io.Writer) {
	mu.Lock()
	defer mu.Unlock()
	base := "http://" + internalAddr
	fmt.Fprintf(out, "  keel, on this computer only:\n")
	fmt.Fprintf(out, "    probes    %s/livez  %s/readyz\n", base, base)
	fmt.Fprintf(out, "    metrics   %s/metrics\n", base)
	fmt.Fprintf(out, "    profiles  go tool pprof %s/debug/pprof/profile\n", base)
	fmt.Fprintf(out, "    trace     curl -o trace.out %s/debug/flightrecorder; go tool trace trace.out\n", base)
	fmt.Fprintf(out, "    replay    curl -o keel.log %s/debug/replay; go run ./cmd/keel replay keel.log\n", base)
	fmt.Fprintf(out, "    input logs in %s, traces of slow ticks in %s\n\n", replayDir, traceDir)
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
	printInternal(&s.mu, out)

	snap, err := goSnapshot(".")
	if err != nil {
		return err
	}
	physicsSnap, err := goSnapshot(physicsDir)
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
			if p, err := goSnapshot(physicsDir); err == nil && p != physicsSnap {
				physicsSnap = p
				fmt.Fprintln(newPrefixed(&s.mu, out, "dev"), "physics changed: rebuilding the module")
				if err := buildPhysics(ctx, newPrefixed(&s.mu, out, "physics")); err != nil {
					fmt.Fprintln(newPrefixed(&s.mu, out, "dev"), "physics build failed; the page keeps the old module")
				}
			}
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
	if err := checkModuleServed(ctx, client, base+"/src/predict/physics.wasm"); err != nil {
		return err
	}
	if err := checkInternal(ctx, s); err != nil {
		return err
	}
	fmt.Fprintf(out, "smoke: ok: page, /api/version and the physics module over HTTPS, keel's probes and metrics (build %s, catalog %s)\n", v.Build, v.Catalog)
	return nil
}

// checkInternal checks keel's internal listener: live, ready once it has
// ticked, and its metrics showing ticks.
func checkInternal(ctx context.Context, s *stack) error {
	plain := &http.Client{Timeout: 5 * time.Second}
	base := "http://" + internalAddr
	if _, err := getWhenUp(ctx, plain, base+"/livez", s); err != nil {
		return err
	}
	if _, err := getWhenUp(ctx, plain, base+"/readyz", s); err != nil {
		return err
	}
	metrics, err := getWhenUp(ctx, plain, base+"/metrics", s)
	if err != nil {
		return err
	}
	for _, name := range []string{"keel_sim_ticks_total", "keel_sim_tick_duration_seconds_bucket", "keel_build_info"} {
		if !strings.Contains(metrics, name) {
			return fmt.Errorf("smoke: /metrics has no %s", name)
		}
	}
	return nil
}

// checkModuleServed fetches the physics module as the page does. Browsers
// compile it while it downloads only when it comes as application/wasm.
func checkModuleServed(ctx context.Context, client *http.Client, url string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("smoke: %w", err)
	}
	defer res.Body.Close()
	magic := make([]byte, 4)
	if _, err := io.ReadFull(res.Body, magic); err != nil || res.StatusCode != http.StatusOK || string(magic) != "\x00asm" {
		return fmt.Errorf("smoke: %s is not a WebAssembly module (%s)", url, res.Status)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/wasm") {
		return fmt.Errorf("smoke: %s is served as %q, not application/wasm", url, ct)
	}
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
		{clientDir, []string{"npx", "--no-install", "biome", "ci", ".", "../art"}},
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
