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
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/actions"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/infisical"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/production"
)

// The folders the tool works with, from the repository's root.
const (
	devDir   = ".dev"
	tofuDir  = "infra/tofu"
	workDir  = ".dev/accounts"
	lockFile = ".terraform.lock.hcl"
	// dataDir holds OpenTofu's working folders, one for each kind of run:
	// never the folder the plan is handed over in, which a plan empties.
	dataDir = ".dev/accounts/tofu"
	// planDir is what the plan job hands the apply job, as an artifact of
	// the run: the plan, encrypted, and what says where it came from.
	planDir  = ".dev/accounts/plan"
	planFile = "accounts.tfplan"
	metaFile = "accounts.json"
)

// The workflow's credentials, in keel-accounts' folder /accounts.
const accountsFolder = "/accounts"

var credentials = []string{"CLOUDFLARE_API_TOKEN", "B2_KEY_ID", "B2_KEY", "TOFU_PASSPHRASE", "NOTIFY_EMAIL"}

// platforms are where OpenTofu runs: the runners, and the owner's Mac.
var platforms = []string{"linux_amd64", "linux_arm64", "darwin_arm64"}

type accounts struct {
	// out is the log, where workflow commands (::add-mask::) go too.
	out     io.Writer
	summary io.WriteCloser
	cmd     commands
	hc      *http.Client
	prod    production.Production
	root    string
	// idToken gets the job's OIDC token for an audience.
	idToken func(ctx context.Context, audience string) (string, error)
	// tofu is the path of the pinned OpenTofu, fetched when first needed.
	tofu func(ctx context.Context) (string, error)
	// getenv reads the run's identity: GITHUB_RUN_ID, GITHUB_SHA.
	getenv func(string) string
}

func newAccounts() (*accounts, error) {
	root, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	p, err := production.Read(production.File)
	if err != nil {
		return nil, err
	}
	summary, err := actions.Summary()
	if err != nil {
		return nil, err
	}
	hc := &http.Client{Timeout: time.Minute}
	return &accounts{
		out: os.Stdout, summary: summary, cmd: execCommands{}, hc: hc, prod: p, root: root,
		idToken: func(ctx context.Context, audience string) (string, error) {
			return actions.IDToken(ctx, hc, os.Stdout, audience)
		},
		tofu: func(ctx context.Context) (string, error) {
			bin, err := pinned.OpenTofu.Ensure(ctx, filepath.Join(root, devDir), os.Stderr)
			if err != nil {
				return "", err
			}
			return filepath.Abs(bin)
		},
		getenv: os.Getenv,
	}, nil
}

func (a *accounts) logf(format string, args ...any) {
	fmt.Fprintf(a.out, "accounts: "+format+"\n", args...)
}

// path is a path under the repository's root.
func (a *accounts) path(p ...string) string { return filepath.Join(append([]string{a.root}, p...)...) }

// commands runs tofu. Tests replace it.
type commands interface {
	// run runs c, keeping all it prints: nothing reaches the log but what
	// the tool chooses to show.
	run(ctx context.Context, c cmd) (stdout, stderr []byte, err error)
}

type cmd struct {
	argv []string
	// env is added to the tool's own environment, and wins over it.
	env []string
	dir string
}

type execCommands struct{}

