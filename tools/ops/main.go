// SPDX-License-Identifier: AGPL-3.0-only

// Command ops reaches what production keeps to itself, from the owner's
// Mac: Grafana, VictoriaMetrics' and VictoriaLogs' own pages, the database
// and keel's internal listener, none of which has a route.
//
//	go run ./tools/ops -tunnel          forward a local port to each, over Tailscale SSH, until interrupted
//	go run ./tools/ops -tunnel -print   print the command it would run, and run nothing
//
// Each has a Service with a fixed address in the cluster (the manifests'
// forwards), which the machine dials for the forward: Tailscale SSH lets
// root forward to any address the machine reaches, and nothing listens for
// it on the machine itself. Tailscale asks for a fresh sign-in at most
// every 12 hours. The ports are on this Mac's loopback alone.
//
// It needs Tailscale's command line, signed in to the tailnet, and runs
// from the repository root.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/production"
)

// tailscaleApp is where Tailscale's app keeps its command line on a Mac
// that has no tailscale on its PATH.
const tailscaleApp = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

func main() {
	tunnel := flag.Bool("tunnel", false, "forward local ports to production's pages and database")
	print := flag.Bool("print", false, "with -tunnel: print the command, and run nothing")
	flag.Parse()
	if !*tunnel {
		flag.Usage()
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Stdout, *print); err != nil {
		fmt.Fprintln(os.Stderr, "ops:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, out io.Writer, printOnly bool) error {
	p, err := production.Read(production.File)
	if err != nil {
		return err
	}
	argv := tunnelArgs(p.Machine, manifests.Forwards)
	if printOnly {
		fmt.Fprintln(out, "tailscale "+strings.Join(argv, " "))
		return nil
	}
	bin, err := exec.LookPath("tailscale")
	if err != nil {
		if _, statErr := os.Stat(tailscaleApp); statErr != nil {
			return fmt.Errorf("no tailscale on the PATH, nor Tailscale's app: %w", err)
		}
		bin = tailscaleApp
	}
	fmt.Fprint(out, links(manifests.Forwards))
	fmt.Fprintf(out, "\nForwarding to %s until interrupted (Ctrl-C).\n", p.Machine)
	cmd := exec.CommandContext(ctx, bin, argv...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stderr, os.Stderr
	// An interrupt ends the forward, which is how it is meant to end.
	if err := cmd.Run(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("tailscale ssh: %w", err)
	}
	return nil
}

// tunnelArgs is tailscale's command line for the forwards: an SSH session
// to the machine as root that runs nothing (-N), and for each forward a
// port on this Mac's loopback carried to its Service's fixed address. The
// machine comes first: tailscale takes it as its own argument, refuses any
// flag before it, and hands what follows it to ssh.
func tunnelArgs(machine string, forwards []manifests.Forward) []string {
	argv := []string{"ssh", "root@" + machine, "-N"}
	for _, f := range forwards {
		argv = append(argv, "-L", "127.0.0.1:"+strconv.Itoa(f.Local)+":"+f.IP+":"+strconv.Itoa(f.Port))
	}
	return argv
}

// links says where each forward is, and how to use the two that are not
// web pages.
func links(forwards []manifests.Forward) string {
	var b strings.Builder
	for _, f := range forwards {
		switch f.Service {
		case "keel-db-forward":
			fmt.Fprintf(&b, "  %-22s %s\n", "localhost:"+strconv.Itoa(f.Local), f.What)
			// The certificate is checked against the cluster's CA, not the
			// name, which through a forward is localhost.
			fmt.Fprintf(&b, "  %-22s   psql \"host=localhost port=%d dbname=keel user=reader sslmode=verify-ca sslrootcert=keel-db-ca.crt\"\n", "", f.Local)
			fmt.Fprintf(&b, "  %-22s   (the CA and reader's password: docs/development.md, \"The database\")\n", "")
		case "keel-internal-forward":
			fmt.Fprintf(&b, "  %-22s %s\n", "localhost:"+strconv.Itoa(f.Local), f.What)
			fmt.Fprintf(&b, "  %-22s   go tool pprof http://localhost:%d/debug/pprof/profile\n", "", f.Local)
		default:
			fmt.Fprintf(&b, "  %-22s %s\n", "http://localhost:"+strconv.Itoa(f.Local), f.What)
		}
	}
	return b.String()
}
