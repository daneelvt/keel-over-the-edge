// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
)

// fakeAPI answers from recorded responses and records every write.
type fakeAPI struct {
	answers map[string]answer // "GET repos/o/r/path" → answer
	writes  []string
}

type answer struct {
	status int
	body   string
}

func (f *fakeAPI) call(method, path string, body any) (int, []byte, error) {
	if method != "GET" {
		raw, _ := json.Marshal(body)
		f.writes = append(f.writes, fmt.Sprintf("%s %s %s", method, path, raw))
		return 200, []byte("{}"), nil
	}
	a, ok := f.answers[method+" "+path]
	if !ok {
		return 404, []byte(`{"message":"Not Found"}`), nil
	}
	return a.status, []byte(a.body), nil
}

const repo = "o/r"

func testSettings() settings {
	return settings{
		endpoints: []endpoint{
			{Method: "PATCH", Path: "", Body: map[string]any{
				"has_wiki": false,
				"security_and_analysis": map[string]any{
					"secret_scanning": map[string]any{"status": "enabled"},
				},
			}},
			{Method: "PUT", Path: "vulnerability-alerts", ExpectStatus: 204},
			{Method: "PUT", Path: "private-vulnerability-reporting", Expect: map[string]any{"enabled": true}},
			{Method: "PUT", Path: "actions/permissions/artifact-and-log-retention", Body: map[string]any{"days": float64(90)}},
		},
		rulesets: []map[string]any{{
			"name": "main", "target": "branch", "enforcement": "active",
			"rules": []any{
				map[string]any{"type": "required_signatures"},
				map[string]any{"type": "deletion"},
				map[string]any{"type": "required_status_checks", "parameters": map[string]any{
					"required_status_checks": []any{
						map[string]any{"context": "pr-lint"},
						map[string]any{"context": "ci"},
					},
				}},
			},
		}},
	}
}

// matching is a repository that has every setting of testSettings.
func matching() map[string]answer {
	return map[string]answer{
		"GET repos/o/r":                                                {200, `{"has_wiki":false,"name":"r","security_and_analysis":{"secret_scanning":{"status":"enabled"},"other":{"status":"disabled"}}}`},
		"GET repos/o/r/vulnerability-alerts":                           {204, ``},
		"GET repos/o/r/private-vulnerability-reporting":                {200, `{"enabled":true}`},
		"GET repos/o/r/actions/permissions/artifact-and-log-retention": {200, `{"days":90,"maximum_allowed_days":90}`},
		"GET repos/o/r/rulesets?includes_parents=false":                {200, `[{"id":7,"name":"main"}]`},
		// GitHub returns the rules and checks in its own order, with extra fields.
		"GET repos/o/r/rulesets/7": {200, `{"id":7,"name":"main","target":"branch","enforcement":"active","source":"o/r","rules":[
			{"type":"deletion"},
			{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,"required_status_checks":[{"context":"ci"},{"context":"pr-lint"}]}},
			{"type":"required_signatures"}]}`},
	}
}

func TestCheckMatching(t *testing.T) {
	tl := &tool{api: &fakeAPI{answers: matching()}, repo: repo, out: io.Discard}
	drift, err := tl.check(testSettings())
	if err != nil {
		t.Fatal(err)
	}
	if len(drift) > 0 {
		t.Fatalf("drift on a matching repository: %v", drift)
	}
}

