// SPDX-License-Identifier: AGPL-3.0-only

// Command e2e runs keel for the browser tests, which Playwright starts: keel
// built from this tree, migrated and served on a database of its own on the
// test server (KEEL_TEST_DATABASE_URL, or .dev/db.env from go run ./tools/dev
// -db), on ports of its own so it can run beside go run ./tools/dev. The
// database is dropped when it stops. Land is off (KEEL_LAND=off), the
// terrain made from seed 1. Developer commands are on (POST
// /debug/wind and /debug/weather on keel's internal listener).
//
//	go run ./tools/e2e [-lag 200ms,2%] [-limit N] [-sailors N] [-client dir [-rule=false]] [-land]
//	go run ./tools/e2e -tls dir      write a throwaway certificate for localhost into dir, and exit
//
// Beside keel it runs the lag proxy (tools/lag) on 127.0.0.1:18090, in
// front of keel's play listener, at -lag, for the browser tests of a slow
// network, which reach it through a Vite of their own; and, on
// 127.0.0.1:19099, POST /restart[?down=30s], which stops keel as a
// deployment does and starts it again, after down if given, for the tests
// of a restart (with no bell: KEEL_BELL=0s) and of a world's end missed
// while keel was down. It answers once keel is ready again, or with a 500
// that says why not: what /readyz last answered and keel's last words. WebKit sends a Secure cookie
// to https only, even on localhost, so its tests reach keel through a Vite
// serving https with the certificate -tls writes.
//
// With -client, keel serves the built page from dir (KEEL_CLIENT_DIR, a
// path from the repository's root), as the image does, for the tests of
// the page as players load it, behind a stand-in for Cloudflare's edge on
// 127.0.0.1:18088, the page's origin http://localhost:18088, which
// compresses what Cloudflare would (edge.go; -rule=false as it did before
// the zone's Compression Rule); POST /restart?client=dir then
// starts keel again serving another build, as a deploy does. With -land,
// keel sails the world's land, as the page's first download fetches the
// chunks in sight of the start.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"

	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// readyWait is how long a restart waits for keel to be ready again. Across a
// missed world's end keel makes the next world as it starts, which took 29 s
// on one runner: the runners vary 2.5× in speed, so the wait is four times
// that.
const readyWait = 120 * time.Second

// The addresses keel serves the browser tests on, and the page's origin:
// Vite's, on loopback, where browsers allow a Secure cookie over http.
const (
	playAddr     = "127.0.0.1:18080"
	agentsAddr   = "127.0.0.1:18081"
	internalAddr = "127.0.0.1:19090"
	origin       = "http://localhost:5181"
	// With -client, Cloudflare's stand-in in front of keel, and so the
	// page's origin.
	edgeAddr    = "127.0.0.1:18088"
	builtOrigin = "http://localhost:18088"
	lagAddr     = "127.0.0.1:18090"
	controlAddr = "127.0.0.1:19099"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "e2e:", err)
		os.Exit(1)
	}
}

