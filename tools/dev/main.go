// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

// Command dev runs the game locally with one command, over HTTPS so a phone
// on the same network gets a secure context:
//
//	go run ./tools/dev          start keel serve and Vite; restart keel on Go changes, rebuild the physics module
//	go run ./tools/dev -smoke   start everything, check the page, /api/version, the physics module and keel's probes and metrics, stop
//	go run ./tools/dev -lint    run every linter the pull-request checks run
//
// KEEL_DEV_SAILORS, if set, is passed to keel serve: scripted sailors to load
// the tick. It runs from the repository root.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const (
	vitePort   = 5173 // the address players use
	caPort     = 5174 // plain HTTP: the local root certificate, for phones
	playAddr   = "127.0.0.1:8080"
	agentsAddr = "127.0.0.1:8081"
	// internalAddr is keel's probes, metrics, profiles and input log, on
	// loopback only.
	internalAddr = "127.0.0.1:9090"
	traceDir     = ".dev/traces"
	replayDir    = ".dev/replays"
	// replayKeep is how long input logs are kept in replayDir.
	replayKeep = time.Hour
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
