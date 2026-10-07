// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/tinygo"
)

// tinygoArgs builds the module: TinyGo's target for a bare WebAssembly
// module, with the collector that never frees and no scheduler (the target's
// defaults, written out), a trap for any panic, and no debug information.
// -opt=2 favours speed: a step runs about 13% faster than at TinyGo's
// default -opt=z, for about 120 more bytes gzipped.
var tinygoArgs = []string{
	"build",
	"-target=wasm-unknown",
	"-gc=leaking",
	"-scheduler=none",
	"-panic=trap",
	"-no-debug",
	"-opt=2",
}

// allocArgs build the module once more only to list its heap allocations:
// TinyGo's -print-allocs reports nothing with the leaking collector, so this
// build uses the conservative one. The code is otherwise the same.
var allocArgs = []string{
	"build",
	"-target=wasm-unknown",
	"-gc=conservative",
	"-scheduler=none",
	"-panic=trap",
	"-no-debug",
	"-opt=2",
	`-print-allocs=^(main|github\.com/daneelvt/keel-over-the-edge/internal/physics)\.`,
}

type module struct {
	size, gzipped int
}

func (m module) String() string {
	return fmt.Sprintf("%d bytes, %d gzipped (budget %d)", m.size, m.gzipped, budget)
}

// buildModule builds the module into out and checks it: no heap allocation
// in the package or the module's exports, and within the size budget.
func buildModule(ctx context.Context, out string) (module, error) {
	bin, err := tinygo.Ensure(ctx, stateDir, os.Stdout)
	if err != nil {
		return module{}, err
	}
	env, err := tinygoEnv(ctx)
	if err != nil {
		return module{}, err
	}
	run := func(args []string, o string) (string, error) {
		cmd := exec.CommandContext(ctx, bin, append(append([]string{}, args...), "-o", o, wasmPkg)...)
		cmd.Env = env
		output, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("tinygo build: %w\n%s", err, output)
		}
		return string(output), nil
	}

	tmp, err := os.MkdirTemp("", "physics-allocs-*")
	if err != nil {
		return module{}, err
	}
	defer os.RemoveAll(tmp)
	report, err := run(allocArgs, filepath.Join(tmp, "physics.wasm"))
	if err != nil {
		return module{}, err
	}
	if allocs := heapAllocations(strings.NewReader(report)); len(allocs) > 0 {
		return module{}, fmt.Errorf("the module allocates on the heap, which its allocator never frees:\n  %s",
			strings.Join(allocs, "\n  "))
	}
	if _, err := run(tinygoArgs, out); err != nil {
		return module{}, err
	}
	return measure(out)
}

// tinygoEnv puts the repository's Go first on the PATH, since TinyGo uses
// it to read the packages, and points TinyGo at the client's wasm-opt.
func tinygoEnv(ctx context.Context) ([]string, error) {
	goroot, err := exec.CommandContext(ctx, "go", "env", "GOROOT").Output()
	if err != nil {
		return nil, fmt.Errorf("go env GOROOT: %w", err)
	}
	wasmOpt, err := filepath.Abs(filepath.Join("client", "node_modules", ".bin", "wasm-opt"))
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(wasmOpt); err != nil {
		return nil, errors.New("client/node_modules has no wasm-opt: run npm ci in client/")
	}
	gobin := filepath.Join(strings.TrimSpace(string(goroot)), "bin")
	return append(os.Environ(),
		"PATH="+gobin+string(os.PathListSeparator)+os.Getenv("PATH"),
		"WASMOPT="+wasmOpt,
	), nil
}

// heapAllocations picks TinyGo's -print-allocs reports out of its output.
func heapAllocations(r io.Reader) []string {
	var found []string
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		if line := sc.Text(); strings.Contains(line, "allocated on the heap") {
			found = append(found, line)
		}
	}
	return found
}

func measure(path string) (module, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return module{}, err
	}
	var gz bytes.Buffer
	w, _ := gzip.NewWriterLevel(&gz, gzip.BestCompression)
	w.Write(data)
	w.Close()
	m := module{size: len(data), gzipped: gz.Len()}
	if m.gzipped > budget {
		return m, fmt.Errorf("the module is over budget: %s", m)
	}
	return m, nil
}

// vetModule type-checks and vets the module's entry point the way TinyGo
// will see it, without TinyGo.
func vetModule(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "go", "vet", "-tags=tinygo.wasm,wasm_unknown", wasmPkg)
	cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("go vet %s: %s", wasmPkg, strings.TrimSpace(string(out)))
	}
	return nil
}
