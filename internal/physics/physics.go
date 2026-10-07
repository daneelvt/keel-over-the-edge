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
//     (and on amd64 with GOAMD64=v3), even across statements, which changes
//     the last bits. A product that is added to or subtracted from is written
//     float64(x*y): an explicit conversion rounds and forbids the fusion. The
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

// StepsPerSecond is the rate of the fixed step, on the server and in the
// client's prediction alike.
const StepsPerSecond = 30

// Dt is the length of one step in seconds.
const Dt = 1.0 / StepsPerSecond
