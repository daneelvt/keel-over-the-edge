// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// The website, deployed by wrangler after the apply: its folder, its
// configuration as kept, and the configuration the deploy writes from it
// with the KV namespace's id filled in (git ignores it).
const (
	websiteDir    = "website"
	wranglerFile  = "wrangler.jsonc"
	deployFile    = "wrangler.deploy.json"
	websiteKVName = "WEBSITE"
)

// The OpenTofu outputs the deploy reads: the KV namespace's id, and the
// Access service token the Worker calls keel's status with.
const (
	outputKV     = "website_kv_namespace_id"
	outputID     = "website_access_client_id"
	outputSecret = "website_access_client_secret"
)

// What wrangler.jsonc must say for the deploy to be the website's: the
// Worker's fetch to play. goes through Access, and the apex is its own
// custom domain.
const (
	strictlyPublic = "global_fetch_strictly_public"
	apex           = "keelovertheedge.com"
)

// The Worker's secrets, as it reads them.
const (
	secretID     = "ACCESS_CLIENT_ID"
	secretSecret = "ACCESS_CLIENT_SECRET"
)

// wranglerConfig is what the deploy and the check read of wrangler.jsonc.
type wranglerConfig struct {
	Main               string   `json:"main"`
	CompatibilityFlags []string `json:"compatibility_flags"`
	Routes             []struct {
		Pattern      string `json:"pattern"`
		CustomDomain bool   `json:"custom_domain"`
	} `json:"routes"`
	KV []struct {
		Binding string `json:"binding"`
		ID      string `json:"id"`
	} `json:"kv_namespaces"`
	Triggers struct {
		Crons []string `json:"crons"`
	} `json:"triggers"`
	Assets struct {
		Directory string `json:"directory"`
	} `json:"assets"`
}

// stripJSONC takes the comments out of JSON with comments, // and /* */,
// leaving strings as they are.
func stripJSONC(in []byte) []byte {
	var out bytes.Buffer
	inString, escaped := false, false
	for i := 0; i < len(in); i++ {
		c := in[i]
		switch {
		case inString:
			out.WriteByte(c)
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
		case c == '"':
			inString = true
			out.WriteByte(c)
		case c == '/' && i+1 < len(in) && in[i+1] == '/':
			for i < len(in) && in[i] != '\n' {
				i++
			}
			out.WriteByte('\n')
		case c == '/' && i+1 < len(in) && in[i+1] == '*':
			end := bytes.Index(in[i+2:], []byte("*/"))
			if end < 0 {
				i = len(in)
			} else {
				i += end + 3
			}
		default:
			out.WriteByte(c)
		}
	}
	return out.Bytes()
}

// readWrangler reads website/wrangler.jsonc, as a whole and as the deploy
// reads it.
func (a *accounts) readWrangler() (map[string]any, wranglerConfig, error) {
	var whole map[string]any
	var cfg wranglerConfig
	data, err := os.ReadFile(a.path(websiteDir, wranglerFile))
	if err != nil {
		return nil, cfg, err
	}
	plain := stripJSONC(data)
	if err := json.Unmarshal(plain, &whole); err != nil {
		return nil, cfg, fmt.Errorf("%s: %w", filepath.Join(websiteDir, wranglerFile), err)
	}
	if err := json.Unmarshal(plain, &cfg); err != nil {
		return nil, cfg, fmt.Errorf("%s: %w", filepath.Join(websiteDir, wranglerFile), err)
	}
	return whole, cfg, nil
}

