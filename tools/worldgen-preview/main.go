// SPDX-License-Identifier: AGPL-3.0-only

// Command worldgen-preview draws the world of a seed as a chart to review:
// land by height and the sea by depth, coasts, every island's name, the
// main port, the start area, the calm water's ring, the mist band's and the
// edge's, and a scale; and a page around it with the validator's rules,
// every island, and layers for each sea area's fetch, the land's shelter
// and the surfaces.
//
//	go run ./tools/worldgen-preview -seed S            chart.svg and index.html for seed S
//	go run ./tools/worldgen-preview -bundle FILE       the same for a bundle keel worldgen -out wrote
//	go run ./tools/worldgen-preview -seeds N -from S   seeds S to S+N−1 side by side: seeds.html
//	go run ./tools/worldgen-preview -seed S -island I  island I at the lattice's resolution: island-I.svg
//
// It writes into -out, .dev/worldgen by default, and runs from the
// repository root.
package main

import (
	"errors"
	"flag"
	"fmt"
	"image/color"
	"os"
	"path/filepath"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen/chart"
)

// Scales, metres a pixel: the page's chart, the shelter's layers, and each
// chart of several seeds.
const (
	chartScale   = 12
	shelterScale = 24
	seedsScale   = 32
)

func main() {
	seed := flag.Uint64("seed", 1, "the seed")
	bundle := flag.String("bundle", "", "a bundle keel worldgen -out wrote, instead of a seed")
	seeds := flag.Int("seeds", 0, "draw this many seeds side by side, from -from")
	from := flag.Uint64("from", 1, "the first of -seeds")
	isl := flag.Int("island", -1, "draw this island alone, at the lattice's resolution")
	out := flag.String("out", filepath.Join(".dev", "worldgen"), "where to write")
	flag.Parse()
	if err := run(*seed, *bundle, *seeds, *from, *isl, *out); err != nil {
		fmt.Fprintln(os.Stderr, "worldgen-preview:", err)
		os.Exit(1)
	}
}

func run(seed uint64, bundle string, seeds int, from uint64, isl int, out string) error {
	cat, err := catalog.Load()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	cc := &chartConfig{
		calm: cat.World.MainPort.Calm * 1852,
		mist: cat.World.Disk.Mist * 1852,
		disk: cat.World.Disk.Radius,
	}
	write := func(name string, data []byte) error {
		path := filepath.Join(out, name)
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return err
		}
		fmt.Println("worldgen-preview: wrote", path)
		return nil
	}
	make1 := func(s uint64) (*worldgen.Bundle, error) {
		b, err := worldgen.Generate(s, cat)
		if errors.Is(err, worldgen.ErrInvalid) {
			fmt.Fprintf(os.Stderr, "worldgen-preview: seed %d passed no attempt; drawing the last\n", s)
			err = nil
		}
		return b, err
	}

	if seeds > 0 {
		var bundles []*worldgen.Bundle
		var charts [][]byte
		v := worldView(seedsScale)
		for k := range seeds {
			b, err := make1(from + uint64(k))
			if err != nil {
				return err
			}
			terrain := chart.Raster(b.Ground, v, chart.Terrain)
			bundles = append(bundles, b)
			charts = append(charts, worldChart(b, cc, v, terrain))
		}
		return write("seeds.html", seedsPage(bundles, charts))
	}

	var b *worldgen.Bundle
	if bundle != "" {
		data, err := os.ReadFile(bundle)
		if err != nil {
			return err
		}
		if b, err = worldgen.ReadFile(data); err != nil {
			return err
		}
	} else if b, err = make1(seed); err != nil {
		return err
	}
	if isl >= 0 {
		svg, err := chart.Island(b, isl)
		if err != nil {
			return err
		}
		return write(fmt.Sprintf("island-%d.svg", isl), svg)
	}
	v := worldView(chartScale)
	terrain := chart.Raster(b.Ground, v, chart.Terrain)
	surfaces := chart.Raster(b.Ground, v, func(_ float64, s int32) color.RGBA {
		return chart.SurfaceColours[int(s)%len(chart.SurfaceColours)]
	})
	sv := worldView(shelterScale)
	var shelters [][]byte
	for k := range physics.ShelterDirections {
		shelters = append(shelters, shelterLayer(b, sv, k))
	}
	if err := write("chart.svg", worldChart(b, cc, v, terrain)); err != nil {
		return err
	}
	return write("index.html", page(b, cc, v, terrain, surfaces, shelters, cat.Weather.Sea.FetchCap*1852))
}
