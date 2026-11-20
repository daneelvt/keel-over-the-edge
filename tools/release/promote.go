// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/registry"
)

// revisionAnnotation is where a release's artifact says what it was made
// from, as main@sha1:<commit>: flux push artifact writes its --revision
// there.
const revisionAnnotation = "org.opencontainers.image.revision"

// mainBranch is the branch releases are made from.
const mainBranch = "main"

// latestBuild is what -promote takes in place of a build, to promote the
// newest one released; latestWithin, how many of main's commits it looks
// through for it, GitHub's most for one page.
const (
	latestBuild  = "latest"
	latestWithin = 100
)

// approvalEnvironment is the deployment environment the promote workflow's
// job runs in: its required reviewers are who approves a promotion.
const approvalEnvironment = "production"

// promoter reads the releases in the registry and moves the tag
// production follows.
type promoter struct {
	out io.Writer
	reg *registry.Registry
	// repo is the manifests' repository in the registry, without its host.
	repo string
	// api is GitHub's API, as https://api.github.com; code, the game's
	// repository there, owner/name; token, sent with each request if set.
	api, code, token string
	hc               *http.Client
	// run runs cosign or flux, by name, and returns what it printed.
	run func(ctx context.Context, name string, args ...string) ([]byte, error)
	// summary is the workflow run's summary, if there is one.
	summary io.Writer
}

// newPromoter is a promoter of the game's releases. It runs cosign and
// flux as the repository pins them, fetched when first needed.
func newPromoter(out io.Writer) (*promoter, error) {
	host, repo, _ := strings.Cut(manifests.ManifestsRepo, "/")
	hc := &http.Client{Timeout: time.Minute}
	p := &promoter{
		out: out, repo: repo, hc: hc,
		reg:   &registry.Registry{Base: "https://" + host, User: os.Getenv("GITHUB_ACTOR"), Password: os.Getenv("GITHUB_TOKEN"), HC: hc},
		api:   "https://api.github.com",
		code:  "daneelvt/keel-over-the-edge",
		token: os.Getenv("GITHUB_TOKEN"),
		run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			bin, err := pinned.Install(ctx, stateDir, os.Stderr, pinned.Cosign, pinned.Flux)
			if err != nil {
				return nil, err
			}
			cmd := exec.CommandContext(ctx, filepath.Join(bin, name), args...)
			out, err := cmd.CombinedOutput()
			if err != nil {
				return out, fmt.Errorf("%s %s: %w\n%s", name, args[0], err, strings.TrimSpace(string(out)))
			}
			return out, nil
		},
		summary: io.Discard,
	}
	if file := os.Getenv("GITHUB_STEP_SUMMARY"); file != "" {
		f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return nil, err
		}
		p.summary = f
	}
	return p, nil
}

func (p *promoter) logf(format string, a ...any) { fmt.Fprintf(p.out, "release: "+format+"\n", a...) }

// release is a release in the registry.
type release struct {
	build, commit, digest string
	// annotations are its manifest's.
	annotations map[string]string
}

func (r release) String() string {
	return fmt.Sprintf("build %s (commit %s, %s)", r.build, r.commit, r.digest)
}

// find reads the release a tag names: a build, or the tag production
// follows. found is false when the registry has none.
func (p *promoter) find(ctx context.Context, tag string) (r release, found bool, err error) {
	a, found, err := p.reg.Resolve(ctx, p.repo, tag)
	if err != nil || !found {
		return r, false, err
	}
	revision := a.Annotations[revisionAnnotation]
	branch, commit, ok := strings.Cut(revision, "@sha1:")
	if !ok || branch != mainBranch || len(commit) != 40 || !manifests.BuildID.MatchString(commit[:12]) {
		return r, false, fmt.Errorf("%s:%s does not say it was made from a commit on %s (%s is %q)", manifests.ManifestsRepo, tag, mainBranch, revisionAnnotation, revision)
	}
	return release{build: commit[:12], commit: commit, digest: a.Digest, annotations: a.Annotations}, true, nil
}

// verify checks a release's signature as Flux will: cosign, keyless,
// accepting the release workflow on main alone.
func (p *promoter) verify(ctx context.Context, r release) error {
	_, err := p.run(ctx, "cosign", "verify",
		"--certificate-oidc-issuer-regexp", manifests.ReleaseIssuer,
		"--certificate-identity-regexp", manifests.ReleaseSubject,
		manifests.ManifestsRepo+"@"+r.digest)
	return err
}

