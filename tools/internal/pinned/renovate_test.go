// SPDX-License-Identifier: AGPL-3.0-only

package pinned

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

const repoRoot = "../../.."

// renovate is the part of renovate.json that finds pins no manager of
// Renovate's own understands: a pattern per kind of pin, and the files it
// is looked for in.
type renovate struct {
	CustomManagers []struct {
		Description         string   `json:"description"`
		ManagerFilePatterns []string `json:"managerFilePatterns"`
		MatchStrings        []string `json:"matchStrings"`
		DepNameTemplate     string   `json:"depNameTemplate"`
	} `json:"customManagers"`
}

// found is what a pattern captured: the dependency, its version and digest.
type found struct{ dep, value, digest string }

// renovateFinds applies every custom manager to the repository's files, as
// Renovate does, and returns what each finds, by its description.
func renovateFinds(t *testing.T) map[string][]found {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(repoRoot, "renovate.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg renovate
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	var files []string
	err = filepath.WalkDir(repoRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if slices.Contains([]string{".git", ".dev", "node_modules", "dist"}, d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(repoRoot, p)
		files = append(files, filepath.ToSlash(rel))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	finds := map[string][]found{}
	for _, m := range cfg.CustomManagers {
		matched := 0
		for _, pattern := range m.ManagerFilePatterns {
			// A pattern between slashes is a regular expression.
			if len(pattern) < 2 || !strings.HasPrefix(pattern, "/") || !strings.HasSuffix(pattern, "/") {
				t.Fatalf("%s: the file pattern %q is not a regular expression", m.Description, pattern)
			}
			re := regexp.MustCompile(pattern[1 : len(pattern)-1])
			for _, f := range files {
				if !re.MatchString(f) {
					continue
				}
				matched++
				text, err := os.ReadFile(filepath.Join(repoRoot, f))
				if err != nil {
					t.Fatal(err)
				}
				for _, ms := range m.MatchStrings {
					re := regexp.MustCompile(ms)
					for _, sub := range re.FindAllStringSubmatch(string(text), -1) {
						got := found{dep: m.DepNameTemplate}
						for i, name := range re.SubexpNames() {
							switch name {
							case "depName":
								got.dep = sub[i]
							case "currentValue":
								got.value = sub[i]
							case "currentDigest":
								got.digest = sub[i]
							}
						}
						finds[m.Description] = append(finds[m.Description], got)
					}
				}
			}
		}
		if matched == 0 {
			t.Errorf("%s: no file matches %v", m.Description, m.ManagerFilePatterns)
		}
		if len(finds[m.Description]) == 0 {
			t.Errorf("%s: its pattern finds nothing in its files: the pin would never be updated", m.Description)
		}
		for _, f := range finds[m.Description] {
			if f.dep == "" || f.value == "" || f.digest == "" {
				t.Errorf("%s: found %+v, without a dependency, a version or a digest", m.Description, f)
			}
		}
	}
	return finds
}

// TestRenovateFindsEveryPin: each pin Renovate is told of by a pattern is
// where the pattern looks, written as the pattern expects: the programs
// pinned here, each platform's file; k3s, with its commit; and BuildKit.
func TestRenovateFindsEveryPin(t *testing.T) {
	finds := renovateFinds(t)
	var tools, k3s, buildkit []found
	for description, f := range finds {
		switch {
		case strings.HasPrefix(description, "TinyGo, cosign and the Flux CLI"):
			tools = f
		case strings.HasPrefix(description, "k3s"):
			k3s = f
		case strings.HasPrefix(description, "BuildKit"):
			buildkit = f
		}
	}
	if len(tools) != len(releases) {
		t.Fatalf("Renovate finds %d of the %d pinned files", len(tools), len(releases))
	}
	for i, r := range releases {
		if tools[i] != (found{r.repo, r.tag, r.sha256}) {
			t.Errorf("Renovate finds %+v, the pin is %+v", tools[i], r)
		}
	}
	pin, err := ReadK3s(filepath.Join(repoRoot, K3sFile))
	if err != nil {
		t.Fatal(err)
	}
	if len(k3s) != 1 || k3s[0] != (found{"k3s-io/k3s", pin.Version, pin.Commit}) {
		t.Errorf("Renovate finds k3s as %+v, the pin is %+v", k3s, pin)
	}
	if len(buildkit) != 1 || buildkit[0].dep != "moby/buildkit" || !strings.HasPrefix(buildkit[0].digest, "sha256:") {
		t.Errorf("Renovate finds BuildKit as %+v", buildkit)
	}
}
