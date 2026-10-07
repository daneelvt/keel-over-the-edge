// SPDX-License-Identifier: AGPL-3.0-only

// Package tinygo fetches the pinned release of TinyGo, the compiler that
// builds the physics package to WebAssembly, into the repository's .dev
// folder, the way Go fetches the toolchain go.mod names. The archive is
// checked against the SHA-256 pinned below before anything is unpacked.
package tinygo

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// release pins the archive for each platform. Renovate updates the tags and
// the digests together (renovate.json).
type release struct {
	platform string // GOOS-GOARCH
	tag      string
	sha256   string
}

var releases = []release{
	{"darwin-amd64", "v0.42.0", "ef7b96cf59de5714a7493a696e9db141a85a99459620b00c42cb3bad14be2af2"},
	{"darwin-arm64", "v0.42.0", "493da3585e66c5da677a4be39402faf2041b4e45a61eb456e4547eca753a544e"},
	{"linux-amd64", "v0.42.0", "b87688fa2e19cee7d813cad7fd7dadb71dff3198e47125aba66ba4af5e490438"},
	{"linux-arm64", "v0.42.0", "f2f3f863e63728b87772e7306bd6030df6e6c89773a7082eb0122113cf9e453d"},
}

// Version is the TinyGo release the repository builds with.
var Version = strings.TrimPrefix(releases[0].tag, "v")

// maxUnpacked bounds what an archive may unpack to; TinyGo is about 1.2 GB.
const maxUnpacked = 4 << 30

// Ensure returns the path of the pinned tinygo binary under dir (the
// repository's .dev folder), downloading and unpacking it the first time.
func Ensure(ctx context.Context, dir string, log io.Writer) (string, error) {
	r, err := releaseFor(runtime.GOOS + "-" + runtime.GOARCH)
	if err != nil {
		return "", err
	}
	root := filepath.Join(dir, "tinygo", Version)
	bin := filepath.Join(root, "tinygo", "bin", "tinygo")
	done := filepath.Join(root, ".complete")
	if exists(done) && exists(bin) {
		return bin, nil
	}

	url := fmt.Sprintf("https://github.com/tinygo-org/tinygo/releases/download/%s/tinygo%s.%s.tar.gz",
		r.tag, strings.TrimPrefix(r.tag, "v"), r.platform)
	fmt.Fprintf(log, "tinygo: downloading TinyGo %s for %s (about 180 MB, once)\n", Version, r.platform)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	archive, err := os.CreateTemp(dir, "tinygo-*.tar.gz")
	if err != nil {
		return "", err
	}
	defer os.Remove(archive.Name())
	defer archive.Close()
	if err := download(ctx, url, archive, r.sha256); err != nil {
		return "", err
	}

	// Unpack beside the final folder and rename, so an interrupted run
	// never leaves a half-unpacked TinyGo that looks complete.
	tmp, err := os.MkdirTemp(dir, "tinygo-unpack-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	if err := untar(archive, tmp); err != nil {
		return "", fmt.Errorf("tinygo: unpacking %s: %w", url, err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".complete"), nil, 0o644); err != nil {
		return "", err
	}
	if err := os.RemoveAll(root); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(root), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, root); err != nil {
		return "", err
	}
	return bin, nil
}

func releaseFor(platform string) (release, error) {
	for _, r := range releases {
		if r.platform == platform {
			return r, nil
		}
	}
	return release{}, fmt.Errorf("tinygo: no pinned TinyGo release for %s", platform)
}

// download writes url to w and fails unless its SHA-256 is want.
func download(ctx context.Context, url string, w io.Writer, want string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("tinygo: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("tinygo: %s answered %s", url, res.Status)
	}
	return copyChecked(w, res.Body, want)
}

// copyChecked copies r to w and fails unless what it copied has SHA-256 want.
func copyChecked(w io.Writer, r io.Reader, want string) error {
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(w, h), r); err != nil {
		return fmt.Errorf("tinygo: %w", err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("tinygo: the archive's SHA-256 is %s, but %s is pinned", got, want)
	}
	return nil
}

// untar unpacks a gzipped tar archive into dir. Only folders and regular
// files are accepted, and no path may leave dir.
func untar(r io.Reader, dir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var total int64
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.FromSlash(h.Name)
		if !filepath.IsLocal(name) {
			return fmt.Errorf("unsafe path %q", h.Name)
		}
		target := filepath.Join(dir, name)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if total += h.Size; h.Size < 0 || total > maxUnpacked {
				return errors.New("the archive unpacks to more than expected")
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := writeFile(target, tr, h.Size, os.FileMode(h.Mode)&0o755|0o644); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%q is neither a folder nor a regular file", h.Name)
		}
	}
}

func writeFile(path string, r io.Reader, size int64, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.CopyN(f, r, size); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
