// SPDX-License-Identifier: AGPL-3.0-only

// Command keel is the game server. It is one binary with subcommands:
//
//	keel serve    run the game
//	keel migrate  bring the database's schema up to this build's
//	keel replay   replay an input log and check it
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
)

const usage = `usage: keel <command> [flags]

commands:
  serve    run the game
  migrate  bring the database's schema up to this build's
  replay   replay an input log and check it
`

func main() {
	ctx, stop := signalContext()
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

// signalContext ends at the first SIGTERM or interrupt, which stops the
// server in order; a second, handled as Go does by default, kills it. The
// signals stop being relayed before the context ends, so by the time the
// server begins to stop, a second one is sure to kill it.
func signalContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGTERM, os.Interrupt)
	go func() {
		select {
		case <-ch:
		case <-ctx.Done():
		}
		signal.Stop(ch)
		cancel()
	}()
	return ctx, cancel
}

// run is main without the process: it returns the exit status.
func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	var err error
	switch args[0] {
	case "serve":
		err = serve(ctx, args[1:], getenv, stdout, stderr)
	case "migrate":
		err = migrate(ctx, args[1:], getenv, stdout, stderr)
	case "replay":
		err = replayCmd(args[1:], stdout, stderr)
	case "help", "-h", "-help", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "keel: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
	if errors.Is(err, errUsage) {
		return 2
	}
	if errors.Is(err, errDiverged) {
		return 1
	}
	if err != nil {
		fmt.Fprintln(stderr, "keel:", err)
		return 1
	}
	return 0
}

var errUsage = errors.New("usage")
