// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRepositorysDashboards: every dashboard the repository holds is
// valid, has a UID of its own, names only the cluster's data sources, and
// is in the kustomization; every vendored one is pinned.
func TestRepositorysDashboards(t *testing.T) {
	t.Chdir("../..")
	if err := checkAll(dir); err != nil {
		t.Fatal(err)
	}
	ds, err := readIndex(dir)
	if err != nil {
		t.Fatal(err)
	}
	own, vendored := 0, 0
	for _, d := range ds {
		if d.From == nil {
			own++
		} else {
			vendored++
		}
		// A ConfigMap holds a megabyte at most.
		if info, err := os.Stat(filepath.Join(dir, d.File)); err != nil || info.Size() > 900<<10 {
			t.Errorf("%s: %v, too large for a ConfigMap, or missing", d.File, err)
		}
	}
	if own < 6 || vendored == 0 {
		t.Errorf("%d dashboards of our own and %d vendored", own, vendored)
	}
}

const published = `{
  "__inputs": [{"name": "DS_PROMETHEUS", "pluginId": "prometheus", "type": "datasource"}, {"name": "DS_EXPRESSION", "pluginId": "__expr__", "type": "datasource"}],
  "__requires": [{"id": "grafana"}],
  "uid": "upstream", "title": "Upstream",
  "templating": {"list": [{"name": "ds", "type": "datasource", "query": "prometheus"}, {"name": "job", "type": "query", "datasource": {"type": "prometheus", "uid": "${ds}"}}]},
  "panels": [
    {"datasource": {"type": "prometheus", "uid": "${DS_PROMETHEUS}"}, "targets": [{"datasource": "$ds", "expr": "up"}, {"datasource": {"uid": "${DS_EXPRESSION}"}}]},
    {"datasource": {"uid": "prometheus"}, "type": "row"},
    {"datasource": "prometheus", "targets": [{"datasource": {"type": "prometheus", "uid": "-- Mixed --"}}]}
  ]
}`

// TestRewrite: a published dashboard is made one Grafana is given as a
// file, and nothing else in it changes.
func TestRewrite(t *testing.T) {
	out, err := rewrite([]byte(published))
	if err != nil {
		t.Fatal(err)
	}
	if uid, err := checkDashboard(out); err != nil || uid != "upstream" {
		t.Fatalf("the rewritten dashboard: %q, %v\n%s", uid, err, out)
	}
	var d map[string]any
	json.Unmarshal(out, &d)
	if d["__inputs"] != nil || d["__requires"] != nil {
		t.Error("the import inputs are left")
	}
	s := string(out)
	for _, gone := range []string{"${DS_PROMETHEUS}", "${DS_EXPRESSION}", `"uid": "prometheus"`, `"datasource": "prometheus"`} {
		if strings.Contains(s, gone) {
			t.Errorf("%s is left:\n%s", gone, s)
		}
	}
	// The type of a data source is not its name.
	if strings.Count(s, `"type": "prometheus"`) != 3 || !strings.Contains(s, `"value": "VictoriaMetrics"`) || !strings.Contains(s, `"uid": "__expr__"`) {
		t.Errorf("rewritten:\n%s", s)
	}
	// As published, it is refused.
	if _, err := checkDashboard([]byte(published)); err == nil {
		t.Error("a dashboard with its import inputs was accepted")
	}
}

func TestCheckDashboardRefuses(t *testing.T) {
	for name, tc := range map[string]struct{ json, want string }{
		"not JSON":             {`{"uid": `, "unexpected"},
		"no UID":               {`{"title": "x"}`, "no uid or title"},
		"a long UID":           {`{"title": "x", "uid": "` + strings.Repeat("a", 41) + `"}`, "40 characters"},
		"another data source":  {`{"title": "x", "uid": "x", "panels": [{"datasource": {"type": "loki", "uid": "Loki"}}]}`, "[Loki]"},
		"an unknown variable":  {`{"title": "x", "uid": "x", "panels": [{"datasource": {"uid": "${ds}"}}]}`, "[${ds}]"},
		"a variable of others": {`{"title": "x", "uid": "x", "templating": {"list": [{"name": "ds", "type": "datasource", "query": "loki"}]}}`, `"loki" data sources`},
	} {
		if _, err := checkDashboard([]byte(tc.json)); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v, want %q", name, err, tc.want)
		}
	}
	for _, ok := range []string{
		`{"title": "x", "uid": "x", "panels": [{"datasource": {"type": "prometheus", "uid": "VictoriaMetrics"}}, {"datasource": {"uid": "Database"}}, {"datasource": "-- Grafana --"}]}`,
		`{"title": "x", "uid": "x", "templating": {"list": [{"name": "ds", "type": "datasource", "query": "prometheus"}]}, "panels": [{"datasource": {"uid": "$ds"}}]}`,
	} {
		if _, err := checkDashboard([]byte(ok)); err != nil {
			t.Errorf("refused %s: %v", ok, err)
		}
	}
}

