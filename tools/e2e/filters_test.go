// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"strings"
	"testing"

	"github.com/bmatcuk/doublestar/v4"
	"go.yaml.in/yaml/v3"
)

// pr.render's path filters, as dorny/paths-filter reads them: each step's
// filters, a filter's patterns flattened (they may share a list by a YAML
// anchor), and how a file must match them: some pattern (the default), or
// every one, a pattern starting ! matching what it does not.
type filterStep struct {
	every   bool
	filters map[string][]string
}

func renderFilters(t *testing.T) []filterStep {
	t.Helper()
	b, err := os.ReadFile("../../.github/workflows/pr.render.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var wf struct {
		Jobs struct {
			Changes struct {
				Steps []struct {
					Uses string
					With map[string]string
				}
			}
		}
	}
	if err := yaml.Unmarshal(b, &wf); err != nil {
		t.Fatal(err)
	}
	var out []filterStep
	for _, s := range wf.Jobs.Changes.Steps {
		if !strings.HasPrefix(s.Uses, "dorny/paths-filter@") {
			continue
		}
		var raw map[string]any
		if err := yaml.Unmarshal([]byte(s.With["filters"]), &raw); err != nil {
			t.Fatal(err)
		}
		step := filterStep{every: s.With["predicate-quantifier"] == "every", filters: map[string][]string{}}
		for name, v := range raw {
			step.filters[name] = flatten(v)
		}
		out = append(out, step)
	}
	if len(out) == 0 {
		t.Fatal("no path filters in pr.render.yaml")
	}
	return out
}

func flatten(v any) []string {
	switch v := v.(type) {
	case string:
		return []string{v}
	case []any:
		var out []string
		for _, e := range v {
			out = append(out, flatten(e)...)
		}
		return out
	}
	return nil
}

func (s filterStep) matches(name, path string) bool {
	patterns := s.filters[name]
	if len(patterns) == 0 {
		return false
	}
	for _, p := range patterns {
		neg := strings.HasPrefix(p, "!")
		ok, err := doublestar.Match(strings.TrimPrefix(p, "!"), path)
		if err != nil {
			panic(err)
		}
		if neg {
			ok = !ok
		}
		if s.every && !ok {
			return false
		}
		if !s.every && ok {
			return true
		}
	}
	return s.every
}

// runs says whether a change to path runs the filter's tests: whether any
// step's filter of that name matches it, as the changes job's outputs say.
func runs(steps []filterStep, name, path string) bool {
	for _, s := range steps {
		if s.matches(name, path) {
			return true
		}
	}
	return false
}

func TestRenderFilters(t *testing.T) {
	steps := renderFilters(t)
	for _, c := range []struct {
		path        string
		page, scene bool
	}{
		// What the old single filter ran on, each still run by one or both.
		{".github/workflows/pr.render.yaml", true, true},
		{".github/actions/setup/action.yaml", true, true},
		{".nvmrc", true, true},
		{"go.mod", true, true},
		{"go.sum", true, true},
		{"client/package.json", true, true},
		{"client/package-lock.json", true, true},
		{"client/playwright.config.ts", true, true},
		{"client/vite.config.ts", true, true},
		{"client/build/licences.ts", true, true},
		{"client/e2e/helpers.ts", true, true},
		{"client/e2e/sea.spec.ts", true, true},
		{"client/e2e/pictures/webgl2-linux/calm-sea.png", true, true},
		{"client/src/render/stage.ts", true, true},
		{"client/src/game/game.ts", true, true},
		{"client/src/ui/hud.tsx", true, true},
		{"client/src/boot/main.ts", true, true},
		{"client/src/ocean/ocean.ts", false, true},
		{"client/src/sky/sky.ts", false, true},
		{"client/src/sandbox/sandbox.ts", false, true},
		{"client/src/net/worker.ts", true, false},
		{"client/src/account/start.tsx", true, false},
		{"client/src/owner/app.tsx", true, false},
		{"client/approve/main.tsx", true, false},
		{"art/boats/jolly-boat/build.ts", true, true},
		{"shared/catalog/world.yaml", true, true},
		{"cmd/keel/serve.go", true, false},
		{"internal/sim/sim.go", true, false},
		{"internal/store/store.go", true, false},
		{"internal/physics/step.go", true, true},
		{"internal/sky/sky.go", true, true},
		{"internal/catalog/catalog.go", true, true},
		{"internal/worldgen/worldgen.go", true, true},
		{"internal/chart/chart.go", true, true},
		{"tools/e2e/main.go", true, false},
		{"tools/dev/main.go", true, true},
		{"tools/internal/pinned/pinned.go", true, true},
		{"tools/physics/main.go", true, true},
		{"tools/licences/allowed.txt", true, true},
		// What neither reads.
		{"docs/development.md", false, false},
		{"infra/tofu/rules.tf", false, false},
		{"tools/machine/main.go", false, false},
		{".github/workflows/ci.yaml", false, false},
	} {
		if got := runs(steps, "page", c.path); got != c.page {
			t.Errorf("%s: the page's tests run %v, want %v", c.path, got, c.page)
		}
		if got := runs(steps, "scene", c.path); got != c.scene {
			t.Errorf("%s: the scene's tests run %v, want %v", c.path, got, c.scene)
		}
	}
}