// github reads a path of the game's repository from GitHub's REST API
// into v, and returns the status it answered with.
func (p *promoter) github(ctx context.Context, path string, v any) (int, error) {
	u := p.api + "/repos/" + p.code + "/" + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if p.token != "" {
		req.Header.Set("Authorization", "Bearer "+p.token)
	}
	res, err := p.hc.Do(req)
	if err != nil {
		return 0, fmt.Errorf("GitHub: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return 0, fmt.Errorf("GitHub: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		return res.StatusCode, nil
	}
	if err := json.Unmarshal(body, v); err != nil {
		return 0, fmt.Errorf("GitHub's answer for %s: %w", path, err)
	}
	return res.StatusCode, nil
}

// compare asks GitHub how head stands to base in the game's repository:
// "ahead", "behind", "identical" or "diverged" (its REST API, "Compare two
// commits").
func (p *promoter) compare(ctx context.Context, base, head string) (string, error) {
	var c struct {
		Status string `json:"status"`
	}
	status, err := p.github(ctx, "compare/"+base+"..."+head, &c)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("GitHub answered %d comparing %s with %s", status, base, head)
	}
	return c.Status, nil
}

// approved checks that a promotion cannot run without someone's approval:
// the environment the promote workflow's job waits in exists and requires
// a reviewer. GitHub makes an environment a workflow names and the
// repository lacks, with no protection at all: a job in it would wait for
// nobody.
func (p *promoter) approved(ctx context.Context) error {
	var env struct {
		ProtectionRules []struct {
			Type      string `json:"type"`
			Reviewers []any  `json:"reviewers"`
		} `json:"protection_rules"`
	}
	status, err := p.github(ctx, "environments/"+approvalEnvironment, &env)
	if err != nil {
		return err
	}
	if status != http.StatusOK && status != http.StatusNotFound {
		return fmt.Errorf("GitHub answered %d for the environment %s", status, approvalEnvironment)
	}
	for _, rule := range env.ProtectionRules {
		if rule.Type == "required_reviewers" && len(rule.Reviewers) > 0 {
			return nil
		}
	}
	return fmt.Errorf("the environment %s requires nobody's approval: not promoted. go run ./tools/github -apply sets it as .github/settings/environments.json says", approvalEnvironment)
}

// released is whether build is released: its manifests are in the
// registry under its tag, signed by the release workflow. Manifests
// published but not signed, as when a run failed between the two, are an
// error, not a release: nothing may deploy them, and they are not
// replaced silently.
func (p *promoter) released(ctx context.Context, build string) (bool, error) {
	if !manifests.BuildID.MatchString(build) {
		return false, fmt.Errorf("%q is not a build, the first 12 characters of its commit", build)
	}
	r, found, err := p.find(ctx, build)
	if err != nil {
		return false, err
	}
	if !found {
		p.logf("build %s is not released yet", build)
		return false, nil
	}
	if r.build != build {
		return false, fmt.Errorf("%s:%s says it was made from build %s", manifests.ManifestsRepo, build, r.build)
	}
	if err := p.verify(ctx, r); err != nil {
		return false, fmt.Errorf("%s:%s is published, but its signature does not verify: run again the job that failed after publishing it, which signs it, or release a new commit\n%w", manifests.ManifestsRepo, build, err)
	}
	p.logf("already released: %s. A release is never replaced", r)
	return true, nil
}

// promotion is how a build is to be promoted: what the boxes of the
// promote workflow ask.
type promotion struct {
	// rollback allows a build older than the one production follows.
	rollback bool
	// hotfix allows a build that passed only the hotfix checks, before
	// the full suite after it has passed.
	hotfix bool
	// check says what promoting would do and moves nothing.
	check bool
}

// releaseWorkflow is the workflow that makes releases, and afterJob the
// job of its run that runs the full suite after a hotfix's short checks:
// ci.yaml's own ci job, called as after.
const (
	releaseWorkflow = "release.yaml"
	afterJob        = "after / ci"
)

// The states of the full suite after a hotfix.
const (
	suitePassed  = "passed"
	suiteFailed  = "failed"
	suiteRunning = "running"
	suiteMissing = "not found"
)

// suite is the full suite run after a hotfix's short checks, in the
// release run of its commit.
type suite struct {
	state string
	// url is the release run's page, if there is one.
	url string
}

// said is the suite's state in a sentence: "the full suite after them …".
func (s suite) said() string {
	switch s.state {
	case suiteRunning:
		return "is still running"
	case suiteMissing:
		return "was not found"
	}
	return s.state
}

func (s suite) link() string {
	if s.url == "" {
		return s.state
	}
	return fmt.Sprintf("%s ([the release run](%s))", s.state, s.url)
}

