// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"bytes"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestPrefixedWritesWholeLines(t *testing.T) {
	var mu sync.Mutex
	var out bytes.Buffer
	w := newPrefixed(&mu, &out, "keel")
	for _, part := range []string{"first li", "ne\nsecond\nthi", "rd\n"} {
		if _, err := w.Write([]byte(part)); err != nil {
			t.Fatal(err)
		}
	}
	want := "keel │ first line\nkeel │ second\nkeel │ third\n"
	if out.String() != want {
		t.Fatalf("got %q, want %q", out.String(), want)
	}
}

func TestGoSnapshotNoticesChanges(t *testing.T) {
	root := t.TempDir()
	write := func(p, s string) {
		t.Helper()
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("cmd/a.go", "package a")
	snap := func() string {
		t.Helper()
		s, err := goSnapshot(root)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	first := snap()

	// Files that are not Go source, and folders that are skipped, change nothing.
	write("README.md", "x")
	write("client/src/b.go", "package b")
	write("node_modules/c/c.go", "package c")
	if snap() != first {
		t.Fatal("snapshot changed for files that are not watched")
	}

	write("cmd/a.go", "package a // edited")
	if snap() == first {
		t.Fatal("snapshot missed an edit")
	}
	second := snap()
	write("internal/d/d.go", "package d")
	if snap() == second {
		t.Fatal("snapshot missed a new file")
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		sign int
	}{
		{"v24.21.0", "24.21.0", 0},
		{"v24.21.1", "24.21.0", 1},
		{"v24.12.0", "24.21.0", -1},
		{"12.2", "12.2.0", 0},
	}
	for _, c := range cases {
		got := compareVersions(c.a, c.b)
		if (got > 0) != (c.sign > 0) || (got < 0) != (c.sign < 0) {
			t.Errorf("compareVersions(%s, %s) = %d", c.a, c.b, got)
		}
	}
	if major("v24.21.0") != 24 || major("12.2.0") != 12 {
		t.Error("major")
	}
}

func TestPlayOrigin(t *testing.T) {
	if got := playOrigin(nil); got != "https://localhost:5173" {
		t.Errorf("no network: %s", got)
	}
	if got := playOrigin([]net.IP{net.ParseIP("192.168.1.20")}); got != "https://192.168.1.20:5173" {
		t.Errorf("network: %s", got)
	}
	hosts := certHosts([]net.IP{net.ParseIP("10.0.0.5")})
	if len(hosts) != 4 || hosts[3] != "10.0.0.5" {
		t.Errorf("certHosts = %v", hosts)
	}
}

func TestProcStopsItsProcessGroup(t *testing.T) {
	var mu sync.Mutex
	var out bytes.Buffer
	// The shell starts a child of its own; stopping must end both.
	p, err := startProc("sh", ".", nil, newPrefixed(&mu, &out, "sh"), "sh", "-c", "sleep 60 & wait")
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	p.stop(2 * time.Second)
	select {
	case <-p.done:
	default:
		t.Fatal("process still running after stop")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("stop took too long")
	}
}

func TestProcExitIsReported(t *testing.T) {
	var mu sync.Mutex
	var out bytes.Buffer
	p, err := startProc("sh", ".", nil, newPrefixed(&mu, &out, "sh"), "sh", "-c", "echo hello; exit 3")
	if err != nil {
		t.Fatal(err)
	}
	<-p.done
	if err := p.exitErr(); err == nil || !bytes.Contains([]byte(err.Error()), []byte("exit status 3")) {
		t.Fatalf("exitErr = %v", err)
	}
	if out.String() != "sh   │ hello\n" {
		t.Fatalf("output %q", out.String())
	}
}

func TestPruneOlder(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	for name, age := range map[string]time.Duration{"old.log": 2 * time.Hour, "new.log": time.Minute} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, now.Add(-age), now.Add(-age)); err != nil {
			t.Fatal(err)
		}
	}
	if err := pruneOlder(dir, time.Hour, now); err != nil {
		t.Fatal(err)
	}
	names, _ := filepath.Glob(filepath.Join(dir, "*"))
	if len(names) != 1 || filepath.Base(names[0]) != "new.log" {
		t.Fatalf("left %v", names)
	}
	if err := pruneOlder(filepath.Join(dir, "none"), time.Hour, now); err != nil {
		t.Fatalf("a missing folder: %v", err)
	}
}
