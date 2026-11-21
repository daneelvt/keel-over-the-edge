// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

// rulesTests are the alert rules' unit tests, in vmalert-tool's format,
// without their rule_files: the test gives each every rule production
// renders.
const rulesTests = repoCluster + "/monitoring/rules/tests"

// alertRules are the groups of every VMRule production renders, by the
// rule's name, and every alert's name among them.
func alertRules(t *testing.T) (map[string]any, []string) {
	t.Helper()
	rules := map[string]any{}
	var alerts []string
	for _, e := range prod.Entries {
		for _, o := range release(t, prod, e) {
			if o.Kind() != "VMRule" {
				continue
			}
			rules[Str(o, "metadata", "namespace")+"-"+o.Name()] = Get(o, "spec", "groups")
			for _, g := range List(o, "spec", "groups") {
				for _, r := range List(g, "rules") {
					if a := Str(r, "alert"); a != "" {
						alerts = append(alerts, a)
					}
				}
			}
		}
	}
	return rules, alerts
}

// TestAlertRules runs every alert rule's unit test with vmalert-tool, the
// release the cluster's vmalert is, against the rules as production
// renders them; and checks every alert has a test that expects it to fire,
// a severity, a component and a summary with no template in it, since the
// summary is a label.
func TestAlertRules(t *testing.T) {
	rules, alerts := alertRules(t)
	if len(alerts) == 0 {
		t.Fatal("production renders no alert")
	}
	if dup := len(alerts) - len(slices.Compact(slices.Sorted(slices.Values(alerts)))); dup != 0 {
		t.Errorf("%d alerts share a name", dup)
	}
	for name, groups := range rules {
		for _, g := range List(groups) {
			for _, r := range List(g, "rules") {
				sum, sev := Str(r, "labels", "summary"), Str(r, "labels", "severity")
				if sum == "" || strings.Contains(sum, "{{") || !slices.Contains([]string{"critical", "warning", "none"}, sev) || Str(r, "annotations", "description") == "" {
					t.Errorf("%s: %s needs a severity, a summary label with no template, and a description: %v", name, Str(r, "alert"), r)
				}
				if sev != "none" && Str(r, "labels", "component") == "" {
					t.Errorf("%s: %s names no component", name, Str(r, "alert"))
				}
			}
		}
	}

	dir := t.TempDir()
	var ruleFiles []string
	for name, groups := range rules {
		data, err := yaml.Marshal(map[string]any{"groups": groups})
		if err != nil {
			t.Fatal(err)
		}
		file := filepath.Join(dir, name+".rules.yaml")
		if err := os.WriteFile(file, data, 0o644); err != nil {
			t.Fatal(err)
		}
		ruleFiles = append(ruleFiles, file)
	}
	slices.Sort(ruleFiles)
	tests, err := filepath.Glob(filepath.Join(rulesTests, "*.yaml"))
	if err != nil || len(tests) == 0 {
		t.Fatalf("no tests in %s (%v)", rulesTests, err)
	}
	tested := map[string]bool{}
	var files []string
	for _, f := range tests {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var doc map[string]any
		if err := yaml.Unmarshal(data, &doc); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if doc["rule_files"] != nil {
			t.Errorf("%s names rule_files: the test gives it the rules production renders", f)
		}
		for _, tc := range List(doc, "tests") {
			for _, a := range List(tc, "alert_rule_test") {
				if len(List(a, "exp_alerts")) > 0 {
					tested[Str(a, "alertname")] = true
				}
			}
		}
		doc["rule_files"] = ruleFiles
		out, err := yaml.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		file := filepath.Join(dir, filepath.Base(f))
		if err := os.WriteFile(file, out, 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, file)
	}
	for _, a := range alerts {
		if !tested[a] {
			t.Errorf("no test expects %s to fire", a)
		}
	}

	dev, err := filepath.Abs(filepath.Join("..", "..", "..", ".dev"))
	if err != nil {
		t.Fatal(err)
	}
	tool, err := pinned.VMAlertTool.Ensure(context.Background(), dev, os.Stderr)
	if err != nil {
		t.Fatal(err)
	}
	// vmalert-tool keeps its test data in the folder it runs in.
	cmd := exec.Command(tool, "unittest", "--files="+strings.Join(files, ","))
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("vmalert-tool unittest: %v\n%s", err, out)
	}
}
