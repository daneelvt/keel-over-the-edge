// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

type runOptions struct {
	// mode is check (report what would change) or apply.
	mode string
	// reboot lets apply reboot the machine when a change needs it.
	reboot bool
	// local runs on this runner, as root, with a made-up credential.
	local bool
	// unchanged fails the run if anything changed.
	unchanged bool
}

// run runs the playbook against the machine, over Tailscale SSH, or on
// the runner itself.
func (m *machine) run(ctx context.Context, o runOptions) error {
	if o.mode != "check" && o.mode != "apply" {
		return fmt.Errorf("the mode is check or apply, not %q", o.mode)
	}
	if o.reboot && (o.mode != "apply" || o.local) {
		return errors.New("only apply on the machine reboots it")
	}
	flux, err := m.release(ctx)
	if err != nil {
		return err
	}
	var creds map[string]string
	if o.local {
		creds, err = madeUpCredential()
	} else {
		creds, err = m.infisical(ctx)
	}
	if err != nil {
		return err
	}

	// A folder of its own each run: on the runner, root writes in it.
	junit, err := os.MkdirTemp(m.path(stateDir), "junit-"+o.mode+"-")
	if err != nil {
		return err
	}
	env := []string{"JUNIT_OUTPUT_DIR=" + junit}
	for _, name := range secrets {
		env = append(env, name+"="+creds[name])
	}
	args := []string{"--extra-vars", "machine_flux_manifests=" + flux,
		"--extra-vars", `{"machine_reboot": ` + strconv.FormatBool(o.reboot) + `}`}
	if o.mode == "check" {
		args = append(args, "--check", "--diff")
	}
	c, err := m.playbook("site.yaml", o.local, env, args...)
	if err != nil {
		return err
	}

	where := m.prod.Machine
	if o.local {
		where = "this runner"
	}
	m.logf("running the playbook on %s: %s", where, o.mode)
	var log bytes.Buffer
	start := time.Now()
	c.out = &tee{m.out, &log}
	_, runErr := m.cmd.run(ctx, c)
	took := time.Since(start).Round(time.Second)

	r := parseRun(log.String())
	times, _ := roleTimes(junit)
	m.report(o, where, r, times, took, runErr)
	if runErr != nil {
		return runErr
	}
	if r.recap == nil {
		return errors.New("the playbook printed no recap")
	}
	if o.unchanged && r.recap["changed"] != 0 {
		return fmt.Errorf("the run changed %d things, and should have changed none: %s", r.recap["changed"], strings.Join(r.changed, "; "))
	}
	return nil
}

// playbook is the command that runs a playbook of infra/ansible: on the
// machine, over Tailscale SSH at the address -join wrote, its host key
// checked against the one the tailnet holds; or on this runner, as root.
// On the runner, env goes on sudo's command line, which shows only what a
// runner may see.
func (m *machine) playbook(file string, local bool, env []string, args ...string) (cmd, error) {
	env = append([]string{"ANSIBLE_CONFIG=" + m.path(ansibleDir, "ansible.cfg"), "ANSIBLE_NOCOLOR=1", "ANSIBLE_FORCE_COLOR=0"}, env...)
	argv := append([]string{m.path(venvDir, "bin", "ansible-playbook"), file}, args...)
	if local {
		argv = append(argv, "--inventory", "inventory/runner.yaml")
		return cmd{argv: append(append([]string{"sudo", "env"}, env...), argv...), dir: m.path(ansibleDir)}, nil
	}
	host, err := os.ReadFile(m.hostFile())
	if err != nil {
		return cmd{}, fmt.Errorf("no address for the machine: run -join first (%w)", err)
	}
	argv = append(argv, "--inventory", "inventory/production.yaml",
		"--extra-vars", "ansible_host="+strings.TrimSpace(string(host)),
		"--ssh-common-args", "-o UserKnownHostsFile="+m.knownHosts()+" -o StrictHostKeyChecking=yes -o ControlPath="+m.path(stateDir, "ssh-%C"))
	return cmd{argv: argv, env: env, dir: m.path(ansibleDir)}, nil
}

// verify runs verify.yaml, which checks the machine, or this runner, is as
// the playbook leaves it, and changes nothing.
func (m *machine) verify(ctx context.Context, local bool) error {
	c, err := m.playbook("verify.yaml", local, nil)
	if err != nil {
		return err
	}
	var log bytes.Buffer
	c.out = &tee{m.out, &log}
	start := time.Now()
	_, err = m.cmd.run(ctx, c)
	where := m.prod.Machine
	if local {
		where = "this runner"
	}
	r := parseRun(log.String())
	fmt.Fprintf(m.summary, "### Verified %s in %s: %s\n\n", where, time.Since(start).Round(time.Second), map[bool]string{true: "as the playbook leaves it", false: "**it is not**"}[err == nil])
	if r.recap != nil {
		fmt.Fprintf(m.summary, "%d checks passed, %d failed.\n\n", r.recap["ok"], r.recap["failed"])
	}
	if listening := listeningReport(log.String()); listening != "" {
		fmt.Fprintf(m.summary, "<details><summary>What listens</summary>\n\n```\n%s\n```\n\n</details>\n\n", listening)
	}
	return err
}

// listeningReport is what verify.yaml reported listening, one socket a
// line.
func listeningReport(out string) string {
	i := strings.Index(out, "TASK [Report it]")
	if i < 0 {
		return ""
	}
	var lines []string
	for _, l := range strings.Split(out[i:], "\n")[1:] {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "TASK [") || strings.HasPrefix(l, "PLAY RECAP") {
			break
		}
		if strings.HasPrefix(l, `"`) {
			lines = append(lines, strings.Join(strings.Fields(strings.Trim(strings.TrimSuffix(l, ","), `"`)), " "))
		}
	}
	return strings.Join(lines, "\n")
}