func run() error {
	lagFlag := flag.String("lag", "200ms,2%", "the lag proxy's round trip and loss")
	tlsDir := flag.String("tls", "", "write a self-signed certificate for localhost into this directory, and exit")
	limit := flag.Int("limit", 0, "keel's boat limit (KEEL_BOAT_LIMIT); its default if 0")
	sailors := flag.Int("sailors", 0, "scripted sailors for keel to sail (KEEL_DEV_SAILORS)")
	clientDir := flag.String("client", "", "serve the built page from this directory, a path from the repository's root (KEEL_CLIENT_DIR)")
	land := flag.Bool("land", false, "sail the world's land (KEEL_LAND=on)")
	rule := flag.Bool("rule", true, "with -client, compress the models as the zone's Compression Rule does; false, as Cloudflare did before it")
	flag.Parse()
	if *tlsDir != "" {
		return writeCert(*tlsDir)
	}
	lag, err := client.ParseLag(*lagFlag)
	if err != nil {
		return err
	}
	lag.Seed = 1
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	srv := storetest.ServerURL()
	if srv == "" {
		return errors.New("no test database: run go run ./tools/dev -db, or set KEEL_TEST_DATABASE_URL")
	}
	root, err := moduleRoot()
	if err != nil {
		return err
	}
	keel := filepath.Join(root, ".dev", "e2e", "keel")
	build := exec.CommandContext(ctx, "go", "build", "-o", keel, "./cmd/keel")
	build.Dir, build.Stdout, build.Stderr = root, os.Stderr, os.Stderr
	if err := build.Run(); err != nil {
		return fmt.Errorf("building keel: %w", err)
	}

	name := "keel_e2e_" + strings.ToLower(rand.Text()[:16])
	if err := storetest.CreateDatabase(ctx, srv, name, ""); err != nil {
		return fmt.Errorf("the test database: %w", err)
	}
	defer func() {
		dctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := storetest.DropDatabase(dctx, srv, name); err != nil {
			fmt.Fprintln(os.Stderr, "e2e: dropping the database:", err)
		}
	}()
	dbURL, err := storetest.WithDatabase(srv, name)
	if err != nil {
		return err
	}
	page, err := pageEnv(root, *clientDir)
	if err != nil {
		return err
	}
	env := append(os.Environ(), page...)
	env = append(env,
		"KEEL_DATABASE_URL="+dbURL,
		"KEEL_PLAY_ADDR="+playAddr,
		"KEEL_AGENTS_ADDR="+agentsAddr,
		"KEEL_INTERNAL_ADDR="+internalAddr,
		"KEEL_LOG_LEVEL=warn",
		"KEEL_DEV_COMMANDS=1",
		// A restart in a test needs no time for the bell to be seen.
		"KEEL_BELL=0s",
		// The tests sail open sea, but for -land's, on a world whose terrain
		// is made all the same (from a fixed seed, in a time that does not
		// change from run to run), stored and loaded.
		"KEEL_LAND="+onOff(*land),
		"KEEL_WORLD_SEED=1",
		fmt.Sprintf("KEEL_DEV_SAILORS=%d", *sailors),
	)
	if *limit > 0 {
		env = append(env, fmt.Sprintf("KEEL_BOAT_LIMIT=%d", *limit))
	}
	migrate := exec.CommandContext(ctx, keel, "migrate")
	migrate.Env, migrate.Stdout, migrate.Stderr = env, os.Stderr, os.Stderr
	if err := migrate.Run(); err != nil {
		return fmt.Errorf("keel migrate: %w", err)
	}

	ln, err := net.Listen("tcp", lagAddr)
	if err != nil {
		return err
	}
	go client.Proxy(ctx, ln, playAddr, lag)
	if *clientDir != "" {
		front := &http.Server{Addr: edgeAddr, Handler: edge(playAddr, *rule)}
		go front.ListenAndServe()
		defer front.Close()
	}

	k := &keelProc{path: keel, env: env, ready: "http://" + internalAddr + "/readyz", wait: readyWait, root: root, served: *clientDir != ""}
	if err := k.start(); err != nil {
		return err
	}
	go holdWeather(ctx)
	control := &http.Server{Addr: controlAddr, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/restart" {
			http.NotFound(w, r)
			return
		}
		var down time.Duration
		client := r.URL.Query().Get("client")
		if client != "" && !k.served {
			http.Error(w, "client: keel serves no built page (no -client)", http.StatusBadRequest)
			return
		}
		if d := r.URL.Query().Get("down"); d != "" {
			var err error
			if down, err = time.ParseDuration(d); err != nil || down < 0 || down > 5*time.Minute {
				http.Error(w, "down: a duration to 5m", http.StatusBadRequest)
				return
			}
		}
		if err := k.restart(down, client); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})}
	go control.ListenAndServe()
	defer control.Close()

	select {
	case err := <-k.exited():
		return fmt.Errorf("keel serve exited: %v", err)
	case <-ctx.Done():
		k.stop()
		return nil
	}
}

