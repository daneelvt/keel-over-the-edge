// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
)

// The machines the server runs on, built the way that lets Go fuse the most:
// arm64 always may, amd64 only from GOAMD64=v3.
var fusingTargets = []struct{ goarch, goamd64 string }{
	{"arm64", ""},
	{"amd64", "v3"},
}

// fusedInstr matches a fused multiply-add or multiply-subtract in go tool
// objdump's output: FMADDD, FNMSUBD on arm64; VFMADD231SD and the like on
// amd64. Its first group is the source position.
var fusedInstr = regexp.MustCompile(`^\s*(\S+\.go:\d+)\s.*\b(V?FN?M(?:ADD|SUB)[0-9A-Z]*)\b`)

// checkFused compiles pkg for each target and lists every fused
// instruction in it: the check that catches what a reading of the source
// cannot, since Go may fuse across statements.
func checkFused(ctx context.Context, pkg string) ([]string, error) {
	dir, err := os.MkdirTemp("", "physics-fused-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	var problems []string
	for _, t := range fusingTargets {
		archive := filepath.Join(dir, t.goarch+".a")
		build := exec.CommandContext(ctx, "go", "build", "-o", archive, pkg)
		build.Env = append(os.Environ(), "GOOS=linux", "GOARCH="+t.goarch, "GOAMD64="+t.goamd64, "CGO_ENABLED=0")
		if out, err := build.CombinedOutput(); err != nil {
			return nil, fmt.Errorf("go build %s for %s: %v\n%s", pkg, t.goarch, err, out)
		}
		dump, err := exec.CommandContext(ctx, "go", "tool", "objdump", archive).Output()
		if err != nil {
			return nil, fmt.Errorf("go tool objdump: %w", err)
		}
		for _, f := range fusedIn(dump) {
			problems = append(problems, fmt.Sprintf("%s: fused into %s on %s; write the product as float64(…)", f.pos, f.instr, t.goarch))
		}
	}
	return problems, nil
}

type fused struct{ pos, instr string }

func fusedIn(dump []byte) []fused {
	var found []fused
	sc := bufio.NewScanner(bytes.NewReader(dump))
	sc.Buffer(make([]byte, 0, 1<<16), 1<<20)
	for sc.Scan() {
		if m := fusedInstr.FindSubmatch(sc.Bytes()); m != nil {
			found = append(found, fused{pos: string(m[1]), instr: string(m[2])})
		}
	}
	return found
}
