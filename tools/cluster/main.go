// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

// Command cluster runs the game as it will run for good, in a k3s cluster
// on this Mac: in a Lima virtual machine with Ubuntu, behind Traefik, in
// front of a CloudNativePG database, from one image holding keel and its
// page. Phones on the same network play it at https://<this Mac>.local.
//
//	go run ./tools/cluster -up       make or start the VM, install k3s, apply the cluster's manifests, deploy the game
//	go run ./tools/cluster -deploy   build the image, import it into the cluster, apply the game's manifests
//	go run ./tools/cluster -release <build>  take a published release through Flux, as production does; prod for the one production follows
//	go run ./tools/cluster -restart  restart keel on the build it runs, as a deploy does
//	go run ./tools/cluster -kill     delete keel's pod by force, as when its node is lost
//	go run ./tools/cluster -crash    kill keel with SIGKILL in its container, as a crash does
//	go run ./tools/cluster -smoke    check the game in the cluster over HTTPS: the page, a guest, the game connection, probes, the database's TLS
//	go run ./tools/cluster -status   the VM, the node, the pods, the build running, the addresses
//	go run ./tools/cluster -logs     follow keel's logs
//	go run ./tools/cluster -phone    serve the page that sets up a phone, and print the game's address
//	go run ./tools/cluster -schemas  write infra/schemas, the schemas of the custom resources the manifests use, from the cluster's own
//	go run ./tools/cluster -stop     stop the VM; -up starts it again
//	go run ./tools/cluster -delete   delete the VM and the cluster's local state (asks first)
//
// It needs Lima (brew install lima), Docker and kubectl, and runs from the
// repository root. Its kubeconfig is .dev/cluster/kubeconfig, context
// keel-local: it never reads or changes ~/.kube/config. KEEL_DEV_SAILORS,
// if set, is passed to keel serve.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
)

func main() {
	up := flag.Bool("up", false, "make or start the VM and the cluster, and deploy the game")
	deployFlag := flag.Bool("deploy", false, "build the game's image and deploy it to the cluster")
	releaseFlag := flag.String("release", "", "the `build` of a published release to take through Flux, or prod")
	schemasFlag := flag.Bool("schemas", false, "write infra/schemas from the cluster's custom resource definitions")
	restart := flag.Bool("restart", false, "restart keel on the build it runs")
	kill := flag.Bool("kill", false, "delete keel's pod by force")
	crashFlag := flag.Bool("crash", false, "kill keel with SIGKILL")
	smokeFlag := flag.Bool("smoke", false, "check the game in the cluster")
	status := flag.Bool("status", false, "show the VM, the cluster and the build running")
	logs := flag.Bool("logs", false, "follow keel's logs")
	phone := flag.Bool("phone", false, "serve the phone setup page until interrupted")
	stop := flag.Bool("stop", false, "stop the VM")
	del := flag.Bool("delete", false, "delete the VM and the cluster's local state")
	flag.Parse()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	c := newCluster(execCommands{}, os.Stdout)

	var err error
	switch {
	case *up:
		err = c.up(ctx)
	case *deployFlag:
		err = c.deployGame(ctx)
	case *releaseFlag != "":
		err = c.release(ctx, *releaseFlag)
	case *schemasFlag:
		err = c.schemas(ctx)
	case *restart:
		err = c.restartGame(ctx)
	case *kill:
		err = c.killPod(ctx)
	case *crashFlag:
		err = c.crash(ctx)
	case *smokeFlag:
		err = c.smoke(ctx)
	case *status:
		err = c.status(ctx)
	case *logs:
		err = c.logs(ctx)
	case *phone:
		err = c.phone(ctx)
	case *stop:
		err = c.stopVM(ctx)
	case *del:
		err = c.deleteVM(ctx, os.Stdin)
	default:
		flag.Usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "cluster:", err)
		os.Exit(1)
	}
}

// commands runs the programs tools/cluster drives: limactl, kubectl,
// docker, git. Tests replace it.
type commands interface {
	// run runs argv with stdin, if not nil, and returns what it wrote to
	// its standard output. With out, its output goes there instead as it
	// runs. A failure's error holds its standard error.
	run(ctx context.Context, c cmd) ([]byte, error)
	lookPath(name string) (string, error)
}

type cmd struct {
	argv  []string
	stdin io.Reader
	out   io.Writer
}

type execCommands struct{}

func (execCommands) lookPath(name string) (string, error) { return exec.LookPath(name) }

func (execCommands) run(ctx context.Context, c cmd) ([]byte, error) {
	x := exec.CommandContext(ctx, c.argv[0], c.argv[1:]...)
	x.Stdin = c.stdin
	var stdout, stderr strings.Builder
	if c.out != nil {
		x.Stdout, x.Stderr = c.out, c.out
	} else {
		x.Stdout, x.Stderr = &stdout, &stderr
	}
	if err := x.Run(); err != nil {
		name := strings.Join(c.argv[:min(len(c.argv), 3)], " ")
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return []byte(stdout.String()), fmt.Errorf("%s: %w: %s", name, err, msg)
		}
		return []byte(stdout.String()), fmt.Errorf("%s: %w", name, err)
	}
	return []byte(stdout.String()), nil
}

// confirm asks a yes-or-no question; only yes is yes.
func confirm(in io.Reader, out io.Writer, question string) bool {
	fmt.Fprintf(out, "%s [y/N] ", question)
	line, _ := bufio.NewReader(in).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	}
	return false
}
