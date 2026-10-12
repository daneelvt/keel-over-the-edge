// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/production"
)

// The credentials the fake Infisical holds, and the job's OIDC tokens.
var creds = map[string]string{
	"CLOUDFLARE_API_TOKEN": "cf-token-0123456789",
	"B2_KEY_ID":            "b2-key-id-0123",
	"B2_KEY":               "b2-key-secret-4567",
	"TOFU_PASSPHRASE":      "a-passphrase-of-forty-eight-letters-and-digits00",
	"NOTIFY_EMAIL":         "owner@example.org",
}

const (
	runID  = "4242"
	commit = "0123456789abcdef0123456789abcdef01234567"
)

// thePlan is what tofu show -json prints of a plan: the tunnel whose
// connections moved, with the machine's address in them; the tunnel's
// token written write-only; a zone setting changed; and a new record.
const thePlan = `{
  "format_version": "1.2",
  "resource_changes": [
    {
      "address": "cloudflare_zero_trust_tunnel_cloudflared.prod",
      "change": {
        "actions": ["update"],
        "before": {"name": "keel-prod", "tunnel_secret": "fake-fake-fake-fake", "connections": [{"origin_ip": "203.0.113.7", "colo_name": "ewr01"}], "status": "healthy"},
        "after": {"name": "keel-prod", "tunnel_secret": "fake-fake-fake-fake", "connections": [{"origin_ip": "198.51.100.9", "colo_name": "ewr08"}], "status": "healthy"},
        "after_unknown": {},
        "before_sensitive": {"tunnel_secret": true},
        "after_sensitive": {"tunnel_secret": true}
      }
    },
    {
      "address": "infisical_secret.tunnel_token",
      "change": {
        "actions": ["update"],
        "before": {"name": "TUNNEL_TOKEN", "value_wo": null, "value_wo_version": 1},
        "after": {"name": "TUNNEL_TOKEN", "value_wo": null, "value_wo_version": 2},
        "after_unknown": {"last_updated": true}
      }
    },
    {
      "address": "cloudflare_zone_setting.zone[\"ssl\"]",
      "change": {"actions": ["update"], "before": {"value": "full"}, "after": {"value": "strict"}, "after_unknown": {}}
    },
    {
      "address": "cloudflare_dns_record.play",
      "change": {"actions": ["create"], "before": null, "after": {"name": "play.keelovertheedge.com", "content": "6ff42ae2-0000-4000-8000-000000000000.cfargotunnel.com"}, "after_unknown": {"id": true}}
    },
    {
      "address": "cloudflare_ruleset.cache",
      "change": {"actions": ["no-op"], "before": {"name": "cache"}, "after": {"name": "cache"}}
    }
  ]
}`

// values are every value thePlan holds: none may reach the log or the
// summary.
var values = []string{"fake-fake-fake-fake", "203.0.113.7", "198.51.100.9", "ewr01", "ewr08", "full", "strict", "6ff42ae2", "healthy"}

// fakeTofu stands for OpenTofu: it records each run, keeps a plan where
// it is told to, and prints thePlan for show -json.
type fakeTofu struct {
	t     *testing.T
	log   *bytes.Buffer
	calls []call
	// fail makes the named subcommand fail, saying this on its standard
	// error.
	fail, says string
	// plan, if set, is what show -json prints, not thePlan.
	plan string
}

type call struct {
	cmd
	// logged is the log as it was when the call was made.
	logged string
}

