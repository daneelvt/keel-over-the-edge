// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

// Command dev runs the game locally with one command, over HTTPS so a phone
// on the same network gets a secure context:
//
//	go run ./tools/dev          start keel serve and Vite; restart keel on Go changes, rebuild the physics module
//	go run ./tools/dev -lag 200ms,2%   the same, with the game's traffic slowed and lost as a phone's network would (tools/lag)
//	go run ./tools/dev -limit 2        the same, with at most 2 boats at sea: a third player waits in the queue
//	go run ./tools/dev -smoke   start everything, check the page, /api/version, the physics module, a guest, the game connection, a second player seeing the first's boat, and keel's probes and metrics, stop
//	go run ./tools/dev -lint    run every linter the pull-request checks run
//	go run ./tools/dev -db      start the database alone, print its URLs
//	go run ./tools/dev -db-reset  remove the database's container and data
//
// The database is PostgreSQL in a container (docker, or else podman), left
// running between runs; KEEL_DEV_DATABASE_URL instead names a PostgreSQL 18
// of your own, and no container is started. KEEL_DEV_SAILORS, if set, is
// passed to keel serve: scripted sailors to load the tick. keel runs with
// KEEL_DEV_COMMANDS=1, so POST /debug/wind on its internal listener changes
// the wind. It runs from the repository root.
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
	// lagAddr is the lag proxy's, between Vite and keel, with -lag.
	lagAddr   = "127.0.0.1:8070"
	traceDir  = ".dev/traces"
	replayDir = ".dev/replays"
	// replayKeep is how long input logs are kept in replayDir.
	replayKeep = time.Hour
	stateDir   = ".dev"
	clientDir  = "client"
	physicsDir = "internal/physics"
)

func main() {
	smoke := flag.Bool("smoke", false, "start everything, check the page and /api/version over HTTPS, then stop")
	lint := flag.Bool("lint", false, "run the linters and exit")
	dbOnly := flag.Bool("db", false, "start the database alone, print its URLs and exit")
	dbReset := flag.Bool("db-reset", false, "remove the database's container, its data and its password")
	lagFlag := flag.String("lag", "", "a round trip and loss such as 200ms,2%: the game's traffic through tools/lag")
	limit := flag.Int("limit", 0, "the most boats at sea (KEEL_BOAT_LIMIT), from 1 to 4096; keel's default if 0")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch {
	case *lint:
		err = runLint(ctx, os.Stdout)
	case *dbOnly:
		err = runDB(ctx, os.Stdout)
	case *dbReset:
		err = runDBReset(ctx, os.Stdout)
	case *smoke:
		err = runSmoke(ctx, os.Stdout)
	default:
		err = runDev(ctx, os.Stdout, *lagFlag, *limit)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "dev:", err)
		os.Exit(1)
	}
}
