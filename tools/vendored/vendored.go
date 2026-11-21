// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

// File is one vendored file.
type File struct {
	// File is where it is kept, from the repository's root.
	File string `yaml:"file"`
	// URL is where it is published: a release's file, at its version.
	URL string `yaml:"url"`
	// Checksums, if set, is the release's list of its files' SHA-256s.
	Checksums string `yaml:"checksums,omitempty"`
	// SHA256 is the file's, as published.
	SHA256 string `yaml:"sha256"`
}

func readList(file string) ([]File, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var l struct {
		Files []File `yaml:"files"`
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&l); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	return l.Files, nil
}

// released is a file of a release on GitHub, named by its version's tag:
// never a branch, whose files change.
var released = regexp.MustCompile(`^https://github\.com/[^/]+/[^/]+/releases/download/[^/]+/[^/]+$`)

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

func sum(data []byte) string {
	s := sha256.Sum256(data)
	return hex.EncodeToString(s[:])
}

// pullAll fetches each file of the list, checks it and writes it; a
// SHA-256 it had to record is written back into the list.
func pullAll(ctx context.Context, list string, hc *http.Client, out io.Writer) error {
	files, err := readList(list)
	if err != nil {
		return err
	}
	recorded := map[string]string{}
	for _, f := range files {
		if !released.MatchString(f.URL) {
			return fmt.Errorf("%s: %s is not a file of a release", f.File, f.URL)
		}
		data, err := fetch(ctx, hc, f.URL)
		if err != nil {
			return fmt.Errorf("%s: %w", f.File, err)
		}
		got := sum(data)
		how := "pinned by its SHA-256"
		if f.Checksums != "" {
			sums, err := fetch(ctx, hc, f.Checksums)
			if err != nil {
				return fmt.Errorf("%s: %w", f.File, err)
			}
			u, _ := url.Parse(f.URL)
			if want, listed := listedSum(sums, path.Base(u.Path)); listed {
				if want != got {
					return fmt.Errorf("%s: %s has the SHA-256 %s, and its release's checksums say %s", f.File, f.URL, got, want)
				}
				how = "as its release's checksums list it"
			}
		}
		switch f.SHA256 {
		case "":
			recorded[f.File] = got
		case got:
		default:
			return fmt.Errorf("%s: %s has the SHA-256 %s, not the %s pinned", f.File, f.URL, got, f.SHA256)
		}
		if err := os.MkdirAll(filepath.Dir(f.File), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(f.File, data, 0o644); err != nil {
			return err
		}
		fmt.Fprintf(out, "vendored: %s, %d bytes, %s\n", f.File, len(data), how)
	}
	if len(recorded) == 0 {
		return nil
	}
	return record(list, recorded)
}

// listedSum finds name in a list of checksums, as sha256sum writes one: a
// SHA-256, then the file's path, which may be in a folder.
func listedSum(sums []byte, name string) (string, bool) {
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && path.Base(strings.TrimPrefix(fields[1], "*")) == name && sha256Hex.MatchString(fields[0]) {
			return fields[0], true
		}
	}
	return "", false
}

// record writes the SHA-256s -pull found for files listed without one into
// the list, in place: its comments stay.
func record(list string, sums map[string]string) error {
	data, err := os.ReadFile(list)
	if err != nil {
		return err
	}
	lines := strings.Split(string(data), "\n")
	current := ""
	for i, l := range lines {
		t := strings.TrimSpace(l)
		if v, ok := strings.CutPrefix(t, "- file: "); ok {
			current = v
		}
		if s, ok := sums[current]; ok && (t == `sha256: ""` || t == "sha256:") {
			lines[i] = l[:strings.Index(l, "sha256:")] + "sha256: " + s
			delete(sums, current)
		}
	}
	if len(sums) > 0 {
		return fmt.Errorf("%s: no empty sha256 to record for %v", list, sums)
	}
	return os.WriteFile(list, []byte(strings.Join(lines, "\n")), 0o644)
}

func fetch(ctx context.Context, hc *http.Client, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	res, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", u, res.Status)
	}
	return io.ReadAll(io.LimitReader(res.Body, 16<<20))
}

// checkAll checks each file of the list is in the repository, pinned by a
// release's URL and a SHA-256, and has that SHA-256.
func checkAll(list string) error {
	files, err := readList(list)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("%s lists nothing", list)
	}
	var errs []error
	for _, f := range files {
		if !released.MatchString(f.URL) || (f.Checksums != "" && !released.MatchString(f.Checksums)) {
			errs = append(errs, fmt.Errorf("%s: not pinned to a release's files: %s %s", f.File, f.URL, f.Checksums))
		}
		if !sha256Hex.MatchString(f.SHA256) {
			errs = append(errs, fmt.Errorf("%s: no SHA-256 pinned: run go run ./tools/vendored -pull", f.File))
			continue
		}
		data, err := os.ReadFile(f.File)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if got := sum(data); got != f.SHA256 {
			errs = append(errs, fmt.Errorf("%s has the SHA-256 %s, not the %s pinned: it is kept as published, and changed in the kustomization beside it", f.File, got, f.SHA256))
		}
	}
	return errors.Join(errs...)
}
