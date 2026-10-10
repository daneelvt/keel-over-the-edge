// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/production"
)

const repoPolicy = "../../infra/tailnet/policy.hujson"

func readRepoPolicy(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(repoPolicy)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRepositoryPolicyKeepsItsRules(t *testing.T) {
	if _, err := readPolicy(repoPolicy); err != nil {
		t.Fatal(err)
	}
}

// checkText parses and checks a policy given as text.
func checkText(s string) error {
	p, err := parsePolicy([]byte(s))
	if err != nil {
		return err
	}
	return p.check([]byte(s))
}

// TestEachRuleFails breaks the policy one way at a time: the check must
// fail and say why.
func TestEachRuleFails(t *testing.T) {
	cases := []struct {
		name, old, new, want string
	}{
		{"a grant for everyone", `{"src": ["autogroup:admin"], "dst": ["tag:keel-prod"], "ip": ["tcp:22"]},`,
			`{"src": ["*"], "dst": ["*"], "ip": ["*"]},`, "no rule is for everyone"},
		{"an unowned tag", `{"src": ["tag:ci-prod"], "dst": ["tag:keel-prod"], "ip": ["tcp:22"]},`,
			`{"src": ["tag:other"], "dst": ["tag:keel-prod"], "ip": ["tcp:22"]},`, "tag:other has no owner"},
		{"a tag owned by someone else", `"tag:ci-prod":   ["autogroup:admin"],`,
			`"tag:ci-prod":   ["autogroup:admin", "autogroup:member"],`, "owned by autogroup:member"},
		{"the CI node reaching another port", `{"src": ["tag:ci-prod"], "dst": ["tag:keel-prod"], "ip": ["tcp:22"]},`,
			`{"src": ["tag:ci-prod"], "dst": ["tag:keel-prod"], "ip": ["tcp:22", "tcp:6443"]},`, "SSH is the only way in"},
		{"the CI node reaching elsewhere", `{"src": ["tag:ci-prod"], "dst": ["tag:keel-prod"], "ip": ["tcp:22"]},`,
			`{"src": ["tag:ci-prod"], "dst": ["autogroup:internet"], "ip": ["tcp:22"]},`, "SSH is the only way in"},
		{"the admins without a fresh sign-in", `"action":      "check",`, `"action":      "accept",`, "only tag:ci-prod is accepted"},
		{"the CI node as another user", `"users":  ["root"],`, `"users":  ["root", "ubuntu"],`, "want tag:keel-prod as root"},
		{"a person's login", `"tag:keel-prod": ["autogroup:admin"],`, `"tag:keel-prod": ["autogroup:admin", "someone@github"],`, "a person's login"},
		{"a person's login as a source", `{"src": ["autogroup:admin"], "dst": ["tag:keel-prod"], "ip": ["tcp:22"]},`,
			`{"src": ["someone@example.com"], "dst": ["tag:keel-prod"], "ip": ["tcp:22"]},`, "a person's login"},
		{"no test of the API's port", `"tag:keel-prod:6443", `, ``, "denied tag:keel-prod:6443"},
		{"no test that SSH works", `"accept": ["tag:keel-prod:22"],`, `"accept": [],`, "reaches tag:keel-prod:22"},
		{"no SSH test", `"accept": ["root"],`, `"accept": [],`, "logs in as root"},
		{"another section", `"tagOwners": {`, `"acls": [{"action": "accept", "src": ["*"], "dst": ["*:*"]}], "tagOwners": {`, "unknown field"},
		{"not HuJSON", `"grants": [`, `"grants": [[`, "invalid"},
	}
	policy := readRepoPolicy(t)
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if !strings.Contains(policy, c.old) {
				t.Fatalf("the policy has no %q to change", c.old)
			}
			err := checkText(strings.Replace(policy, c.old, c.new, 1))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("got %v, want an error saying %q", err, c.want)
			}
		})
	}
}

// fakeTailscale is Tailscale's API, as far as -apply uses it.
type fakeTailscale struct {
	mu        sync.Mutex
	live      string
	etag      string
	refuse    string // a validation's answer, if it refuses
	changedBy bool   // the live policy changes between the read and the write
	calls     []string
	written   string
	ifMatch   string
}

const (
	clientID = "kAbCdE1CNTRL"
	jwt      = "eyJ.github.jwt"
	token    = "tskey-api-secret"
)