func (execCommands) run(ctx context.Context, c cmd) ([]byte, []byte, error) {
	x := exec.CommandContext(ctx, c.argv[0], c.argv[1:]...)
	x.Env = append(os.Environ(), c.env...)
	x.Dir = c.dir
	var stdout, stderr bytes.Buffer
	x.Stdout, x.Stderr = &stdout, &stderr
	err := x.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

// tofuRun runs OpenTofu in infra/tofu with its working folder under
// .dev/accounts, never asking anything. On failure the error holds what
// OpenTofu said, every IP address in it replaced, and nothing else.
func (a *accounts) tofuRun(ctx context.Context, data string, env []string, args ...string) ([]byte, error) {
	bin, err := a.tofu(ctx)
	if err != nil {
		return nil, err
	}
	env = append([]string{
		"TF_DATA_DIR=" + a.path(dataDir, data),
		"TF_IN_AUTOMATION=1",
		"TF_INPUT=0",
		"CHECKPOINT_DISABLE=1",
	}, env...)
	stdout, stderr, err := a.cmd.run(ctx, cmd{argv: append([]string{bin}, args...), env: env, dir: a.path(tofuDir)})
	if err != nil {
		said := strings.TrimSpace(string(stderr))
		if said == "" {
			said = "(it said nothing on its standard error)"
		}
		return stdout, fmt.Errorf("tofu %s: %w:\n%s", args[0], err, scrubAddresses(said))
	}
	return stdout, nil
}

// plan is what the plan job hands the apply job, beside the plan itself:
// the run and commit it was made in, and the plan file's digest.
type planMeta struct {
	RunID  string `json:"runID"`
	Commit string `json:"commit"`
	SHA256 string `json:"sha256"`
}

// run plans, or applies the plan this run's plan job kept.
func (a *accounts) run(ctx context.Context, mode string) error {
	if mode != "plan" && mode != "apply" {
		return fmt.Errorf("the mode is plan or apply, not %q", mode)
	}
	runID, commit := a.getenv("GITHUB_RUN_ID"), a.getenv("GITHUB_SHA")
	if runID == "" || commit == "" {
		return errors.New("no run to tie the plan to: this runs in the accounts workflow, which sets GITHUB_RUN_ID and GITHUB_SHA")
	}
	plan := a.path(planDir, planFile)
	if mode == "apply" {
		// Before anything is read from Infisical: a plan from anywhere but
		// this run's plan job is refused outright.
		if err := a.checkPlan(plan, runID, commit); err != nil {
			return err
		}
	}
	env, err := a.environment(ctx)
	if err != nil {
		return err
	}
	if err := a.init(ctx, mode, env); err != nil {
		return err
	}
	if mode == "plan" {
		return a.plan(ctx, env, plan, runID, commit)
	}
	return a.apply(ctx, env, plan)
}

// environment reads the workflow's credentials from Infisical, masked, and
// makes tofu's environment: the backend's key, Cloudflare's token, the
// passphrase, the owner's address, production's identifiers, and an OIDC
// token for Infisical's provider. It is never on a command line.
func (a *accounts) environment(ctx context.Context) ([]string, error) {
	in, cf, st := a.prod.Infisical, a.prod.Cloudflare, a.prod.State
	if err := production.Need(map[string]string{
		"infisical.host": in.Host, "infisical.accounts.identityID": in.Accounts.IdentityID, "infisical.accounts.project": in.Accounts.Project,
		"infisical.cluster.project": in.Cluster.Project, "cloudflare.account": cf.Account, "cloudflare.zone": cf.Zone,
		"state.bucket": st.Bucket, "state.endpoint": st.Endpoint, "state.region": st.Region,
	}); err != nil {
		return nil, err
	}
	jwt, err := a.idToken(ctx, in.Audience)
	if err != nil {
		return nil, err
	}
	c := &infisical.Client{Host: in.Host, HC: a.hc, Log: a.out}
	s, err := c.Login(ctx, in.Accounts.IdentityID, jwt)
	if err != nil {
		return nil, err
	}
	creds, err := s.Read(ctx, in.Accounts.Project, in.Environment, accountsFolder, credentials...)
	if err != nil {
		return nil, err
	}
	a.logf("read %s from Infisical", strings.Join(credentials, ", "))
	// Infisical's provider signs in by itself, with a token of its own.
	providerJWT, err := a.idToken(ctx, in.Audience)
	if err != nil {
		return nil, err
	}
	return []string{
		"AWS_ACCESS_KEY_ID=" + creds["B2_KEY_ID"],
		"AWS_SECRET_ACCESS_KEY=" + creds["B2_KEY"],
		"CLOUDFLARE_API_TOKEN=" + creds["CLOUDFLARE_API_TOKEN"],
		"TF_VAR_state_passphrase=" + creds["TOFU_PASSPHRASE"],
		"TF_VAR_notify_email=" + creds["NOTIFY_EMAIL"],
		"INFISICAL_AUTH_JWT=" + providerJWT,
		"TF_VAR_cloudflare_account_id=" + cf.Account,
		"TF_VAR_cloudflare_zone_id=" + cf.Zone,
		"TF_VAR_infisical_host=" + in.Host,
		"TF_VAR_infisical_identity_id=" + in.Accounts.IdentityID,
		"TF_VAR_cluster_project_id=" + in.Cluster.Project,
	}, nil
}

// init initialises the backend from production's identifiers, with the
// providers the lock file names and nothing else.
func (a *accounts) init(ctx context.Context, mode string, env []string) error {
	st := a.prod.State
	backend := a.path(workDir, "backend.tfbackend")
	if err := os.MkdirAll(filepath.Dir(backend), 0o700); err != nil {
		return err
	}
	conf := fmt.Sprintf("bucket = %s\nregion = %s\nendpoints = {\n  s3 = %s\n}\n", strconv.Quote(st.Bucket), strconv.Quote(st.Region), strconv.Quote(st.Endpoint))
	if err := os.WriteFile(backend, []byte(conf), 0o600); err != nil {
		return err
	}
	a.logf("initialising the state in %s, on %s", st.Bucket, st.Endpoint)
	_, err := a.tofuRun(ctx, mode, env, "init", "-input=false", "-no-color", "-lockfile=readonly", "-backend-config="+backend)
	return err
}

// plan plans, keeps the plan for the apply job, and shows what it would
// do, by address, action and attribute names.
func (a *accounts) plan(ctx context.Context, env []string, plan, runID, commit string) error {
	if err := os.RemoveAll(filepath.Dir(plan)); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(plan), 0o700); err != nil {
		return err
	}
	a.logf("planning")
	if _, err := a.tofuRun(ctx, "plan", env, "plan", "-input=false", "-no-color", "-out="+plan); err != nil {
		return err
	}
	changes, err := a.show(ctx, "plan", env, plan)
	if err != nil {
		return err
	}
	digest, err := fileSHA256(plan)
	if err != nil {
		return err
	}
	meta, _ := json.Marshal(planMeta{RunID: runID, Commit: commit, SHA256: digest})
	if err := os.WriteFile(filepath.Join(filepath.Dir(plan), metaFile), meta, 0o600); err != nil {
		return err
	}
	a.report("Planned", changes)
	return nil
}

