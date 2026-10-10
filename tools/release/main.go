// SPDX-License-Identifier: AGPL-3.0-only

// Command release is what the release and promote workflows run, and what
// renders a release's manifests by hand:
//
//	go run ./tools/release -tools                        fetch cosign and the Flux CLI, pinned by digest, into .dev/bin
//	go run ./tools/release -render <dir> -image <image>  render every cluster's manifests with the game's image by digest, check them, write them under dir
//	go run ./tools/release -released <build>             say whether the build is released: its manifests published and signed
//	go run ./tools/release -promote <build> [-rollback]  make the build the release production follows
//
// A build is the first 12 characters of its commit. A release is the
// cluster's manifests, rendered with the image built from that commit, as
// an OCI artifact in the registry, signed by the release workflow.
// Production follows the tag prod, which -promote moves, and only to a
// release whose signature it has checked.
//
// It runs from the repository root. -released and -promote read the
// registry as GITHUB_ACTOR with GITHUB_TOKEN, if set, and GitHub's API
// with GITHUB_TOKEN; without them, as anyone may.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

// The folders the tool works in, from the repository's root.
const (
	stateDir   = ".dev"
	clusterDir = "infra/cluster"
	schemasDir = "infra/schemas"
	// schemaCache keeps the schemas of Kubernetes' own kinds once
	// downloaded.
	schemaCache = ".dev/schemas"
)

func main() {
	tools := flag.Bool("tools", false, "fetch cosign and the Flux CLI into .dev/bin")
	renderDir := flag.String("render", "", "render every cluster's manifests into `dir`, which must be empty or not there")
	image := flag.String("image", "", "the game's `image` to render with, ghcr.io/daneelvt/keel@sha256:<digest>")
	releasedBuild := flag.String("released", "", "say whether `build` is released, as released=true or released=false")
	promoteBuild := flag.String("promote", "", "make `build` the release production follows")
	rollback := flag.Bool("rollback", false, "with -promote: allow a build older than the one production follows")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch {
	case *tools:
		var dir string
		if dir, err = pinned.Install(ctx, stateDir, os.Stderr, pinned.Cosign, pinned.Flux); err == nil {
			fmt.Printf("release: cosign %s and flux %s are in %s\n", pinned.Cosign.Version(), pinned.Flux.Version(), dir)
		}
	case *renderDir != "":
		err = render(ctx, os.Stdout, *renderDir, *image)
	case *releasedBuild != "":
		var p *promoter
		if p, err = newPromoter(os.Stderr); err == nil {
			var done bool
			if done, err = p.released(ctx, *releasedBuild); err == nil {
				// Alone on standard output, as a workflow's step output.
				fmt.Printf("released=%t\n", done)
			}
		}
	case *promoteBuild != "":
		var p *promoter
		if p, err = newPromoter(os.Stdout); err == nil {
			err = p.promote(ctx, *promoteBuild, *rollback)
		}
	default:
		flag.Usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}
