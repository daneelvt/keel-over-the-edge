// SPDX-License-Identifier: AGPL-3.0-only

// Package physics steps boats. The server runs it for every boat, and the
// client runs the same code, built to WebAssembly with TinyGo, to predict the
// player's own boat. Both must get the same bits from the same inputs, so the
// package follows strict rules, checked by go run ./tools/physics -check:
//
//   - Pure: no goroutines, channels, maps, defer, closures or I/O. It imports
//     only math and math/bits, and from math uses only operations that IEEE
//     754 rounds exactly (Sqrt, Floor, Ceil, Trunc, Abs, Copysign) and
//     functions that only move bits (Float64bits, Float64frombits, Signbit,
//     IsNaN, IsInf, Inf, NaN). Sine, cosine, the exponential, the logarithm
//     and the arctangent are its own (fmath.go): Go's differ between amd64
//     and arm64, and TinyGo replaces them with LLVM's.
//   - No fused multiply-add. Go may fuse x*y + z into one instruction on arm64
//     (and on amd64 with GOAMD64=v3), even across statements and through
//     inlined calls, which changes the last bits. So every product of floats
//     is written float64(x*y), unless it only feeds another product or a
//     division: an explicit conversion rounds and forbids the fusion. The
//     check also disassembles the package for both machines.
//   - No conversion from float64 to an integer type outside toInt32 (fmath.go):
//     out-of-range conversions differ between amd64, arm64 and WebAssembly.
//   - Integers have explicit sizes where they could overflow: int is 64 bits
//     on the server and 32 bits in TinyGo's WebAssembly.
//   - No allocation in a step: the WebAssembly build's allocator never frees.
//
// Units are SI: metres, seconds, kilograms, radians. The world's x axis points
// east and y north; headings and directions are measured clockwise from north,
// as on a compass.
package physics

import "math"

// StepsPerSecond is the rate of the fixed step, on the server and in the
// client's prediction alike.
const StepsPerSecond = 30

// Dt is the length of one step in seconds.
const Dt = 1.0 / StepsPerSecond

// Substeps is how many times a step integrates the boat's motion: the forces
// change quickly in a gust or a capsize, and semi-implicit Euler is
// first-order accurate, so a step is cut into Substeps parts.
const Substeps = 4

// Physical constants.
const (
	airDensity   = 1.225  // kg/m³, standard atmosphere
	waterDensity = 1025.0 // kg/m³, sea water at 15 °C
	gravity      = 9.81   // m/s²
	// seaRoughness is the roughness length of the open sea in a moderate
	// breeze, from Charnock's relation (Charnock 1955).
	seaRoughness = 0.0002 // m
	degree       = math.Pi / 180
)