// pageEnv is where the page is served from, and so its origin: Vite's,
// with keel behind it, or, given a directory of the built page, keel's
// play listener.
func pageEnv(root, client string) ([]string, error) {
	if client == "" {
		return []string{
			"KEEL_PLAY_ORIGIN=" + origin,
			// The lagged server's page and WebKit's, on https, make and use
			// passkeys too.
			"KEEL_PASSKEY_ORIGINS=http://localhost:5182,https://localhost:5183",
		}, nil
	}
	dir, err := builtDir(root, client)
	if err != nil {
		return nil, err
	}
	return []string{"KEEL_PLAY_ORIGIN=" + builtOrigin, "KEEL_CLIENT_DIR=" + dir}, nil
}

// builtDir is a built page's directory, given from the repository's root
// or absolute: one inside the repository that holds index.html.
func builtDir(root, client string) (string, error) {
	dir := client
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(root, dir)
	}
	rel, err := filepath.Rel(root, dir)
	if err != nil || !filepath.IsLocal(rel) {
		return "", fmt.Errorf("-client %s: not inside the repository", client)
	}
	dir = filepath.Join(root, rel)
	if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
		return "", fmt.Errorf("-client %s: no built page there (vite build in client/ first): %w", client, err)
	}
	return dir, nil
}

func onOff(on bool) string {
	if on {
		return "on"
	}
	return "off"
}

// holdWeather holds the world's weather to one endless spell of the
// catalog's commonest regime once keel is ready, so the specs sail in a
// steady breeze, gusts and shifts and all, whatever the world's own week
// brings at the hour they run: a breeze no light air or front stills. A
// developer's weather is in the checkpoint, so it holds across a restart.
func holdWeather(ctx context.Context) {
	cat, err := catalog.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2e: the catalog:", err)
		return
	}
	id, share := "", 0.0
	for _, r := range cat.Weather.Regimes {
		if r.Share > share {
			id, share = string(r.ID), r.Share
		}
	}
	for ctx.Err() == nil {
		if res, err := http.Get("http://" + internalAddr + "/readyz"); err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				res, err := http.Post("http://"+internalAddr+"/debug/weather?regime="+id, "", nil)
				if err == nil {
					res.Body.Close()
					fmt.Fprintf(os.Stderr, "e2e: the weather held to %s\n", id)
					return
				}
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// keelProc is keel serve, which a test may restart.
type keelProc struct {
	path string
	env  []string
	// ready is keel's /readyz, and wait how long a restart waits for it.
	ready string
	wait  time.Duration
	// root is the repository's, which a restart's client directory is
	// given from; served, whether keel serves a built page.
	root   string
	served bool
	// said keeps keel's last lines of output, for a restart that fails.
	said tail

	mu  sync.Mutex
	cmd *exec.Cmd
	// done is closed when cmd has exited, its error then in err.
	done chan struct{}
	err  error
	// died is told when keel exits other than by stop or restart.
	died chan error
}

func (k *keelProc) start() error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.died == nil {
		k.died = make(chan error, 1)
	}
	cmd := exec.Command(k.path, "serve")
	cmd.Env = k.env
	cmd.Stdout = io.MultiWriter(os.Stdout, &k.said)
	cmd.Stderr = io.MultiWriter(os.Stderr, &k.said)
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	k.cmd, k.done = cmd, done
	go func() {
		err := cmd.Wait()
		k.mu.Lock()
		k.err = err
		current := k.cmd == cmd
		k.mu.Unlock()
		close(done)
		if current {
			k.died <- err
		}
	}()
	return nil
}

func (k *keelProc) exited() <-chan error { return k.died }