// after finds the full suite run after a hotfix: the after job of the
// newest release run of commit, in its latest attempt.
func (p *promoter) after(ctx context.Context, commit string) (suite, error) {
	var runs struct {
		WorkflowRuns []struct {
			ID      int64  `json:"id"`
			Status  string `json:"status"`
			HTMLURL string `json:"html_url"`
		} `json:"workflow_runs"`
	}
	status, err := p.github(ctx, "actions/workflows/"+releaseWorkflow+"/runs?event=push&head_sha="+commit+"&per_page=1", &runs)
	if err != nil {
		return suite{}, err
	}
	if status != http.StatusOK {
		return suite{}, fmt.Errorf("GitHub answered %d for the release runs of %s", status, commit)
	}
	if len(runs.WorkflowRuns) == 0 {
		return suite{state: suiteMissing}, nil
	}
	run := runs.WorkflowRuns[0]
	var jobs struct {
		Jobs []struct {
			Name       string `json:"name"`
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
		} `json:"jobs"`
	}
	status, err = p.github(ctx, fmt.Sprintf("actions/runs/%d/jobs?filter=latest&per_page=100", run.ID), &jobs)
	if err != nil {
		return suite{}, err
	}
	if status != http.StatusOK {
		return suite{}, fmt.Errorf("GitHub answered %d for the jobs of the release run %d", status, run.ID)
	}
	s := suite{url: run.HTMLURL, state: suiteRunning}
	for _, j := range jobs.Jobs {
		if j.Name != afterJob {
			continue
		}
		switch {
		case j.Status != "completed":
			s.state = suiteRunning
		case j.Conclusion == "success":
			s.state = suitePassed
		default:
			s.state = suiteFailed
		}
		return s, nil
	}
	// The suite's jobs appear as they start; once the run has ended
	// without them, they never ran.
	if run.Status == "completed" {
		s.state = suiteMissing
	}
	return s, nil
}

// latest is the newest build with a release: the first of main's commits,
// from its head back, whose build has a tag in the registry. A commit just
// merged has none until its release is published, and is passed over, as
// one whose release failed is. Whether the release found is signed is
// promote's to check: one published and not signed is refused there, not
// passed over for an older one.
func (p *promoter) latest(ctx context.Context) (string, error) {
	var commits []struct {
		SHA string `json:"sha"`
	}
	status, err := p.github(ctx, fmt.Sprintf("commits?sha=%s&per_page=%d", mainBranch, latestWithin), &commits)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("GitHub answered %d for the commits of %s", status, mainBranch)
	}
	for i, c := range commits {
		if len(c.SHA) != 40 || !manifests.BuildID.MatchString(c.SHA[:12]) {
			return "", fmt.Errorf("GitHub's commits of %s: %q is not a commit", mainBranch, c.SHA)
		}
		build := c.SHA[:12]
		_, found, err := p.reg.Resolve(ctx, p.repo, build)
		if err != nil {
			return "", err
		}
		if !found {
			continue
		}
		if i == 0 {
			p.logf("no build given: the latest release is build %s, the head of %s", build, mainBranch)
		} else {
			p.logf("no build given: the latest release is build %s; %d newer commit(s) of %s have no release, the newest %s", build, i, mainBranch, commits[0].SHA[:12])
		}
		return build, nil
	}
	return "", fmt.Errorf("none of the last %d commits of %s has a release: not promoted. Name the build", len(commits), mainBranch)
}

