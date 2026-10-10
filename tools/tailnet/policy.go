// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/tailscale/hujson"
)

// The tags the policy gives: production's machine, and the node a
// workflow joins as. The owner is autogroup:admin, the tailnet's admins.
const (
	machineTag = "tag:keel-prod"
	ciTag      = "tag:ci-prod"
	admins     = "autogroup:admin"
)

// policy is the tailnet policy file, as far as this one uses it
// (Tailscale's documentation, "Tailnet policy file syntax"). Any other
// section is refused: what the file allows is only what is read here.
type policy struct {
	TagOwners map[string][]string `json:"tagOwners"`
	Grants    []grant             `json:"grants"`
	SSH       []sshRule           `json:"ssh"`
	Tests     []aclTest           `json:"tests"`
	SSHTests  []sshTest           `json:"sshTests"`
}

type grant struct {
	Src []string `json:"src"`
	Dst []string `json:"dst"`
	IP  []string `json:"ip"`
}

type sshRule struct {
	Action      string   `json:"action"`
	Src         []string `json:"src"`
	Dst         []string `json:"dst"`
	Users       []string `json:"users"`
	CheckPeriod string   `json:"checkPeriod,omitempty"`
}

type aclTest struct {
	Src    string   `json:"src"`
	Accept []string `json:"accept"`
	Deny   []string `json:"deny"`
}

type sshTest struct {
	Src    string   `json:"src"`
	Dst    []string `json:"dst"`
	Accept []string `json:"accept"`
	Check  []string `json:"check,omitempty"`
	Deny   []string `json:"deny,omitempty"`
}

// parsePolicy reads a policy file written in HuJSON (JSON with comments
// and trailing commas).
func parsePolicy(data []byte) (policy, error) {
	var p policy
	std, err := hujson.Standardize(bytes.Clone(data))
	if err != nil {
		return p, err
	}
	dec := json.NewDecoder(bytes.NewReader(std))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return p, err
	}
	return p, nil
}

// The ports nobody on the tailnet may reach on the machine, which the
// policy's own tests must say: the web, the Kubernetes API, the kubelet.
var closedPorts = []string{"80", "443", "6443", "10250"}

// check keeps the policy's shape: no rule for everyone, tags owned by the
// admins alone, the workflow's node reaching SSH on the machine and no
// other port, logging in there without a fresh sign-in only for it, and
// Tailscale's own tests saying so, so that a change that broke it is
// refused when it is applied.
func (p policy) check(raw []byte) error {
	var errs []error
	fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }

	// No one's login: people are autogroup:admin.
	if err := noLogins(raw); err != nil {
		errs = append(errs, err)
	}

	for _, tag := range []string{machineTag, ciTag} {
		if !slices.Equal(p.TagOwners[tag], []string{admins}) {
			fail("tagOwners: %s is owned by %v, want [%s]", tag, p.TagOwners[tag], admins)
		}
	}
	for tag, owners := range p.TagOwners {
		if !slices.Contains([]string{machineTag, ciTag}, tag) {
			fail("tagOwners: %s is no tag this policy gives", tag)
		}
		for _, o := range owners {
			if o != admins {
				fail("tagOwners: %s is owned by %s, want %s alone", tag, o, admins)
			}
		}
	}
	owned := func(where, name string) {
		if strings.HasPrefix(name, "tag:") {
			if _, ok := p.TagOwners[name]; !ok {
				fail("%s: %s has no owner in tagOwners", where, name)
			}
		}
	}

	if len(p.Grants) == 0 {
		fail("grants: none")
	}
	for i, g := range p.Grants {
		where := fmt.Sprintf("grants[%d]", i)
		for _, s := range slices.Concat(g.Src, g.Dst, g.IP) {
			if strings.Contains(s, "*") {
				fail("%s: %q: no rule is for everyone, or every port", where, s)
			}
		}
		for _, s := range slices.Concat(g.Src, g.Dst) {
			owned(where, s)
		}
		if !slices.Equal(g.Dst, []string{machineTag}) || !slices.Equal(g.IP, []string{"tcp:22"}) {
			fail("%s: to %v on %v, want %s on tcp:22 alone: SSH is the only way in", where, g.Dst, g.IP, machineTag)
		}
		for _, s := range g.Src {
			if s != ciTag && s != admins {
				fail("%s: from %s, want %s or %s", where, s, ciTag, admins)
			}
		}
	}

	var ciAccept, adminCheck bool
	for i, r := range p.SSH {
		where := fmt.Sprintf("ssh[%d]", i)
		for _, s := range slices.Concat(r.Src, r.Dst, r.Users) {
			if strings.Contains(s, "*") {
				fail("%s: %q: no rule is for everyone", where, s)
			}
		}
		for _, s := range slices.Concat(r.Src, r.Dst) {
			owned(where, s)
		}
		if !slices.Equal(r.Dst, []string{machineTag}) || !slices.Equal(r.Users, []string{"root"}) {
			fail("%s: to %v as %v, want %s as root", where, r.Dst, r.Users, machineTag)
		}
		switch {
		case slices.Equal(r.Src, []string{ciTag}) && r.Action == "accept":
			ciAccept = true
		case slices.Equal(r.Src, []string{admins}) && r.Action == "check":
			adminCheck = true
		default:
			fail("%s: %s from %v: only %s is accepted, and %s is checked", where, r.Action, r.Src, ciTag, admins)
		}
	}
	if !ciAccept {
		fail("ssh: no rule lets %s log in as root on %s", ciTag, machineTag)
	}
	if !adminCheck {
		fail("ssh: no rule lets %s log in as root on %s, with a fresh sign-in", admins, machineTag)
	}

	reaches, denied := false, map[string]bool{}
	for _, t := range p.Tests {
		if t.Src != ciTag {
			continue
		}
		if slices.Contains(t.Accept, machineTag+":22") {
			reaches = true
		}
		for _, d := range t.Deny {
			denied[d] = true
		}
	}
	if !reaches {
		fail("tests: none says %s reaches %s:22", ciTag, machineTag)
	}
	for _, port := range closedPorts {
		if !denied[machineTag+":"+port] {
			fail("tests: none says %s is denied %s:%s", ciTag, machineTag, port)
		}
	}
	sshTested := false
	for _, t := range p.SSHTests {
		if t.Src == ciTag && slices.Contains(t.Dst, machineTag) && slices.Contains(t.Accept, "root") {
			sshTested = true
		}
	}
	if !sshTested {
		fail("sshTests: none says %s logs in as root on %s", ciTag, machineTag)
	}
	return errors.Join(errs...)
}

// noLogins fails if a value in the policy is a person's login, which has
// an @ (as someone@github, or an e-mail address). The policy is public;
// the owner is autogroup:admin.
func noLogins(raw []byte) error {
	v, err := hujson.Parse(bytes.Clone(raw))
	if err != nil {
		return err
	}
	var found []string
	var walk func(v hujson.Value)
	walk = func(v hujson.Value) {
		switch x := v.Value.(type) {
		case *hujson.Object:
			for _, m := range x.Members {
				walk(m.Name)
				walk(m.Value)
			}
		case *hujson.Array:
			for _, e := range x.Elements {
				walk(e)
			}
		case hujson.Literal:
			if s := x.String(); strings.Contains(s, "@") {
				found = append(found, s)
			}
		}
	}
	walk(v)
	if len(found) > 0 {
		return fmt.Errorf("%v: a person's login; the policy names people only as %s", found, admins)
	}
	return nil
}
