// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// endpoint is one setting: a write to a path under /repos/{repo}, and what a
// read of the same path must show once it is applied.
type endpoint struct {
	Method string         `json:"method"`
	Path   string         `json:"path"`
	Body   map[string]any `json:"body,omitempty"`
	// Expect is what a GET must contain; Body when empty.
	Expect map[string]any `json:"expect,omitempty"`
	// ExpectStatus, when set, is checked instead of a body: some settings
	// answer 204 when on and 404 when off.
	ExpectStatus int `json:"expect_status,omitempty"`
}

type settings struct {
	// endpoints in the order they are applied: some depend on earlier ones
	// (the action allowlist exists only once "selected actions" is on).
	endpoints []endpoint
	rulesets  []map[string]any
}

// loadSettings reads repository.json, security.json and actions.json, in
// that order, and every file in rulesets/.
func loadSettings(dir string) (settings, error) {
	var s settings
	for _, name := range []string{"repository.json", "security.json", "actions.json"} {
		var eps []endpoint
		if err := readJSON(filepath.Join(dir, name), &eps); err != nil {
			return s, err
		}
		for _, ep := range eps {
			if ep.Method != "PUT" && ep.Method != "PATCH" {
				return s, fmt.Errorf("%s: %s %s: method must be PUT or PATCH", name, ep.Method, ep.Path)
			}
		}
		s.endpoints = append(s.endpoints, eps...)
	}
	paths, err := filepath.Glob(filepath.Join(dir, "rulesets", "*.json"))
	if err != nil {
		return s, err
	}
	sort.Strings(paths)
	for _, p := range paths {
		var rs map[string]any
		if err := readJSON(p, &rs); err != nil {
			return s, err
		}
		if name, _ := rs["name"].(string); name == "" {
			return s, fmt.Errorf("%s: a ruleset needs a name", p)
		}
		s.rulesets = append(s.rulesets, rs)
	}
	return s, nil
}

func readJSON(path string, v any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

// api makes one GitHub API call and returns the status and body. A 4xx or
// 5xx status is not an error by itself.
type api interface {
	call(method, path string, body any) (status int, resp []byte, err error)
}

// ghAPI calls the API through the gh command, with the owner's login.
type ghAPI struct{}

func (ghAPI) call(method, path string, body any) (int, []byte, error) {
	args := []string{"api", "--include", "--method", method, path,
		"-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"}
	var stdin io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		args = append(args, "--input", "-")
		stdin = bytes.NewReader(raw)
	}
	cmd := exec.Command("gh", args...)
	cmd.Stdin = stdin
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	status, resp, err := parseIncluded(stdout.Bytes())
	if err != nil {
		if runErr != nil {
			return 0, nil, fmt.Errorf("gh %s %s: %v: %s", method, path, runErr, strings.TrimSpace(stderr.String()))
		}
		return 0, nil, err
	}
	return status, resp, nil
}

// parseIncluded splits gh's --include output into the status and the body.
func parseIncluded(out []byte) (int, []byte, error) {
	head, body, found := bytes.Cut(out, []byte("\r\n\r\n"))
	if !found {
		head, body, found = bytes.Cut(out, []byte("\n\n"))
	}
	if !found {
		head, body = out, nil
	}
	line, _, _ := bytes.Cut(head, []byte("\n"))
	fields := strings.Fields(string(line))
	if len(fields) < 2 || !strings.HasPrefix(fields[0], "HTTP/") {
		return 0, nil, fmt.Errorf("no HTTP status in gh output: %q", line)
	}
	status, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, nil, fmt.Errorf("bad HTTP status %q", fields[1])
	}
	return status, bytes.TrimSpace(body), nil
}

type tool struct {
	api  api
	repo string
	out  io.Writer
}

func (t *tool) url(path string) string {
	if path == "" {
		return "repos/" + t.repo
	}
	return "repos/" + t.repo + "/" + path
}

// check returns every difference between the settings and the repository.
func (t *tool) check(s settings) ([]string, error) {
	var drift []string
	for _, ep := range s.endpoints {
		d, err := t.checkEndpoint(ep)
		if err != nil {
			return nil, err
		}
		drift = append(drift, d...)
	}
	existing, err := t.rulesets()
	if err != nil {
		return nil, err
	}
	for _, want := range s.rulesets {
		name := want["name"].(string)
		id, ok := existing[name]
		if !ok {
			drift = append(drift, fmt.Sprintf("ruleset %q does not exist", name))
			continue
		}
		got, err := t.getJSON(fmt.Sprintf("rulesets/%d", id))
		if err != nil {
			return nil, err
		}
		drift = append(drift, diff("ruleset "+name, normalize(want), normalize(got))...)
	}
	return drift, nil
}

func (t *tool) checkEndpoint(ep endpoint) ([]string, error) {
	label := ep.Path
	if label == "" {
		label = "repository"
	}
	status, resp, err := t.api.call("GET", t.url(ep.Path), nil)
	if err != nil {
		return nil, err
	}
	if ep.ExpectStatus != 0 {
		if status != ep.ExpectStatus {
			return []string{fmt.Sprintf("%s: answered %d, want %d", label, status, ep.ExpectStatus)}, nil
		}
		return nil, nil
	}
	if status == 409 {
		// The setting is not in effect at all, for example the action
		// allowlist while every action is allowed.
		return []string{fmt.Sprintf("%s: not in effect (409)", label)}, nil
	}
	if status != 200 {
		return nil, fmt.Errorf("GET %s answered %d: %s", t.url(ep.Path), status, resp)
	}
	var got any
	if err := json.Unmarshal(resp, &got); err != nil {
		return nil, fmt.Errorf("GET %s: %w", t.url(ep.Path), err)
	}
	want := ep.Expect
	if want == nil {
		want = ep.Body
	}
	return diff(label, want, got), nil
}

