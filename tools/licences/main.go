// SPDX-License-Identifier: AGPL-3.0-only

// Command licences checks that every source file carries the licence header
// and that every Go package linked into keel has a licence in allowed.txt.
// The client's bundled packages are checked by the client build itself.
//
// Files under art/ are art, not code: all rights reserved, outside the AGPL
// (art/README.md). They carry the art header instead.
//
//	go run ./tools/licences
//
// It runs from the repository root.
package main

import (
	"bufio"
	"context"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const (
	header      = "SPDX-License-Identifier: AGPL-3.0-only"
	artHeader   = "SPDX-License-Identifier: LicenseRef-All-Rights-Reserved"
	artDir      = "art"
	headerLines = 5 // the header must be within the first lines of a file
	allowedFile = "tools/licences/allowed.txt"
)

// sourceExts are the files that carry the header.
var sourceExts = map[string]bool{
	".go": true, ".ts": true, ".tsx": true, ".css": true, ".html": true, ".grit": true,
}

// artDataExts are data files that carry the art header too, under art/ only:
// a JSON recipe names it in its first field.
var artDataExts = map[string]bool{".json": true}

func main() {
	missing, err := missingHeaders(".")
	if err != nil {
		fail(err)
	}
	if len(missing) > 0 {
		fail(fmt.Errorf("files without %q (under %s/: %q) in their first %d lines:\n  %s",
			header, artDir, artHeader, headerLines, strings.Join(missing, "\n  ")))
	}
	fmt.Println("licences: every source file has the header")

	allowed, err := readAllowed(allowedFile)
	if err != nil {
		fail(err)
	}
	cmd := exec.CommandContext(context.Background(), "go", "tool", "go-licenses", "check",
		"./cmd/keel", "--allowed_licenses="+strings.Join(allowed, ","),
		// The game's own code is AGPL; only what it links from others is checked.
		"--ignore", "github.com/daneelvt/keel-over-the-edge")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fail(fmt.Errorf("go-licenses: a package linked into keel has a licence outside %s: %w", allowedFile, err))
	}
	fmt.Println("licences: every Go package linked into keel is allowed")
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "licences:", err)
	os.Exit(1)
}

// missingHeaders lists the source files under root without their header:
// the AGPL's, or under art/ the art's.
func missingHeaders(root string) ([]string, error) {
	var missing []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", ".dev", "node_modules", "dist", "testdata":
				if p != root {
					return fs.SkipDir
				}
			}
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		inArt := strings.HasPrefix(rel, artDir+"/")
		if !sourceExts[filepath.Ext(p)] && !(inArt && artDataExts[filepath.Ext(p)]) {
			return nil
		}
		want := header
		if inArt {
			want = artHeader
		}
		ok, err := hasHeader(p, want)
		if err != nil {
			return err
		}
		if !ok {
			missing = append(missing, rel)
		}
		return nil
	})
	sort.Strings(missing)
	return missing, err
}

func hasHeader(path, header string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for i := 0; i < headerLines && sc.Scan(); i++ {
		if strings.Contains(sc.Text(), header) {
			return true, nil
		}
	}
	return false, sc.Err()
}

func readAllowed(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var ids []string
	for line := range strings.SplitSeq(string(raw), "\n") {
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		if line = strings.TrimSpace(line); line != "" {
			ids = append(ids, line)
		}
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("%s lists no licences", path)
	}
	return ids, nil
}
