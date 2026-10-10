// SPDX-License-Identifier: AGPL-3.0-only

package pinned

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"
)

type entry struct {
	name, body string
	flag       byte
	link       string
}

func archive(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Typeflag: e.flag, Mode: 0o755, Size: int64(len(e.body)), Linkname: e.link}
		if e.flag != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(e.body)); err != nil && e.flag == tar.TypeReg {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestUntar(t *testing.T) {
	dir := t.TempDir()
	data := archive(t,
		entry{name: "tinygo/", flag: tar.TypeDir},
		entry{name: "tinygo/bin/tinygo", body: "#!", flag: tar.TypeReg},
	)
	if err := untar(bytes.NewReader(data), dir); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "tinygo", "bin", "tinygo"))
	if err != nil || string(got) != "#!" {
		t.Fatalf("unpacked file = %q, %v", got, err)
	}
	info, err := os.Stat(filepath.Join(dir, "tinygo", "bin", "tinygo"))
	if err != nil || info.Mode()&0o100 == 0 {
		t.Errorf("the binary lost its execute bit: %v %v", info.Mode(), err)
	}
}

func TestUntarRefuses(t *testing.T) {
	for name, e := range map[string]entry{
		"a path outside the folder": {name: "../evil", body: "x", flag: tar.TypeReg},
		"an absolute path":          {name: "/tmp/evil", body: "x", flag: tar.TypeReg},
		"a symbolic link":           {name: "tinygo/link", flag: tar.TypeSymlink, link: "/etc/passwd"},
		"a hard link":               {name: "tinygo/link", flag: tar.TypeLink, link: "tinygo/bin"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := untar(bytes.NewReader(archive(t, e)), dir); err == nil {
				t.Fatal("untar accepted it")
			}
		})
	}
}

func TestCopyChecked(t *testing.T) {
	body := "tinygo archive"
	sum := sha256.Sum256([]byte(body))
	var out bytes.Buffer
	if err := copyChecked(&out, strings.NewReader(body), hex.EncodeToString(sum[:])); err != nil {
		t.Fatalf("the right digest was refused: %v", err)
	}
	if out.String() != body {
		t.Errorf("copied %q", out.String())
	}
	if err := copyChecked(&out, strings.NewReader(body+"!"), hex.EncodeToString(sum[:])); err == nil {
		t.Fatal("a changed archive was accepted")
	}
}