func (f *fakeTailscale) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	body, _ := io.ReadAll(r.Body)
	if r.URL.Path == "/api/v2/oauth/token-exchange" {
		if !strings.Contains(string(body), "client_id="+clientID) || !strings.Contains(string(body), "jwt="+jwt) {
			http.Error(w, `{"message":"invalid token"}`, http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"access_token":"`+token+`","token_type":"Bearer","expires_in":3600}`)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+token {
		http.Error(w, `{"message":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	switch r.Method + " " + r.URL.Path {
	case "POST /api/v2/tailnet/-/acl/validate":
		if f.refuse != "" {
			io.WriteString(w, f.refuse)
			return
		}
		io.WriteString(w, `{}`)
	case "GET /api/v2/tailnet/-/acl":
		w.Header().Set("ETag", f.etag)
		io.WriteString(w, f.live)
	case "POST /api/v2/tailnet/-/acl":
		f.ifMatch = r.Header.Get("If-Match")
		if f.changedBy || f.ifMatch != f.etag {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		f.written, f.live, f.etag = string(body), string(body), `"e2"`
		w.Write(body)
	default:
		http.NotFound(w, r)
	}
}

func newTestApplier(t *testing.T, f *fakeTailscale, policy string) (*applier, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	file := filepath.Join(t.TempDir(), "policy.hujson")
	if err := os.WriteFile(file, []byte(policy), 0o644); err != nil {
		t.Fatal(err)
	}
	var out, summary bytes.Buffer
	return &applier{
		out: &out, summary: nopCloser{&summary}, hc: srv.Client(), base: srv.URL, file: file,
		id: production.Identity{ClientID: clientID, Audience: "api.tailscale.com/" + clientID},
		idToken: func(_ context.Context, audience string) (string, error) {
			if audience != "api.tailscale.com/"+clientID {
				return "", errors.New("wrong audience " + audience)
			}
			return jwt, nil
		},
	}, &out, &summary
}

type nopCloser struct{ io.Writer }

func (nopCloser) Close() error { return nil }

func TestApplyWritesWhatDiffers(t *testing.T) {
	policy := readRepoPolicy(t)
	old := strings.Replace(policy, `"checkPeriod": "12h",`, `"checkPeriod": "24h",`, 1)
	f := &fakeTailscale{live: old, etag: `"e1"`}
	a, out, summary := newTestApplier(t, f, policy)
	if err := a.apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"POST /api/v2/oauth/token-exchange",
		"POST /api/v2/tailnet/-/acl/validate",
		"GET /api/v2/tailnet/-/acl",
		"POST /api/v2/tailnet/-/acl",
	}
	if strings.Join(f.calls, "\n") != strings.Join(want, "\n") {
		t.Errorf("calls:\n%s\nwant\n%s", strings.Join(f.calls, "\n"), strings.Join(want, "\n"))
	}
	if f.ifMatch != `"e1"` {
		t.Errorf("If-Match %q, want the ETag read", f.ifMatch)
	}
	if f.written != policy {
		t.Error("what was written is not the repository's policy, as written")
	}
	for _, l := range []string{`-			"checkPeriod": "24h",`, `+			"checkPeriod": "12h",`} {
		if !strings.Contains(summary.String(), l) {
			t.Errorf("the summary does not show %q:\n%s", l, summary)
		}
	}
	// The token is printed once, to mask it, and nowhere else.
	if !strings.Contains(out.String(), "::add-mask::"+token+"\n") || strings.Count(out.String(), token) != 1 || strings.Contains(summary.String(), token) || strings.Contains(out.String()+summary.String(), jwt) {
		t.Errorf("a token is printed other than to mask it:\n%s", out)
	}
}

func TestApplyWritesNothingWhenTheSame(t *testing.T) {
	policy := readRepoPolicy(t)
	f := &fakeTailscale{live: policy, etag: `"e1"`}
	a, _, summary := newTestApplier(t, f, policy)
	if err := a.apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.written != "" {
		t.Error("an unchanged policy was written")
	}
	if !strings.Contains(summary.String(), "unchanged") {
		t.Errorf("summary: %s", summary)
	}
}

func TestApplyRefusedByValidation(t *testing.T) {
	policy := readRepoPolicy(t)
	f := &fakeTailscale{live: "{}", etag: `"e1"`, refuse: `{"message":"test(s) failed","data":[{"user":"tag:ci-prod","errors":["tag:keel-prod:6443: expected deny, got allow"]}]}`}
	a, _, _ := newTestApplier(t, f, policy)
	err := a.apply(context.Background())
	if err == nil || !strings.Contains(err.Error(), "expected deny, got allow") {
		t.Fatalf("got %v, want Tailscale's refusal", err)
	}
	for _, c := range f.calls {
		if c == "POST /api/v2/tailnet/-/acl" || c == "GET /api/v2/tailnet/-/acl" {
			t.Errorf("%s after a refused validation", c)
		}
	}
}

func TestApplyRefusesWhenTheLivePolicyChanged(t *testing.T) {
	policy := readRepoPolicy(t)
	f := &fakeTailscale{live: "{}", etag: `"e1"`, changedBy: true}
	a, _, _ := newTestApplier(t, f, policy)
	if err := a.apply(context.Background()); !errors.Is(err, errChanged) {
		t.Fatalf("got %v, want %v", err, errChanged)
	}
}

func TestApplyChecksTheRulesFirst(t *testing.T) {
	broken := strings.Replace(readRepoPolicy(t), `"ip": ["tcp:22"]},`, `"ip": ["*"]},`, 1)
	f := &fakeTailscale{live: "{}", etag: `"e1"`}
	a, _, _ := newTestApplier(t, f, broken)
	if err := a.apply(context.Background()); err == nil {
		t.Fatal("a policy breaking the rules was applied")
	}
	if len(f.calls) != 0 {
		t.Errorf("Tailscale was called: %v", f.calls)
	}
}

func TestApplyRefusedToken(t *testing.T) {
	f := &fakeTailscale{live: "{}", etag: `"e1"`}
	a, _, _ := newTestApplier(t, f, readRepoPolicy(t))
	a.id.ClientID = "another"
	err := a.apply(context.Background())
	if err == nil || !strings.Contains(err.Error(), "refused this job's token") {
		t.Fatalf("got %v", err)
	}
}

func TestLineDiff(t *testing.T) {
	got := lineDiff("a\nb\nc\n", "a\nc\nd\n")
	want := []string{" a", "-b", " c", "+d"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("got %q, want %q", got, want)
	}
	if changed(lineDiff("x\ny", "x\ny\n")) {
		t.Error("a final newline is a change")
	}
}
