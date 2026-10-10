// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

// acceptedFile lists the Lynis warnings accepted, each with its reason.
const acceptedFile = "infra/ansible/lynis-accepted.txt"

// audit runs Lynis on the machine, or on this runner, and changes nothing
// there: Lynis is copied to a folder of its own, run, and the folder
// removed. The run fails on a warning that lynis-accepted.txt does not
// list; the hardening index and the suggestions go to the summary. On the
// runner, kube-bench reports on k3s too, against CIS's newest k3s profile,
// which is for an older Kubernetes: a report, never a failure.
func (m *machine) audit(ctx context.Context, local bool) error {
	lynis, version, err := m.lynis(ctx)
	if err != nil {
		return err
	}
	report := m.path(stateDir, "lynis-report.dat")
	c, err := m.playbook("audit.yaml", local, nil, "--extra-vars", "machine_lynis="+lynis, "--extra-vars", "machine_report="+report)
	if err != nil {
		return err
	}
	where := m.prod.Machine
	if local {
		where = "this runner"
	}
	m.logf("auditing %s with Lynis %s", where, version)
	c.out = m.out
	if _, err := m.cmd.run(ctx, c); err != nil {
		return err
	}
	// On the runner, root fetched the report, and it is root's alone.
	var data []byte
	if local {
		data, err = m.cmd.run(ctx, cmd{argv: []string{"sudo", "cat", report}})
	} else {
		data, err = os.ReadFile(report)
	}
	if err != nil {
		return err
	}
	accepted, err := readAccepted(m.path(acceptedFile))
	if err != nil {
		return err
	}
	r := parseLynis(string(data))
	var unaccepted []string
	var b strings.Builder
	fmt.Fprintf(&b, "### Lynis %s on %s: hardening index %s\n\n", version, where, r.index)
	if len(r.warnings) > 0 {
		b.WriteString("| Warning | | Accepted because |\n|---|---|---|\n")
	}
	for _, w := range r.warnings {
		reason, ok := accepted[w.id]
		if !ok {
			unaccepted = append(unaccepted, w.id)
			reason = "**not accepted**"
		}
		fmt.Fprintf(&b, "| `%s` | %s | %s |\n", w.id, w.text, reason)
	}
	fmt.Fprintf(&b, "\n<details><summary>%d suggestions</summary>\n\n", len(r.suggestions))
	for _, s := range r.suggestions {
		fmt.Fprintf(&b, "- `%s` %s\n", s.id, s.text)
	}
	b.WriteString("\n</details>\n\n")
	fmt.Fprint(m.summary, b.String())
	m.logf("Lynis: hardening index %s, %d warnings, %d suggestions", r.index, len(r.warnings), len(r.suggestions))

	if local {
		m.kubeBench(ctx)
	}
	if len(unaccepted) > 0 {
		return fmt.Errorf("the audit warns of %s, which %s does not accept", strings.Join(unaccepted, ", "), acceptedFile)
	}
	return nil
}

// lynis unpacks Ubuntu's Lynis package for this runner's release into a
// folder laid out as Lynis's own release is (the program, include/,
// plugins/, db/, default.prf), from which it runs anywhere, installing
// nothing.
func (m *machine) lynis(ctx context.Context) (dir, version string, err error) {
	work := m.path(stateDir, "lynis-package")
	if err := os.RemoveAll(work); err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(work, 0o700); err != nil {
		return "", "", err
	}
	if _, err := m.cmd.run(ctx, cmd{argv: []string{"apt-get", "download", "lynis"}, dir: work}); err != nil {
		return "", "", err
	}
	debs, _ := filepath.Glob(filepath.Join(work, "lynis_*.deb"))
	if len(debs) != 1 {
		return "", "", fmt.Errorf("apt-get download lynis left %d packages", len(debs))
	}
	out, err := m.cmd.run(ctx, cmd{argv: []string{"dpkg-deb", "--field", debs[0], "Version"}})
	if err != nil {
		return "", "", err
	}
	version = strings.TrimSpace(string(out))
	x := filepath.Join(work, "x")
	if _, err := m.cmd.run(ctx, cmd{argv: []string{"dpkg-deb", "--extract", debs[0], x}}); err != nil {
		return "", "", err
	}
	dir = m.path(stateDir, "lynis")
	if err := os.RemoveAll(dir); err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	for src, dst := range map[string]string{
		"usr/sbin/lynis":          "lynis",
		"usr/share/lynis/include": "include",
		"etc/lynis/plugins":       "plugins",
		"usr/share/lynis/db":      "db",
		"etc/lynis/default.prf":   "default.prf",
	} {
		if err := os.Rename(filepath.Join(x, filepath.FromSlash(src)), filepath.Join(dir, dst)); err != nil {
			return "", "", fmt.Errorf("unpacking lynis: %w", err)
		}
	}
	return dir, version, nil
}

