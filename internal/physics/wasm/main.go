// SPDX-License-Identifier: AGPL-3.0-only

//go:build tinygo.wasm

// Command wasm is the physics package as a WebAssembly module for the
// client, built by go run ./tools/physics with TinyGo's wasm-unknown target:
// no imports, no scheduler and an allocator that never frees, which is safe
// because a step allocates nothing.
//
// The records live at fixed addresses in the module's memory. The client
// reads and writes them through typed arrays, at the addresses the exports
// below return. It calls _initialize once first; writes seaParams and calls
// seaPrepare; writes params and calls prepare; then steps. The prepared
// constants stay inside the module.
//
// The sea is held as the server sends it: seaSlots windows of sea areas,
// each filled from the areas' inputs by seaArea and made ready by seaSeal.
// A step sails in the window seaUse names, at the tick seaAt set. Drawing
// has a time of its own, seaDrawAt, so that the sea between two ticks can be
// asked about without disturbing the steps.
package main

import (
	"runtime"
	"unsafe"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

var (
	state    physics.State
	control  physics.Control
	env      physics.Env
	params   physics.Params
	out      physics.Out
	prepared physics.Prepared

	seaParams physics.SeaParams
	waves     physics.Waves
	wave      physics.EffectiveWave
)

const (
	// seaSlots is how many windows of the sea the module holds: the one in
	// effect and the one to come.
	seaSlots = physics.SeaClientSlots
	// seaSide is the most areas a side a window has.
	seaSide  = physics.SeaClientWindow
	seaAreas = seaSide * seaSide
	// sampleCapacity is how many points one call of seaSample takes.
	sampleCapacity = physics.SeaSampleCapacity
)

// seaWindow is a window and its storage.
type seaWindow struct {
	win    physics.SeaWindow
	inputs [seaAreas]physics.SeaInput
	amp    [seaAreas * physics.SeaComponents]float64
	hs     [seaAreas]float64
	peak   [seaAreas]float64
}

var (
	windows  [seaSlots]seaWindow
	stepTime physics.SeaTick
	drawTime physics.SeaTick
	// use is the window a step sails in, or -1 for flat water.
	use int32 = -1

	// seaInput is what seaInputOf writes: an area's inputs in whole steps,
	// the wind's speed, the direction it comes from, the fetch.
	seaInput [3]uint32

	// samplePoints holds the points seaSample reads, east then north of
	// each; sampleValues what it writes: height, slope east, slope north
	// and significant height of each.
	samplePoints [2 * sampleCapacity]float64
	sampleValues [4 * sampleCapacity]float64
)

func init() {
	for i := range windows {
		w := &windows[i]
		w.win = physics.SeaWindow{Size: seaSide, Inputs: w.inputs[:], Amp: w.amp[:], Hs: w.hs[:], Peak: w.peak[:]}
	}
}

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

//go:wasmexport out
func outAddr() uint32 { return addr(unsafe.Pointer(&out)) }

//go:wasmexport seaParams
func seaParamsAddr() uint32 { return addr(unsafe.Pointer(&seaParams)) }

// components is the sea's waves, for drawing them: valid after seaPrepare.
//
//go:wasmexport components
func componentsAddr() uint32 { return addr(unsafe.Pointer(&waves.Components)) }

// wave is the record waveUnder writes.
//
//go:wasmexport wave
func waveAddr() uint32 { return addr(unsafe.Pointer(&wave)) }

// seaPrepare derives the sea's waves from seaParams. Call it after writing
// seaParams and before prepare.
//
//go:wasmexport seaPrepare
func seaPrepare() { physics.PrepareSea(&seaParams, &waves) }

// prepare derives the boat's constants from params, for the sea's waves.
// Call it after writing params and after seaPrepare, and before stepping.
//
//go:wasmexport prepare
func prepare() { physics.Prepare(&params, &waves, &prepared) }

func slot(i uint32) *seaWindow { return &windows[min(i, seaSlots-1)] }

// seaWindow places window s: its first area's column and row, and how many
// areas it has on a side, at most seaSide. Its areas keep their amplitudes
// until seaArea sets them.
//
//go:wasmexport seaWindow
func seaWindowPlace(s uint32, col, row int32, size uint32) {
	w := &slot(s).win
	w.Col, w.Row, w.Size = col, row, int32(min(max(size, 1), seaSide))
}

// seaArea sets the inputs of area i of window s, in whole steps.
//
//go:wasmexport seaArea
func seaArea(s, i, speed, from, fetch uint32) {
	w := &slot(s).win
	if i >= uint32(w.Size*w.Size) {
		return
	}
	physics.SeaArea(&waves, w, int32(i), physics.SeaInput{Speed: speed, From: from % physics.SeaFromSteps, Fetch: fetch})
}

// seaInputOf rounds a wind and a fetch to an area's inputs, as the server
// does, and writes them to seaInput. A negative fetch is that of open water.
// It is for a client that makes its own sea, with no server to send one.
//
//go:wasmexport seaInputOf
func seaInputOf(speed, from, fetch float64) {
	in := waves.OpenSea(speed, from)
	if fetch >= 0 {
		in = physics.SeaInputOf(speed, from, fetch)
	}
	seaInput = [3]uint32{in.Speed, in.From, in.Fetch}
}

//go:wasmexport seaInput
func seaInputAddr() uint32 { return addr(unsafe.Pointer(&seaInput)) }

// seaSeal makes window s ready, once its areas are set.
//
//go:wasmexport seaSeal
func seaSeal(s uint32) { slot(s).win.Seal() }

// seaAmp is window s's amplitudes: physics.SeaComponents float64s for each
// area, row by row.
//
//go:wasmexport seaAmp
func seaAmp(s uint32) uint32 { return addr(unsafe.Pointer(&slot(s).amp)) }

// seaHs is window s's significant heights, a float64 for each area.
//
//go:wasmexport seaHs
func seaHs(s uint32) uint32 { return addr(unsafe.Pointer(&slot(s).hs)) }

// seaPeak is the frequency of each area's spectral peak, in rad/s.
//
//go:wasmexport seaPeak
func seaPeak(s uint32) uint32 { return addr(unsafe.Pointer(&slot(s).peak)) }

// seaActive is the waves with an amplitude anywhere in window s, as int32s,
// ascending; seaCount is how many.
//
//go:wasmexport seaActive
func seaActive(s uint32) uint32 { return addr(unsafe.Pointer(&slot(s).win.Active)) }

//go:wasmexport seaCount
func seaCount(s uint32) uint32 { return uint32(slot(s).win.Count) }

// seaUse names the window steps sail in; a negative s is flat water.
//
//go:wasmexport seaUse
func seaUse(s int32) {
	use = -1
	if s >= 0 && s < seaSlots {
		use = s
	}
}

// seaAt sets the tick steps sail at.
//
//go:wasmexport seaAt
func seaAt(tick float64) { physics.SeaAt(&waves, &stepTime, tick) }

// seaDrawAt sets the time waveUnder and seaSample answer for, in ticks,
// which need not be whole.
//
//go:wasmexport seaDrawAt
func seaDrawAt(tick float64) { physics.SeaAt(&waves, &drawTime, tick) }

// step advances the state by one step and writes out.
//
//go:wasmexport step
func step() {
	if use < 0 {
		physics.Step(&state, &control, &env, nil, &prepared, &out)
		return
	}
	sea := physics.Sea{Waves: &waves, Window: &windows[use].win, Tick: &stepTime}
	physics.Step(&state, &control, &env, &sea, &prepared, &out)
}

// waveUnder writes to wave the sea under a hull at (x, y) heading heading,
// with a waterplane of the given length and beam, in window s at the time
// seaDrawAt set.
//
//go:wasmexport waveUnder
func waveUnder(s uint32, x, y, heading, length, beam float64) {
	sea := physics.Sea{Waves: &waves, Window: &slot(s).win, Tick: &drawTime}
	wave = physics.WaveUnder(&sea, length, beam, x, y, heading)
}

//go:wasmexport samplePoints
func samplePointsAddr() uint32 { return addr(unsafe.Pointer(&samplePoints)) }

//go:wasmexport sampleValues
func sampleValuesAddr() uint32 { return addr(unsafe.Pointer(&sampleValues)) }

// seaSample writes the sea at the first n of samplePoints to sampleValues,
// in window s at the time seaDrawAt set.
//
//go:wasmexport seaSample
func seaSample(s, n uint32) {
	sea := physics.Sea{Waves: &waves, Window: &slot(s).win, Tick: &drawTime}
	for i := uint32(0); i < n && i < sampleCapacity; i++ {
		p := physics.SeaSample(&sea, samplePoints[2*i], samplePoints[2*i+1])
		sampleValues[4*i], sampleValues[4*i+1], sampleValues[4*i+2], sampleValues[4*i+3] = p.Height, p.East, p.North, p.Hs
	}
}

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