// checkWrangler checks website/wrangler.jsonc is what the deploy needs:
// the Worker's fetch the public way, through Access; the apex as its
// custom domain; a cron; the KV namespace bound with no id of its own,
// which the deploy takes from OpenTofu; and that OpenTofu has each output
// the deploy reads.
func (a *accounts) checkWrangler() error {
	_, cfg, err := a.readWrangler()
	if err != nil {
		return err
	}
	var bad []string
	if cfg.Main == "" {
		bad = append(bad, "no main")
	} else if _, err := os.Stat(a.path(websiteDir, cfg.Main)); err != nil {
		bad = append(bad, "main "+cfg.Main+" is not there")
	}
	if !slices.Contains(cfg.CompatibilityFlags, strictlyPublic) {
		bad = append(bad, "no "+strictlyPublic+": the fetch to play. would skip Access")
	}
	if !slices.ContainsFunc(cfg.Routes, func(r struct {
		Pattern      string `json:"pattern"`
		CustomDomain bool   `json:"custom_domain"`
	}) bool {
		return r.Pattern == apex && r.CustomDomain
	}) {
		bad = append(bad, "the apex is not its custom domain")
	}
	if len(cfg.Triggers.Crons) == 0 {
		bad = append(bad, "no cron to keep the last good copy")
	}
	kv := 0
	for _, k := range cfg.KV {
		if k.Binding == websiteKVName {
			kv++
			if k.ID != "" {
				bad = append(bad, "the KV namespace has an id of its own: the deploy takes OpenTofu's")
			}
		}
	}
	if kv != 1 {
		bad = append(bad, "no KV namespace bound as "+websiteKVName)
	}
	if cfg.Assets.Directory == "" {
		bad = append(bad, "no static files")
	}
	tf, err := filepath.Glob(a.path(tofuDir, "*.tf"))
	if err != nil {
		return err
	}
	var all []byte
	for _, f := range tf {
		b, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		all = append(all, b...)
	}
	for _, o := range []string{outputKV, outputID, outputSecret} {
		if !bytes.Contains(all, []byte(`output "`+o+`"`)) {
			bad = append(bad, "OpenTofu has no output "+o)
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("%s: %s", filepath.Join(websiteDir, wranglerFile), strings.Join(bad, "; "))
	}
	a.logf("%s is the website's, and OpenTofu has the outputs its deploy reads", filepath.Join(websiteDir, wranglerFile))
	return nil
}

// outputs reads the website's outputs from OpenTofu's state, which never
// leave the tool but to wrangler, the token's masked first.
func (a *accounts) outputs(ctx context.Context, env []string) (kv, id, secret string, err error) {
	out, err := a.tofuRun(ctx, "apply", env, "output", "-json", "-no-color")
	if err != nil {
		return "", "", "", err
	}
	var o map[string]struct {
		Value any `json:"value"`
	}
	if err := json.Unmarshal(out, &o); err != nil {
		return "", "", "", errors.New("tofu output -json: not JSON")
	}
	get := func(name string) (string, error) {
		v, ok := o[name].Value.(string)
		if !ok || v == "" {
			return "", fmt.Errorf("OpenTofu has no output %s", name)
		}
		return v, nil
	}
	if id, err = get(outputID); err != nil {
		return
	}
	if secret, err = get(outputSecret); err != nil {
		return
	}
	// Masked before anything else is printed.
	fmt.Fprintf(a.out, "::add-mask::%s\n::add-mask::%s\n", id, secret)
	kv, err = get(outputKV)
	return
}

// deployWebsite deploys the website after the apply: its packages
// installed from the lockfile, its letters cut, and wrangler deploy run
// with the configuration as kept but for the KV namespace's id, OpenTofu's,
// and with the Access service token as the Worker's secrets, handed over
// on wrangler's standard input: never on a command line, in a file or the
// log. Cloudflare's token and account are the run's own.
func (a *accounts) deployWebsite(ctx context.Context, env []string) error {
	kvID, id, secret, err := a.outputs(ctx, env)
	if err != nil {
		return err
	}
	whole, _, err := a.readWrangler()
	if err != nil {
		return err
	}
	kvs, _ := whole["kv_namespaces"].([]any)
	for _, k := range kvs {
		if m, ok := k.(map[string]any); ok && m["binding"] == websiteKVName {
			m["id"] = kvID
		}
	}
	deploy, err := json.MarshalIndent(whole, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(a.path(websiteDir, deployFile), deploy, 0o644); err != nil {
		return err
	}
	secrets, err := json.Marshal(map[string]string{secretID: id, secretSecret: secret})
	if err != nil {
		return err
	}
	// Cloudflare's token from the run's environment, as tofu had it.
	wenv := []string{"CLOUDFLARE_ACCOUNT_ID=" + a.prod.Cloudflare.Account, "WRANGLER_SEND_METRICS=false", "CI=1"}
	for _, e := range env {
		if strings.HasPrefix(e, "CLOUDFLARE_API_TOKEN=") {
			wenv = append(wenv, e)
		}
	}
	dir := a.path(websiteDir)
	steps := []cmd{
		{argv: []string{"npm", "ci", "--no-audit", "--no-fund"}, dir: dir},
		{argv: []string{"npm", "run", "glyphs"}, dir: dir},
		{
			argv:  []string{"npx", "--no-install", "wrangler", "deploy", "--config", deployFile, "--secrets-file", "/dev/stdin"},
			env:   wenv,
			dir:   dir,
			stdin: secrets,
		},
	}
	a.logf("deploying the website")
	for _, c := range steps {
		_, stderr, err := a.cmd.run(ctx, c)
		if err != nil {
			said := strings.TrimSpace(string(stderr))
			for _, s := range []string{id, secret} {
				said = strings.ReplaceAll(said, s, "***")
			}
			return fmt.Errorf("%s: %w:\n%s", strings.Join(c.argv[:min(len(c.argv), 3)], " "), err, scrubAddresses(said))
		}
	}
	a.logf("deployed the website, with the service token's id and secret")
	fmt.Fprintf(a.summary, "\n## Website\n\nDeployed by wrangler, with the service token as its secrets.\n")
	return nil
}