// madeUpCredential stands in for External Secrets' credential on a
// runner, which has no access to Infisical. It is the same every run, so a
// second run finds nothing to change.
func madeUpCredential() (map[string]string, error) {
	return map[string]string{"ESO_CLIENT_ID": "made-up-for-a-test", "ESO_CLIENT_SECRET": "made-up-for-a-test-too"}, nil
}

type tee struct {
	a, b interface{ Write([]byte) (int, error) }
}

func (t *tee) Write(p []byte) (int, error) {
	t.b.Write(p)
	return t.a.Write(p)
}

// playRun is what a playbook's output says.
type playRun struct {
	// recap is the play recap's counts for the host: ok, changed,
	// unreachable, failed, skipped, rescued, ignored.
	recap map[string]int
	// changed are the tasks that changed something, as role : task.
	changed []string
	// reboot is why a reboot is due, if it is.
	reboot string
}

var (
	taskLine   = regexp.MustCompile(`^(?:TASK|RUNNING HANDLER) \[(.+)\] \**$`)
	recapLine  = regexp.MustCompile(`^\S+\s+:\s+((?:\w+=\d+\s*)+)$`)
	rebootLine = regexp.MustCompile(`"msg": "(A reboot is due: [^"]*)"`)
)

// parseRun reads Ansible's default output.
func parseRun(out string) playRun {
	var r playRun
	task := ""
	inRecap := false
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if m := taskLine.FindStringSubmatch(line); m != nil {
			task = m[1]
			continue
		}
		if strings.HasPrefix(line, "changed: [") && !slices.Contains(r.changed, task) {
			r.changed = append(r.changed, task)
		}
		if m := rebootLine.FindStringSubmatch(line); m != nil {
			r.reboot = m[1]
		}
		if strings.HasPrefix(line, "PLAY RECAP") {
			inRecap = true
			continue
		}
		if m := recapLine.FindStringSubmatch(line); inRecap && m != nil {
			r.recap = map[string]int{}
			for _, kv := range strings.Fields(m[1]) {
				k, v, _ := strings.Cut(kv, "=")
				n, _ := strconv.Atoi(v)
				r.recap[k] = n
			}
		}
	}
	return r
}

// roleTimes sums the time each role's tasks took, from the JUnit report
// Ansible's junit callback writes: each task a test case, its class name
// the file the task is in, under roles/<role>/ for a role's.
func roleTimes(dir string) (map[string]time.Duration, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.xml"))
	if err != nil || len(files) == 0 {
		return nil, err
	}
	times := map[string]time.Duration{}
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		var suites struct {
			Suites []struct {
				Cases []struct {
					Class string  `xml:"classname,attr"`
					Time  float64 `xml:"time,attr"`
				} `xml:"testcase"`
			} `xml:"testsuite"`
		}
		if err := xml.Unmarshal(data, &suites); err != nil {
			return nil, err
		}
		for _, s := range suites.Suites {
			for _, c := range s.Cases {
				role := "(the playbook)"
				if m := roleFile.FindStringSubmatch(filepath.ToSlash(c.Class)); m != nil {
					role = m[1]
				}
				times[role] += time.Duration(c.Time * float64(time.Second))
			}
		}
	}
	return times, nil
}

var roleFile = regexp.MustCompile(`/roles/([^/]+)/`)

// report writes the run to the workflow's summary.
func (m *machine) report(o runOptions, where string, r playRun, times map[string]time.Duration, took time.Duration, runErr error) {
	var b strings.Builder
	verb := map[string]string{"check": "Checked", "apply": "Applied"}[o.mode]
	fmt.Fprintf(&b, "### %s the playbook on %s in %s\n\n", verb, where, took)
	if runErr != nil {
		fmt.Fprintf(&b, "**It failed**: `%s`\n\n", oneLine(runErr.Error()))
	}
	if r.recap != nil {
		b.WriteString("| ok | changed | unreachable | failed | skipped |\n|---|---|---|---|---|\n")
		fmt.Fprintf(&b, "| %d | %d | %d | %d | %d |\n\n", r.recap["ok"], r.recap["changed"], r.recap["unreachable"], r.recap["failed"], r.recap["skipped"])
	}
	if len(r.changed) > 0 {
		word := "Changed"
		if o.mode == "check" {
			word = "Would change"
		}
		fmt.Fprintf(&b, "<details><summary>%s %d tasks</summary>\n\n", word, len(r.changed))
		for _, t := range r.changed {
			fmt.Fprintf(&b, "- %s\n", t)
		}
		b.WriteString("\n</details>\n\n")
	}
	if len(times) > 0 {
		b.WriteString("| Role | Time |\n|---|---|\n")
		roles := slices.SortedFunc(func(yield func(string) bool) {
			for k := range times {
				if !yield(k) {
					return
				}
			}
		}, func(a, b string) int { return int(times[b] - times[a]) })
		for _, role := range roles {
			fmt.Fprintf(&b, "| %s | %s |\n", role, times[role].Round(100*time.Millisecond))
		}
		b.WriteString("\n")
	}
	if r.reboot != "" {
		fmt.Fprintf(&b, "**%s**\n\n", r.reboot)
	}
	fmt.Fprint(m.summary, b.String())
}

func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}
