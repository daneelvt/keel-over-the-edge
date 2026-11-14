// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"slices"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/legal"
)

const page = "https://play.example/agreement"

func setup(t *testing.T) (*fakeGitHub, *memStore, *Checker, *[]string) {
	f := newFakeGitHub(t)
	m := newMemStore()
	var results []string
	c := &Checker{GitHub: f.client(), Store: m, Page: page, Log: quietLog(), Result: func(r string) { results = append(results, r) }}
	return f, m, c, &results
}

func annsPull() *fakePull {
	return &fakePull{open: true, head: "h1", author: ann, commits: []Commit{commit(by(ann, "ann@example.com"), by(ann, "ann@example.com"), "Fix")}}
}

// TestCheckAndSign: an outsider's pull request waits, with one comment;
// once they sign, the same comment says so and the status turns green.
func TestCheckAndSign(t *testing.T) {
	ctx := context.Background()
	f, m, c, results := setup(t)
	f.pulls[5] = annsPull()
	pr := store.PullRef{Repo: "o/r", Number: 5}

	if err := c.Check(ctx, pr); err != nil {
		t.Fatal(err)
	}
	st := f.last()
	if st.SHA != "h1" || st.State != "pending" || st.Context != StatusContext || st.TargetURL != page ||
		st.Description != "Waiting for 1 person to sign the contributor agreement" {
		t.Errorf("status: %+v", st)
	}
	cs := f.commentsOn(5)
	if len(cs) != 1 || !strings.Contains(cs[0].Body, "@ann") || !strings.Contains(cs[0].Body, page) || !strings.Contains(cs[0].Body, marker) {
		t.Fatalf("comments: %+v", cs)
	}
	if got, _ := m.WaitingFor(ctx, ann.ID); len(got) != 1 || got[0] != pr {
		t.Errorf("waiting for ann: %v", got)
	}

	// A push checks it again: still one comment, unchanged.
	f.pulls[5].head = "h2"
	if err := c.Check(ctx, pr); err != nil {
		t.Fatal(err)
	}
	if cs := f.commentsOn(5); len(cs) != 1 {
		t.Fatalf("a second check made %d comments", len(cs))
	}

	// She signs: her pull request is checked again from the waiting list.
	m.Sign(ctx, store.Signature{GitHubID: ann.ID, Login: "ann", Name: "Ann", Version: legal.Current().Number, TextSHA256: legal.Current().SHA256, How: store.SignedOnPage})
	waiting, _ := m.WaitingFor(ctx, ann.ID)
	c.Enqueue(waiting...)
	drain(t, c)
	st = f.last()
	if st.SHA != "h2" || st.State != "success" || st.Description != "Everyone has signed the contributor agreement" {
		t.Errorf("status after signing: %+v", st)
	}
	cs = f.commentsOn(5)
	if len(cs) != 1 || !strings.Contains(cs[0].Body, "has signed") || strings.Contains(cs[0].Body, "@ann") {
		t.Errorf("comment after signing: %+v", cs)
	}
	if got, _ := m.WaitingFor(ctx, ann.ID); len(got) != 0 {
		t.Errorf("still waiting for ann: %v", got)
	}
	if strings.Join(*results, ",") != "pending,pending,success" {
		t.Errorf("results: %v", *results)
	}
}

// TestCheckOldVersion: a signature of an older version does not count.
func TestCheckOldVersion(t *testing.T) {
	ctx := context.Background()
	f, m, c, _ := setup(t)
	f.pulls[5] = annsPull()
	m.Sign(ctx, store.Signature{GitHubID: ann.ID, Login: "ann", Name: "Ann", Version: legal.Current().Number + 1, TextSHA256: strings.Repeat("0", 64), How: store.SignedOnPage})
	if err := c.Check(ctx, store.PullRef{Repo: "o/r", Number: 5}); err != nil {
		t.Fatal(err)
	}
	if st := f.last(); st.State != "pending" {
		t.Errorf("status with another version signed: %+v", st)
	}
}