// checkPlan refuses a plan that this run's plan job did not make: its
// record must name this run and commit, and its digest the file's.
func (a *accounts) checkPlan(plan, runID, commit string) error {
	data, err := os.ReadFile(filepath.Join(filepath.Dir(plan), metaFile))
	if err != nil {
		return fmt.Errorf("no plan from this run's plan job: %w", err)
	}
	var m planMeta
	if err := json.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("the plan's record: %w", err)
	}
	if m.RunID != runID || m.Commit != commit {
		return fmt.Errorf("the plan was made in run %s at %s, not in this run, %s at %s: only this run's plan is applied", m.RunID, m.Commit, runID, commit)
	}
	digest, err := fileSHA256(plan)
	if err != nil {
		return fmt.Errorf("no plan from this run's plan job: %w", err)
	}
	if digest != m.SHA256 {
		return errors.New("the plan file is not the one the plan job made: its digest differs from the one it recorded")
	}
	return nil
}

// apply applies the plan the owner read in the plan job's summary.
func (a *accounts) apply(ctx context.Context, env []string, plan string) error {
	changes, err := a.show(ctx, "apply", env, plan)
	if err != nil {
		return err
	}
	a.logf("applying the plan of this run's plan job")
	if _, err := a.tofuRun(ctx, "apply", env, "apply", "-input=false", "-no-color", plan); err != nil {
		return err
	}
	a.report("Applied", changes)
	return nil
}

// show reads a saved plan's changes from tofu show -json, which never
// leaves the tool.
func (a *accounts) show(ctx context.Context, data string, env []string, plan string) ([]change, error) {
	out, err := a.tofuRun(ctx, data, env, "show", "-json", "-no-color", plan)
	if err != nil {
		return nil, err
	}
	return planChanges(out)
}

