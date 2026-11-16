// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// npmRan are the calls of npm and npx, in order.
func (f *fakeTofu) npmRan() []call {
	var out []call
	for _, c := range f.calls {
		if c.argv[0] == "npm" || c.argv[0] == "npx" {
			out = append(out, c)
		}
	}
	return out
}

// TestApplyDeploysTheWebsite: after the apply, the website's packages are
// installed from its lockfile, its letters cut and wrangler deploy run in
// website/, with the KV namespace's id from OpenTofu and the service
// token on wrangler's standard input alone, masked before it runs.
func TestApplyDeploysTheWebsite(t *testing.T) {
	a, f, log, summary := testAccounts(t)
	if err := a.run(context.Background(), "plan"); err != nil {
		t.Fatal(err)
	}
	f.calls = nil
	if err := a.run(context.Background(), "apply"); err != nil {
		t.Fatal(err)
	}
	if len(f.ran("output")) != 1 {
		t.Fatalf("tofu output ran %d times", len(f.ran("output")))
	}
	ran := f.npmRan()
	want := [][]string{
		{"npm", "ci", "--no-audit", "--no-fund"},
		{"npm", "run", "glyphs"},
		{"npx", "--no-install", "wrangler", "deploy", "--config", deployFile, "--secrets-file", "/dev/stdin"},
	}
	if len(ran) != len(want) {
		t.Fatalf("npm ran %v", ran)
	}
	for i, c := range ran {
		if !slices.Equal(c.argv, want[i]) || c.dir != a.path(websiteDir) {
			t.Errorf("step %d ran %v in %s, not %v in website", i, c.argv, c.dir, want[i])
		}
	}
	deploy := ran[2]
	var secrets map[string]string
	if err := json.Unmarshal(deploy.stdin, &secrets); err != nil {
		t.Fatal(err)
	}
	if secrets[secretID] != clientID || secrets[secretSecret] != clientSecret || len(secrets) != 2 {
		t.Errorf("wrangler was handed %v", secrets)
	}
	for _, e := range []string{"CLOUDFLARE_API_TOKEN=" + creds["CLOUDFLARE_API_TOKEN"], "CLOUDFLARE_ACCOUNT_ID=" + a.prod.Cloudflare.Account, "WRANGLER_SEND_METRICS=false"} {
		if !slices.Contains(deploy.env, e) {
			t.Errorf("wrangler's environment has no %s", strings.SplitN(e, "=", 2)[0])
		}
	}
	for _, secret := range []string{clientID, clientSecret} {
		if !strings.Contains(deploy.logged, "::add-mask::"+secret+"\n") {
			t.Errorf("%q was not masked before wrangler ran", secret)
		}
		if strings.Count(log.String(), secret) != 1 || strings.Contains(summary.String(), secret) {
			t.Errorf("%q is in the log or the summary", secret)
		}
		for _, c := range f.calls {
			if strings.Contains(strings.Join(c.argv, " "), secret) || strings.Contains(strings.Join(c.env, " "), secret) {
				t.Errorf("%q is on %v's command line or in its environment", secret, c.argv)
			}
		}
	}
	// The configuration deployed: the kept one, with OpenTofu's id for the KV namespace.
	data, err := os.ReadFile(a.path(websiteDir, deployFile))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	kept, _, err := a.readWrangler()
	if err != nil {
		t.Fatal(err)
	}
	kv := got["kv_namespaces"].([]any)[0].(map[string]any)
	if kv["binding"] != websiteKVName || kv["id"] != kvID {
		t.Errorf("the KV namespace deployed: %v", kv)
	}
	delete(kv, "id")
	g, _ := json.Marshal(got)
	k, _ := json.Marshal(kept)
	if string(g) != string(k) {
		t.Errorf("the configuration deployed is not the kept one:\n%s\n%s", g, k)
	}
	if !strings.Contains(summary.String(), "## Website") {
		t.Errorf("the summary does not say the website was deployed:\n%s", summary)
	}
}

