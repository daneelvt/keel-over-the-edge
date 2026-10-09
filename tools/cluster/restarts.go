// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// gameSelector picks keel's pods.
const gameSelector = "app.kubernetes.io/name=" + deployment

// The ways keel's pod can end, each one command: a deploy of a new build
// is -deploy's.

// restartGame restarts keel on the build it runs, as a deploy does with no
// new build: a rollout of the same template, the old pod stopped (its bell
// rung, its final checkpoint written) before the new one starts.
func (c *cluster) restartGame(ctx context.Context) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	start := time.Now()
	c.logf("restarting keel")
	if _, err := c.kubectl(ctx, nil, "-n", namespace, "rollout", "restart", "deployment/"+deployment); err != nil {
		return err
	}
	if err := c.waitKubectl(ctx, "keel", 5*time.Minute, "-n", namespace, "rollout", "status", "deployment/"+deployment); err != nil {
		return err
	}
	c.logf("keel is ready again, %.1f s after the restart", time.Since(start).Seconds())
	return nil
}

// killPod deletes keel's pod by force, as when its node is lost: the Pod
// object goes at once and its replacement starts while the old process
// may still be stopping. The simulation's lease keeps the replacement
// waiting, not ready, until the old one has gone.
func (c *cluster) killPod(ctx context.Context) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	out, err := c.kubectl(ctx, nil, "-n", namespace, "get", "pods", "-l", gameSelector, "-o", "jsonpath={.items[*].metadata.name}")
	if err != nil {
		return err
	}
	pods := strings.Fields(string(out))
	if len(pods) == 0 {
		return fmt.Errorf("no pod of keel's: go run ./tools/cluster -deploy")
	}
	start := time.Now()
	for _, pod := range pods {
		c.logf("deleting the pod %s by force", pod)
		if _, err := c.kubectl(ctx, nil, "-n", namespace, "delete", "pod", pod, "--grace-period=0", "--force", "--wait=false"); err != nil {
			return err
		}
	}
	if err := c.waitKubectl(ctx, "keel", 5*time.Minute, "-n", namespace, "rollout", "status", "deployment/"+deployment); err != nil {
		return err
	}
	c.logf("keel is ready again, %.1f s after the delete", time.Since(start).Seconds())
	return nil
}

// crash kills keel in its container with SIGKILL, as a crash does, with no
// time to stop at all: the kubelet starts the container again in the same
// pod, and keel restores the last of its periodic checkpoints.
func (c *cluster) crash(ctx context.Context) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	before, err := c.restarts(ctx)
	if err != nil {
		return err
	}
	start := time.Now()
	c.logf("killing keel with SIGKILL")
	if _, err := c.guest(ctx, nil, "sudo", "pkill", "-KILL", "-x", "keel"); err != nil {
		return err
	}
	for {
		n, err := c.restarts(ctx)
		if err == nil && n > before {
			break
		}
		if time.Since(start) > 2*time.Minute {
			return fmt.Errorf("keel's container was not restarted: %v", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	if err := c.waitKubectl(ctx, "keel", 5*time.Minute, "-n", namespace, "wait", "--for=condition=Ready", "pod", "-l", gameSelector); err != nil {
		return err
	}
	c.logf("keel is ready again, %.1f s after the kill", time.Since(start).Seconds())
	return nil
}

// restarts is how many times keel's container has been started again in
// its pod.
func (c *cluster) restarts(ctx context.Context) (int, error) {
	out, err := c.kubectl(ctx, nil, "-n", namespace, "get", "pods", "-l", gameSelector, "-o",
		`jsonpath={.items[0].status.containerStatuses[?(@.name=="keel")].restartCount}`)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(out)))
}
