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

// environment is a deployment environment: who must approve a job that
// uses it, and which branches' workflows may.
type environment struct {
	Name string `json:"name"`
	// WaitTimer is the minutes a job waits after it is approved.
	WaitTimer int `json:"wait_timer"`
	// PreventSelfReview is whether who started a run may not approve it.
	PreventSelfReview bool       `json:"prevent_self_review"`
	Reviewers         []reviewer `json:"reviewers"`
	// DeploymentBranches are the only branches whose jobs may use the
	// environment, by name.
	DeploymentBranches []string `json:"deployment_branches"`
}

// reviewer is a user or a team, by GitHub's numeric ID.
type reviewer struct {
	Type string `json:"type"`
	ID   int64  `json:"id"`
}

type settings struct {
	// endpoints in the order they are applied: some depend on earlier ones
	// (the action allowlist exists only once "selected actions" is on).
	endpoints    []endpoint
	environments []environment
	rulesets     []map[string]any
}

// loadSettings reads repository.json, security.json and actions.json, in
// that order, environments.json, and every file in rulesets/.
func loadSettings(dir string) (settings, error) {
	var s settings
	if err := readJSON(filepath.Join(dir, "environments.json"), &s.environments); err != nil {
		return s, err
	}
	for _, env := range s.environments {
		if env.Name == "" || len(env.Reviewers) == 0 || len(env.DeploymentBranches) == 0 {
			return s, fmt.Errorf("environments.json: the environment %q needs a name, a reviewer and a branch: one with neither protects nothing", env.Name)
		}
	}
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
	for _, env := range s.environments {
		d, _, err := t.checkEnvironment(env)
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

// branchPolicy is a branch, or a pattern of branches, an environment's
// jobs may come from.
type branchPolicy struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// environmentState is what the repository holds of an environment that
// differs from the settings.
type environmentState struct {
	// rules is whether its reviewers, timer or kind of branch rule differ,
	// or it does not exist.
	rules bool
	// missing are the branches to allow; extra, the policies to remove.
	missing []string
	extra   []branchPolicy
}

// checkEnvironment compares an environment with the repository's (GitHub's
// REST API, "Deployment environments" and "Deployment branch policies").
func (t *tool) checkEnvironment(env environment) ([]string, environmentState, error) {
	var state environmentState
	label := "environment " + env.Name
	path := "environments/" + env.Name
	status, resp, err := t.api.call("GET", t.url(path), nil)
	if err != nil {
		return nil, state, err
	}
	if status == 404 {
		state.rules, state.missing = true, env.DeploymentBranches
		return []string{label + ": does not exist"}, state, nil
	}
	if status != 200 {
		return nil, state, fmt.Errorf("GET %s answered %d: %s", t.url(path), status, resp)
	}
	var got struct {
		ProtectionRules []struct {
			Type              string `json:"type"`
			WaitTimer         int    `json:"wait_timer"`
			PreventSelfReview bool   `json:"prevent_self_review"`
			Reviewers         []struct {
				Type     string `json:"type"`
				Reviewer struct {
					ID int64 `json:"id"`
				} `json:"reviewer"`
			} `json:"reviewers"`
		} `json:"protection_rules"`
		DeploymentBranchPolicy *struct {
			ProtectedBranches    bool `json:"protected_branches"`
			CustomBranchPolicies bool `json:"custom_branch_policies"`
		} `json:"deployment_branch_policy"`
	}
	if err := json.Unmarshal(resp, &got); err != nil {
		return nil, state, fmt.Errorf("GET %s: %w", t.url(path), err)
	}
	var drift []string
	timer, selfReview := 0, false
	have := []reviewer{}
	for _, rule := range got.ProtectionRules {
		switch rule.Type {
		case "wait_timer":
			timer = rule.WaitTimer
		case "required_reviewers":
			selfReview = rule.PreventSelfReview
			for _, r := range rule.Reviewers {
				have = append(have, reviewer{r.Type, r.Reviewer.ID})
			}
		}
	}
	byID := func(rs []reviewer) []reviewer {
		rs = append([]reviewer{}, rs...)
		sort.Slice(rs, func(i, j int) bool { return rs[i].Type+fmt.Sprint(rs[i].ID) < rs[j].Type+fmt.Sprint(rs[j].ID) })
		return rs
	}
	if want := byID(env.Reviewers); !reflect.DeepEqual(want, byID(have)) {
		drift = append(drift, fmt.Sprintf("%s.reviewers: want %s, have %s", label, show(want), show(byID(have))))
	}
	if timer != env.WaitTimer {
		drift = append(drift, fmt.Sprintf("%s.wait_timer: want %d, have %d", label, env.WaitTimer, timer))
	}
	if selfReview != env.PreventSelfReview {
		drift = append(drift, fmt.Sprintf("%s.prevent_self_review: want %t, have %t", label, env.PreventSelfReview, selfReview))
	}
	custom := got.DeploymentBranchPolicy != nil && got.DeploymentBranchPolicy.CustomBranchPolicies && !got.DeploymentBranchPolicy.ProtectedBranches
	if !custom {
		// Any branch, or every protected one: not the branches named.
		drift = append(drift, fmt.Sprintf("%s.deployment_branch_policy: want the branches %s alone, have %s", label, show(env.DeploymentBranches), show(got.DeploymentBranchPolicy)))
	}
	state.rules = len(drift) > 0
	if !custom {
		state.missing = env.DeploymentBranches
		return drift, state, nil
	}

	path += "/deployment-branch-policies"
	status, resp, err = t.api.call("GET", t.url(path), nil)
	if err != nil {
		return nil, state, err
	}
	if status != 200 {
		return nil, state, fmt.Errorf("GET %s answered %d: %s", t.url(path), status, resp)
	}
	var policies struct {
		BranchPolicies []branchPolicy `json:"branch_policies"`
	}
	if err := json.Unmarshal(resp, &policies); err != nil {
		return nil, state, fmt.Errorf("GET %s: %w", t.url(path), err)
	}
	allowed := map[string]bool{}
	for _, p := range policies.BranchPolicies {
		wanted := false
		for _, b := range env.DeploymentBranches {
			wanted = wanted || (p.Name == b && p.Type == "branch")
		}
		if !wanted {
			state.extra = append(state.extra, p)
			drift = append(drift, fmt.Sprintf("%s.deployment_branches: %s %q may deploy, and should not", label, p.Type, p.Name))
			continue
		}
		allowed[p.Name] = true
	}
	for _, b := range env.DeploymentBranches {
		if !allowed[b] {
			state.missing = append(state.missing, b)
			drift = append(drift, fmt.Sprintf("%s.deployment_branches: the branch %q may not deploy, and should", label, b))
		}
	}
	return drift, state, nil
}

// applyEnvironment writes what differs of an environment: its rules, then
// each branch to allow, then each policy to remove.
func (t *tool) applyEnvironment(env environment) error {
	drift, state, err := t.checkEnvironment(env)
	if err != nil || len(drift) == 0 {
		return err
	}
	write := func(method, path string, body any) error {
		status, resp, err := t.api.call(method, t.url(path), body)
		if err != nil {
			return err
		}
		if status >= 300 {
			return fmt.Errorf("%s %s answered %d: %s", method, t.url(path), status, resp)
		}
		fmt.Fprintf(t.out, "applied: %s %s\n", method, t.url(path))
		return nil
	}
	path := "environments/" + env.Name
	if state.rules {
		reviewers := []any{}
		for _, r := range env.Reviewers {
			reviewers = append(reviewers, map[string]any{"type": r.Type, "id": r.ID})
		}
		body := map[string]any{
			"wait_timer": env.WaitTimer, "prevent_self_review": env.PreventSelfReview, "reviewers": reviewers,
			"deployment_branch_policy": map[string]any{"protected_branches": false, "custom_branch_policies": true},
		}
		if err := write("PUT", path, body); err != nil {
			return err
		}
	}
	for _, b := range state.missing {
		if err := write("POST", path+"/deployment-branch-policies", map[string]any{"name": b, "type": "branch"}); err != nil {
			return err
		}
	}
	for _, p := range state.extra {
		if err := write("DELETE", fmt.Sprintf("%s/deployment-branch-policies/%d", path, p.ID), nil); err != nil {
			return err
		}
	}
	return nil
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
	for _, env := range s.environments {
		if err := t.applyEnvironment(env); err != nil {
			return err
		}
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
