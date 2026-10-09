// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"context"
	"fmt"
	"net"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/devcert"
)

// phonePort is where -phone serves the phone setup page: beside tools/dev's
// 5174, so both can run.
const phonePort = 5175

// status shows the VM, the node, every pod, the build the game runs and
// where to reach it.
func (c *cluster) status(ctx context.Context) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	status, err := c.vmStatus(ctx)
	if err != nil {
		return err
	}
	if status == "" {
		status = "not made: go run ./tools/cluster -up"
	}
	fmt.Fprintf(c.out, "VM %s: %s\n", vmName, status)
	if status != "Running" {
		return nil
	}
	for _, args := range [][]string{{"get", "nodes", "-o", "wide"}, {"get", "pods", "-A"}} {
		out, err := c.kubectl(ctx, nil, args...)
		if err != nil {
			return err
		}
		fmt.Fprintf(c.out, "\n%s", out)
	}
	host, err := c.localHost(ctx)
	if err != nil {
		return err
	}
	build, err := c.runningBuild(ctx)
	if err != nil {
		fmt.Fprintf(c.out, "\nThe game is not deployed: go run ./tools/cluster -deploy\n")
		return nil
	}
	fmt.Fprintf(c.out, "\nkeel %s\n  the game        https://%s\n", build, host)
	for _, ip := range devcert.LANAddresses() {
		fmt.Fprintf(c.out, "                  https://%s\n", ip)
	}
	fmt.Fprintf(c.out, "  kubectl         kubectl --kubeconfig %s ...\n", c.kubeconfig)
	fmt.Fprintf(c.out, "  probes, metrics kubectl --kubeconfig %s -n %s port-forward deployment/%s 9090:internal\n", c.kubeconfig, namespace, deployment)
	return nil
}

// logs follows keel's logs, its init container's too, until interrupted.
func (c *cluster) logs(ctx context.Context) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	return c.stream(ctx, "kubectl", "--kubeconfig", c.kubeconfig, "--context", vmName,
		"-n", namespace, "logs", "--follow", "--all-containers", "--prefix", "deployment/"+deployment)
}

// phone serves the page that walks a phone through trusting the local
// root, and prints its address and the game's, until interrupted.
func (c *cluster) phone(ctx context.Context) error {
	host, err := c.localHost(ctx)
	if err != nil {
		return err
	}
	root, err := devcert.Root(ctx)
	if err != nil {
		return err
	}
	game := "https://" + host
	srv, err := devcert.ServePhoneSetup(root, phonePort, devcert.Phone{Game: game, Command: "go run ./tools/cluster -phone"})
	if err != nil {
		return err
	}
	defer srv.Close()
	setup := "http://" + net.JoinHostPort(host, strconv.Itoa(phonePort)) + "/"
	if lan := devcert.LANAddresses(); len(lan) > 0 {
		setup = "http://" + net.JoinHostPort(lan[0].String(), strconv.Itoa(phonePort)) + "/"
	}
	devcert.PrintAddresses(c.out, setup, game)
	c.logf("serving the phone setup page; Ctrl-C stops it")
	<-ctx.Done()
	return nil
}
