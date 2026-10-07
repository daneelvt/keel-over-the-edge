// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

// goSnapshot fingerprints every Go source file and go.mod under root by
// path, size and modification time. Polling it twice a second is enough to
// notice a save, with no file-watching dependency.
func goSnapshot(root string) (string, error) {
	h := sha256.New()
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", ".dev", "node_modules", clientDir, "testdata":
				if p != root {
					return fs.SkipDir
				}
			}
			return nil
		}
		name := d.Name()
		if !strings.HasSuffix(name, ".go") && name != "go.mod" && name != "go.sum" && !strings.HasSuffix(name, ".gen.json") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		fmt.Fprintf(h, "%s %d %d\n", p, info.Size(), info.ModTime().UnixNano())
		return nil
	})
	return hex.EncodeToString(h.Sum(nil)), err
}
