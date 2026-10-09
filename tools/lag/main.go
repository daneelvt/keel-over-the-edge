// SPDX-License-Identifier: AGPL-3.0-only

// Command lag is a TCP proxy that slows and loses traffic as a phone's
// network would, under TCP: each chunk arrives after half the round trip,
// and a lost one is held for TCP's probe timeout, with everything behind
// it, rather than lost (internal/client's Lag). Seeded, so a run
// repeats.
//
//	go run ./tools/lag -listen 127.0.0.1:18090 -to 127.0.0.1:8080 -lag 200ms,2%
//
// go run ./tools/dev -lag and go run ./tools/e2e -lag put it between Vite
// and keel serve themselves.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/daneelvt/keel-over-the-edge/internal/client"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:18090", "the address to listen on")
	to := flag.String("to", "127.0.0.1:8080", "the address to forward to")
	lagFlag := flag.String("lag", "200ms,2%", "the round trip, and the share of packets lost each way")
	seed := flag.Uint64("seed", 1, "the random numbers' seed")
	flag.Parse()
	lag, err := client.ParseLag(*lagFlag)
	if err != nil {
		fail(err)
	}
	lag.Seed = *seed
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fail(err)
	}
	fmt.Printf("lag: %s → %s at %s, seed %d\n", ln.Addr(), *to, lag, lag.Seed)
	if err := client.Proxy(ctx, ln, *to, lag); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "lag:", err)
	os.Exit(1)
}
