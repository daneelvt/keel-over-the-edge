// SPDX-License-Identifier: AGPL-3.0-only

// Command tailnet keeps the tailnet's access policy, infra/tailnet/
// policy.hujson: who may reach production's machine, and how.
//
//	go run ./tools/tailnet -check   read the policy and check its rules, offline
//	go run ./tools/tailnet -apply   have Tailscale validate it, then write it over the live one
//
// -apply runs in the tailnet workflow, once the owner has approved it. It
// signs in to Tailscale as the federated identity infra/production.yaml
// names (tailscale.policy), with the job's OIDC token: no stored secret.
// It writes the policy only if the live one has not changed since it was
// read (its ETag), and puts what it replaced in the run's summary. It
// runs from the repository root.
package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/actions"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/production"
)

// policyFile is the policy, from the repository's root.
const policyFile = "infra/tailnet/policy.hujson"

func main() {
	check := flag.Bool("check", false, "read the policy and check its rules, offline")
	apply := flag.Bool("apply", false, "validate the policy with Tailscale and write it")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch {
	case *check:
		if _, err = readPolicy(policyFile); err == nil {
			fmt.Printf("tailnet: %s keeps its rules\n", policyFile)
		}
	case *apply:
		var a *applier
		if a, err = newApplier(); err == nil {
			err = a.apply(ctx)
			a.summary.Close()
		}
	default:
		flag.Usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "tailnet:", err)
		os.Exit(1)
	}
}

// readPolicy reads the policy file and checks its rules.
func readPolicy(file string) ([]byte, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	p, err := parsePolicy(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	if err := p.check(raw); err != nil {
		return nil, fmt.Errorf("%s:\n%w", file, err)
	}
	return raw, nil
}

// applier writes the policy to Tailscale.
type applier struct {
	out     io.Writer
	summary io.WriteCloser
	hc      *http.Client
	base    string
	id      production.Identity
	file    string
	// idToken gets the job's OIDC token for an audience.
	idToken func(ctx context.Context, audience string) (string, error)
}

func newApplier() (*applier, error) {
	p, err := production.Read(production.File)
	if err != nil {
		return nil, err
	}
	id := p.Tailscale.Policy
	if err := production.Need(map[string]string{"tailscale.policy.clientID": id.ClientID, "tailscale.policy.audience": id.Audience}); err != nil {
		return nil, err
	}
	summary, err := actions.Summary()
	if err != nil {
		return nil, err
	}
	hc := &http.Client{Timeout: time.Minute}
	return &applier{
		out: os.Stdout, summary: summary, hc: hc, base: "https://api.tailscale.com", id: id, file: policyFile,
		idToken: func(ctx context.Context, audience string) (string, error) {
			return actions.IDToken(ctx, hc, os.Stdout, audience)
		},
	}, nil
}

func (a *applier) logf(format string, args ...any) {
	fmt.Fprintf(a.out, "tailnet: "+format+"\n", args...)
}

// apply checks the policy offline, has Tailscale validate it (its tests
// included), reads the live policy, and writes the repository's over it
// unless they are the same, only if the live one is still the one read.
func (a *applier) apply(ctx context.Context) error {
	want, err := readPolicy(a.file)
	if err != nil {
		return err
	}
	jwt, err := a.idToken(ctx, a.id.Audience)
	if err != nil {
		return err
	}
	token, err := exchange(ctx, a.hc, a.base, a.id.ClientID, jwt)
	if err != nil {
		return err
	}
	actions.Mask(a.out, token)
	t := &api{base: a.base, token: token, hc: a.hc}

	if err := t.validate(ctx, want); err != nil {
		return err
	}
	a.logf("Tailscale validated %s, and its tests pass", a.file)
	live, etag, err := t.live(ctx)
	if err != nil {
		return err
	}
	diff := lineDiff(string(live), string(want))
	if !changed(diff) {
		a.logf("the live policy is %s already: nothing written", a.file)
		fmt.Fprintf(a.summary, "### The tailnet policy is unchanged\n\nThe live policy is `%s` already.\n", a.file)
		return nil
	}
	if err := t.write(ctx, want, etag); err != nil {
		return err
	}
	a.logf("wrote %s over the live policy:\n%s", a.file, strings.Join(diff, "\n"))
	var b bytes.Buffer
	fmt.Fprintf(&b, "### The tailnet policy was written\n\n`%s` replaced the live policy. Lines marked `-` were live and are gone: a change made in the admin page shows here.\n\n```diff\n", a.file)
	for _, l := range diff {
		fmt.Fprintln(&b, l)
	}
	b.WriteString("```\n")
	_, err = a.summary.Write(b.Bytes())
	return err
}
