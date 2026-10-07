// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

// Command dev runs the game locally with one command, over HTTPS so a phone
// on the same network gets a secure context:
//
//	go run ./tools/dev          start keel serve and Vite; restart keel on Go changes, rebuild the physics module
//	go run ./tools/dev -smoke   start everything, check the page, /api/version and the physics module, stop
//	go run ./tools/dev -lint    run every linter the pull-request checks run
//
// It runs from the repository root.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

const (
	vitePort   = 5173 // the address players use
	caPort     = 5174 // plain HTTP: the local root certificate, for phones
	playAddr   = "127.0.0.1:8080"
	stateDir   = ".dev"
	clientDir  = "client"
	physicsDir = "internal/physics"
)

func main() {
	smoke := flag.Bool("smoke", false, "start everything, check the page and /api/version over HTTPS, then stop")
	lint := flag.Bool("lint", false, "run the linters and exit")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch {
	case *lint:
		err = runLint(ctx, os.Stdout)
	case *smoke:
		err = runSmoke(ctx, os.Stdout)
	default:
		err = runDev(ctx, os.Stdout)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "dev:", err)
		os.Exit(1)
	}
}
