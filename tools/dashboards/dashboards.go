// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Dashboard is one dashboard of index.yaml.
type Dashboard struct {
	// File is its JSON file, under the dashboards' folder.
	File string `yaml:"file"`
	// Folder is its folder in Grafana.
	Folder string `yaml:"folder"`
	// From is where a vendored dashboard comes from; nil for our own.
	From *Source `yaml:"from,omitempty"`
}

// Source is a vendored dashboard's origin: a file at a commit of a
// repository on GitHub, and its SHA-256 as published there.
type Source struct {
	Repo   string `yaml:"repo"`
	Commit string `yaml:"commit"`
	Path   string `yaml:"path"`
	SHA256 string `yaml:"sha256"`
}

// The cluster's data sources, as Grafana is given them (the monitoring
// stack's values): each by its UID, which is its name too.
var dataSources = map[string]string{
	"VictoriaMetrics": "prometheus",
	"VictoriaLogs":    "victoriametrics-logs-datasource",
	"Alertmanager":    "alertmanager",
	"Database":        "grafana-postgresql-datasource",
}

// grafanaOwn are the data sources Grafana has of itself.
var grafanaOwn = []string{"-- Grafana --", "grafana", "-- Mixed --", "-- Dashboard --", "__expr__"}

const indexFile = "index.yaml"

func readIndex(dir string) ([]Dashboard, error) {
	data, err := os.ReadFile(filepath.Join(dir, indexFile))
	if err != nil {
		return nil, err
	}
	var idx struct {
		Dashboards []Dashboard `yaml:"dashboards"`
	}
	if err := yaml.Unmarshal(data, &idx); err != nil {
		return nil, fmt.Errorf("%s: %w", indexFile, err)
	}
	return idx.Dashboards, nil
}

var commitID = regexp.MustCompile(`^[0-9a-f]{40}$`)

// pullAll fetches every vendored dashboard from base (GitHub's raw
// content), checks it, rewrites it and writes it; then the kustomization.
func pullAll(ctx context.Context, dir, base string, hc *http.Client, out io.Writer) error {
	ds, err := readIndex(dir)
	if err != nil {
		return err
	}
	changed := false
	for i, d := range ds {
		if d.From == nil {
			continue
		}
		f := d.From
		if !commitID.MatchString(f.Commit) {
			return fmt.Errorf("%s: %q is not a commit: a vendored dashboard is pinned by its commit", d.File, f.Commit)
		}
		url := base + "/" + f.Repo + "/" + f.Commit + "/" + f.Path
		raw, err := fetch(ctx, hc, url)
		if err != nil {
			return fmt.Errorf("%s: %w", d.File, err)
		}
		sum := sha256.Sum256(raw)
		got := hex.EncodeToString(sum[:])
		switch f.SHA256 {
		case "":
			ds[i].From.SHA256 = got
			changed = true
		case got:
		default:
			return fmt.Errorf("%s: %s has the SHA-256 %s, not the %s recorded", d.File, url, got, f.SHA256)
		}
		rewritten, err := rewrite(raw)
		if err != nil {
			return fmt.Errorf("%s: %w", d.File, err)
		}
		if err := os.WriteFile(filepath.Join(dir, d.File), rewritten, 0o644); err != nil {
			return err
		}
		fmt.Fprintf(out, "dashboards: %s from %s at %s (%d bytes)\n", d.File, f.Repo, f.Commit[:12], len(rewritten))
	}
	if changed {
		if err := writeIndex(dir, ds); err != nil {
			return err
		}
	}
	return os.WriteFile(filepath.Join(dir, "kustomization.yaml"), kustomization(ds), 0o644)
}

func fetch(ctx context.Context, hc *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", url, res.Status)
	}
	return io.ReadAll(io.LimitReader(res.Body, 8<<20))
}

