// SPDX-License-Identifier: AGPL-3.0-only

// Command accounts runs OpenTofu on infra/tofu for the accounts workflow:
// the zone keelovertheedge.com at Cloudflare, the tunnel, and the secrets
// they make, written into Infisical for the cluster.
//
//	go run ./tools/accounts -run plan    plan, and keep the plan, encrypted, for the apply job of the same run
//	go run ./tools/accounts -run apply   apply the plan the plan job of this run kept, and nothing else
//	go run ./tools/accounts -check       fmt, init without the backend, validate, and the lock file's platforms
//	go run ./tools/accounts -lock        write .terraform.lock.hcl for every platform that runs OpenTofu
//
// -run signs in to Infisical as the identity infra/production.yaml names,
// with the job's OIDC token, reads the workflow's credentials, masks each,
// and hands them to tofu in its environment alone, with a second OIDC
// token for Infisical's provider. Everything tofu prints is kept from the
// log: a run shows each resource's address, its action and the names of
// the attributes that change, never a value; an error is shown with every
// IP address in it replaced.
//
// It runs from the repository root. OpenTofu is the pinned one, under
// .dev; its working folder is .dev/accounts.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	run := flag.String("run", "", "plan, or apply the plan this run's plan job kept, in `mode` plan or apply")
	check := flag.Bool("check", false, "check infra/tofu without credentials: fmt, validate, the lock file")
	lock := flag.Bool("lock", false, "write infra/tofu/.terraform.lock.hcl for every platform")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	a, err := newAccounts()
	if err == nil {
		defer a.summary.Close()
		switch {
		case *run != "":
			err = a.run(ctx, *run)
		case *check:
			err = a.check(ctx)
		case *lock:
			err = a.lock(ctx)
		default:
			flag.Usage()
			os.Exit(2)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "accounts:", err)
		os.Exit(1)
	}
}
