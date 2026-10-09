// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/devcert"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/smoke"
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

// stack is keel serve and Vite, running, and the database keel uses.
type stack struct {
	mu     sync.Mutex
	out    io.Writer
	origin string
	certs  devcert.Certs
	dbURL  string
	keel   *proc
	vite   *proc
	// viteToKeel is where Vite sends the game's requests: keel, or the lag
	// proxy in front of it.
	viteToKeel string
	// limit is keel's boat limit; its default if 0.
	limit int
}

func (s *stack) buildKeel(ctx context.Context) error {
	w := newPrefixed(&s.mu, s.out, "keel")
	return runIn(ctx, ".", w, "go", "build", "-o", filepath.Join(stateDir, "keel"), "./cmd/keel")
}

// migrate brings the database's schema up to the keel just built, as a
// deployment does before starting it.
func (s *stack) migrate(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, filepath.Join(stateDir, "keel"), "migrate")
	cmd.Env = append(os.Environ(), "KEEL_DATABASE_URL="+s.dbURL)
	w := newPrefixed(&s.mu, s.out, "keel")
	cmd.Stdout, cmd.Stderr = w, w
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("keel migrate: %w", err)
	}
	return nil
}

func (s *stack) startKeel(ctx context.Context) error {
	if err := pruneOlder(replayDir, replayKeep, time.Now()); err != nil {
		return err
	}
	if err := s.migrate(ctx); err != nil {
		return err
	}
	env := []string{
		"KEEL_DATABASE_URL=" + s.dbURL,
		"KEEL_PLAY_ADDR=" + playAddr,
		"KEEL_PLAY_ORIGIN=" + s.origin,
		"KEEL_AGENTS_ADDR=" + agentsAddr,
		"KEEL_INTERNAL_ADDR=" + internalAddr,
		"KEEL_TRACE_DIR=" + traceDir,
		"KEEL_REPLAY_DIR=" + replayDir,
		"KEEL_DEV_COMMANDS=1",
		// A restart on a change to the code needs no time for the bell to
		// be seen; the boats are kept all the same.
		"KEEL_BELL=0s",
	}
	if n := os.Getenv("KEEL_DEV_SAILORS"); n != "" {
		env = append(env, "KEEL_DEV_SAILORS="+n)
	}
	if s.limit > 0 {
		env = append(env, fmt.Sprintf("KEEL_BOAT_LIMIT=%d", s.limit))
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
	fmt.Fprintf(out, "    wind      curl -X POST '%s/debug/wind?knots=15&from=270'\n", base)
	fmt.Fprintf(out, "    input logs in %s, traces of slow ticks in %s\n\n", replayDir, traceDir)
}

func (s *stack) startVite() error {
	cert, err := filepath.Abs(s.certs.Cert)
	if err != nil {
		return err
	}
	key, err := filepath.Abs(s.certs.Key)
	if err != nil {
		return err
	}
	p, err := startProc("vite", clientDir, []string{
		"KEEL_DEV_CERT=" + cert,
		"KEEL_DEV_KEY=" + key,
		"KEEL_PLAY_ADDR=" + cmp.Or(s.viteToKeel, playAddr),
		"FORCE_COLOR=1",
	}, newPrefixed(&s.mu, s.out, "vite"), filepath.Join("node_modules", ".bin", "vite"))
	s.vite = p
	return err
}

func (s *stack) start(ctx context.Context) error {
	if err := s.buildKeel(ctx); err != nil {
		return err
	}
	if err := s.startKeel(ctx); err != nil {
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
// source changes. Vite reloads the client by itself. With lag, the game's
// traffic between Vite and keel goes through the lag proxy; with a limit,
// keel holds at most that many boats at sea.
func runDev(ctx context.Context, out io.Writer, lag string, limit int) error {
	if limit < 0 || limit > sim.Capacity {
		return fmt.Errorf("-limit %d: from 1 to %d, or 0 for keel's default", limit, sim.Capacity)
	}
	if err := prepare(ctx, out); err != nil {
		return err
	}
	db, err := devDatabase(ctx, out)
	if err != nil {
		return err
	}
	lan := devcert.LANAddresses()
	c, err := makeCerts(ctx, out, certHosts(lan), true)
	if err != nil {
		return err
	}
	s := &stack{out: out, origin: playOrigin(lan), certs: c, dbURL: db.App, limit: limit}
	if limit > 0 {
		fmt.Fprintf(newPrefixed(&s.mu, out, "dev"), "at most %d boats at sea: more players wait in the queue\n", limit)
	}
	if lag != "" {
		l, err := client.ParseLag(lag)
		if err != nil {
			return err
		}
		l.Seed = uint64(time.Now().UnixNano())
		ln, err := net.Listen("tcp", lagAddr)
		if err != nil {
			return err
		}
		go client.Proxy(ctx, ln, playAddr, l)
		s.viteToKeel = lagAddr
		fmt.Fprintf(newPrefixed(&s.mu, out, "dev"), "the game's traffic goes through the lag proxy: %s round trip and loss\n", l)
	}
	if err := s.start(ctx); err != nil {
		return err
	}
	defer s.stop()

	caSrv, err := servePhoneSetup(c.Root, s.origin)
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
			if err := s.startKeel(ctx); err != nil {
				return err
			}
		}
	}
}

// runSmoke starts everything, checks the page and /api/version over HTTPS
// trusting only the local root, makes a guest and reads it back, and stops.
// CI runs it on every push.
func runSmoke(ctx context.Context, out io.Writer) error {
	if err := prepare(ctx, out); err != nil {
		return err
	}
	db, err := devDatabase(ctx, out)
	if err != nil {
		return err
	}
	c, err := makeCerts(ctx, out, certHosts(devcert.LANAddresses()), false)
	if err != nil {
		return err
	}
	base := fmt.Sprintf("https://127.0.0.1:%d", vitePort)
	s := &stack{out: out, origin: base, certs: c, dbURL: db.App}
	if err := s.start(ctx); err != nil {
		return err
	}
	defer s.stop()

	client, err := devcert.ClientTrusting(c.Root)
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
	if err := smoke.ModuleServed(ctx, client, base+"/src/predict/physics.wasm"); err != nil {
		return err
	}
	if err := checkInternal(ctx, s); err != nil {
		return err
	}
	name, jar, err := smoke.Guest(ctx, client, base)
	if err != nil {
		return err
	}
	_, jar2, err := smoke.Guest(ctx, client, base)
	if err != nil {
		return err
	}
	if err := smoke.Game(ctx, client, jar, jar2, base); err != nil {
		return err
	}
	fmt.Fprintf(out, "smoke: ok: page, /api/version and the physics module over HTTPS, keel's probes and metrics, a guest made and read back (%s), the game connection's Welcome, snapshot and Pong, and a second player seeing the first's boat (build %s, catalog %s)\n", name, v.Build, v.Catalog)
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
	return smoke.Metrics(metrics)
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
		// The store's queries: valid against the migrations, and the
		// generated code current. Without cgo, sqlc parses SQL with
		// PostgreSQL's parser compiled to WebAssembly: no C compiler needed.
		{".", []string{"env", "CGO_ENABLED=0", "go", "tool", "sqlc", "compile", "-f", "internal/store/sqlc.yaml"}},
		{".", []string{"env", "CGO_ENABLED=0", "go", "tool", "sqlc", "diff", "-f", "internal/store/sqlc.yaml"}},
		{".", []string{"go", "run", "./tools/confusables", "-check"}},
		// The game connection's schema: buf's own rules, and the code
		// generated from it current.
		{"shared/protocol", []string{"../../client/node_modules/.bin/buf", "lint"}},
		{".", []string{"go", "run", "./tools/protocol", "-check"}},
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
