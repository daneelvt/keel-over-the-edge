// SPDX-License-Identifier: AGPL-3.0-only

// Command dashboards keeps Grafana's dashboards, which the cluster's
// monitoring layer gives Grafana as ConfigMaps
// (infra/cluster/monitoring/dashboards):
//
//	go run ./tools/dashboards -pull    fetch each vendored dashboard at the commit index.yaml pins, check its SHA-256, point it at the cluster's data sources, and write it and the kustomization
//	go run ./tools/dashboards -check   check every dashboard: valid JSON, a UID of its own, data sources the cluster has; and the kustomization up to date
//
// index.yaml lists every dashboard, its folder in Grafana, and for a
// vendored one where it comes from: a repository, a commit and a path, and
// the SHA-256 of the file as published there. A vendored dashboard is
// fetched by its commit, never a branch, and only by the owner: nothing is
// fetched as the cluster deploys. A new vendored one is listed with no
// SHA-256, which -pull records; after that, -pull refuses a file that
// differs.
//
// It runs from the repository root. go test runs -check's checks.
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// dir is the dashboards' folder, from the repository's root.
const dir = "infra/cluster/monitoring/dashboards"

func main() {
	pull := flag.Bool("pull", false, "fetch the vendored dashboards and write the kustomization")
	check := flag.Bool("check", false, "check every dashboard and the kustomization")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var err error
	switch {
	case *pull:
		err = pullAll(ctx, dir, "https://raw.githubusercontent.com", &http.Client{Timeout: time.Minute}, os.Stdout)
	case *check:
		if err = checkAll(dir); err == nil {
			fmt.Println("dashboards: every dashboard is valid, each with a UID of its own and the cluster's data sources; the kustomization is up to date")
		}
	default:
		flag.Usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "dashboards:", err)
		os.Exit(1)
	}
}
