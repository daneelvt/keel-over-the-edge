// SPDX-License-Identifier: AGPL-3.0-only

// Package agreement is the keeper of the contributor agreement: a GitHub
// App's server, run by keel agreement as a process of its own. GitHub tells
// it of each pull request opened or pushed to; it works out who wrote it
// (Who), looks up who has signed the current version of the agreement,
// and sets the pull request's status pr-agreement, with one comment that
// says who must still sign, and where. People sign on its page, after
// signing in with GitHub; their pull requests are checked again at once.
// The owner's tools list, export, enter and void signatures.
package agreement

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/legal"
)

// StatusContext is the status the check sets: a required check on the
// repository's main branch, from this App alone.
const StatusContext = "pr-agreement"

// marker is in the App's one comment on a pull request, which is found by
// it and edited in place.
const marker = "<!-- pr-agreement -->"

// Status is a commit's status, as GitHub's API takes it.
type Status struct {
	State       string `json:"state"`
	TargetURL   string `json:"target_url,omitempty"`
	Description string `json:"description"`
	Context     string `json:"context"`
}

// Store is what the keeper keeps: store.Agreements.
type Store interface {
	Ready(ctx context.Context) error
	Signed(ctx context.Context, ids []int64, version int) (map[int64]bool, error)
	Sign(ctx context.Context, s store.Signature) (bool, error)
	SignaturesOf(ctx context.Context, githubID int64) ([]store.Signature, error)
	Signatures(ctx context.Context) ([]store.Signature, error)
	Void(ctx context.Context, id store.AccountID, reason string) (int64, error)
	WaitingFor(ctx context.Context, githubID int64) ([]store.PullRef, error)
	Waiting(ctx context.Context) ([]store.PullRef, error)
	SetWaiting(ctx context.Context, pr store.PullRef, headSHA string, ids []int64) error
}

// Checker checks pull requests, one at a time, from a queue: the
// webhook's, a signer's, and the sweeps'.
type Checker struct {
	GitHub *GitHub
	Store  Store
	// Page is the signing page's address.
	Page string
	Log  *slog.Logger
	// Result, if not nil, is told how each check ended: success, pending
	// or error.
	Result func(string)

	mu      sync.Mutex
	pending []store.PullRef
	queued  map[store.PullRef]bool
	wake    chan struct{}
}

// Enqueue asks for a pull request to be checked; one already waiting to
// be is not queued twice.
func (c *Checker) Enqueue(prs ...store.PullRef) {
	c.mu.Lock()
	if c.queued == nil {
		c.queued = map[store.PullRef]bool{}
		c.wake = make(chan struct{}, 1)
	}
	for _, pr := range prs {
		if !c.queued[pr] {
			c.queued[pr] = true
			c.pending = append(c.pending, pr)
		}
	}
	wake := c.wake
	c.mu.Unlock()
	select {
	case wake <- struct{}{}:
	default:
	}
}

func (c *Checker) next() (store.PullRef, bool, chan struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.wake == nil {
		c.queued = map[store.PullRef]bool{}
		c.wake = make(chan struct{}, 1)
	}
	if len(c.pending) == 0 {
		return store.PullRef{}, false, c.wake
	}
	pr := c.pending[0]
	c.pending = c.pending[1:]
	delete(c.queued, pr)
	return pr, true, c.wake
}

// Idle reports whether nothing waits to be checked, for tests.
func (c *Checker) Idle() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pending) == 0
}

// Run checks what is queued until ctx ends.
func (c *Checker) Run(ctx context.Context) {
	for {
		pr, ok, wake := c.next()
		if !ok {
			select {
			case <-ctx.Done():
				return
			case <-wake:
				continue
			}
		}
		if err := c.Check(ctx, pr); err != nil && ctx.Err() == nil {
			c.Log.Warn("a pull request was not checked", "repo", pr.Repo, "number", pr.Number, "err", err)
		}
	}
}

