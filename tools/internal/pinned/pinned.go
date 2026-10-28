// SPDX-License-Identifier: AGPL-3.0-only

// Package pinned fetches the programs the repository pins by release:
// TinyGo, the compiler that builds the physics package to WebAssembly;
// cosign and the Flux CLI, which sign and publish a release; Tailscale's
// client, with which a workflow joins the tailnet; kube-bench, which
// audits a k3s node; OpenTofu, which manages the accounts outside the
// machine; and vmalert-tool, which tests the cluster's alert rules. Each is downloaded into the repository's .dev folder,
// the way Go fetches the toolchain go.mod names, and checked against the
// SHA-256 pinned below before anything is unpacked or run.
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
	"slices"
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
	{"tinygo-org/tinygo", "darwin-amd64", "v0.43.0", "e544fe732d7b81f058ac8d2c7303e22031eff734c027295e7a53c3037e4d9e89"},
	{"tinygo-org/tinygo", "darwin-arm64", "v0.43.0", "f5e0161f212fb69ad4650a4809e3ca66856e184892e80058f0d47abc64151812"},
	{"tinygo-org/tinygo", "linux-amd64", "v0.43.0", "ca9fc6d055e3889462dea4450a2e42a92242d88b5c362a7ec39bdb563413d78a"},
	{"tinygo-org/tinygo", "linux-arm64", "v0.43.0", "a2165b9f46aff9a895a0abed54aedffab1e93317a387c6c2e9dd839425527cbd"},

	{"sigstore/cosign", "darwin-amd64", "v3.1.4", "9d1e4abe2b6be279ed0d2ff706fde1ccd738747c834e3e6d44039c238867334f"},
	{"sigstore/cosign", "darwin-arm64", "v3.1.4", "9f9b8cd557cf2e5b3df3373a00baa005a86b02391e3e06dd0ce37b3a1533d3a4"},
	{"sigstore/cosign", "linux-amd64", "v3.1.4", "424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa"},
	{"sigstore/cosign", "linux-arm64", "v3.1.4", "ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2"},

	{"fluxcd/flux2", "darwin-amd64", "v2.9.6", "c3c3532c8c6cf689ef7b93125b33dc170df84a9d5d036f578568bfdf88a2d7e6"},
	{"fluxcd/flux2", "darwin-arm64", "v2.9.6", "7008a758da4b8d57c5845aad6552f256d4d23630c2b2de2ca8da362f9a48c126"},
	{"fluxcd/flux2", "linux-amd64", "v2.9.6", "b4d22673e9246cbd628881f1a9ef3b090085dced291e42d804555cee8e8d42c5"},
	{"fluxcd/flux2", "linux-arm64", "v2.9.6", "6663c154755b732f43dc993d72321f71c2fc1ff0bcb94b2696e0a8638fa562b4"},

	{"aquasecurity/kube-bench", "linux-amd64", "v0.16.0", "82dbc7e598740dc9344d41f8ad0b8210d57c4c00bdb2c5f1d8a69a2b98baddcf"},
	{"aquasecurity/kube-bench", "linux-arm64", "v0.16.0", "64500561f5fcaa3f86fe951ed26bbfc28f7bbf3d2eac13843abfd2924955d10b"},

	{"opentofu/opentofu", "darwin-arm64", "v1.13.2", "0d1cdc85f38992055b48e7fb161304a2ddfe2e5ee0ff68ffec9d0349c8bd1b59"},
	{"opentofu/opentofu", "linux-amd64", "v1.13.2", "ac05d9952662c7db28dd57e93f0a68018837bfdf9342384ec0987977c16a9645"},
	{"opentofu/opentofu", "linux-arm64", "v1.13.2", "88e2d9e3f94f97b76ab2faf55ade87578f56aed19c5e45fa139d70e994366d1f"},

	{"VictoriaMetrics/VictoriaMetrics", "darwin-arm64", "v1.154.1", "073f44a6c6169d0542043d114a57731dcd03174a542f922fc64a796491283e26"},
	{"VictoriaMetrics/VictoriaMetrics", "linux-amd64", "v1.154.1", "989c8f73edc5d131eb169bb689d7b77bb1d31b14314159c7f6bbae38ba655938"},
	{"VictoriaMetrics/VictoriaMetrics", "linux-arm64", "v1.154.1", "e9a44e352da8200d427815acab179850cef0a13ed4d0e5ef95a7f1e46c81b0aa"},
}

// byHand pins what is not a GitHub release, which Renovate cannot follow:
// Tailscale's static client, from its own site. go run ./tools/machine
// -pin <version> moves it, with the digests Tailscale publishes beside
// each file. Any client from 1.94 on joins with a federated identity.
var byHand = []release{
	{tailscaleSite, "linux-amd64", "1.104.1", "108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528"},
	{tailscaleSite, "linux-arm64", "1.104.1", "f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806"},
}

// tailscaleSite is where Tailscale publishes its stable static clients.
const tailscaleSite = "pkgs.tailscale.com/stable"