// TestCheckPassedSilently: the owner's and Renovate's pull requests pass
// without a comment.
func TestCheckPassedSilently(t *testing.T) {
	ctx := context.Background()
	f, _, c, _ := setup(t)
	f.pulls[1] = &fakePull{open: true, head: "o1", author: theOwner, commits: []Commit{commit(by(theOwner, "o@example.com"), by(theOwner, "o@example.com"),
		"Change\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>")}}
	f.pulls[2] = &fakePull{open: true, head: "r1", author: renov, commits: []Commit{commit(by(renov, "r"), by(webflow, "noreply@github.com"), "Update x")}}
	for _, n := range []int{1, 2} {
		if err := c.Check(ctx, store.PullRef{Repo: "o/r", Number: n}); err != nil {
			t.Fatal(err)
		}
		if st := f.last(); st.State != "success" {
			t.Errorf("#%d: %+v", n, st)
		}
		if cs := f.commentsOn(n); len(cs) != 0 {
			t.Errorf("#%d has comments: %+v", n, cs)
		}
	}
}

// TestCheckUnknownAndLabel: an unlinked co-author holds the merge, named in
// the comment as code; the owner's label passes them.
func TestCheckUnknownAndLabel(t *testing.T) {
	ctx := context.Background()
	f, m, c, _ := setup(t)
	m.Sign(ctx, store.Signature{GitHubID: ann.ID, Login: "ann", Name: "Ann", Version: legal.Current().Number, TextSHA256: legal.Current().SHA256, How: store.SignedOnPage})
	p := annsPull()
	p.commits[0].Message = "Fix\n\nCo-authored-by: Ev`il **x** <evil@example.com>"
	f.pulls[6] = p
	pr := store.PullRef{Repo: "o/r", Number: 6}
	if err := c.Check(ctx, pr); err != nil {
		t.Fatal(err)
	}
	if st := f.last(); st.State != "pending" {
		t.Errorf("status: %+v", st)
	}
	cs := f.commentsOn(6)
	if len(cs) != 1 || !strings.Contains(cs[0].Body, "`` Ev`il **x** <evil@example.com> ``") {
		t.Fatalf("comment: %+v", cs)
	}
	f.pulls[6].labels = []string{CheckedLabel}
	if err := c.Check(ctx, pr); err != nil {
		t.Fatal(err)
	}
	if st := f.last(); st.State != "success" {
		t.Errorf("status with the label: %+v", st)
	}
	if cs := f.commentsOn(6); len(cs) != 1 || !strings.Contains(cs[0].Body, "has signed") {
		t.Errorf("comment with the label: %+v", cs)
	}
}

// TestCheckErrors: GitHub failing mid-check, or the records, set the error
// status where they can, and count as errors.
func TestCheckErrors(t *testing.T) {
	ctx := context.Background()
	f, m, c, results := setup(t)
	f.pulls[5] = annsPull()
	pr := store.PullRef{Repo: "o/r", Number: 5}
	m.broken = true
	if err := c.Check(ctx, pr); err == nil {
		t.Fatal("a check with its records down succeeded")
	}
	if st := f.last(); st.State != "error" || !strings.Contains(st.Description, "records") {
		t.Errorf("status: %+v", st)
	}
	m.broken = false
	f.failing = true
	if err := c.Check(ctx, pr); err == nil {
		t.Fatal("a check with GitHub down succeeded")
	}
	if strings.Join(*results, ",") != "error,error" {
		t.Errorf("results: %v", *results)
	}
}

// TestCheckClosed: a closed pull request waits for nobody.
func TestCheckClosed(t *testing.T) {
	ctx := context.Background()
	f, m, c, _ := setup(t)
	f.pulls[5] = annsPull()
	pr := store.PullRef{Repo: "o/r", Number: 5}
	c.Check(ctx, pr)
	f.pulls[5].open = false
	if err := c.Check(ctx, pr); err != nil {
		t.Fatal(err)
	}
	if got, _ := m.Waiting(ctx); len(got) != 0 {
		t.Errorf("waiting after close: %v", got)
	}
	// Another repository the App is not on: nothing waits there either.
	m.SetWaiting(ctx, store.PullRef{Repo: "a/b", Number: 1}, "s", []int64{7})
	if err := c.Check(ctx, store.PullRef{Repo: "a/b", Number: 1}); err != nil {
		t.Fatal(err)
	}
	if got, _ := m.Waiting(ctx); len(got) != 0 {
		t.Errorf("waiting on an uninstalled repository: %v", got)
	}
}

