// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestMissingHeaders(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"cmd/ok.go":                   "// " + header + "\n\npackage main\n",
		"cmd/missing.go":              "package main\n",
		"client/src/ok.ts":            "// " + header + "\n",
		"client/src/missing.ts":       "export {};\n",
		"client/index.html":           "<!doctype html>\n<!-- " + header + " -->\n",
		"client/src/late.css":         "a{}\nb{}\nc{}\nd{}\ne{}\n/* " + header + " */\n",
		"client/node_modules/x/y.ts":  "export {};\n",
		"internal/x/testdata/fix.go":  "package x\n",
		"README.md":                   "no header needed\n",
		"client/dist/assets/index.js": "no header needed\n",
	}
	for p, s := range files {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := missingHeaders(root)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"client/src/late.css", "client/src/missing.ts", "cmd/missing.go"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestReadAllowed(t *testing.T) {
	p := filepath.Join(t.TempDir(), "allowed.txt")
	if err := os.WriteFile(p, []byte("# note\nMIT\n\nApache-2.0 # why\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := readAllowed(p)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, []string{"MIT", "Apache-2.0"}) {
		t.Fatalf("got %v", got)
	}
}

func TestRepositoryHasHeaders(t *testing.T) {
	missing, err := missingHeaders(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) > 0 {
		t.Fatalf("files without the licence header: %v", missing)
	}
}