// TestReleasesPinned: every tool is pinned to one release, by a digest,
// for the machines that build and release (Linux on amd64 and arm64) and
// the Mac that develops.
func TestReleasesPinned(t *testing.T) {
	digest := regexp.MustCompile(`^[0-9a-f]{64}$`)
	tag := regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+$`)
	for _, tool := range []Tool{TinyGo, Cosign, Flux} {
		var platforms []string
		for _, r := range releases {
			if r.repo != tool.repo {
				continue
			}
			platforms = append(platforms, r.platform)
			if r.tag != "v"+tool.Version() || !tag.MatchString(r.tag) {
				t.Errorf("%s for %s is pinned to %s, the others to v%s", tool.Name, r.platform, r.tag, tool.Version())
			}
			if !digest.MatchString(r.sha256) {
				t.Errorf("%s for %s: %q is not a SHA-256", tool.Name, r.platform, r.sha256)
			}
		}
		for _, want := range []string{"linux-amd64", "linux-arm64", "darwin-arm64"} {
			if !slices.Contains(platforms, want) {
				t.Errorf("%s is not pinned for %s", tool.Name, want)
			}
		}
		if _, err := tool.releaseFor("plan9-386"); err == nil || !strings.Contains(err.Error(), tool.Name+": no pinned release for plan9-386") {
			t.Errorf("%s on a platform without a pin: %v", tool.Name, err)
		}
	}
	for _, r := range releases {
		if !slices.ContainsFunc([]Tool{TinyGo, Cosign, Flux}, func(tool Tool) bool { return tool.repo == r.repo }) {
			t.Errorf("%s is pinned, but is no tool", r.repo)
		}
	}
	// The files' names, as the releases publish them.
	for tool, want := range map[*Tool]string{&TinyGo: "tinygo0.42.0.linux-arm64.tar.gz", &Cosign: "cosign-linux-arm64", &Flux: "flux_2.9.6_linux_arm64.tar.gz"} {
		version := map[*Tool]string{&TinyGo: "0.42.0", &Cosign: "3.1.3", &Flux: "2.9.6"}[tool]
		if got := tool.asset(version, "linux", "arm64"); got != want {
			t.Errorf("%s's file is named %s, want %s", tool.Name, got, want)
		}
	}
}

// pinFor serves body as the release file of a tool pinned, for this test,
// to this platform and digest.
func pinFor(t *testing.T, tool Tool, body []byte, digest string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "/" + tool.repo + "/releases/download/v1.2.3/" + tool.asset("1.2.3", runtime.GOOS, runtime.GOARCH)
		if r.URL.Path != want {
			http.NotFound(w, r)
			return
		}
		w.Write(body)
	}))
	oldBase, oldReleases := base, releases
	base = srv.URL
	releases = []release{{tool.repo, runtime.GOOS + "-" + runtime.GOARCH, "v1.2.3", digest}}
	t.Cleanup(func() { srv.Close(); base, releases = oldBase, oldReleases })
}

func sum(body []byte) string {
	s := sha256.Sum256(body)
	return hex.EncodeToString(s[:])
}

func TestEnsure(t *testing.T) {
	ctx := context.Background()
	t.Run("a program", func(t *testing.T) {
		body := []byte("#!/bin/sh\necho cosign\n")
		pinFor(t, Cosign, body, sum(body))
		dir := t.TempDir()
		bin, err := Cosign.Ensure(ctx, dir, io.Discard)
		if err != nil {
			t.Fatal(err)
		}
		if want := filepath.Join(dir, "cosign", "1.2.3", "cosign"); bin != want {
			t.Errorf("cosign is at %s, want %s", bin, want)
		}
		got, _ := os.ReadFile(bin)
		info, err := os.Stat(bin)
		if err != nil || !bytes.Equal(got, body) || info.Mode()&0o100 == 0 {
			t.Errorf("cosign: %q, %v, %v", got, info, err)
		}
		// The second time, nothing is downloaded.
		base = "http://127.0.0.1:1"
		if again, err := Cosign.Ensure(ctx, dir, io.Discard); err != nil || again != bin {
			t.Errorf("the second time: %s, %v", again, err)
		}
	})
	t.Run("an archive", func(t *testing.T) {
		body := archive(t, entry{name: "flux", body: "#!flux", flag: tar.TypeReg})
		pinFor(t, Flux, body, sum(body))
		dir := t.TempDir()
		bin, err := Flux.Ensure(ctx, dir, io.Discard)
		if err != nil {
			t.Fatal(err)
		}
		if got, _ := os.ReadFile(bin); string(got) != "#!flux" || bin != filepath.Join(dir, "flux", "1.2.3", "flux") {
			t.Errorf("flux at %s: %q", bin, got)
		}
	})
	t.Run("a download whose digest differs", func(t *testing.T) {
		for _, tool := range []Tool{Cosign, Flux} {
			body := archive(t, entry{name: "flux", body: "#!not flux", flag: tar.TypeReg})
			pinFor(t, tool, body, sum([]byte("what was pinned")))
			dir := t.TempDir()
			_, err := tool.Ensure(ctx, dir, io.Discard)
			if err == nil || !strings.Contains(err.Error(), "is pinned") || !strings.Contains(err.Error(), tool.Name+":") {
				t.Fatalf("%s with another digest: %v", tool.Name, err)
			}
			left, _ := os.ReadDir(dir)
			if len(left) != 0 {
				t.Errorf("%s: left behind %v", tool.Name, left)
			}
		}
	})
	t.Run("an archive without the program", func(t *testing.T) {
		body := archive(t, entry{name: "README", body: "no program", flag: tar.TypeReg})
		pinFor(t, Flux, body, sum(body))
		dir := t.TempDir()
		if _, err := Flux.Ensure(ctx, dir, io.Discard); err == nil || !strings.Contains(err.Error(), "holds no flux") {
			t.Fatalf("an archive with no flux: %v", err)
		}
		if left, _ := os.ReadDir(dir); len(left) != 0 {
			t.Errorf("left behind %v", left)
		}
	})
	t.Run("a platform without a pin", func(t *testing.T) {
		pinFor(t, Cosign, nil, sum(nil))
		releases[0].platform = "plan9-386"
		_, err := Cosign.Ensure(ctx, t.TempDir(), io.Discard)
		if err == nil || !strings.Contains(err.Error(), "cosign: no pinned release for "+runtime.GOOS+"-"+runtime.GOARCH) {
			t.Fatalf("no pin for this platform: %v", err)
		}
	})
}

func TestInstallLinksByName(t *testing.T) {
	ctx := context.Background()
	body := []byte("#!cosign one")
	pinFor(t, Cosign, body, sum(body))
	dir := t.TempDir()
	binDir, err := Install(ctx, dir, io.Discard, Cosign)
	if err != nil {
		t.Fatal(err)
	}
	if binDir != filepath.Join(dir, "bin") {
		t.Errorf("the folder is %s", binDir)
	}
	if got, _ := os.ReadFile(filepath.Join(binDir, "cosign")); !bytes.Equal(got, body) {
		t.Fatalf("bin/cosign: %q", got)
	}
	// A new pin replaces the link; the old version stays in its folder.
	next := []byte("#!cosign two")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write(next) }))
	defer srv.Close()
	base = srv.URL
	releases = []release{{Cosign.repo, runtime.GOOS + "-" + runtime.GOARCH, "v1.2.4", sum(next)}}
	if _, err := Install(ctx, dir, io.Discard, Cosign); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(binDir, "cosign")); !bytes.Equal(got, next) {
		t.Errorf("bin/cosign after a new pin: %q", got)
	}
	if target, _ := os.Readlink(filepath.Join(binDir, "cosign")); target != filepath.Join("..", "cosign", "1.2.4", "cosign") {
		t.Errorf("bin/cosign links to %s", target)
	}
}