// Sweep queues every open pull request of every repository the App is
// installed on, and every one waiting for a signature: at the start, and
// every hour, so a webhook GitHub failed to deliver mends itself.
func (c *Checker) Sweep(ctx context.Context) error {
	repos, err := c.GitHub.Repos(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, repo := range repos {
		ns, err := c.GitHub.OpenPulls(ctx, repo)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		for _, n := range ns {
			c.Enqueue(store.PullRef{Repo: repo, Number: n})
		}
	}
	waiting, err := c.Store.Waiting(ctx)
	if err != nil {
		errs = append(errs, err)
	}
	c.Enqueue(waiting...)
	return errors.Join(errs...)
}

// SweepEvery sweeps at once, then every period, until ctx ends.
func (c *Checker) SweepEvery(ctx context.Context, period time.Duration) {
	t := time.NewTicker(period)
	defer t.Stop()
	for {
		if err := c.Sweep(ctx); err != nil && ctx.Err() == nil {
			c.Log.Warn("the sweep of open pull requests failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (c *Checker) result(r string) {
	if c.Result != nil {
		c.Result(r)
	}
}

// Check checks one pull request: who must sign, who has, its status and
// its comment.
func (c *Checker) Check(ctx context.Context, ref store.PullRef) error {
	p, err := c.GitHub.Pull(ctx, ref.Repo, ref.Number)
	if err != nil {
		if errors.Is(err, ErrNotInstalled) {
			// Uninstalled from a repository: nothing there waits any more.
			return c.Store.SetWaiting(ctx, ref, "", nil)
		}
		c.result("error")
		return err
	}
	if !p.Open {
		return c.Store.SetWaiting(ctx, ref, "", nil)
	}
	need := Who(p)
	v := legal.Current()
	ids := make([]int64, len(need.Users))
	for i, u := range need.Users {
		ids[i] = u.ID
	}
	signed, err := c.Store.Signed(ctx, ids, v.Number)
	if err != nil {
		c.failed(ctx, p, "its records did not answer")
		return err
	}
	var missing []User
	var missingIDs []int64
	for _, u := range need.Users {
		if !signed[u.ID] {
			missing = append(missing, u)
			missingIDs = append(missingIDs, u.ID)
		}
	}
	waiting := len(missing) + len(need.Unknown)
	st := Status{State: "success", Description: "Everyone has signed the contributor agreement", Context: StatusContext, TargetURL: c.Page}
	if waiting > 0 {
		st.State = "pending"
		st.Description = "Waiting for " + count(waiting, "person", "people") + " to sign the contributor agreement"
	}
	if err := c.GitHub.Status(ctx, p.Repo, p.HeadSHA, st); err != nil {
		c.failed(ctx, p, "GitHub did not answer")
		return err
	}
	if err := c.comment(ctx, p, missing, need.Unknown, v); err != nil {
		c.failed(ctx, p, "GitHub did not answer")
		return err
	}
	if err := c.Store.SetWaiting(ctx, ref, p.HeadSHA, missingIDs); err != nil {
		c.result("error")
		return err
	}
	c.result(st.State)
	return nil
}

// failed sets the error status, if it can: the check could not finish,
// and runs again within the hour.
func (c *Checker) failed(ctx context.Context, p Pull, why string) {
	c.result("error")
	st := Status{State: "error", Context: StatusContext, TargetURL: c.Page,
		Description: "Could not check: " + why + ". It is checked again within the hour."}
	if err := c.GitHub.Status(ctx, p.Repo, p.HeadSHA, st); err != nil {
		c.Log.Warn("the error status was not set", "repo", p.Repo, "number", p.Number, "err", err)
	}
}

// comment writes the App's one comment on a pull request: made only when
// someone must sign, edited in place after, never a second.
func (c *Checker) comment(ctx context.Context, p Pull, missing []User, unknown []string, v legal.Version) error {
	existing, found, err := c.GitHub.FindComment(ctx, p.Repo, p.Number, marker)
	if err != nil {
		return err
	}
	var body string
	switch {
	case len(missing)+len(unknown) > 0:
		body = c.askBody(p, missing, unknown, v)
	case found:
		body = marker + "\nEveryone who wrote this pull request has signed the [contributor agreement](" + c.Page + "). Thank you.\n"
	default:
		return nil
	}
	if !found {
		return c.GitHub.AddComment(ctx, p.Repo, p.Number, body)
	}
	if existing.Body == body {
		return nil
	}
	return c.GitHub.EditComment(ctx, p.Repo, existing.ID, body)
}

func (c *Checker) askBody(p Pull, missing []User, unknown []string, v legal.Version) string {
	var b strings.Builder
	b.WriteString(marker + "\n")
	b.WriteString("Thank you for your pull request! Before it can be merged, everyone who wrote it signs the [" +
		v.Name() + "](" + c.Page + "), once. It takes under a minute: sign in with GitHub, read it, tick three " +
		"boxes and sign. This check turns green by itself.\n\n")
	if len(missing) > 0 {
		b.WriteString("Waiting for:\n\n")
		for _, u := range missing {
			b.WriteString("- @" + u.Login + "\n")
		}
		b.WriteString("\n")
	}
	if len(unknown) > 0 {
		b.WriteString("These authors are not linked to a GitHub account that can sign:\n\n")
		for _, who := range unknown {
			b.WriteString("- " + codeSpan(who) + "\n")
		}
		b.WriteString("\nAdd the commit's e-mail to your GitHub account (Settings, Emails), or write the commit again " +
			"with an e-mail your account has, or name a co-author by their GitHub no-reply address. If none of " +
			"that fits, the owner can check it by hand.\n\n")
	}
	b.WriteString("Why: you keep your copyright. The agreement lets the game's owner license the code under other terms " +
		"too, and promises that it stays available under the AGPL. More in [CONTRIBUTING.md](https://github.com/" +
		p.Repo + "/blob/HEAD/CONTRIBUTING.md#the-contributor-agreement).\n")
	return b.String()
}

// codeSpan writes text as a Markdown code span, whatever backticks it
// holds, so a commit's author name cannot write Markdown into the comment.
func codeSpan(s string) string {
	s = strings.NewReplacer("\r", " ", "\n", " ").Replace(s)
	fence := "`"
	for strings.Contains(s, fence) {
		fence += "`"
	}
	return fence + " " + s + " " + fence
}

func count(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

// String is a pull request's name, owner/name#number.
func String(pr store.PullRef) string { return fmt.Sprintf("%s#%d", pr.Repo, pr.Number) }