// TestSweep: every open pull request of every installation is queued, and
// every one waiting.
func TestSweep(t *testing.T) {
	ctx := context.Background()
	f, m, c, _ := setup(t)
	f.pulls[5] = annsPull()
	f.pulls[7] = &fakePull{open: false, head: "z"}
	m.SetWaiting(ctx, store.PullRef{Repo: "o/r", Number: 7}, "z", []int64{8})
	if err := c.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	drain(t, c)
	if st := f.last(); st.SHA != "h1" {
		t.Errorf("the open pull request was not checked: %+v", st)
	}
	if got, _ := m.WaitingFor(ctx, 8); len(got) != 0 {
		t.Errorf("the closed one still waits: %v", got)
	}
	if !c.Idle() {
		t.Error("the queue is not empty")
	}
}

// TestStrangersInstallation: the App is public, so that anyone may sign in
// through it, and so anyone may install it. On another account's
// repository it does nothing: no token, no status, no comment, and the
// sweep passes it over.
func TestStrangersInstallation(t *testing.T) {
	ctx := context.Background()
	f, m, c, _ := setup(t)
	f.pulls[5] = annsPull()
	if err := c.Check(ctx, store.PullRef{Repo: "x/y", Number: 5}); err != nil {
		t.Fatal(err)
	}
	if err := c.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(c.pending, []store.PullRef{{Repo: "o/r", Number: 5}}) {
		t.Errorf("the sweep queued %v", c.pending)
	}
	if f.strangers != 0 || len(f.statuses) != 0 || len(f.comments) != 0 {
		t.Errorf("on a stranger's repository: %d tokens, %d statuses, %d comments", f.strangers, len(f.statuses), len(f.comments))
	}
	if got, _ := m.Waiting(ctx); len(got) != 0 {
		t.Errorf("waiting on a stranger's repository: %v", got)
	}
}

func TestEnqueueOnce(t *testing.T) {
	c := &Checker{}
	pr := store.PullRef{Repo: "o/r", Number: 1}
	c.Enqueue(pr, pr)
	c.Enqueue(pr)
	if len(c.pending) != 1 {
		t.Errorf("queued %d times", len(c.pending))
	}
}

// TestJWT: the App's token verifies under its public key, by the fake's
// own check, and a key from GitHub's PEM is read.
func TestJWT(t *testing.T) {
	f := newFakeGitHub(t)
	g := f.client()
	if _, err := g.token(context.Background(), "o/r"); err != nil {
		t.Fatalf("the installation's token, with the App's JWT: %v", err)
	}
	if _, err := g.token(context.Background(), "a/b"); err == nil || !strings.Contains(err.Error(), "not installed") {
		t.Errorf("a repository the App is not on: %v", err)
	}
	other := f.client()
	other.ClientID = "someone-else"
	if _, err := other.token(context.Background(), "o/r"); err == nil {
		t.Error("a JWT of another issuer was taken")
	}
	pkcs1 := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(testKey)})
	pkcs8, _ := x509.MarshalPKCS8PrivateKey(testKey)
	for _, p := range []string{string(pkcs1), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))} {
		k, err := ParseKey(p)
		if err != nil || !k.Equal(testKey) {
			t.Errorf("ParseKey: %v", err)
		}
	}
	if _, err := ParseKey("not a key"); err == nil {
		t.Error("ParseKey read text")
	}
}

func TestCodeSpan(t *testing.T) {
	for in, want := range map[string]string{
		"a <b@c>":    "` a <b@c> `",
		"x`y":        "`` x`y ``",
		"a\nb":       "` a b `",
		"``double``": "``` ``double`` ```",
	} {
		if got := codeSpan(in); got != want {
			t.Errorf("codeSpan(%q) = %q, want %q", in, got, want)
		}
	}
}