func (f *fakeTofu) run(_ context.Context, c cmd) ([]byte, []byte, error) {
	f.calls = append(f.calls, call{c, f.log.String()})
	sub := c.argv[1]
	var data string
	for _, e := range c.env {
		if d, ok := strings.CutPrefix(e, "TF_DATA_DIR="); ok {
			data = d
		}
	}
	// As OpenTofu: init leaves the backend's settings in the working
	// folder, and every later command of the run needs them there.
	marker := filepath.Join(data, "terraform.tfstate")
	switch sub {
	case "init":
		os.MkdirAll(data, 0o700)
		os.WriteFile(marker, []byte("{}"), 0o600)
	case "plan", "show", "apply":
		if _, err := os.Stat(marker); err != nil {
			return nil, []byte("Error: Backend initialization required, please run \"tofu init\""), errors.New("exit status 1")
		}
	}
	if sub == f.fail {
		return []byte("everything OpenTofu printed, values and all: 198.51.100.9"), []byte(f.says), errors.New("exit status 1")
	}
	switch sub {
	case "plan":
		for _, arg := range c.argv {
			if out, ok := strings.CutPrefix(arg, "-out="); ok {
				os.WriteFile(out, []byte("an encrypted plan"), 0o600)
			}
		}
		return []byte("  # cloudflare_zone_setting.zone[\"ssl\"] will be updated\n  ~ value = \"full\" -> \"strict\"\n"), nil, nil
	case "show":
		if f.plan != "" {
			return []byte(f.plan), nil, nil
		}
		return []byte(thePlan), nil, nil
	case "apply":
		return []byte("cloudflare_zero_trust_tunnel_cloudflared.prod: Modifying... [connections: 198.51.100.9]\n"), nil, nil
	}
	return nil, nil, nil
}

// ran are the calls of a tofu subcommand.
func (f *fakeTofu) ran(sub string) []call {
	var out []call
	for _, c := range f.calls {
		if c.argv[1] == sub {
			out = append(out, c)
		}
	}
	return out
}

