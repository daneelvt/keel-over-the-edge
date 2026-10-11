// SPDX-License-Identifier: AGPL-3.0-only

// Command vendored keeps the files others publish that the repository holds
// exactly as published (infra/vendor.yaml): release manifests with no
// signature, which Flux cannot verify as a source.
//
//	go run ./tools/vendored -pull    fetch each file from its release, check it, and write it
//	go run ./tools/vendored -check   check each file in the repository is the one pinned
//
// -pull checks a file against its release's checksums, where the list
// names them and they list it, and against the SHA-256 the list pins; a
// file listed with no SHA-256 has it recorded. Only the owner runs it:
// nothing is fetched as the cluster deploys. -check reads nothing but the
// repository; go test runs it.
//
// It runs from the repository root.
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

// listFile is the list of vendored files, from the repository's root.
const listFile = "infra/vendor.yaml"

func main() {
	pull := flag.Bool("pull", false, "fetch each vendored file and check it")
	check := flag.Bool("check", false, "check each vendored file is the one pinned")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var err error
	switch {
	case *pull:
		err = pullAll(ctx, listFile, &http.Client{Timeout: time.Minute}, os.Stdout)
	case *check:
		if err = checkAll(listFile); err == nil {
			fmt.Println("vendored: every vendored file is the one pinned")
		}
	default:
		flag.Usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "vendored:", err)
		os.Exit(1)
	}
}