func writeIndex(dir string, ds []Dashboard) error {
	old, err := os.ReadFile(filepath.Join(dir, indexFile))
	if err != nil {
		return err
	}
	// The comment before the list is kept.
	head, _, _ := bytes.Cut(old, []byte("\ndashboards:"))
	var body bytes.Buffer
	enc := yaml.NewEncoder(&body)
	enc.SetIndent(2)
	if err := enc.Encode(map[string]any{"dashboards": ds}); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, indexFile), append(append(head, '\n'), body.Bytes()...), 0o644)
}

// rewrite makes a published dashboard one Grafana is given as a file: its
// import inputs gone (they are filled in only when a person imports it),
// each data source variable choosing VictoriaMetrics, an input's name
// where it was used replaced by what it stands for, and a data source
// named by the upstream's default name, prometheus, by ours.
func rewrite(raw []byte) ([]byte, error) {
	var d map[string]any
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, err
	}
	inputs := map[string]string{}
	for _, in := range list(d["__inputs"]) {
		m, _ := in.(map[string]any)
		name, _ := m["name"].(string)
		switch m["pluginId"] {
		case "prometheus":
			inputs["${"+name+"}"] = "VictoriaMetrics"
		case "__expr__":
			inputs["${"+name+"}"] = "__expr__"
		}
	}
	for _, k := range []string{"__inputs", "__requires", "__elements"} {
		delete(d, k)
	}
	if t, ok := d["templating"].(map[string]any); ok {
		for _, v := range list(t["list"]) {
			m, _ := v.(map[string]any)
			if m["type"] == "datasource" && m["query"] == "prometheus" {
				m["current"] = map[string]any{"text": "VictoriaMetrics", "value": "VictoriaMetrics"}
			}
		}
	}
	out := replaceStrings(d, inputs)
	renameSource(out, "prometheus", "VictoriaMetrics")
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

func list(v any) []any {
	l, _ := v.([]any)
	return l
}

// replaceStrings replaces each string equal to a key of r with its value,
// everywhere under v.
func replaceStrings(v any, r map[string]string) any {
	switch v := v.(type) {
	case string:
		if s, ok := r[v]; ok {
			return s
		}
		return v
	case map[string]any:
		for k, e := range v {
			v[k] = replaceStrings(e, r)
		}
	case []any:
		for i, e := range v {
			v[i] = replaceStrings(e, r)
		}
	}
	return v
}

// renameSource renames the data source from to to, wherever a panel or a
// target names it, by its name or its uid.
func renameSource(v any, from, to string) {
	switch v := v.(type) {
	case map[string]any:
		for k, e := range v {
			if k == "datasource" {
				switch ds := e.(type) {
				case string:
					if ds == from {
						v[k] = to
					}
				case map[string]any:
					if ds["uid"] == from {
						ds["uid"] = to
					}
				}
			}
			renameSource(e, from, to)
		}
	case []any:
		for _, e := range v {
			renameSource(e, from, to)
		}
	}
}

// kustomization is the dashboards' kustomization: a ConfigMap for each,
// which Grafana's sidecar finds by its label and files in its folder.
func kustomization(ds []Dashboard) []byte {
	var b strings.Builder
	b.WriteString(`# SPDX-License-Identifier: AGPL-3.0-only
# Written by go run ./tools/dashboards -pull, from index.yaml: one
# ConfigMap a dashboard, which Grafana's sidecar finds by its label and
# puts in the folder its annotation names. Not edited by hand.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: monitoring
generatorOptions:
  disableNameSuffixHash: true
  labels:
    grafana_dashboard: "1"
configMapGenerator:
`)
	for _, d := range ds {
		fmt.Fprintf(&b, "  - name: dashboard-%s\n    files:\n      - %s\n    options:\n      annotations:\n        grafana_folder: %s\n",
			strings.TrimSuffix(path.Base(d.File), ".json"), d.File, d.Folder)
	}
	return []byte(b.String())
}

