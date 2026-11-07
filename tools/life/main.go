// SPDX-License-Identifier: AGPL-3.0-only

// Command life tallies the sea's life as a boat sailing about a world
// meets it, to tune the catalog's rates against the targets: how often
// something is in sight, how long the empty stretches between are, and
// how many groups of each kind are met an hour near the islands and in
// the outer water.
//
//	go run ./tools/life -tally                       100 worlds, 20 routes each
//	go run ./tools/life -tally -seeds 20 -from 41    worlds of seeds 41 to 60
//	go run ./tools/life -tally -kinds                each kind by habitat too
//
// For each seed it makes the world as keel does, its week of weather from
// the seed and the sky's sun for a week from the sample epoch, and builds
// the world's life schedule as keel does. It then sails routes at 5 kn
// through open water, each for a stretch of hours begun at a time spread
// over the week, so that day, dusk and night are all sailed: a route turns
// away from water shallower than 2 m and keeps within 4.2 NM of the
// centre. The boat is the only one in the world, and the world's life is
// kept tick by tick as the simulation keeps it, so that the gulls that
// follow boats follow it. A group is in sight while its middle is within
// its kind's reach of the boat and the visibility there; a bird only by
// day, while the sun is up where the boat is.
//
// It runs from the repository root, the worlds side by side over every
// core.
package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

func main() {
	tally := flag.Bool("tally", false, "sail routes about worlds and tally the life met")
	seeds := flag.Int("seeds", 100, "how many worlds, from -from")
	from := flag.Uint64("from", 1, "the first world's seed")
	routes := flag.Int("routes", 20, "routes sailed in each world")
	hours := flag.Float64("hours", 6, "how long each route is sailed, hours")
	step := flag.Float64("step", 5, "the boat's step, s: a multiple of a second")
	kinds := flag.Bool("kinds", false, "also print each kind met an hour in each habitat")
	workers := flag.Int("workers", runtime.GOMAXPROCS(0), "worlds made and sailed at once")
	flag.Parse()
	if !*tally {
		flag.Usage()
		os.Exit(2)
	}
	cat, err := catalog.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "life:", err)
		os.Exit(1)
	}
	o := options{Seeds: *seeds, From: *from, Routes: *routes, Hours: *hours, Step: *step, Workers: *workers}
	start := time.Now()
	t, err := tallyWorlds(cat, o, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "life:", err)
		os.Exit(1)
	}
	t.write(os.Stdout, o, *kinds)
	fmt.Printf("\n%d worlds, %d routes of %g h each, in %s.\n", o.Seeds, o.Seeds*o.Routes, o.Hours, time.Since(start).Round(time.Second))
}
