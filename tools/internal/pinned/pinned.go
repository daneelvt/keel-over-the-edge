// SPDX-License-Identifier: AGPL-3.0-only

// Package pinned fetches the programs the repository pins by release:
// TinyGo, the compiler that builds the physics package to WebAssembly, and
// cosign and the Flux CLI, which sign and publish a release. Each is
// downloaded into the repository's .dev folder, the way Go fetches the
// toolchain go.mod names, and checked against the SHA-256 pinned below
// before anything is unpacked or run.
package pinned

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

// release pins one platform's file of a GitHub release. Renovate updates
// the tags and the digests together (renovate.json).
type release struct {
	repo     string // owner/name on GitHub
	platform string // GOOS-GOARCH
	tag      string
	sha256   string
}

var releases = []release{
	{"tinygo-org/tinygo", "darwin-amd64", "v0.42.0", "ef7b96cf59de5714a7493a696e9db141a85a99459620b00c42cb3bad14be2af2"},
	{"tinygo-org/tinygo", "darwin-arm64", "v0.42.0", "493da3585e66c5da677a4be39402faf2041b4e45a61eb456e4547eca753a544e"},
	{"tinygo-org/tinygo", "linux-amd64", "v0.42.0", "b87688fa2e19cee7d813cad7fd7dadb71dff3198e47125aba66ba4af5e490438"},
	{"tinygo-org/tinygo", "linux-arm64", "v0.42.0", "f2f3f863e63728b87772e7306bd6030df6e6c89773a7082eb0122113cf9e453d"},

	{"sigstore/cosign", "darwin-amd64", "v3.1.3", "2347488e5d5b25336644024dfeca5601b190e91197a71a917bda44744aff106c"},
	{"sigstore/cosign", "darwin-arm64", "v3.1.3", "5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76"},
	{"sigstore/cosign", "linux-amd64", "v3.1.3", "4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71"},
	{"sigstore/cosign", "linux-arm64", "v3.1.3", "c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a"},

	{"fluxcd/flux2", "darwin-amd64", "v2.9.6", "c3c3532c8c6cf689ef7b93125b33dc170df84a9d5d036f578568bfdf88a2d7e6"},
	{"fluxcd/flux2", "darwin-arm64", "v2.9.6", "7008a758da4b8d57c5845aad6552f256d4d23630c2b2de2ca8da362f9a48c126"},
	{"fluxcd/flux2", "linux-amd64", "v2.9.6", "b4d22673e9246cbd628881f1a9ef3b090085dced291e42d804555cee8e8d42c5"},
	{"fluxcd/flux2", "linux-arm64", "v2.9.6", "6663c154755b732f43dc993d72321f71c2fc1ff0bcb94b2696e0a8638fa562b4"},
}

// Tool is a program pinned by release.
type Tool struct {
	// Name is the program's, and its folder's under .dev.
	Name string
	repo string
	// asset names the release's file for a version and platform.
	asset func(version, goos, goarch string) string
	// bin is the program's path in the unpacked archive; "" when the
	// release's file is the program itself.
	bin string
	// size says how much the first use downloads.
	size string
}

var (
	// TinyGo builds the physics package to WebAssembly.
	TinyGo = Tool{
		Name: "tinygo", repo: "tinygo-org/tinygo", bin: "tinygo/bin/tinygo", size: "about 180 MB",
		asset: func(v, goos, goarch string) string { return "tinygo" + v + "." + goos + "-" + goarch + ".tar.gz" },
	}
	// Cosign signs and verifies images and artifacts with Sigstore.
	Cosign = Tool{
		Name: "cosign", repo: "sigstore/cosign", size: "about 140 MB",
		asset: func(_, goos, goarch string) string { return "cosign-" + goos + "-" + goarch },
	}
	// Flux is Flux's command line, which pushes and tags OCI artifacts.
	Flux = Tool{
		Name: "flux", repo: "fluxcd/flux2", bin: "flux", size: "about 25 MB",
		asset: func(v, goos, goarch string) string { return "flux_" + v + "_" + goos + "_" + goarch + ".tar.gz" },
	}
)

// base is where releases are downloaded from; tests replace it.
var base = "https://github.com"

