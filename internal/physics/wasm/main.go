// SPDX-License-Identifier: AGPL-3.0-only

//go:build tinygo.wasm

// Command wasm is the physics package as a WebAssembly module for the
// client, built by go run ./tools/physics with TinyGo's wasm-unknown target:
// no imports, no scheduler and an allocator that never frees, which is safe
// because a step allocates nothing.
//
// The records live at fixed addresses in the module's memory. The client
// reads and writes them through typed arrays, at the addresses the exports
// below return, and calls step. The client calls _initialize once first.
package main

import (
	"runtime"
	"unsafe"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

var (
	state   physics.State
	control physics.Control
	env     physics.Env
	params  physics.Params
)

// fnCapacity is how many values one call of fn evaluates.
const fnCapacity = 256

// The self-test buffers: fn reads fnArgs[0] (and fnArgs[1] for two-argument
// functions) and writes fnResults.
var (
	fnArgs    [2][fnCapacity]float64
	fnResults [fnCapacity]float64
)

func addr(p unsafe.Pointer) uint32 { return uint32(uintptr(p)) }

// layout returns the version of the records' layout, which the client
// compares with its own before using the module.
//
//go:wasmexport layout
func layout() uint32 { return physics.LayoutVersion }

//go:wasmexport state
func stateAddr() uint32 { return addr(unsafe.Pointer(&state)) }

//go:wasmexport control
func controlAddr() uint32 { return addr(unsafe.Pointer(&control)) }

//go:wasmexport env
func envAddr() uint32 { return addr(unsafe.Pointer(&env)) }

//go:wasmexport params
func paramsAddr() uint32 { return addr(unsafe.Pointer(&params)) }

// step advances the state by one step.
//
//go:wasmexport step
func step() { physics.Step(&state, &control, &env, &params) }

//go:wasmexport fnArgs
func fnArgsAddr() uint32 { return addr(unsafe.Pointer(&fnArgs)) }

//go:wasmexport fnResults
func fnResultsAddr() uint32 { return addr(unsafe.Pointer(&fnResults)) }

//go:wasmexport fnCapacity
func fnCapacityValue() uint32 { return fnCapacity }

// fn evaluates function op on the first n arguments.
//
//go:wasmexport fn
func fn(op, n uint32) {
	for i := uint32(0); i < n && i < fnCapacity; i++ {
		fnResults[i] = physics.Eval(physics.Fn(op), fnArgs[0][i], fnArgs[1][i])
	}
}

// allocations returns how many heap allocations the module has made, for the
// test that a step makes none.
//
//go:wasmexport allocations
func allocations() uint32 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return uint32(m.Mallocs)
}

func main() {}