// TestNoDeployWithoutTheApply: when the apply fails, nothing is deployed.
func TestNoDeployWithoutTheApply(t *testing.T) {
	a, f, _, _ := testAccounts(t)
	if err := a.run(context.Background(), "plan"); err != nil {
		t.Fatal(err)
	}
	f.fail, f.says = "apply", "Error: the token may not"
	if err := a.run(context.Background(), "apply"); err == nil {
		t.Fatal("a failed apply passed")
	}
	if len(f.npmRan()) != 0 || len(f.ran("output")) != 0 {
		t.Errorf("deployed after a failed apply: %v", f.npmRan())
	}
}

// TestDeployErrorsHideTheToken: what wrangler says on failing reaches the
// error with the service token's id and secret, and any address, taken out.
func TestDeployErrorsHideTheToken(t *testing.T) {
	a, f, _, _ := testAccounts(t)
	if err := a.run(context.Background(), "plan"); err != nil {
		t.Fatal(err)
	}
	f.failNpm, f.says = "wrangler", "secret "+clientSecret+" for "+clientID+" refused from 198.51.100.9"
	err := a.run(context.Background(), "apply")
	if err == nil {
		t.Fatal("a failed deploy passed")
	}
	for _, v := range []string{clientSecret, clientID, "198.51.100.9"} {
		if strings.Contains(err.Error(), v) {
			t.Errorf("the error shows %q: %v", v, err)
		}
	}
}

// TestTheRepositorysWebsite: website/wrangler.jsonc is the website's, as
// the check and the deploy need it.
func TestTheRepositorysWebsite(t *testing.T) {
	a, _, _, _ := testAccounts(t)
	a.root = filepath.Join("..", "..")
	if err := a.checkWrangler(); err != nil {
		t.Fatal(err)
	}
}

// TestCheckWranglerRefuses: the check refuses a configuration the deploy
// could not make the website's.
func TestCheckWranglerRefuses(t *testing.T) {
	cases := map[string]struct{ from, to, want string }{
		"the fetch skips Access":      {`["global_fetch_strictly_public"]`, `[]`, "global_fetch_strictly_public"},
		"an id of its own":            {`{ "binding": "WEBSITE" }`, `{ "binding": "WEBSITE", "id": "abc" }`, "id of its own"},
		"the apex not its own domain": {`"custom_domain": true`, `"custom_domain": false`, "custom domain"},
		"no cron for the last copy":   {`"crons": ["*/10 * * * *"]`, `"crons": []`, "no cron"},
		"no KV bound for it":          {`"binding": "WEBSITE"`, `"binding": "OTHER"`, "no KV namespace"},
	}
	repo, err := os.ReadFile(filepath.Join("..", "..", websiteDir, wranglerFile))
	if err != nil {
		t.Fatal(err)
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			a, _, _, _ := testAccounts(t)
			if !strings.Contains(string(repo), c.from) {
				t.Fatalf("wrangler.jsonc has no %s", c.from)
			}
			os.WriteFile(a.path(websiteDir, wranglerFile), []byte(strings.Replace(string(repo), c.from, c.to, 1)), 0o644)
			os.MkdirAll(a.path(websiteDir, "worker", "src"), 0o755)
			os.WriteFile(a.path(websiteDir, "worker", "src", "index.ts"), nil, 0o644)
			os.MkdirAll(a.path(tofuDir), 0o755)
			tf, _ := os.ReadFile(filepath.Join("..", "..", tofuDir, "access.tf"))
			web, _ := os.ReadFile(filepath.Join("..", "..", tofuDir, "website.tf"))
			os.WriteFile(a.path(tofuDir, "access.tf"), tf, 0o644)
			os.WriteFile(a.path(tofuDir, "website.tf"), web, 0o644)
			err := a.checkWrangler()
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("checked %v, want %q", err, c.want)
			}
		})
	}
}

func TestStripJSONC(t *testing.T) {
	in := "{\n  // a comment\n  \"url\": \"https://a/b\", /* and\n another */ \"n\": 1 // to the end\n}\n"
	var v map[string]any
	if err := json.Unmarshal(stripJSONC([]byte(in)), &v); err != nil {
		t.Fatal(err)
	}
	if v["url"] != "https://a/b" || v["n"] != 1.0 {
		t.Errorf("read %v", v)
	}
}