// TestPull: a vendored dashboard is fetched at its commit, its SHA-256
// recorded the first time and held to after; the kustomization lists every
// dashboard with its folder; a changed file, a branch, and a dashboard
// nobody listed are each refused.
func TestPull(t *testing.T) {
	body := published
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/someone/dashboards/"+strings.Repeat("ab", 20)+"/boards/upstream.json" {
			http.NotFound(w, r)
			return
		}
		io.WriteString(w, body)
	}))
	defer srv.Close()
	d := t.TempDir()
	os.MkdirAll(filepath.Join(d, "keel"), 0o755)
	os.MkdirAll(filepath.Join(d, "vendored"), 0o755)
	os.WriteFile(filepath.Join(d, "keel", "ours.json"), []byte(`{"title": "Ours", "uid": "ours"}`), 0o644)
	index := "# A comment that stays.\ndashboards:\n  - file: keel/ours.json\n    folder: Keel\n  - file: vendored/upstream.json\n    folder: Others\n    from:\n      repo: someone/dashboards\n      commit: " +
		strings.Repeat("ab", 20) + "\n      path: boards/upstream.json\n      sha256: \"\"\n"
	os.WriteFile(filepath.Join(d, indexFile), []byte(index), 0o644)
	if err := pullAll(context.Background(), d, srv.URL, srv.Client(), io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := checkAll(d); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(published))
	got, _ := os.ReadFile(filepath.Join(d, indexFile))
	if !strings.Contains(string(got), "sha256: "+hex.EncodeToString(sum[:])) || !strings.HasPrefix(string(got), "# A comment that stays.\n") {
		t.Errorf("the index after a first pull:\n%s", got)
	}
	k, _ := os.ReadFile(filepath.Join(d, "kustomization.yaml"))
	for _, want := range []string{"name: dashboard-ours", "- keel/ours.json", "grafana_folder: Keel", "name: dashboard-upstream", "grafana_folder: Others", "disableNameSuffixHash: true", `grafana_dashboard: "1"`} {
		if !strings.Contains(string(k), want) {
			t.Errorf("the kustomization lacks %q:\n%s", want, k)
		}
	}
	// What is published changes under the same commit: refused.
	body = strings.Replace(published, "Upstream", "Changed", 1)
	if err := pullAll(context.Background(), d, srv.URL, srv.Client(), io.Discard); err == nil || !strings.Contains(err.Error(), "not the") {
		t.Errorf("a changed file: %v", err)
	}
	// A dashboard nobody listed, and a kustomization edited by hand.
	os.WriteFile(filepath.Join(d, "keel", "stray.json"), []byte(`{"title": "Stray", "uid": "stray"}`), 0o644)
	if err := checkAll(d); err == nil || !strings.Contains(err.Error(), "stray.json is not in") {
		t.Errorf("a stray dashboard: %v", err)
	}
	os.Remove(filepath.Join(d, "keel", "stray.json"))
	os.WriteFile(filepath.Join(d, "kustomization.yaml"), append(k, "# by hand\n"...), 0o644)
	if err := checkAll(d); err == nil || !strings.Contains(err.Error(), "-pull") {
		t.Errorf("an edited kustomization: %v", err)
	}
	// Two dashboards with one UID.
	os.WriteFile(filepath.Join(d, "kustomization.yaml"), k, 0o644)
	os.WriteFile(filepath.Join(d, "keel", "ours.json"), []byte(`{"title": "Ours", "uid": "upstream"}`), 0o644)
	if err := checkAll(d); err == nil || !strings.Contains(err.Error(), "share the UID") {
		t.Errorf("a shared UID: %v", err)
	}
	// A branch is no pin.
	os.WriteFile(filepath.Join(d, indexFile), []byte(strings.Replace(string(got), strings.Repeat("ab", 20), "master", 1)), 0o644)
	if err := pullAll(context.Background(), d, srv.URL, srv.Client(), io.Discard); err == nil || !strings.Contains(err.Error(), "is not a commit") {
		t.Errorf("a branch: %v", err)
	}
}