type finding struct{ id, text string }

type lynisReport struct {
	index                 string
	warnings, suggestions []finding
}

// parseLynis reads Lynis's report: key=value lines, warning[] and
// suggestion[] as ID|text|details|solution|.
func parseLynis(data string) lynisReport {
	r := lynisReport{index: "?"}
	sc := bufio.NewScanner(strings.NewReader(data))
	for sc.Scan() {
		key, value, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		f := strings.Split(value, "|")
		switch key {
		case "hardening_index":
			r.index = value
		case "warning[]", "suggestion[]":
			fd := finding{id: f[0]}
			if len(f) > 1 {
				fd.text = f[1]
			}
			// ID|text|details|solution|
			if len(f) > 2 && f[2] != "-" && f[2] != "" {
				fd.text += " (" + f[2] + ")"
			}
			if key == "warning[]" {
				r.warnings = append(r.warnings, fd)
			} else {
				r.suggestions = append(r.suggestions, fd)
			}
		}
	}
	return r
}

// readAccepted reads the accepted warnings: an ID, then its reason, a
// line each; # starts a comment.
func readAccepted(file string) (map[string]string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	accepted := map[string]string{}
	for i, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		id, reason, _ := strings.Cut(line, " ")
		if reason = strings.TrimSpace(reason); reason == "" {
			return nil, fmt.Errorf("%s:%d: %s is accepted with no reason", file, i+1, id)
		}
		accepted[id] = reason
	}
	return accepted, nil
}

// kubeBench runs kube-bench against the runner's k3s and puts its counts,
// and what failed, in the summary.
func (m *machine) kubeBench(ctx context.Context) {
	bin, err := m.tool(ctx, pinned.KubeBench)
	if err != nil {
		m.logf("kube-bench: %v", err)
		return
	}
	cfg := filepath.Join(filepath.Dir(bin), "cfg")
	out, err := m.cmd.run(ctx, cmd{argv: []string{"sudo", "env", "KUBECONFIG=/etc/rancher/k3s/k3s.yaml", "PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin",
		bin, "--config-dir", cfg, "--config", filepath.Join(cfg, "config.yaml"), "--benchmark", "k3s-cis-1.9", "--json"}})
	if err != nil && len(out) == 0 {
		m.logf("kube-bench: %v", err)
		fmt.Fprintf(m.summary, "### kube-bench did not run\n\n`%s`\n\n", oneLine(err.Error()))
		return
	}
	r, perr := parseKubeBench(out)
	if perr != nil {
		m.logf("kube-bench: %v", perr)
		return
	}
	var b strings.Builder
	fmt.Fprintf(&b, "### kube-bench %s, profile k3s-cis-1.9 (Kubernetes up to 1.29): a report\n\n", pinned.KubeBench.Version())
	fmt.Fprintf(&b, "| Pass | Fail | Warn | Info |\n|---|---|---|---|\n| %d | %d | %d | %d |\n\n", r.pass, r.fail, r.warn, r.info)
	if len(r.failed) > 0 {
		fmt.Fprintf(&b, "<details><summary>%d failed</summary>\n\n", len(r.failed))
		for _, f := range r.failed {
			fmt.Fprintf(&b, "- `%s` %s\n", f.id, f.text)
		}
		b.WriteString("\n</details>\n\n")
	}
	fmt.Fprint(m.summary, b.String())
	m.logf("kube-bench: %d pass, %d fail, %d warn", r.pass, r.fail, r.warn)
}

type benchReport struct {
	pass, fail, warn, info int
	failed                 []finding
}

// parseKubeBench reads kube-bench's --json output.
func parseKubeBench(out []byte) (benchReport, error) {
	var j struct {
		Controls []struct {
			Tests []struct {
				Results []struct {
					Number string `json:"test_number"`
					Desc   string `json:"test_desc"`
					Status string `json:"status"`
				} `json:"results"`
			} `json:"tests"`
		} `json:"Controls"`
		Totals struct {
			Pass int `json:"total_pass"`
			Fail int `json:"total_fail"`
			Warn int `json:"total_warn"`
			Info int `json:"total_info"`
		} `json:"Totals"`
	}
	if err := json.Unmarshal(out, &j); err != nil {
		return benchReport{}, err
	}
	r := benchReport{pass: j.Totals.Pass, fail: j.Totals.Fail, warn: j.Totals.Warn, info: j.Totals.Info}
	for _, c := range j.Controls {
		for _, t := range c.Tests {
			for _, res := range t.Results {
				if res.Status == "FAIL" {
					r.failed = append(r.failed, finding{res.Number, res.Desc})
				}
			}
		}
	}
	slices.SortFunc(r.failed, func(a, b finding) int { return strings.Compare(a.id, b.id) })
	return r, nil
}
