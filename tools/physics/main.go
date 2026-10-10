// SPDX-License-Identifier: AGPL-3.0-only

// Command physics builds the physics package into the client's WebAssembly
// module and checks the package's rules, and that the simulation that runs it
// on the server compiles to no fused multiply-add either.
//
//	go run ./tools/physics          write the layout files and build client/src/predict/physics.wasm
//	go run ./tools/physics -check   check the rules, the layout files and the module, writing nothing
//
// The first run downloads the pinned TinyGo into .dev (tools/internal/pinned).
// wasm-opt comes from the client's packages, so npm ci must have run. It runs
// from the repository root.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
)

const (
	physicsDir = "internal/physics"
	// simPkg is the simulation, which runs the physics on the server: it
	// does no float arithmetic of its own, and the disassembly checks it
	// fuses none either.
	simPkg    = "./internal/sim"
	wasmPkg   = "./internal/physics/wasm"
	moduleOut = "client/src/predict/physics.wasm"
	goLayout  = "internal/physics/layout.gen.go"
	tsLayout  = "client/src/predict/layout.gen.ts"
	stateDir  = ".dev"
	// budget is the most the module may weigh, gzipped. Browsers get it
	// with Brotli, which is smaller still.
	budget = 300 << 10
)

func main() {
	check := flag.Bool("check", false, "write nothing; fail if a rule is broken, a layout file is out of date or the module is over budget")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	var err error
	if *check {
		err = runCheck(ctx)
	} else {
		err = runBuild(ctx)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "physics:", err)
		os.Exit(1)
	}
}

func runBuild(ctx context.Context) error {
	l, err := describe()
	if err != nil {
		return err
	}
	for path, data := range l.files() {
		if err := writeIfChanged(path, data); err != nil {
			return err
		}
	}
	// TinyGo compiles the package from source, so the module carries the
	// LayoutVersion just written.
	m, err := buildModule(ctx, moduleOut)
	if err != nil {
		return err
	}
	fmt.Printf("physics: %s: %s\n", moduleOut, m)
	return nil
}

func runCheck(ctx context.Context) error {
	var problems []string
	l, err := describe()
	if err != nil {
		return err
	}
	for path, data := range l.files() {
		if old, err := os.ReadFile(path); err != nil || string(old) != string(data) {
			problems = append(problems, path+" is out of date: run go run ./tools/physics")
		}
	}
	found, err := checkRules(physicsDir, allowedImports)
	if err != nil {
		return err
	}
	problems = append(problems, found...)
	found, err = checkRules(wasmPkg, wasmImports)
	if err != nil {
		return err
	}
	problems = append(problems, found...)
	for _, pkg := range []string{"./" + physicsDir, simPkg} {
		found, err = checkFused(ctx, pkg)
		if err != nil {
			return err
		}
		problems = append(problems, found...)
	}
	if err := vetModule(ctx); err != nil {
		problems = append(problems, err.Error())
	}
	if len(problems) > 0 {
		return report(problems)
	}

	dir, err := os.MkdirTemp("", "physics-check-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	m, err := buildModule(ctx, dir+"/physics.wasm")
	if err != nil {
		return err
	}
	fmt.Printf("physics: the rules hold, the layout files are current, the module builds with no allocations: %s\n", m)
	return nil
}

func report(problems []string) error {
	for _, p := range problems {
		fmt.Fprintln(os.Stderr, "  "+p)
	}
	return fmt.Errorf("%d problems", len(problems))
}

func writeIfChanged(path string, data []byte) error {
	if old, err := os.ReadFile(path); err == nil && string(old) == string(data) {
		return nil
	}
	fmt.Println("physics: writing", path)
	return os.WriteFile(path, data, 0o644)
}
