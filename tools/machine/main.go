// SPDX-License-Identifier: AGPL-3.0-only

// Command machine configures production's machine from the machine
// workflow, with Ansible over Tailscale SSH, and tests the same playbook on
// a workflow's own runner.
//
//	go run ./tools/machine -ansible [-lint]      make Ansible's venv in .dev/ansible, from hashed requirements
//	go run ./tools/machine -join                 join the tailnet as a short-lived tag:ci-prod node; write the machine's host keys
//	go run ./tools/machine -leave                log that node out, and stop it
//	go run ./tools/machine -run check|apply [-reboot] [-local] [-unchanged]
//	                                             run the playbook: check reports what apply would change; apply changes it
//	go run ./tools/machine -verify [-local]      check the machine is as the playbook leaves it, changing nothing
//	go run ./tools/machine -audit [-local]       audit the machine with Lynis, changing nothing; on the runner, kube-bench too
//	go run ./tools/machine -pin <version>        pin Tailscale's static client, for the runners, at version
//
// -run reads the cluster's credential for Infisical from Infisical, as the
// identity infra/production.yaml names, with the job's OIDC token, and
// hands it to the playbook in its environment alone. It pulls the release
// production follows and checks its signature before the playbook
// bootstraps Flux from it. -local runs on the runner itself, as root,
// with a made-up credential: what a pull request checks. -unchanged fails
// the run if anything changed: the second run of the same playbook.
//
// It runs from the repository root, on Linux, with sudo.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

func main() {
	ansible := flag.Bool("ansible", false, "make Ansible's venv in .dev/ansible")
	lint := flag.Bool("lint", false, "with -ansible: ansible-lint too")
	join := flag.Bool("join", false, "join the tailnet as a short-lived CI node")
	leave := flag.Bool("leave", false, "log the CI node out and stop it")
	run := flag.String("run", "", "run the playbook, in `mode` check or apply")
	reboot := flag.Bool("reboot", false, "with -run apply: reboot the machine if a change needs it")
	local := flag.Bool("local", false, "with -run, -verify or -audit: on this runner itself, as root")
	unchanged := flag.Bool("unchanged", false, "with -run: fail if anything changed")
	verify := flag.Bool("verify", false, "check the machine is as the playbook leaves it")
	audit := flag.Bool("audit", false, "audit the machine with Lynis")
	pin := flag.String("pin", "", "pin Tailscale's static client at `version`")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch {
	case *pin != "":
		err = pinned.RepinTailscale(ctx, pinned.File, *pin, os.Stdout)
	case *ansible, *join, *leave, *run != "", *verify, *audit:
		var m *machine
		if m, err = newMachine(); err != nil {
			break
		}
		defer m.summary.Close()
		switch {
		case *ansible:
			err = m.ansible(ctx, *lint)
		case *join:
			err = m.join(ctx)
		case *leave:
			err = m.leave(ctx)
		case *run != "":
			err = m.run(ctx, runOptions{mode: *run, reboot: *reboot, local: *local, unchanged: *unchanged})
		case *verify:
			err = m.verify(ctx, *local)
		case *audit:
			err = m.audit(ctx, *local)
		}
	default:
		flag.Usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "machine:", err)
		os.Exit(1)
	}
}