// checkAll checks every dashboard of the index, and that no other is in
// the folder, and that the kustomization is the one -pull writes.
func checkAll(dir string) error {
	ds, err := readIndex(dir)
	if err != nil {
		return err
	}
	var errs []error
	uids := map[string]string{}
	listed := map[string]bool{}
	for _, d := range ds {
		listed[d.File] = true
		if d.Folder == "" {
			errs = append(errs, fmt.Errorf("%s: no folder", d.File))
		}
		if d.From != nil && (!commitID.MatchString(d.From.Commit) || len(d.From.SHA256) != 64) {
			errs = append(errs, fmt.Errorf("%s: vendored, but not pinned by a commit and its SHA-256", d.File))
		}
		data, err := os.ReadFile(filepath.Join(dir, d.File))
		if err != nil {
			errs = append(errs, err)
			continue
		}
		uid, err := checkDashboard(data)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", d.File, err))
			continue
		}
		if prev, ok := uids[uid]; ok {
			errs = append(errs, fmt.Errorf("%s and %s share the UID %q", d.File, prev, uid))
		}
		uids[uid] = d.File
	}
	files, err := filepath.Glob(filepath.Join(dir, "*", "*.json"))
	if err != nil {
		return err
	}
	more, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	for _, f := range append(files, more...) {
		rel, _ := filepath.Rel(dir, f)
		if !listed[filepath.ToSlash(rel)] {
			errs = append(errs, fmt.Errorf("%s is not in %s", rel, indexFile))
		}
	}
	have, err := os.ReadFile(filepath.Join(dir, "kustomization.yaml"))
	if err != nil {
		return err
	}
	if !bytes.Equal(have, kustomization(ds)) {
		errs = append(errs, errors.New("kustomization.yaml is not the one index.yaml makes: run go run ./tools/dashboards -pull"))
	}
	return errors.Join(errs...)
}

// checkDashboard checks one dashboard: valid JSON with a UID and a title,
// no import inputs left, and every data source it names is the cluster's,
// Grafana's own, or a variable of the dashboard's that chooses among the
// cluster's. It returns the UID.
func checkDashboard(data []byte) (string, error) {
	var d map[string]any
	if err := json.Unmarshal(data, &d); err != nil {
		return "", err
	}
	uid, _ := d["uid"].(string)
	title, _ := d["title"].(string)
	if uid == "" || title == "" {
		return "", errors.New("no uid or title")
	}
	if len(uid) > 40 {
		return "", fmt.Errorf("the UID %q is longer than Grafana's 40 characters", uid)
	}
	if _, ok := d["__inputs"]; ok {
		return "", errors.New("import inputs left in it")
	}
	vars := map[string]bool{}
	if t, ok := d["templating"].(map[string]any); ok {
		for _, v := range list(t["list"]) {
			m, _ := v.(map[string]any)
			if m["type"] != "datasource" {
				continue
			}
			q, _ := m["query"].(string)
			if !slices.Contains(values(dataSources), q) {
				return "", fmt.Errorf("the variable %v chooses among %q data sources, which the cluster has none of", m["name"], q)
			}
			name, _ := m["name"].(string)
			vars[name] = true
		}
	}
	var bad []string
	var walk func(v any)
	walk = func(v any) {
		switch v := v.(type) {
		case map[string]any:
			for k, e := range v {
				if k == "datasource" {
					if ref := dsRef(e); ref != "" && !knownSource(ref, vars) {
						bad = append(bad, ref)
					}
				}
				walk(e)
			}
		case []any:
			for _, e := range v {
				walk(e)
			}
		}
	}
	walk(d)
	if len(bad) > 0 {
		slices.Sort(bad)
		return "", fmt.Errorf("it names data sources the cluster does not have: %v", slices.Compact(bad))
	}
	return uid, nil
}

// values lists the values of m.
func values(m map[string]string) []string {
	var out []string
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

// dsRef is the data source a panel's or target's datasource names: a
// string, or an object's uid.
func dsRef(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case map[string]any:
		uid, _ := v["uid"].(string)
		return uid
	}
	return ""
}

var variable = regexp.MustCompile(`^\$\{?([A-Za-z0-9_]+)\}?$`)

func knownSource(ref string, vars map[string]bool) bool {
	if _, ok := dataSources[ref]; ok || slices.Contains(grafanaOwn, ref) {
		return true
	}
	m := variable.FindStringSubmatch(ref)
	return m != nil && vars[m[1]]
}