// promote makes build the release production follows: the tag prod is
// moved to it, once a promotion is seen to need approval, the release's
// signature is checked as Flux will check it, its commit is found on main,
// it is not older than what production follows now unless a rollback is
// meant, and, if it passed only the hotfix checks, the full suite after
// them has passed or a hotfix is meant. With check, it says what it would
// do and moves nothing. The build may be latestBuild, for the newest one
// released.
func (p *promoter) promote(ctx context.Context, build string, o promotion) error {
	chosen := build == latestBuild
	if chosen {
		var err error
		if build, err = p.latest(ctx); err != nil {
			return err
		}
	}
	if !manifests.BuildID.MatchString(build) {
		return fmt.Errorf("%q is not a build, the first 12 characters of its commit", build)
	}
	if err := p.approved(ctx); err != nil {
		return err
	}
	next, found, err := p.find(ctx, build)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("there is no release of build %s: %s has no such tag", build, manifests.ManifestsRepo)
	}
	if next.build != build {
		return fmt.Errorf("%s:%s says it was made from build %s", manifests.ManifestsRepo, build, next.build)
	}
	// Never a release Flux would refuse: production would sit on a source
	// it cannot fetch.
	if err := p.verify(ctx, next); err != nil {
		return fmt.Errorf("the release of build %s is not signed by the release workflow on main: not promoted\n%w", build, err)
	}
	switch status, err := p.compare(ctx, mainBranch, next.commit); {
	case err != nil:
		return err
	case status != "behind" && status != "identical":
		return fmt.Errorf("the commit of build %s, %s, is not on %s (it is %s): not promoted", build, next.commit, mainBranch, status)
	}

	// A build released before the gate was recorded passed every check.
	hotfixBuild := next.annotations[gateAnnotation] == gateHotfix
	var full suite
	if hotfixBuild {
		if full, err = p.after(ctx, next.commit); err != nil {
			return err
		}
		if !o.hotfix && full.state != suitePassed {
			return fmt.Errorf("build %s passed only the hotfix checks, and the full suite after them %s: not promoted. To promote it before that suite passes, run again with hotfix ticked", build, full.said())
		}
	}

	now, following, err := p.find(ctx, manifests.ProdTag)
	if err != nil {
		return err
	}
	if following && now.digest == next.digest {
		p.logf("production follows %s already: nothing to move", next)
		fmt.Fprintf(p.summary, "### Production follows build `%s` already\n\nNothing was moved: `%s`.\n", next.build, next.digest)
		if chosen {
			fmt.Fprintf(p.summary, "\nNo build was given: this is the latest release.\n")
		}
		return nil
	}
	if following {
		switch status, err := p.compare(ctx, now.commit, next.commit); {
		case err != nil:
			return err
		case status == "ahead":
		case status == "behind" && o.rollback:
			p.logf("rolling back: build %s is older than build %s, which production follows", next.build, now.build)
		case status == "behind":
			return fmt.Errorf("build %s is older than build %s, which production follows: not promoted. To roll back, run again with rollback ticked", next.build, now.build)
		default:
			return fmt.Errorf("the commit of build %s is %s the commit of build %s, which production follows: not promoted", next.build, status, now.build)
		}
	}

	world := worldLine(now, next, following)
	p.logf("%s", strings.NewReplacer("**", "", "`", "").Replace(world))
	notes := func() {
		if following && o.rollback {
			fmt.Fprintf(p.summary, "\nA rollback, asked for.\n")
		}
		if chosen {
			fmt.Fprintf(p.summary, "\nNo build was given: this is the latest release.\n")
		}
		switch {
		case hotfixBuild && o.hotfix:
			fmt.Fprintf(p.summary, "\nA hotfix, asked for: build `%s` passed only the hotfix checks. The full suite after them: %s.\n", next.build, full.link())
		case hotfixBuild:
			fmt.Fprintf(p.summary, "\nA hotfix's build, whose full suite after its checks %s.\n", full.link())
		case o.hotfix:
			fmt.Fprintf(p.summary, "\nHotfix was ticked, and build `%s` passed every check: the box changed nothing.\n", next.build)
		}
	}
	table := func(heading string) {
		fmt.Fprintf(p.summary, "%s\n\n%s\n\n| | Build | Commit | Manifests |\n|---|---|---|---|\n", world, heading)
		if following {
			fmt.Fprintf(p.summary, "| Before | `%s` | %s | `%s` |\n", now.build, now.commit, now.digest)
		} else {
			fmt.Fprintf(p.summary, "| Before | none | | |\n")
		}
	}

	if o.check {
		p.logf("promoting %s would pass every check; nothing was moved", next)
		table(fmt.Sprintf("### Promoting build `%s` would pass every check", next.build))
		fmt.Fprintf(p.summary, "| After | `%s` | %s | `%s` |\n", next.build, next.commit, next.digest)
		notes()
		fmt.Fprintf(p.summary, "\nNothing was moved here: the promote job moves it once approved, and checks it all again first.\n")
		return nil
	}

	if _, err := p.run(ctx, "flux", "tag", "artifact", "oci://"+manifests.ManifestsRepo+"@"+next.digest, "--tag", manifests.ProdTag); err != nil {
		return err
	}
	moved, found, err := p.find(ctx, manifests.ProdTag)
	if err != nil {
		return err
	}
	if !found || moved.digest != next.digest {
		return errors.New("the tag " + manifests.ProdTag + " was moved, but does not name the release promoted: " + moved.String())
	}
	was := "nothing before"
	if following {
		was = now.String()
	}
	p.logf("production now follows %s; before, %s", next, was)
	table(fmt.Sprintf("### Production follows build `%s`", next.build))
	fmt.Fprintf(p.summary, "| Now | `%s` | %s | `%s` |\n", next.build, next.commit, next.digest)
	notes()
	return nil
}