func TestCheckFindsDrift(t *testing.T) {
	cases := map[string]struct {
		key, body string
		status    int
		want      string
	}{
		"repository field": {"GET repos/o/r", `{"has_wiki":true,"security_and_analysis":{"secret_scanning":{"status":"enabled"}}}`, 200, "repository.has_wiki"},
		"nested field":     {"GET repos/o/r", `{"has_wiki":false,"security_and_analysis":{"secret_scanning":{"status":"disabled"}}}`, 200, "secret_scanning.status"},
		"status toggle":    {"GET repos/o/r/vulnerability-alerts", ``, 404, "vulnerability-alerts: answered 404"},
		"expect":           {"GET repos/o/r/private-vulnerability-reporting", `{"enabled":false}`, 200, "private-vulnerability-reporting.enabled"},
		"number":           {"GET repos/o/r/actions/permissions/artifact-and-log-retention", `{"days":30}`, 200, "days: want 90, have 30"},
		"no ruleset":       {"GET repos/o/r/rulesets?includes_parents=false", `[]`, 200, `ruleset "main" does not exist`},
		"ruleset rule": {"GET repos/o/r/rulesets/7", `{"name":"main","target":"branch","enforcement":"active","rules":[
			{"type":"deletion"},{"type":"required_signatures"}]}`, 200, "ruleset main.rules"},
		"ruleset enforcement": {"GET repos/o/r/rulesets/7", `{"name":"main","target":"branch","enforcement":"disabled","rules":[
			{"type":"deletion"},{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci"},{"context":"pr-lint"}]}},{"type":"required_signatures"}]}`, 200, "ruleset main.enforcement"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			answers := matching()
			answers[tc.key] = answer{tc.status, tc.body}
			tl := &tool{api: &fakeAPI{answers: answers}, repo: repo, out: io.Discard}
			drift, err := tl.check(testSettings())
			if err != nil {
				t.Fatal(err)
			}
			if len(drift) != 1 || !strings.Contains(drift[0], tc.want) {
				t.Fatalf("drift = %q, want one mentioning %q", drift, tc.want)
			}
		})
	}
}

func TestApplyWritesOnlyWhatDiffers(t *testing.T) {
	answers := matching()
	answers["GET repos/o/r/private-vulnerability-reporting"] = answer{200, `{"enabled":false}`}
	answers["GET repos/o/r/rulesets?includes_parents=false"] = answer{200, `[]`}
	f := &fakeAPI{answers: answers}
	tl := &tool{api: f, repo: repo, out: io.Discard}
	// The fake never changes, so the final check fails; the writes are what
	// this test is about.
	_ = tl.apply(testSettings())
	if len(f.writes) != 2 {
		t.Fatalf("writes = %q, want two", f.writes)
	}
	if !strings.HasPrefix(f.writes[0], "PUT repos/o/r/private-vulnerability-reporting null") {
		t.Errorf("first write %q", f.writes[0])
	}
	if !strings.HasPrefix(f.writes[1], `POST repos/o/r/rulesets {"enforcement":"active","name":"main"`) {
		t.Errorf("second write %q", f.writes[1])
	}
}

func TestApplyUpdatesAnExistingRuleset(t *testing.T) {
	answers := matching()
	answers["GET repos/o/r/rulesets/7"] = answer{200, `{"name":"main","target":"branch","enforcement":"evaluate","rules":[]}`}
	f := &fakeAPI{answers: answers}
	tl := &tool{api: f, repo: repo, out: io.Discard}
	_ = tl.apply(testSettings())
	if len(f.writes) != 1 || !strings.HasPrefix(f.writes[0], "PUT repos/o/r/rulesets/7 ") {
		t.Fatalf("writes = %q", f.writes)
	}
}

func TestParseIncluded(t *testing.T) {
	status, body, err := parseIncluded([]byte("HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"a\":1}\n"))
	if err != nil || status != 200 || string(body) != `{"a":1}` {
		t.Fatalf("got %d %q %v", status, body, err)
	}
	status, body, err = parseIncluded([]byte("HTTP/2.0 204 No Content\r\nX: y\r\n\r\n"))
	if err != nil || status != 204 || len(body) != 0 {
		t.Fatalf("got %d %q %v", status, body, err)
	}
	if _, _, err := parseIncluded([]byte("gh: not logged in")); err == nil {
		t.Fatal("accepted output without a status")
	}
}

func TestLoadRepositorySettings(t *testing.T) {
	s, err := loadSettings("../../.github/settings")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.endpoints) == 0 || len(s.rulesets) != 2 {
		t.Fatalf("loaded %d endpoints and %d rulesets", len(s.endpoints), len(s.rulesets))
	}
	// The allowlist of actions depends on "selected actions" being on.
	var perm, selected int
	for i, ep := range s.endpoints {
		switch ep.Path {
		case "actions/permissions":
			perm = i
		case "actions/permissions/selected-actions":
			selected = i
		}
	}
	if perm >= selected {
		t.Fatal("actions/permissions must be applied before selected-actions")
	}
}