func (t *tool) getJSON(path string) (map[string]any, error) {
	status, resp, err := t.api.call("GET", t.url(path), nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("GET %s answered %d: %s", t.url(path), status, resp)
	}
	var v map[string]any
	return v, json.Unmarshal(resp, &v)
}

// rulesets returns the repository's own rulesets by name.
func (t *tool) rulesets() (map[string]int64, error) {
	status, resp, err := t.api.call("GET", t.url("rulesets?includes_parents=false"), nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("listing rulesets answered %d: %s", status, resp)
	}
	var list []struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(resp, &list); err != nil {
		return nil, err
	}
	out := map[string]int64{}
	for _, r := range list {
		out[r.Name] = r.ID
	}
	return out, nil
}

// apply writes every setting that differs, in order, then checks again.
func (t *tool) apply(s settings) error {
	for _, ep := range s.endpoints {
		d, err := t.checkEndpoint(ep)
		if err != nil {
			return err
		}
		if len(d) == 0 {
			continue
		}
		var body any
		if ep.Body != nil {
			body = ep.Body
		}
		status, resp, err := t.api.call(ep.Method, t.url(ep.Path), body)
		if err != nil {
			return err
		}
		if status >= 300 {
			return fmt.Errorf("%s %s answered %d: %s", ep.Method, t.url(ep.Path), status, resp)
		}
		fmt.Fprintf(t.out, "applied: %s %s\n", ep.Method, t.url(ep.Path))
	}
	existing, err := t.rulesets()
	if err != nil {
		return err
	}
	for _, want := range s.rulesets {
		name := want["name"].(string)
		method, path := "POST", "rulesets"
		if id, ok := existing[name]; ok {
			got, err := t.getJSON(fmt.Sprintf("rulesets/%d", id))
			if err != nil {
				return err
			}
			if len(diff("", normalize(want), normalize(got))) == 0 {
				continue
			}
			method, path = "PUT", fmt.Sprintf("rulesets/%d", id)
		}
		status, resp, err := t.api.call(method, t.url(path), want)
		if err != nil {
			return err
		}
		if status >= 300 {
			return fmt.Errorf("%s %s answered %d: %s", method, t.url(path), status, resp)
		}
		fmt.Fprintf(t.out, "applied: ruleset %s\n", name)
	}
	drift, err := t.check(s)
	if err != nil {
		return err
	}
	if len(drift) > 0 {
		return fmt.Errorf("still different after applying:\n  %s", strings.Join(drift, "\n  "))
	}
	fmt.Fprintln(t.out, "github: the repository matches the settings")
	return nil
}

// normalize sorts a ruleset's lists whose order GitHub does not keep: rules
// by type, required checks by name.
func normalize(rs map[string]any) map[string]any {
	raw, _ := json.Marshal(rs)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	rules, _ := out["rules"].([]any)
	sort.SliceStable(rules, func(i, j int) bool { return ruleType(rules[i]) < ruleType(rules[j]) })
	for _, r := range rules {
		params, _ := r.(map[string]any)["parameters"].(map[string]any)
		if checks, ok := params["required_status_checks"].([]any); ok {
			sort.SliceStable(checks, func(i, j int) bool {
				return fmt.Sprint(checks[i].(map[string]any)["context"]) < fmt.Sprint(checks[j].(map[string]any)["context"])
			})
		}
	}
	return out
}

func ruleType(r any) string {
	m, _ := r.(map[string]any)
	s, _ := m["type"].(string)
	return s
}

// diff lists where got does not contain want. Objects need only contain the
// wanted keys; lists must match element by element; numbers compare as
// numbers.
func diff(where string, want, got any) []string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return []string{fmt.Sprintf("%s: want an object, have %s", where, show(got))}
		}
		keys := make([]string, 0, len(w))
		for k := range w {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var out []string
		for _, k := range keys {
			gv, present := g[k]
			if !present {
				out = append(out, fmt.Sprintf("%s.%s: missing, want %s", where, k, show(w[k])))
				continue
			}
			out = append(out, diff(where+"."+k, w[k], gv)...)
		}
		return out
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return []string{fmt.Sprintf("%s: want %s, have %s", where, show(want), show(got))}
		}
		var out []string
		for i := range w {
			out = append(out, diff(fmt.Sprintf("%s[%d]", where, i), w[i], g[i])...)
		}
		return out
	default:
		if !equalScalar(want, got) {
			return []string{fmt.Sprintf("%s: want %s, have %s", where, show(want), show(got))}
		}
		return nil
	}
}

func equalScalar(a, b any) bool {
	if fa, ok := number(a); ok {
		fb, ok := number(b)
		return ok && fa == fb
	}
	return reflect.DeepEqual(a, b)
}

func number(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

func show(v any) string {
	if v == nil {
		return "nothing"
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(raw)
}
