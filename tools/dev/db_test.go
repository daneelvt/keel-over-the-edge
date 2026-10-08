// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

func TestFindRuntime(t *testing.T) {
	have := func(names ...string) func(string) (string, error) {
		return func(name string) (string, error) {
			for _, n := range names {
				if n == name {
					return "/usr/bin/" + name, nil
				}
			}
			return "", exec.ErrNotFound
		}
	}
	if rt, err := findRuntime(have("podman", "docker")); err != nil || rt != "/usr/bin/docker" {
		t.Errorf("both: %s, %v", rt, err)
	}
	if rt, err := findRuntime(have("podman")); err != nil || rt != "/usr/bin/podman" {
		t.Errorf("podman: %s, %v", rt, err)
	}
	_, err := findRuntime(have())
	if !errors.Is(err, errNoRuntime) {
		t.Fatalf("neither: %v", err)
	}
	for _, want := range []string{"Docker", "Podman", "KEEL_DEV_DATABASE_URL"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("%q does not say %s", err, want)
		}
	}
}

func TestEnvFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "db.env")
	u := localDB.urls("pw")
	if err := writeEnvFile(path, "pw", u); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("%v, %v", info.Mode(), err)
	}
	env, err := readEnvFile(path)
	if err != nil || env["KEEL_DEV_DB_PASSWORD"] != "pw" || env["KEEL_DATABASE_URL"] != u.App || env["KEEL_TEST_DATABASE_URL"] != u.Test {
		t.Fatalf("%v, %v", env, err)
	}
	if u.App != "postgres://keel:pw@127.0.0.1:5433/keel?sslmode=disable" {
		t.Fatalf("the URL %s", u.App)
	}
}

// TestContainer starts a database in a container of its own twice, which
// reuses it, and removes it, which leaves no volume. It needs docker or
// podman running.
func TestContainer(t *testing.T) {
	if testing.Short() {
		t.Skip("starts a container")
	}
	rt, err := findRuntime(exec.LookPath)
	if err != nil {
		t.Skip(err)
	}
	ctx := context.Background()
	if _, err := output(ctx, rt, "info"); err != nil {
		t.Skipf("%s is not running", rt)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	name := "keel-test-db-" + strings.ToLower(rand.Text()[:8])
	d := devDB{container: name, volume: name, port: port, envFile: filepath.Join(t.TempDir(), "db.env")}
	t.Cleanup(func() { _ = d.reset(context.Background(), rt, io.Discard) })

	first, err := d.start(ctx, rt, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	id, err := output(ctx, rt, "container", "inspect", "--format", "{{.Id}}", name)
	if err != nil {
		t.Fatal(err)
	}
	again, err := d.start(ctx, rt, io.Discard)
	if err != nil || again != first {
		t.Fatalf("again: %+v, %v", again, err)
	}
	if id2, _ := output(ctx, rt, "container", "inspect", "--format", "{{.Id}}", name); id2 != id {
		t.Fatal("a second start made a new container")
	}
	s, err := store.Open(ctx, first.App, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if v, err := s.SchemaVersion(ctx); err != nil || v != 0 {
		t.Fatalf("a new database at %d, %v", v, err)
	}
	s.Close()

	if err := d.reset(ctx, rt, io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, err := output(ctx, rt, "volume", "inspect", name); err == nil {
		t.Fatal("the volume is left")
	}
	if _, err := output(ctx, rt, "container", "inspect", name); err == nil {
		t.Fatal("the container is left")
	}
	if _, err := os.Stat(d.envFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the environment file is left: %v", err)
	}
}
