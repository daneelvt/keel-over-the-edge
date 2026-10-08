// SPDX-License-Identifier: AGPL-3.0-only

// Command e2e runs keel for the browser tests, which Playwright starts: keel
// built from this tree, migrated and served on a database of its own on the
// test server (KEEL_TEST_DATABASE_URL, or .dev/db.env from go run ./tools/dev
// -db), on ports of its own so it can run beside go run ./tools/dev. The
// database is dropped when it stops.
//
//	go run ./tools/e2e
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// The addresses keel serves the browser tests on, and the page's origin:
// Vite's, on loopback, where browsers allow a Secure cookie over http.
const (
	playAddr     = "127.0.0.1:18080"
	agentsAddr   = "127.0.0.1:18081"
	internalAddr = "127.0.0.1:19090"
	origin       = "http://localhost:5181"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "e2e:", err)
		os.Exit(1)
	}
}

func run() error {
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
	)
	migrate := exec.CommandContext(ctx, keel, "migrate")
	migrate.Env, migrate.Stdout, migrate.Stderr = env, os.Stderr, os.Stderr
	if err := migrate.Run(); err != nil {
		return fmt.Errorf("keel migrate: %w", err)
	}

	serve := exec.Command(keel, "serve")
	serve.Env, serve.Stdout, serve.Stderr = env, os.Stdout, os.Stderr
	if err := serve.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- serve.Wait() }()
	select {
	case err := <-done:
		return fmt.Errorf("keel serve exited: %v", err)
	case <-ctx.Done():
		// keel stops in order on SIGTERM. Playwright signals the whole
		// process group, keel too; it is passed on here for a stop asked
		// any other way.
		_ = serve.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			_ = serve.Process.Kill()
			<-done
		}
		return nil
	}
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
