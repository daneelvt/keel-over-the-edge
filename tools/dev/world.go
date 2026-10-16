// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// worldsDir is where the sandbox's worlds are written: Vite serves them at
// /dev-worlds/<seed>.world, and ?sandbox&world=<seed> sails them.
const worldsDir = ".dev/worlds"

// runWorld makes seed's world and writes it to worldsDir, for the sandbox.
func runWorld(out io.Writer, seed uint64) error {
	cat, err := catalog.Load()
	if err != nil {
		return err
	}
	start := time.Now()
	b, err := worldgen.Generate(seed, cat)
	if err != nil && !errors.Is(err, worldgen.ErrInvalid) {
		return err
	}
	var file bytes.Buffer
	if err := b.WriteFile(&file); err != nil {
		return err
	}
	if err := os.MkdirAll(worldsDir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(worldsDir, fmt.Sprintf("%d.world", seed))
	if err := os.WriteFile(path, file.Bytes(), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(out, "dev: seed %d's world, %d islands, made in %s: %s (%d bytes)\n", seed, len(b.Islands),
		time.Since(start).Round(time.Millisecond), path, file.Len())
	fmt.Fprintf(out, "dev: sail it at https://localhost:%d/?sandbox&world=%d\n", vitePort, seed)
	return nil
}
