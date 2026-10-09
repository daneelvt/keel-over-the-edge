// SPDX-License-Identifier: AGPL-3.0-only

// Command e2e runs keel for the browser tests, which Playwright starts: keel
// built from this tree, migrated and served on a database of its own on the
// test server (KEEL_TEST_DATABASE_URL, or .dev/db.env from go run ./tools/dev
// -db), on ports of its own so it can run beside go run ./tools/dev. The
// database is dropped when it stops. Developer commands are on (POST
// /debug/wind on keel's internal listener).
//
//	go run ./tools/e2e [-lag 200ms,2%] [-limit N] [-sailors N]
//	go run ./tools/e2e -tls dir      write a throwaway certificate for localhost into dir, and exit
//
// Beside keel it runs the lag proxy (tools/lag) on 127.0.0.1:18090, in
// front of keel's play listener, at -lag, for the browser tests of a slow
// network, which reach it through a Vite of their own; and, on
// 127.0.0.1:19099, POST /restart, which stops keel as a deployment does and
// starts it again, for the tests of a restart (with no bell: KEEL_BELL=0s). WebKit sends a Secure cookie
// to https only, even on localhost, so its tests reach keel through a Vite
// serving https with the certificate -tls writes.
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
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// The addresses keel serves the browser tests on, and the page's origin:
// Vite's, on loopback, where browsers allow a Secure cookie over http.
const (
	playAddr     = "127.0.0.1:18080"
	agentsAddr   = "127.0.0.1:18081"
	internalAddr = "127.0.0.1:19090"
	origin       = "http://localhost:5181"
	lagAddr      = "127.0.0.1:18090"
	controlAddr  = "127.0.0.1:19099"
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
	env := append(os.Environ(),
		"KEEL_DATABASE_URL="+dbURL,
		"KEEL_PLAY_ORIGIN="+origin,
		"KEEL_PLAY_ADDR="+playAddr,
		"KEEL_AGENTS_ADDR="+agentsAddr,
		"KEEL_INTERNAL_ADDR="+internalAddr,
		"KEEL_LOG_LEVEL=warn",
		"KEEL_DEV_COMMANDS=1",
		// A restart in a test needs no time for the bell to be seen.
		"KEEL_BELL=0s",
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

	k := &keelProc{path: keel, env: env}
	if err := k.start(); err != nil {
		return err
	}
	control := &http.Server{Addr: controlAddr, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/restart" {
			http.NotFound(w, r)
			return
		}
		if err := k.restart(); err != nil {
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

// keelProc is keel serve, which a test may restart.
type keelProc struct {
	path string
	env  []string

	mu   sync.Mutex
	cmd  *exec.Cmd
	done chan error
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
	cmd.Env, cmd.Stdout, cmd.Stderr = k.env, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	k.cmd, k.done = cmd, done
	go func() {
		err := cmd.Wait()
		done <- err
		k.mu.Lock()
		current := k.cmd == cmd
		k.mu.Unlock()
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

// restart stops keel and starts it again, and waits until it is ready.
func (k *keelProc) restart() error {
	k.stop()
	if err := k.start(); err != nil {
		return err
	}
	for range 300 {
		res, err := http.Get("http://" + internalAddr + "/readyz")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("keel was not ready again within 30 s")
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