func fakeInfisical(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/auth/oidc-auth/login":
			var in map[string]string
			json.NewDecoder(r.Body).Decode(&in)
			if in["identityId"] != "gha-accounts-id" || !strings.HasPrefix(in["jwt"], "job-token-") {
				http.Error(w, `{"message":"refused"}`, http.StatusUnauthorized)
				return
			}
			io.WriteString(w, `{"accessToken":"infisical-access-token"}`)
		case strings.HasPrefix(r.URL.Path, "/api/v4/secrets/"):
			q := r.URL.Query()
			v, ok := creds[path.Base(r.URL.Path)]
			if !ok || r.Header.Get("Authorization") != "Bearer infisical-access-token" || q.Get("projectId") != "keel-accounts-id" || q.Get("environment") != "prod" || q.Get("secretPath") != "/accounts" {
				http.Error(w, `{"message":"forbidden"}`, http.StatusForbidden)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"secret": map[string]string{"secretValue": v}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

type nopCloser struct{ io.Writer }

func (nopCloser) Close() error { return nil }

func testAccounts(t *testing.T) (*accounts, *fakeTofu, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	srv := fakeInfisical(t)
	var log, summary bytes.Buffer
	f := &fakeTofu{t: t, log: &log}
	var p production.Production
	p.Infisical.Host, p.Infisical.Audience, p.Infisical.Environment = srv.URL, "https://github.com/daneelvt", "prod"
	p.Infisical.Accounts.IdentityID, p.Infisical.Accounts.Project = "gha-accounts-id", "keel-accounts-id"
	p.Infisical.Cluster.Project = "keel-cluster-id"
	p.Cloudflare.Account, p.Cloudflare.Zone = "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"
	p.State.Bucket, p.State.Endpoint, p.State.Region = "keel-state", "https://s3.us-west-004.backblazeb2.com", "us-west-004"
	tokens := 0
	env := map[string]string{"GITHUB_RUN_ID": runID, "GITHUB_SHA": commit}
	a := &accounts{
		out: &log, summary: nopCloser{&summary}, cmd: f, hc: srv.Client(), prod: p, root: t.TempDir(),
		idToken: func(_ context.Context, audience string) (string, error) {
			if audience != "https://github.com/daneelvt" {
				t.Errorf("an OIDC token for %s", audience)
			}
			tokens++
			// As actions.IDToken does, each token is masked.
			tok := "job-token-" + string(rune('0'+tokens))
			io.WriteString(&log, "::add-mask::"+tok+"\n")
			return tok, nil
		},
		tofu:   func(context.Context) (string, error) { return "/pinned/tofu", nil },
		getenv: func(k string) string { return env[k] },
	}
	return a, f, &log, &summary
}

// TestPlanGivesTheCredentialsOnlyToTofu: each credential is masked before
// tofu first runs, reaches it in its environment alone, and is never on a
// command line, in the log but to mask it, or in the summary. Infisical's
// provider gets a token of its own.
func TestPlanGivesTheCredentialsOnlyToTofu(t *testing.T) {
	a, f, log, summary := testAccounts(t)
	if err := a.run(context.Background(), "plan"); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) == 0 {
		t.Fatal("tofu never ran")
	}
	first := f.calls[0]
	want := map[string]string{
		"AWS_ACCESS_KEY_ID": creds["B2_KEY_ID"], "AWS_SECRET_ACCESS_KEY": creds["B2_KEY"],
		"CLOUDFLARE_API_TOKEN": creds["CLOUDFLARE_API_TOKEN"], "TF_VAR_state_passphrase": creds["TOFU_PASSPHRASE"],
		"TF_VAR_notify_email": creds["NOTIFY_EMAIL"], "INFISICAL_AUTH_JWT": "job-token-2",
		"TF_VAR_cluster_project_id": "keel-cluster-id", "TF_VAR_infisical_identity_id": "gha-accounts-id",
	}
	for _, c := range f.calls {
		for k, v := range want {
			if !slices.Contains(c.env, k+"="+v) {
				t.Errorf("tofu %s's environment has no %s", c.argv[1], k)
			}
		}
		if c.dir != a.path(tofuDir) || !slices.Contains(c.env, "TF_DATA_DIR="+a.path(dataDir, "plan")) {
			t.Errorf("tofu %s ran in %s with %v", c.argv[1], c.dir, c.env)
		}
	}
	for _, secret := range append(slicesValues(creds), "job-token-2", "infisical-access-token") {
		for line := range strings.SplitSeq(secret, "\n") {
			if !strings.Contains(first.logged, "::add-mask::"+line+"\n") {
				t.Errorf("%q was not masked before tofu ran", line)
			}
		}
		if strings.Count(log.String(), secret) != 1 {
			t.Errorf("%q is in the log other than to mask it", secret)
		}
		if strings.Contains(summary.String(), secret) {
			t.Errorf("%q is in the summary", secret)
		}
		for _, c := range f.calls {
			if strings.Contains(strings.Join(c.argv, " "), secret) {
				t.Errorf("%q is on tofu %s's command line", secret, c.argv[1])
			}
		}
	}
	// The backend from production's identifiers, the providers from the
	// lock file alone.
	init := f.ran("init")
	if len(init) != 1 || !slices.Contains(init[0].argv, "-lockfile=readonly") {
		t.Fatalf("init %v", init)
	}
	backend, err := os.ReadFile(a.path(workDir, "backend.tfbackend"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "bucket = \"keel-state\"\nregion = \"us-west-004\"\nendpoints = {\n  s3 = \"https://s3.us-west-004.backblazeb2.com\"\n}\n"; string(backend) != want {
		t.Errorf("the backend's configuration:\n%s", backend)
	}
	// The plan kept for the apply job, with its record.
	if _, err := os.Stat(a.path(planDir, planFile)); err != nil {
		t.Error("the plan was not kept")
	}
	if err := a.checkPlan(a.path(planDir, planFile), runID, commit); err != nil {
		t.Errorf("the plan kept is refused: %v", err)
	}
}

func slicesValues(m map[string]string) []string {
	var out []string
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

// TestPlanShowsNoValue: a run shows addresses, actions and the names of
// the attributes that change, and none of the plan's values: not the
// machine's address in the tunnel's connections, not a sensitive value,
// not a setting's.
func TestPlanShowsNoValue(t *testing.T) {
	a, _, log, summary := testAccounts(t)
	if err := a.run(context.Background(), "plan"); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"## Planned: 1 to create, 3 to update",
		"| `cloudflare_zero_trust_tunnel_cloudflared.prod` | update | connections |",
		"| `infisical_secret.tunnel_token` | update | last_updated, value_wo_version |",
		"| `cloudflare_zone_setting.zone[\"ssl\"]` | update | value |",
		"| `cloudflare_dns_record.play` | create |  |",
	} {
		if !strings.Contains(summary.String(), want) {
			t.Errorf("the summary has no %q:\n%s", want, summary)
		}
	}
	if strings.Contains(summary.String(), "cloudflare_ruleset.cache") {
		t.Error("the summary lists a resource that does not change")
	}
	for _, v := range values {
		if strings.Contains(log.String(), v) || strings.Contains(summary.String(), v) {
			t.Errorf("%q, a value of the plan, was shown", v)
		}
	}
}

// passwordsPlan is the plan that first makes the read-only roles' and
// Grafana's passwords: a folder, and four secrets written write-only, whose
// values OpenTofu never puts in a plan.
const passwordsPlan = `{
  "format_version": "1.2",
  "resource_changes": [
    {"address": "infisical_secret_folder.monitoring", "change": {"actions": ["create"], "before": null, "after": {"name": "monitoring", "folder_path": "/"}, "after_unknown": {"id": true, "path": true}}},
    {"address": "infisical_secret.reader_password", "change": {"actions": ["create"], "before": null, "after": {"name": "DB_READER_PASSWORD", "value_wo": null, "value_wo_version": 1}, "after_unknown": {"id": true}}},
    {"address": "infisical_secret.grafana_role_password", "change": {"actions": ["create"], "before": null, "after": {"name": "DB_GRAFANA_PASSWORD", "value_wo": null, "value_wo_version": 1}, "after_unknown": {"id": true}}},
    {"address": "infisical_secret.grafana_role_password_for_grafana", "change": {"actions": ["create"], "before": null, "after": {"name": "DB_GRAFANA_PASSWORD", "value_wo": null, "value_wo_version": 1}, "after_unknown": {"id": true, "folder_path": true}}},
    {"address": "infisical_secret.grafana_admin_password", "change": {"actions": ["create"], "before": null, "after": {"name": "GRAFANA_ADMIN_PASSWORD", "value_wo": null, "value_wo_version": 1}, "after_unknown": {"id": true, "folder_path": true}}},
    {"address": "infisical_secret.database_password", "change": {"actions": ["no-op"], "before": {"name": "DB_PASSWORD"}, "after": {"name": "DB_PASSWORD"}}}
  ]
}`

// TestPlanOfNewPasswords: the plan that makes the new passwords lists the
// folder and the four secrets, and nothing of a value: a write-only
// attribute is null in a plan, and the summary names no attribute of a
// resource it creates.
func TestPlanOfNewPasswords(t *testing.T) {
	a, f, log, summary := testAccounts(t)
	f.plan = passwordsPlan
	if err := a.run(context.Background(), "plan"); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"## Planned: 5 to create",
		"| `infisical_secret_folder.monitoring` | create |  |",
		"| `infisical_secret.reader_password` | create |  |",
		"| `infisical_secret.grafana_role_password` | create |  |",
		"| `infisical_secret.grafana_role_password_for_grafana` | create |  |",
		"| `infisical_secret.grafana_admin_password` | create |  |",
	} {
		if !strings.Contains(summary.String(), want) {
			t.Errorf("the summary has no %q:\n%s", want, summary)
		}
	}
	for _, shown := range []string{"database_password", "value_wo", "DB_READER_PASSWORD", "GRAFANA_ADMIN_PASSWORD"} {
		if strings.Contains(summary.String(), shown) || strings.Contains(log.String(), shown) {
			t.Errorf("%q was shown:\n%s", shown, summary)
		}
	}
}

// TestErrorsHideAddresses: when tofu fails, what it said on its standard
// error is shown, with every address in it, IPv4 or IPv6, replaced; what
// it printed on its standard output is not shown at all.
func TestErrorsHideAddresses(t *testing.T) {
	a, f, log, _ := testAccounts(t)
	f.fail = "plan"
	f.says = "Error: reading the tunnel: connection from 203.0.113.7 and [2001:db8:85a3::8a2e:370:7334]:7844 refused at 12:30:05\nError: 2001:db8::1."
	err := a.run(context.Background(), "plan")
	if err == nil {
		t.Fatal("the plan's failure was not reported")
	}
	msg := err.Error()
	for _, gone := range []string{"203.0.113.7", "2001:db8", "198.51.100.9", "values and all"} {
		if strings.Contains(msg, gone) || strings.Contains(log.String(), gone) {
			t.Errorf("%q was shown: %s", gone, msg)
		}
	}
	for _, kept := range []string{"connection from <address> and [<address>]:7844 refused at 12:30:05", "Error: <address>."} {
		if !strings.Contains(msg, kept) {
			t.Errorf("the error has no %q: %s", kept, msg)
		}
	}
}

func TestScrubAddresses(t *testing.T) {
	for in, want := range map[string]string{
		"from 192.0.2.1:443":                   "from <address>:443",
		"to ::1 and fe80::1%eth0":              "to <address> and <address>%eth0",
		"::ffff:192.0.2.1 mapped":              "<address> mapped",
		"version 1.13.1, 10:30:00, 5.27.0":     "version 1.13.1, 10:30:00, 5.27.0",
		"a.b.c.d 999.1.1.1 cloudflare_ruleset": "a.b.c.d 999.1.1.1 cloudflare_ruleset",
		"2606:4700:4700::1111":                 "<address>",
	} {
		if got := scrubAddresses(in); got != want {
			t.Errorf("scrubAddresses(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestApplyAppliesThePlanJobsPlan: apply runs tofu apply on the plan the
// plan job kept, and does not plan again.
func TestApplyAppliesThePlanJobsPlan(t *testing.T) {
	a, f, log, summary := testAccounts(t)
	if err := a.run(context.Background(), "plan"); err != nil {
		t.Fatal(err)
	}
	f.calls = nil
	summary.Reset()
	if err := a.run(context.Background(), "apply"); err != nil {
		t.Fatal(err)
	}
	applies := f.ran("apply")
	if len(applies) != 1 || applies[0].argv[len(applies[0].argv)-1] != a.path(planDir, planFile) {
		t.Fatalf("apply ran %v", applies)
	}
	if len(f.ran("plan")) != 0 {
		t.Error("apply planned again")
	}
	if !strings.Contains(summary.String(), "## Applied: 1 to create, 3 to update") || strings.Contains(log.String(), "198.51.100.9") {
		t.Errorf("the apply's summary:\n%s", summary)
	}
}

// TestApplyRefusesAnotherPlan: a plan the plan job of this run did not
// make is refused before anything is read from Infisical or run.
func TestApplyRefusesAnotherPlan(t *testing.T) {
	cases := map[string]struct {
		change func(a *accounts)
		want   string
	}{
		"no plan at all": {func(a *accounts) { os.RemoveAll(a.path(planDir)) }, "no plan from this run's plan job"},
		"another run's": {func(a *accounts) {
			writeMeta(t, a, planMeta{RunID: "4141", Commit: commit, SHA256: digestOf(t, a)})
		}, "made in run 4141"},
		"another commit's": {func(a *accounts) {
			writeMeta(t, a, planMeta{RunID: runID, Commit: strings.Repeat("f", 40), SHA256: digestOf(t, a)})
		}, "not in this run"},
		"a plan file swapped": {func(a *accounts) {
			os.WriteFile(a.path(planDir, planFile), []byte("another plan"), 0o600)
		}, "not the one the plan job made"},
		"no record": {func(a *accounts) { os.Remove(a.path(planDir, metaFile)) }, "no plan from this run's plan job"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			a, f, log, _ := testAccounts(t)
			if err := a.run(context.Background(), "plan"); err != nil {
				t.Fatal(err)
			}
			f.calls = nil
			log.Reset()
			tc.change(a)
			err := a.run(context.Background(), "apply")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
			if len(f.calls) != 0 || strings.Contains(log.String(), "add-mask") {
				t.Errorf("after refusing, it ran %v and logged %s", f.calls, log)
			}
		})
	}
}

func digestOf(t *testing.T, a *accounts) string {
	t.Helper()
	d, err := fileSHA256(a.path(planDir, planFile))
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func writeMeta(t *testing.T, a *accounts, m planMeta) {
	t.Helper()
	data, _ := json.Marshal(m)
	if err := os.WriteFile(a.path(planDir, metaFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestRunNeedsTheIdentifiers: before an account is made, the run stops,
// naming what infra/production.yaml lacks, and reads nothing.
func TestRunNeedsTheIdentifiers(t *testing.T) {
	a, f, log, _ := testAccounts(t)
	a.prod.Cloudflare.Zone = ""
	a.prod.State.Bucket = ""
	err := a.run(context.Background(), "plan")
	if err == nil || !strings.Contains(err.Error(), "has no cloudflare.zone, state.bucket yet") {
		t.Fatalf("got %v", err)
	}
	if len(f.calls) != 0 || log.Len() != 0 {
		t.Errorf("it ran %v and logged %s", f.calls, log)
	}
}

func TestRunOutsideAWorkflow(t *testing.T) {
	a, f, _, _ := testAccounts(t)
	a.getenv = func(string) string { return "" }
	if err := a.run(context.Background(), "plan"); err == nil || !strings.Contains(err.Error(), "GITHUB_RUN_ID") {
		t.Fatalf("got %v", err)
	}
	if err := a.run(context.Background(), "destroy"); err == nil || !strings.Contains(err.Error(), "plan or apply") {
		t.Fatalf("destroy: %v", err)
	}
	if len(f.calls) != 0 {
		t.Errorf("ran %v", f.calls)
	}
}

// TestPlanChangesRefusesWhatIsNoPlan: anything but a plan's JSON fails.
func TestPlanChangesRefusesWhatIsNoPlan(t *testing.T) {
	for _, in := range []string{"", "not json", `{"resource_changes": []}`} {
		if _, err := planChanges([]byte(in)); err == nil {
			t.Errorf("%q was read as a plan", in)
		}
	}
	changes, err := planChanges([]byte(`{"format_version":"1.2","resource_changes":[{"address":"x.y","change":{"actions":["delete","create"],"before":{"a":1,"b":2},"after":{"a":1},"after_unknown":{"c":true}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || changes[0].Action != "replace" || !slices.Equal(changes[0].Attributes, []string{"b", "c"}) {
		t.Errorf("a replacement: %+v", changes)
	}
}

// TestTheRepositorysConfiguration: infra/tofu names the variables the
// tool gives it, and the lock file every platform the tool locks for.
func TestTheRepositorysConfiguration(t *testing.T) {
	root := filepath.Join("..", "..")
	vars, err := os.ReadFile(filepath.Join(root, tofuDir, "variables.tf"))
	if err != nil {
		t.Fatal(err)
	}
	a, _, _, _ := testAccounts(t)
	env, err := a.environment(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range env {
		name, _, _ := strings.Cut(e, "=")
		if v, ok := strings.CutPrefix(name, "TF_VAR_"); ok && !strings.Contains(string(vars), `variable "`+v+`"`) {
			t.Errorf("the tool sets %s, but infra/tofu declares no variable %s", name, v)
		}
	}
	lock, err := os.ReadFile(filepath.Join(root, tofuDir, lockFile))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"cloudflare/cloudflare", "infisical/infisical", "hashicorp/random"} {
		if !strings.Contains(string(lock), `provider "registry.opentofu.org/`+p+`"`) {
			t.Errorf("the lock file has no %s", p)
		}
	}
}