// report writes what a plan does to the log and the run's summary.
func (a *accounts) report(verb string, changes []change) {
	text := summarize(changes)
	a.logf("%s: %s", strings.ToLower(verb), counts(changes))
	for _, c := range changes {
		a.logf("  %s %s %s", c.Action, c.Address, strings.Join(c.Attributes, ", "))
	}
	fmt.Fprintf(a.summary, "## %s: %s\n\n%s", verb, counts(changes), text)
}

func fileSHA256(file string) (string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// check checks infra/tofu with no credential at all: as written, it is
// formatted, initialises without a backend from the lock file alone, and
// is valid; and the lock file holds every platform's hashes.
func (a *accounts) check(ctx context.Context) error {
	// Validation evaluates the state's encryption, which needs a
	// passphrase of the right length; this one locks nothing.
	env := []string{"TF_VAR_state_passphrase=checking-the-configuration-only"}
	// fmt lists the files it would change, by name alone.
	if files, err := a.tofuRun(ctx, "check", env, "fmt", "-check", "-recursive", "-no-color"); err != nil {
		return fmt.Errorf("not formatted: %s (tofu fmt -recursive infra/tofu formats them)", strings.Join(strings.Fields(string(files)), ", "))
	}
	if _, err := a.tofuRun(ctx, "check", env, "init", "-input=false", "-no-color", "-backend=false", "-lockfile=readonly"); err != nil {
		return err
	}
	if _, err := a.tofuRun(ctx, "check", env, "validate", "-no-color"); err != nil {
		return err
	}
	a.logf("infra/tofu is formatted and valid")
	return a.checkLock(ctx)
}

// checkLock makes the lock file again, for every platform, from the
// versions the configuration names, and compares it with the one kept.
func (a *accounts) checkLock(ctx context.Context) error {
	kept, err := os.ReadFile(a.path(tofuDir, lockFile))
	if err != nil {
		return err
	}
	fresh, err := a.lockFor(ctx, "check-lock")
	if err != nil {
		return err
	}
	if !bytes.Equal(kept, fresh) {
		return fmt.Errorf("%s is not what OpenTofu writes for %s: go run ./tools/accounts -lock writes it", filepath.Join(tofuDir, lockFile), strings.Join(platforms, ", "))
	}
	a.logf("%s holds every provider's hashes for %s", lockFile, strings.Join(platforms, ", "))
	return nil
}

// lock writes the lock file for every platform.
func (a *accounts) lock(ctx context.Context) error {
	fresh, err := a.lockFor(ctx, "lock")
	if err != nil {
		return err
	}
	if err := os.WriteFile(a.path(tofuDir, lockFile), fresh, 0o644); err != nil {
		return err
	}
	a.logf("wrote %s for %s", filepath.Join(tofuDir, lockFile), strings.Join(platforms, ", "))
	return nil
}

// lockFor is the lock file OpenTofu writes for every platform, made in a
// copy of infra/tofu's configuration so the one kept is untouched.
func (a *accounts) lockFor(ctx context.Context, data string) ([]byte, error) {
	bin, err := a.tofu(ctx)
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "keel-tofu-lock-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	files, err := filepath.Glob(a.path(tofuDir, "*.tf"))
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(dir, filepath.Base(f)), b, 0o644); err != nil {
			return nil, err
		}
	}
	args := []string{bin, "providers", "lock", "-no-color"}
	for _, p := range platforms {
		args = append(args, "-platform="+p)
	}
	_, stderr, err := a.cmd.run(ctx, cmd{argv: args, dir: dir, env: []string{
		"TF_DATA_DIR=" + a.path(dataDir, data), "TF_IN_AUTOMATION=1", "TF_INPUT=0", "CHECKPOINT_DISABLE=1",
	}})
	if err != nil {
		return nil, fmt.Errorf("tofu providers lock: %w:\n%s", err, scrubAddresses(strings.TrimSpace(string(stderr))))
	}
	return os.ReadFile(filepath.Join(dir, lockFile))
}
