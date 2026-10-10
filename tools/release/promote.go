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
)

// revisionAnnotation is where a release's artifact says what it was made
// from, as main@sha1:<commit>: flux push artifact writes its --revision
// there.
const revisionAnnotation = "org.opencontainers.image.revision"

// mainBranch is the branch releases are made from.
const mainBranch = "main"

// approvalEnvironment is the deployment environment the promote workflow's
// job runs in: its required reviewers are who approves a promotion.
const approvalEnvironment = "production"

// promoter reads the releases in the registry and moves the tag
// production follows.
type promoter struct {
	out io.Writer
	reg *registry
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
		reg:   &registry{base: "https://" + host, user: os.Getenv("GITHUB_ACTOR"), password: os.Getenv("GITHUB_TOKEN"), hc: hc},
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
}

func (r release) String() string {
	return fmt.Sprintf("build %s (commit %s, %s)", r.build, r.commit, r.digest)
}

// find reads the release a tag names: a build, or the tag production
// follows. found is false when the registry has none.
func (p *promoter) find(ctx context.Context, tag string) (r release, found bool, err error) {
	a, found, err := p.reg.resolve(ctx, p.repo, tag)
	if err != nil || !found {
		return r, false, err
	}
	revision := a.annotations[revisionAnnotation]
	branch, commit, ok := strings.Cut(revision, "@sha1:")
	if !ok || branch != mainBranch || len(commit) != 40 || !manifests.BuildID.MatchString(commit[:12]) {
		return r, false, fmt.Errorf("%s:%s does not say it was made from a commit on %s (%s is %q)", manifests.ManifestsRepo, tag, mainBranch, revisionAnnotation, revision)
	}
	return release{build: commit[:12], commit: commit, digest: a.digest}, true, nil
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

// promote makes build the release production follows: the tag prod is
// moved to it, once a promotion is seen to need approval, the release's
// signature is checked as Flux will check it, its commit is found on main,
// and it is not older than what production follows now, unless rollback
// says that is meant.
func (p *promoter) promote(ctx context.Context, build string, rollback bool) error {
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

	now, following, err := p.find(ctx, manifests.ProdTag)
	if err != nil {
		return err
	}
	if following && now.digest == next.digest {
		p.logf("production follows %s already: nothing to move", next)
		fmt.Fprintf(p.summary, "### Production follows build `%s` already\n\nNothing was moved: `%s`.\n", next.build, next.digest)
		return nil
	}
	if following {
		switch status, err := p.compare(ctx, now.commit, next.commit); {
		case err != nil:
			return err
		case status == "ahead":
		case status == "behind" && rollback:
			p.logf("rolling back: build %s is older than build %s, which production follows", next.build, now.build)
		case status == "behind":
			return fmt.Errorf("build %s is older than build %s, which production follows: not promoted. To roll back, run again with rollback ticked", next.build, now.build)
		default:
			return fmt.Errorf("the commit of build %s is %s the commit of build %s, which production follows: not promoted", next.build, status, now.build)
		}
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
	fmt.Fprintf(p.summary, "### Production follows build `%s`\n\n| | Build | Commit | Manifests |\n|---|---|---|---|\n", next.build)
	if following {
		fmt.Fprintf(p.summary, "| Before | `%s` | %s | `%s` |\n", now.build, now.commit, now.digest)
	} else {
		fmt.Fprintf(p.summary, "| Before | none | | |\n")
	}
	fmt.Fprintf(p.summary, "| Now | `%s` | %s | `%s` |\n", next.build, next.commit, next.digest)
	if following && rollback {
		fmt.Fprintf(p.summary, "\nA rollback, asked for.\n")
	}
	return nil
}