// Tool is a program pinned by release.
type Tool struct {
	// Name is the program's, and its folder's under .dev.
	Name string
	repo string
	// asset names the release's file for a version and platform.
	asset func(version, goos, goarch string) string
	// bin is the program's path in the unpacked archive, for a version and
	// GOARCH; nil when the release's file is the program itself.
	bin func(version, goarch string) string
	// size says how much the first use downloads.
	size string
	// platforms are where the tool must be pinned: the machines that build
	// and release, and the Mac that develops, unless only workflows run it.
	platforms []string
}

// Platforms are where the tool is pinned.
func (t Tool) Platforms() []string {
	if t.platforms != nil {
		return t.platforms
	}
	return []string{"linux-amd64", "linux-arm64", "darwin-arm64"}
}

// fixed is a path in an archive that is the same for every version.
func fixed(p string) func(string, string) string { return func(string, string) string { return p } }

var (
	// TinyGo builds the physics package to WebAssembly.
	TinyGo = Tool{
		Name: "tinygo", repo: "tinygo-org/tinygo", bin: fixed("tinygo/bin/tinygo"), size: "about 180 MB",
		asset: func(v, goos, goarch string) string { return "tinygo" + v + "." + goos + "-" + goarch + ".tar.gz" },
	}
	// Cosign signs and verifies images and artifacts with Sigstore.
	Cosign = Tool{
		Name: "cosign", repo: "sigstore/cosign", size: "about 140 MB",
		asset: func(_, goos, goarch string) string { return "cosign-" + goos + "-" + goarch },
	}
	// Flux is Flux's command line, which pushes and tags OCI artifacts.
	Flux = Tool{
		Name: "flux", repo: "fluxcd/flux2", bin: fixed("flux"), size: "about 25 MB",
		asset: func(v, goos, goarch string) string { return "flux_" + v + "_" + goos + "_" + goarch + ".tar.gz" },
	}
	// Tailscale is Tailscale's client, tailscale; its daemon, tailscaled,
	// is beside it.
	Tailscale = Tool{
		Name: "tailscale", repo: tailscaleSite, size: "about 30 MB", platforms: []string{"linux-amd64", "linux-arm64"},
		bin:   func(v, goarch string) string { return "tailscale_" + v + "_" + goarch + "/tailscale" },
		asset: func(v, _, goarch string) string { return "tailscale_" + v + "_" + goarch + ".tgz" },
	}
	// KubeBench checks a node against the CIS Kubernetes Benchmark; its
	// profiles are in cfg, beside it.
	KubeBench = Tool{
		Name: "kube-bench", repo: "aquasecurity/kube-bench", bin: fixed("kube-bench"), size: "about 20 MB", platforms: []string{"linux-amd64", "linux-arm64"},
		asset: func(v, goos, goarch string) string { return "kube-bench_" + v + "_" + goos + "_" + goarch + ".tar.gz" },
	}
	// OpenTofu plans and applies what the accounts workflow manages: the
	// zone at Cloudflare, the tunnel, and the secrets they make.
	OpenTofu = Tool{
		Name: "tofu", repo: "opentofu/opentofu", bin: fixed("tofu"), size: "about 30 MB",
		asset: func(v, goos, goarch string) string { return "tofu_" + v + "_" + goos + "_" + goarch + ".tar.gz" },
	}
	// VMAlertTool runs the unit tests of the cluster's alert rules
	// (vmalert-tool unittest), from VictoriaMetrics' archive of its
	// utilities: the release the cluster's vmalert runs.
	VMAlertTool = Tool{
		Name: "vmalert-tool", repo: "VictoriaMetrics/VictoriaMetrics", bin: fixed("vmalert-tool-prod"), size: "about 140 MB",
		asset: func(v, goos, goarch string) string { return "vmutils-" + goos + "-" + goarch + "-v" + v + ".tar.gz" },
	}
)

// base is where GitHub's releases are downloaded from, and site where
// the others are, by their repo; tests replace them.
var (
	base = "https://github.com"
	site = "https://"
)

// pins are every pin, GitHub's releases and the others.
func pins() []release { return slices.Concat(releases, byHand) }

// url is where a pinned file is downloaded from.
func (t Tool) url(r release, version string) string {
	asset := t.asset(version, runtime.GOOS, runtime.GOARCH)
	if r.repo == tailscaleSite {
		return site + r.repo + "/" + asset
	}
	return fmt.Sprintf("%s/%s/releases/download/%s/%s", base, r.repo, r.tag, asset)
}

// maxUnpacked bounds what an archive may unpack to; TinyGo is about 1.2 GB.
const maxUnpacked = 4 << 30

// Version is the release of the tool the repository pins, without its "v".
func (t Tool) Version() string {
	for _, r := range pins() {
		if r.repo == t.repo {
			return strings.TrimPrefix(r.tag, "v")
		}
	}
	return ""
}

// releaseFor is the tool's pin for a platform, GOOS-GOARCH.
func (t Tool) releaseFor(platform string) (release, error) {
	for _, r := range pins() {
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
	file := t.Name
	if t.bin != nil {
		file = t.bin(version, runtime.GOARCH)
	}
	bin := filepath.Join(root, filepath.FromSlash(file))
	done := filepath.Join(root, ".complete")
	if exists(done) && exists(bin) {
		return bin, nil
	}

	url := t.url(r, version)
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
	if t.bin == nil {
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
