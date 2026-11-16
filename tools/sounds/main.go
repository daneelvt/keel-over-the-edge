// SPDX-License-Identifier: AGPL-3.0-only

// Command sounds keeps the game's recordings: the masters under
// art/sound/recorded/masters, each listed in art/sound/SOURCES.md with its
// original's author, title, page, licence and SHA-256, and the files the
// page plays, built from them.
//
//	go run ./tools/sounds -check     check the list, the files and their sizes; needs nothing else
//	go run ./tools/sounds -encode    build each master's files that are missing or stale, then check
//	go run ./tools/sounds -encode -all
//	                                 build every master's files again
//	go run ./tools/sounds -generate  make the game's own masters again (the format probe and
//	                                 the test recording, from ffmpeg's generators) and print
//	                                 their rows for SOURCES.md
//
// A master is a FLAC at 48 kHz, trimmed, cleaned and, for a bed, its end
// crossfaded into its start. Beside it in art/sound/recorded is its
// numbers' file, <name>.json, which says what it is (kind: a bed, a shot
// or the probe) and which voice plays it; -encode fills in the rest. From
// each master -encode writes <name>.webm (Opus) and <name>.m4a (AAC),
// normalised so the mix's numbers are decibels: a bed to −23 LUFS
// integrated, a shot to a true peak of −1 dBTP. Mono files are encoded at
// 48 kbps, stereo at 64. It needs ffmpeg with libopus; -check needs
// nothing but the files.
//
// The budgets: the files a page fetches at most 3 MB in either format,
// decoded at most 40 MB as 32-bit floats at 48 kHz, and the masters at
// most 25 MB. It runs from the repository root; npm run sounds in client/
// runs -encode.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
)

const (
	soundDir    = "art/sound"
	sourcesFile = "SOURCES.md"
	recordedDir = "recorded"
	mastersDir  = recordedDir + "/masters"
	// rate is the sample rate of every master, and of the page's context.
	rate = 48000
)

func main() {
	check := flag.Bool("check", false, "check SOURCES.md, the recordings' files and their sizes")
	encode := flag.Bool("encode", false, "build each master's WebM and AAC files that are missing or stale, then check")
	all := flag.Bool("all", false, "with -encode: build every master's files again")
	generate := flag.Bool("generate", false, "make the game's own masters again (the probe and the test recording) and print their rows for "+sourcesFile)
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	var err error
	switch {
	case *generate:
		err = generateOwn(ctx, soundDir, os.Stdout)
	case *encode:
		err = encodeAll(ctx, soundDir, *all, os.Stdout)
		if err == nil {
			err = report(soundDir)
		}
	case *check:
		err = report(soundDir)
	default:
		flag.Usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "sounds:", err)
		os.Exit(1)
	}
}

// report checks the recordings and says what they come to.
func report(dir string) error {
	s, err := checkRecordings(dir)
	if err != nil {
		return err
	}
	fmt.Printf("sounds: %d recordings: %.0f KB as WebM, %.0f KB as AAC, %.1f MB decoded, %.1f MB of masters\n",
		s.recordings, float64(s.webm)/1024, float64(s.m4a)/1024, float64(s.decoded)/(1<<20), float64(s.masters)/(1<<20))
	return nil
}
