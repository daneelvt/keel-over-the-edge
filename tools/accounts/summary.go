// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"net"
	"reflect"
	"regexp"
	"slices"
	"strings"
)

// change is one resource a plan changes, as a run shows it: never a value.
type change struct {
	Address string
	// Action is create, update, delete, replace, read or no-op.
	Action string
	// Attributes are the names of the attributes that change, for an update
	// or a replacement: those whose value differs, or will be known only
	// once applied.
	Attributes []string
}

// planChanges reads the changes of tofu show -json's plan (OpenTofu's
// "JSON Output Format": resource_changes, each with its actions and the
// values before and after), keeping only what a run shows.
func planChanges(data []byte) ([]change, error) {
	var plan struct {
		FormatVersion   string `json:"format_version"`
		ResourceChanges []struct {
			Address string `json:"address"`
			Change  struct {
				Actions      []string `json:"actions"`
				Before       any      `json:"before"`
				After        any      `json:"after"`
				AfterUnknown any      `json:"after_unknown"`
			} `json:"change"`
		} `json:"resource_changes"`
	}
	if err := json.Unmarshal(data, &plan); err != nil {
		return nil, fmt.Errorf("reading the plan's JSON: %w", err)
	}
	if plan.FormatVersion == "" {
		return nil, fmt.Errorf("reading the plan's JSON: no format_version: not a plan")
	}
	var changes []change
	for _, rc := range plan.ResourceChanges {
		c := change{Address: rc.Address, Action: action(rc.Change.Actions)}
		if c.Action == "no-op" {
			continue
		}
		if c.Action == "update" || c.Action == "replace" {
			c.Attributes = changedNames(rc.Change.Before, rc.Change.After, rc.Change.AfterUnknown)
		}
		changes = append(changes, c)
	}
	slices.SortFunc(changes, func(a, b change) int { return strings.Compare(a.Address, b.Address) })
	return changes, nil
}

// action names a change's list of actions.
func action(actions []string) string {
	switch {
	case slices.Equal(actions, []string{"delete", "create"}), slices.Equal(actions, []string{"create", "delete"}):
		return "replace"
	case len(actions) == 1:
		return actions[0]
	}
	return strings.Join(actions, "+")
}

// changedNames are the top-level attributes whose values differ before and
// after, or are unknown until applied: their names, sorted.
func changedNames(before, after, unknown any) []string {
	b, _ := before.(map[string]any)
	a, _ := after.(map[string]any)
	u, _ := unknown.(map[string]any)
	names := map[string]bool{}
	for k := range a {
		if !reflect.DeepEqual(a[k], b[k]) {
			names[k] = true
		}
	}
	for k := range b {
		if _, ok := a[k]; !ok && b[k] != nil {
			names[k] = true
		}
	}
	for k, v := range u {
		if v != false && v != nil {
			names[k] = true
		}
	}
	var out []string
	for k := range names {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// counts says how many resources each action touches.
func counts(changes []change) string {
	if len(changes) == 0 {
		return "no changes"
	}
	n := map[string]int{}
	for _, c := range changes {
		n[c.Action]++
	}
	var parts []string
	for _, a := range []string{"create", "update", "replace", "delete", "read"} {
		if n[a] > 0 {
			parts = append(parts, fmt.Sprintf("%d to %s", n[a], a))
			delete(n, a)
		}
	}
	for a, k := range n {
		parts = append(parts, fmt.Sprintf("%d to %s", k, a))
	}
	return strings.Join(parts, ", ")
}

// summarize is the run summary's table of changes.
func summarize(changes []change) string {
	if len(changes) == 0 {
		return "Everything is as the configuration says.\n"
	}
	var b strings.Builder
	b.WriteString("| Resource | Action | Attributes that change |\n|---|---|---|\n")
	for _, c := range changes {
		fmt.Fprintf(&b, "| `%s` | %s | %s |\n", c.Address, c.Action, strings.Join(c.Attributes, ", "))
	}
	return b.String()
}

// Candidates for an IP address in text: four dotted numbers, or hex digits
// and dots with at least two colons. Each is checked by net.ParseIP, so a
// time of day is left alone.
var (
	ipv4Candidate = regexp.MustCompile(`\d{1,3}(?:\.\d{1,3}){3}`)
	ipv6Candidate = regexp.MustCompile(`[0-9A-Fa-f.]*:[0-9A-Fa-f.]*:[0-9A-Fa-f:.]*`)
)

// scrubAddresses replaces every IPv4 and IPv6 address in text, whoever's
// it is: the tunnel's connections hold the machine's public address, and a
// filter with exceptions could let it through.
func scrubAddresses(text string) string {
	replace := func(s string) string {
		if net.ParseIP(s) != nil {
			return "<address>"
		}
		return s
	}
	text = ipv6Candidate.ReplaceAllStringFunc(text, func(s string) string {
		// An address at the end of a sentence, or before a port.
		if ip := strings.TrimRight(s, ":."); net.ParseIP(ip) != nil {
			return "<address>" + s[len(ip):]
		}
		return replace(s)
	})
	return ipv4Candidate.ReplaceAllStringFunc(text, replace)
}
