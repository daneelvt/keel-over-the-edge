// SPDX-License-Identifier: AGPL-3.0-only

package tinygo

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
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

func TestReleasesPinned(t *testing.T) {
	digest := regexp.MustCompile(`^[0-9a-f]{64}$`)
	want := []string{"darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"}
	if len(releases) != len(want) {
		t.Fatalf("%d releases pinned, want %d", len(releases), len(want))
	}
	for i, r := range releases {
		if r.platform != want[i] {
			t.Errorf("release %d is for %s, want %s", i, r.platform, want[i])
		}
		if r.tag != "v"+Version {
			t.Errorf("%s is pinned to %s, the others to v%s", r.platform, r.tag, Version)
		}
		if !digest.MatchString(r.sha256) {
			t.Errorf("%s: %q is not a SHA-256", r.platform, r.sha256)
		}
	}
	if _, err := releaseFor("plan9-386"); err == nil {
		t.Error("an unpinned platform was accepted")
	}
}