// stop stops keel in order, as SIGTERM does, and waits for it.
func (k *keelProc) stop() {
	k.mu.Lock()
	cmd, done := k.cmd, k.done
	k.cmd = nil
	k.mu.Unlock()
	if cmd == nil {
		return
	}
	// keel stops in order on SIGTERM. Playwright signals the whole process
	// group, keel too; it is passed on here for a stop asked any other way.
	_ = cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		_ = cmd.Process.Kill()
		<-done
	}
}

// restart stops keel and starts it again after down, serving the built
// page from client if given (and from then on), and waits until it is
// ready. If it is not ready within the wait, or exits meanwhile, the error
// says what /readyz last answered and what keel last said.
func (k *keelProc) restart(down time.Duration, client string) error {
	if client != "" {
		dir, err := builtDir(k.root, client)
		if err != nil {
			return err
		}
		k.mu.Lock()
		k.env = withEnv(k.env, "KEEL_CLIENT_DIR", dir)
		k.mu.Unlock()
	}
	k.stop()
	time.Sleep(down)
	k.said.reset()
	if err := k.start(); err != nil {
		return err
	}
	k.mu.Lock()
	done := k.done
	k.mu.Unlock()
	err := waitReady(k.ready, k.wait, done)
	if errors.Is(err, errExited) {
		k.mu.Lock()
		err = fmt.Errorf("%w (%v)", err, k.err)
		k.mu.Unlock()
	}
	if err == nil {
		return nil
	}
	if words := k.said.lines(); len(words) > 0 {
		return fmt.Errorf("%w; keel's last words:\n%s", err, strings.Join(words, "\n"))
	}
	return err
}

// withEnv is env with name set to value, in place of any it had.
func withEnv(env []string, name, value string) []string {
	out := slices.DeleteFunc(slices.Clone(env), func(e string) bool {
		return strings.HasPrefix(e, name+"=")
	})
	return append(out, name+"="+value)
}

// errExited is waitReady's error when keel exits before it is ready.
var errExited = errors.New("keel exited before it was ready")

// waitReady polls url every 100 ms until it answers 200, for up to wait, or
// until exited is closed: the error says which, and what url last answered.
func waitReady(url string, wait time.Duration, exited <-chan struct{}) error {
	start := time.Now()
	last := "nothing"
	for time.Since(start) < wait {
		res, err := http.Get(url)
		if err != nil {
			last = err.Error()
		} else {
			body, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
			last = fmt.Sprintf("%d %q", res.StatusCode, strings.TrimSpace(string(body)))
		}
		select {
		case <-exited:
			return fmt.Errorf("%w, after %s: /readyz last answered %s",
				errExited, time.Since(start).Round(100*time.Millisecond), last)
		case <-time.After(100 * time.Millisecond):
		}
	}
	return fmt.Errorf("keel was not ready again within %s: /readyz last answered %s", wait, last)
}

// tail keeps the last lines written to it.
type tail struct {
	mu      sync.Mutex
	partial []byte
	kept    []string
}

// tailLines is how many lines a tail keeps.
const tailLines = 20

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.partial = append(t.partial, p...)
	for {
		i := slices.Index(t.partial, '\n')
		if i < 0 {
			break
		}
		t.kept = append(t.kept, string(t.partial[:i]))
		t.partial = t.partial[i+1:]
	}
	if n := len(t.kept) - tailLines; n > 0 {
		t.kept = slices.Delete(t.kept, 0, n)
	}
	return len(p), nil
}

// lines is what was kept, and any line not yet ended.
func (t *tail) lines() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := slices.Clone(t.kept)
	if len(t.partial) > 0 {
		out = append(out, string(t.partial))
	}
	return out
}

func (t *tail) reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.partial, t.kept = nil, nil
}

// writeCert writes a self-signed certificate for localhost and 127.0.0.1,
// good for a day, as cert.pem and key.pem.
func writeCert(dir string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(now.UnixNano()),
		Subject:      pkix.Name{CommonName: "localhost"},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "cert.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "key.pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600)
}

func moduleRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("no go.mod above the working directory")
		}
		dir = parent
	}
}
