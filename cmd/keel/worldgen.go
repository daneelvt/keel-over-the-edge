// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/names"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

const worldgenUsage = `usage: keel worldgen -seed S [-out FILE] [-report]

Makes the world of a seed, as a new world's first start does, checks it
against the validator's rules, and prints a summary: the attempts, the
islands by size and biome, the land's share, each rule's result and how
long each stage took. Exits 1 if no attempt passed.

  -seed S     the seed, a whole number from 0 to 2⁶⁴−1
  -out FILE   write the bundle to FILE, for tools/worldgen-preview and keel replay -world
  -report     print the full report as JSON instead of the summary
`

func worldgenCmd(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("worldgen", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { io.WriteString(stderr, worldgenUsage) }
	seedText := fs.String("seed", "", "")
	out := fs.String("out", "", "")
	report := fs.Bool("report", false, "")
	if err := fs.Parse(args); err != nil {
		return errUsage
	}
	seed, err := strconv.ParseUint(*seedText, 10, 64)
	if err != nil || fs.NArg() > 0 {
		fs.Usage()
		return errUsage
	}
	cat, err := catalog.Load()
	if err != nil {
		return err
	}
	db, err := names.Load()
	if err != nil {
		return err
	}
	b, genErr := worldgen.Generate(seed, cat, db)
	if b == nil {
		return genErr
	}
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			return err
		}
		if err := b.WriteFile(f); err != nil {
			f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
	}
	if *report {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(b.Report); err != nil {
			return err
		}
	} else {
		writeSummary(stdout, b)
	}
	if errors.Is(genErr, worldgen.ErrInvalid) {
		return fmt.Errorf("seed %d: %w after %d attempts", seed, genErr, b.Attempts)
	}
	return genErr
}

// writeSummary prints what a world holds and how it was made.
func writeSummary(w io.Writer, b *worldgen.Bundle) {
	fmt.Fprintf(w, "seed %d, generator %d: made from seed %d at attempt %d of %d, digest %s\n",
		b.Seed, b.Generator, b.Made, b.Attempts, len(b.Report.Attempts), b.DigestHex())
	for _, a := range b.Report.Attempts {
		if len(a.Failed) > 0 {
			fmt.Fprintf(w, "  attempt from seed %d failed: %s\n", a.Seed, strings.Join(a.Failed, ", "))
		}
	}
	fmt.Fprintf(w, "%d islands and %d groups; land %.2f%% of the disk; open water at most %.0f m from land\n",
		len(b.Islands), len(b.Groups), b.Report.LandShare, b.Report.Open)
	fmt.Fprintf(w, "  by size:  %s\n", counted(b.Report.ByClass))
	fmt.Fprintf(w, "  by biome: %s\n", counted(b.Report.ByBiome))
	port := b.MainPort()
	fmt.Fprintf(w, "%s: %.0f m across, %.1f m high, cliffs on %.0f%% of its coast; boats start %d places off it\n",
		port.Name, port.Across, port.Highest, 100*port.Cliffs, len(b.Start.Places))
	for _, r := range b.Report.Rules {
		mark := "pass"
		if !r.Pass {
			mark = "FAIL"
		}
		fmt.Fprintf(w, "  %s  %-26s %s (wants %s)\n", mark, r.Name, r.Measured, r.Wants)
	}
	fmt.Fprintf(w, "made in %v:", b.Generated())
	keys := make([]string, 0, len(b.Report.Millis))
	for k := range b.Report.Millis {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		fmt.Fprintf(w, " %s %.0f ms", k, b.Report.Millis[k])
	}
	fmt.Fprintln(w)
}

// counted lists counts by name, in the names' order.
func counted(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = fmt.Sprintf("%s %d", k, m[k])
	}
	return strings.Join(parts, ", ")
}
