// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

const (
	sourcesFile = "SOURCES.md"
	vendorDir   = "vendor"
)

// inputLicences are the licences an input may have: the art is all rights
// reserved, so nothing that asks for credit or forbids selling it.
var inputLicences = []string{"CC0-1.0"}

// source is one input file, listed in SOURCES.md.
type source struct {
	Path    string `json:"path"` // from art/sailors
	Pack    string `json:"pack"`
	Licence string `json:"licence"`
	SHA256  string `json:"sha256"`
}

var (
	tableRow = regexp.MustCompile(`^\|(.+)\|\s*$`)
	digest   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// readSources reads SOURCES.md's tables and checks them against what is
// there: every vendored file listed, by its digest and an allowed licence,
// and the programs' rows naming the pins. It returns the files, by path.
func readSources(dir string) (map[string]source, error) {
	f, err := os.Open(filepath.Join(dir, sourcesFile))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	files := map[string]source{}
	programs := map[string]string{}
	var section string
	var problems []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "## ") {
			section = strings.TrimPrefix(line, "## ")
			continue
		}
		m := tableRow.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		cells := strings.Split(m[1], "|")
		for i := range cells {
			cells[i] = strings.Trim(strings.TrimSpace(cells[i]), "`")
		}
		if strings.HasPrefix(cells[0], "---") || !digest.MatchString(cells[len(cells)-1]) {
			continue // a header, a rule, or a row without a digest
		}
		switch section {
		case "Programs":
			programs[cells[0]] = cells[len(cells)-1]
		case "Files":
			if len(cells) != 4 {
				problems = append(problems, fmt.Sprintf("%s: the row for %s has %d cells, not 4", sourcesFile, cells[0], len(cells)))
				continue
			}
			s := source{Path: cells[0], Pack: cells[1], Licence: cells[2], SHA256: cells[3]}
			if !slices.Contains(inputLicences, s.Licence) {
				problems = append(problems, fmt.Sprintf("%s: %s is %s, but only %s may be an input", sourcesFile, s.Path, s.Licence, strings.Join(inputLicences, ", ")))
			}
			if _, twice := files[s.Path]; twice {
				problems = append(problems, fmt.Sprintf("%s: %s is listed twice", sourcesFile, s.Path))
			}
			files[s.Path] = s
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	for name, want := range map[string]string{"MPFB": mpfbSHA256, "gltfpack": gltfpackSHA256()} {
		if programs[name] != want {
			problems = append(problems, fmt.Sprintf("%s: the row for %s says %q, but %s is pinned", sourcesFile, name, programs[name], want))
		}
	}

	// Every vendored file listed, and every listed file there, unchanged.
	err = filepath.WalkDir(filepath.Join(dir, vendorDir), func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Name() == ".DS_Store" {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		if _, ok := files[filepath.ToSlash(rel)]; !ok {
			problems = append(problems, fmt.Sprintf("%s is not in %s: list it with its pack, licence and SHA-256, or remove it", filepath.ToSlash(rel), sourcesFile))
		}
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	for _, s := range files {
		got, err := fileSHA256(filepath.Join(dir, filepath.FromSlash(s.Path)))
		switch {
		case err != nil:
			problems = append(problems, fmt.Sprintf("%s lists %s, which cannot be read: %v", sourcesFile, s.Path, err))
		case got != s.SHA256:
			problems = append(problems, fmt.Sprintf("%s has SHA-256 %s, but %s lists %s", s.Path, got, sourcesFile, s.SHA256))
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return nil, fmt.Errorf("the inputs:\n  %s", strings.Join(problems, "\n  "))
	}
	return files, nil
}

// gltfpackSHA256 is the digest of the gltfpack pinned for the Mac, which
// SOURCES.md names.
func gltfpackSHA256() string {
	return pinned.Gltfpack.SHA256("darwin-arm64")
}
