// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// blenderSeries is the Blender the build is written for: its Python API
// renames things between versions, so another is refused.
const blenderSeries = "5.2"

// MPFB is pinned by the archive Blender's extensions site serves, by its
// SHA-256, which is also its address there. Its code is GPL and runs only
// here, as a build tool; what it makes from its CC0 assets is the game's.
const (
	mpfbVersion = "2.0.18"
	mpfbSHA256  = "c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad"
	mpfbURL     = "https://extensions.blender.org/download/sha256:" + mpfbSHA256 + "/add-on-mpfb-v" + mpfbVersion + ".zip"
	// mpfbRepo is the extensions repository of the profile MPFB goes into.
	mpfbRepo = "user_default"
)

type blender struct {
	path, version string
}

// blenderPlaces are where Blender is looked for when BLENDER is not set.
var blenderPlaces = []string{"/Applications/Blender.app/Contents/MacOS/Blender", "blender"}

func findBlender(ctx context.Context) (blender, error) {
	places := blenderPlaces
	if b := os.Getenv("BLENDER"); b != "" {
		places = []string{b}
	}
	for _, p := range places {
		path, err := exec.LookPath(p)
		if err != nil {
			continue
		}
		out, err := exec.CommandContext(ctx, path, "--version").Output()
		if err != nil {
			return blender{}, fmt.Errorf("%s --version: %w", path, err)
		}
		version, err := blenderVersion(string(out))
		if err != nil {
			return blender{}, fmt.Errorf("%s: %w", path, err)
		}
		return blender{path, version}, nil
	}
	return blender{}, fmt.Errorf("no Blender found (looked for %s): install Blender %s LTS, or name it by BLENDER", strings.Join(places, ", "), blenderSeries)
}

var versionLine = regexp.MustCompile(`(?m)^Blender ([0-9]+\.[0-9]+)\.([0-9]+)( LTS)?\b`)

// blenderVersion reads the version from Blender's --version, and refuses
// any but the series the build is written for.
func blenderVersion(out string) (string, error) {
	m := versionLine.FindStringSubmatch(out)
	if m == nil {
		return "", errors.New("its --version names no version")
	}
	version := m[1] + "." + m[2]
	if m[1] != blenderSeries || m[3] == "" {
		return "", fmt.Errorf("this is Blender %s%s, but the build needs %s LTS", version, m[3], blenderSeries)
	}
	return version, nil
}

// mpfbInstalled is the version of MPFB in the profile, or "" if none.
func mpfbInstalled(profile string) string {
	raw, err := os.ReadFile(filepath.Join(profile, "extensions", mpfbRepo, "mpfb", "blender_manifest.toml"))
	if err != nil {
		return ""
	}
	if m := regexp.MustCompile(`(?m)^version = "([^"]+)"`).FindSubmatch(raw); m != nil {
		return string(m[1])
	}
	return ""
}

// ensureMPFB installs the pinned MPFB into the profile, unless it is there.
func ensureMPFB(ctx context.Context, b blender, profile string, log io.Writer) error {
	if mpfbInstalled(profile) == mpfbVersion {
		return nil
	}
	fmt.Fprintf(log, "sailors: installing MPFB %s into %s (about 45 MB, once)\n", mpfbVersion, profileDir)
	downloads := filepath.Join(profile, "downloads")
	if err := os.MkdirAll(downloads, 0o755); err != nil {
		return err
	}
	archive := filepath.Join(downloads, filepath.Base(mpfbURL))
	if err := download(ctx, mpfbURL, archive, mpfbSHA256); err != nil {
		return fmt.Errorf("MPFB: %w", err)
	}
	cmd := exec.CommandContext(ctx, b.path, "-b", "--command", "extension", "install-file", "-r", mpfbRepo, "-e", archive)
	cmd.Env = append(os.Environ(), "BLENDER_USER_RESOURCES="+profile)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("installing MPFB: %w\n%s", err, out)
	}
	if got := mpfbInstalled(profile); got != mpfbVersion {
		return fmt.Errorf("installed MPFB, but the profile holds version %q", got)
	}
	return nil
}

// download writes url to file, unless file is already there with the
// digest, and fails unless what it wrote has it.
func download(ctx context.Context, url, file, want string) error {
	if have, err := fileSHA256(file); err == nil && have == want {
		return nil
	}
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
	tmp, err := os.CreateTemp(filepath.Dir(file), filepath.Base(file)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), res.Body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("the download's SHA-256 is %s, but %s is pinned", got, want)
	}
	return os.Rename(tmp.Name(), file)
}

func fileSHA256(file string) (string, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// build runs the Python build on a job, in the profile, without a window.
// Blender exits with an error when the script raises. MPFB's own log lines
// are left out unless verbose.
func (b blender) build(ctx context.Context, profile, job string, verbose bool) error {
	cmd := exec.CommandContext(ctx, b.path, "-b", "--python-exit-code", "1", "--python", buildEntry, "--", job)
	cmd.Env = append(os.Environ(), "BLENDER_USER_RESOURCES="+profile)
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return err
	}
	sc := bufio.NewScanner(pipe)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if line := sc.Text(); verbose || shown(line) {
			fmt.Println(line)
		}
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("blender: %w", err)
	}
	return sc.Err()
}

// shown says whether a line Blender prints is the build's to show: MPFB
// logs every step at INFO, and Blender times every import.
func shown(line string) bool {
	for _, p := range []string{"[INFO ", "[DEBUG", "OBJ import of", "Blender quit", "Read prefs:", "Blender 5."} {
		if strings.HasPrefix(line, p) {
			return false
		}
	}
	return strings.TrimSpace(line) != ""
}
