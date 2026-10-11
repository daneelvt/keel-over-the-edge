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
		// A pin with no digest of its own says so by a pattern that
		// captures none: the upgrade plan's version, whose image is pinned
		// beside it.
		digests := strings.Contains(strings.Join(m.MatchStrings, " "), "currentDigest")
		for _, f := range finds[m.Description] {
			if f.dep == "" || f.value == "" || (digests && f.digest == "") {
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
	var tools, k3s, buildkit, images, plan []found
	for description, f := range finds {
		switch {
		case strings.HasPrefix(description, "TinyGo, cosign, the Flux CLI, kube-bench and OpenTofu"):
			tools = f
		case strings.HasPrefix(description, "k3s"):
			k3s = f
		case strings.HasPrefix(description, "BuildKit"):
			buildkit = f
		case strings.HasPrefix(description, "The images the cluster's charts"):
			images = f
		case strings.HasPrefix(description, "The k3s release the upgrade plan names"):
			plan = f
		}
	}
	// Every line that names an image for Renovate is followed by a pin its
	// pattern reads: none is written a way it would never be found.
	marked := 0
	err := filepath.WalkDir(filepath.Join(repoRoot, "infra", "cluster"), func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(p)
		marked += strings.Count(string(data), "# renovate: image=")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(images) != marked || marked < 20 {
		t.Errorf("Renovate finds %d of the %d images the manifests mark for it", len(images), marked)
	}
	for _, want := range []string{"quay.io/jetstack/cert-manager-webhook", "ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar", "victoriametrics/victoria-metrics", "victoriametrics/vlagent",
		"grafana/grafana", "quay.io/prometheus/node-exporter", "ghcr.io/kubereboot/kured", "rancher/kubectl", "rancher/k3s-upgrade"} {
		if !slices.ContainsFunc(images, func(f found) bool {
			return f.dep == want && strings.HasPrefix(f.digest, "sha256:") && !strings.Contains(f.value, "sha256")
		}) {
			t.Errorf("Renovate does not find %s among %+v", want, images)
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
	if len(plan) != 1 || plan[0] != (found{dep: "k3s-io/k3s", value: pin.Version}) {
		t.Errorf("Renovate finds the upgrade plan's k3s as %+v, the pin is %s", plan, pin.Version)
	}
	if len(buildkit) != 1 || buildkit[0].dep != "moby/buildkit" || !strings.HasPrefix(buildkit[0].digest, "sha256:") {
		t.Errorf("Renovate finds BuildKit as %+v", buildkit)
	}
}
