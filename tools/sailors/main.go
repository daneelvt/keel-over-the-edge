// SPDX-License-Identifier: AGPL-3.0-only

// Command sailors builds the sailors' models with Blender, by script: each
// look under art/sailors/looks is made by the Python build in
// art/sailors/build on MPFB's human, which is CC0, and written beside it as
// glTF binaries, one a level and version.
//
//	go run ./tools/sailors              build every look
//	go run ./tools/sailors -look test   build one look
//	go run ./tools/sailors -setup       check Blender, install MPFB and gltfpack, build nothing
//	go run ./tools/sailors -vendor UAL1.glb -into quaternius -pack "..." -clips Idle_Loop,...
//	                                    copy clips out of an animation library into vendor/
//
// Blender 5.2 LTS must be installed: in /Applications, on the PATH, or named
// by BLENDER. The first run installs the pinned MPFB into .dev/blender, a
// Blender profile of the build's own (never the user's), and downloads the
// pinned gltfpack into .dev (tools/internal/pinned). Every input the build
// reads is listed in art/sailors/SOURCES.md with its SHA-256, and the build
// fails on one that is not. CI does not run it: the built files are
// committed. It runs from the repository root.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

const (
	sailorsDir = "art/sailors"
	looksDir   = sailorsDir + "/looks"
	buildEntry = sailorsDir + "/build/main.py"
	stateDir   = ".dev"
	// profileDir is the Blender profile the build runs in: its add-ons,
	// its preferences, MPFB's own data.
	profileDir = stateDir + "/blender"
	// workDir holds what a build writes that is not committed: the jobs,
	// the runs, the looks that are not the game's.
	workDir = stateDir + "/sailors"
)

func main() {
	look := flag.String("look", "", "build only this look (its file's name in "+looksDir+", without .yaml)")
	setup := flag.Bool("setup", false, "check Blender and install MPFB and gltfpack, build nothing")
	verbose := flag.Bool("v", false, "show everything Blender and MPFB print")
	pack := flag.String("vendor", "", "copy clips out of this animation library's glTF binary into "+sailorsDir+"/"+vendorDir+", and build nothing")
	into := flag.String("into", "", "with -vendor: the folder under "+vendorDir+" they go into")
	pkg := flag.String("pack", "", "with -vendor: the pack's name, for SOURCES.md")
	clips := flag.String("clips", "", "with -vendor: the clips' names, comma-separated")
	flag.Parse()

	if *pack != "" {
		if *into == "" || *pkg == "" || *clips == "" {
			fmt.Fprintln(os.Stderr, "sailors: -vendor needs -into, -pack and -clips")
			os.Exit(2)
		}
		if err := vendorClips(*pack, *into, *pkg, strings.Split(*clips, ",")); err != nil {
			fmt.Fprintln(os.Stderr, "sailors:", err)
			os.Exit(1)
		}
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx, *look, *setup, *verbose); err != nil {
		fmt.Fprintln(os.Stderr, "sailors:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, only string, setupOnly, verbose bool) error {
	blender, err := findBlender(ctx)
	if err != nil {
		return err
	}
	profile, err := filepath.Abs(profileDir)
	if err != nil {
		return err
	}
	if err := ensureMPFB(ctx, blender, profile, os.Stdout); err != nil {
		return err
	}
	gltfpack, err := pinned.Gltfpack.Ensure(ctx, stateDir, os.Stdout)
	if err != nil {
		return err
	}
	if setupOnly {
		fmt.Printf("sailors: Blender %s, MPFB %s, gltfpack %s: ready\n", blender.version, mpfbVersion, pinned.Gltfpack.Version())
		return nil
	}

	sources, err := readSources(sailorsDir)
	if err != nil {
		return err
	}
	looks, err := readLooks(looksDir, only)
	if err != nil {
		return err
	}
	tables, err := readTables(sailorsDir)
	if err != nil {
		return err
	}
	poses, err := readPoses(filepath.Join(sailorsDir, posesDir), tables, sources)
	if err != nil {
		return err
	}
	for _, l := range looks {
		if err := checkClips(l, poses); err != nil {
			return err
		}
	}
	root, err := os.Getwd()
	if err != nil {
		return err
	}
	for _, l := range looks {
		start := time.Now()
		job := newJob(root, l, tables, sources, poses, gltfpack)
		file, err := job.write(filepath.Join(workDir, "jobs"))
		if err != nil {
			return err
		}
		if err := blender.build(ctx, profile, file, verbose); err != nil {
			return fmt.Errorf("%s: %w", l.ID, err)
		}
		fmt.Printf("sailors: %s built in %.1f s, into %s\n", l.ID, time.Since(start).Seconds(), strings.TrimPrefix(job.Out, root+"/"))
	}
	return nil
}