// maxUnpacked bounds what an archive may unpack to; TinyGo is about 1.2 GB.
const maxUnpacked = 4 << 30

// Version is the release of the tool the repository pins, without its "v".
func (t Tool) Version() string {
	for _, r := range releases {
		if r.repo == t.repo {
			return strings.TrimPrefix(r.tag, "v")
		}
	}
	return ""
}

// releaseFor is the tool's pin for a platform, GOOS-GOARCH.
func (t Tool) releaseFor(platform string) (release, error) {
	for _, r := range releases {
		if r.repo == t.repo && r.platform == platform {
			return r, nil
		}
	}
	return release{}, fmt.Errorf("%s: no pinned release for %s", t.Name, platform)
}

// Ensure returns the path of the pinned program under dir (the
// repository's .dev folder), downloading and unpacking it the first time.
func (t Tool) Ensure(ctx context.Context, dir string, log io.Writer) (string, error) {
	r, err := t.releaseFor(runtime.GOOS + "-" + runtime.GOARCH)
	if err != nil {
		return "", err
	}
	version := strings.TrimPrefix(r.tag, "v")
	root := filepath.Join(dir, t.Name, version)
	file := t.bin
	if file == "" {
		file = t.Name
	}
	bin := filepath.Join(root, filepath.FromSlash(file))
	done := filepath.Join(root, ".complete")
	if exists(done) && exists(bin) {
		return bin, nil
	}

	url := fmt.Sprintf("%s/%s/releases/download/%s/%s", base, t.repo, r.tag, t.asset(version, runtime.GOOS, runtime.GOARCH))
	fmt.Fprintf(log, "%s: downloading %s %s for %s (%s, once)\n", t.Name, t.Name, version, r.platform, t.size)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	download, err := os.CreateTemp(dir, t.Name+"-download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(download.Name())
	defer download.Close()
	if err := fetch(ctx, url, download, r.sha256); err != nil {
		return "", fmt.Errorf("%s: %w", t.Name, err)
	}

	// Unpack beside the final folder and rename, so an interrupted run
	// never leaves a half-unpacked program that looks complete.
	tmp, err := os.MkdirTemp(dir, t.Name+"-unpack-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	if _, err := download.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	if t.bin == "" {
		err = writeFile(filepath.Join(tmp, t.Name), download, -1, 0o755)
	} else {
		err = untar(download, tmp)
	}
	if err != nil {
		return "", fmt.Errorf("%s: unpacking %s: %w", t.Name, url, err)
	}
	if !exists(filepath.Join(tmp, filepath.FromSlash(file))) {
		return "", fmt.Errorf("%s: %s holds no %s", t.Name, url, file)
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

// Install makes sure each tool is under dir and links it by name in
// dir/bin, which it returns: one folder to put on PATH, whatever versions
// are pinned.
func Install(ctx context.Context, dir string, log io.Writer, tools ...Tool) (string, error) {
	binDir := filepath.Join(dir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return "", err
	}
	for _, t := range tools {
		bin, err := t.Ensure(ctx, dir, log)
		if err != nil {
			return "", err
		}
		target, err := filepath.Rel(binDir, bin)
		if err != nil {
			return "", err
		}
		link := filepath.Join(binDir, t.Name)
		if have, err := os.Readlink(link); err == nil && have == target {
			continue
		}
		if err := os.RemoveAll(link); err != nil {
			return "", err
		}
		if err := os.Symlink(target, link); err != nil {
			return "", err
		}
	}
	return binDir, nil
}

// fetch writes url to w and fails unless its SHA-256 is want.
func fetch(ctx context.Context, url string, w io.Writer, want string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", url, res.Status)
	}
	return copyChecked(w, res.Body, want)
}

// copyChecked copies r to w and fails unless what it copied has SHA-256 want.
func copyChecked(w io.Writer, r io.Reader, want string) error {
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(w, h), r); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("the download's SHA-256 is %s, but %s is pinned", got, want)
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

// writeFile writes size bytes of r to a new file, or all of r when size is
// negative.
func writeFile(path string, r io.Reader, size int64, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if size < 0 {
		_, err = io.Copy(f, r)
	} else {
		_, err = io.CopyN(f, r, size)
	}
	if err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
