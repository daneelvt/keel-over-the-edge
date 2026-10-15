// SPDX-License-Identifier: AGPL-3.0-only

//go:build tinygo.wasm

// Command wasm is the physics package, and the rule of the sky with it, as
// a WebAssembly module for the client, built by go run ./tools/physics with TinyGo's wasm-unknown target:
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
//
// Encounters: the client writes encounterParams and calls
// encounterPrepare once. Before a step it may write the wakes of the boats
// near its own into wakes and call shadowAt after windAt, so the step sails
// in their shadow; wakeOf gives a drawn boat's wake. courseTrack, with the
// course record, follows a boat's tack; articlesJudge reads the encounter
// record and writes the verdict; collide resolves a contact between the
// state and other records, writing the contact record.
//
// The ground: the client writes groundParams and calls groundPrepare once.
// It holds groundSlots chunks of the ground and of the shelter at a time:
// groundChunk gives a slot to a chunk by number and returns the address of
// its elevations, then its surfaces, which the client fills; shelterChunk
// the same for its shelter's table. groundUse and shelterUse say whether
// steps sail on the ground and windAt reads the shelter; a chunk not held
// is deep water and open wind. hexAt writes the hexagon that holds a point
// to hexValues.
//
// The sky is asked about once a frame: the client writes skyParams and
// calls skyPrepare once, then skyAt with sky time and the boat's place, and
// reads the sky record; skyStar answers for one star into the skyBody
// record.
package main

import (
	"runtime"
	"unsafe"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
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

	weatherParams   physics.WeatherParams
	weatherPrepared physics.WeatherPrepared
	regime          physics.Regime
	spell           physics.Spell
	wind            physics.WindPoint
	gustFrame       physics.GustFrame
	weather         = physics.Weather{Prepared: &weatherPrepared}
	stepWeather     physics.WeatherTick
	drawWeather     physics.WeatherTick
	// stepFresh says stepWeather is at the tick it holds in the spells in
	// play.
	stepFresh bool

	other             physics.State
	encounterParams   physics.EncounterParams
	encounterPrepared physics.EncounterPrepared
	wake1             physics.Wake
	wakes             [wakeCapacity]physics.Wake
	sources           physics.Sources
	course            physics.Course
	encounter         physics.Encounter
	verdict           physics.Verdict
	contact           physics.Contact
	hulls             physics.Hulls

	skyParams   sky.Params
	skyPrepared sky.Prepared
	skyNow      sky.Sky
	skyBody     sky.Body

	groundParams   physics.GroundParams
	groundPrepared physics.GroundPrepared
	ground         = physics.Ground{Prepared: &groundPrepared}
	shelter        physics.Shelter
	groundSlots    [groundSlotCount]physics.GroundChunk
	shelterSlots   [groundSlotCount]physics.ShelterChunk
	// groundOf and shelterOf are the chunk each slot holds, or -1.
	groundOf  = [groundSlotCount]int32{-1, -1, -1, -1, -1, -1, -1, -1, -1}
	shelterOf = [groundSlotCount]int32{-1, -1, -1, -1, -1, -1, -1, -1, -1}
	groundOn  bool
	shelterOn bool
	hexValues [2]int32
)

// groundSlotCount is how many chunks of the ground the module holds: the
// one the boat is in and its eight neighbours.
const groundSlotCount = physics.GroundSlots

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

	// windValues is what windSample writes: for each point the wind's
	// speed and direction, the mean wind's speed and direction, the gust
	// field and the gust factor.
	windValues [windValuesEach * sampleCapacity]float64
	// waveValues is what waveWind writes: the wave wind's speed and the
	// direction it comes from.
	waveValues  [2]float64
	waveScratch physics.WeatherTick
	waveRing    [physics.MaxWaveSamples]physics.WaveSample
)

const windValuesEach = 6

// wakeCapacity is how many wakes the client may offer a step.
const wakeCapacity = physics.ClientWakes

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
	var g *physics.Ground
	if groundOn {
		g = &ground
	}
	if use < 0 {
		physics.Step(&state, &control, &env, nil, g, &prepared, &out)
		return
	}
	sea := physics.Sea{Waves: &waves, Window: &windows[use].win, Tick: &stepTime}
	physics.Step(&state, &control, &env, &sea, g, &prepared, &out)
}

//go:wasmexport groundParams
func groundParamsAddr() uint32 { return addr(unsafe.Pointer(&groundParams)) }

// groundPrepare derives grounding's constants from groundParams.
//
//go:wasmexport groundPrepare
func groundPrepare() { physics.PrepareGround(&groundParams, &groundPrepared) }

// groundChunk gives slot s to chunk n, dropping the chunk it held, and
// returns the address of its elevations, physics.ChunkHexes int16s, then
// its surfaces, as many bytes. An n off the grid only drops it.
//
//go:wasmexport groundChunk
func groundChunk(s, n uint32) uint32 {
	s = min(s, groundSlotCount-1)
	if old := groundOf[s]; old >= 0 {
		ground.Chunks[old] = nil
	}
	groundOf[s] = -1
	if n < physics.ChunkCount {
		if old := ground.Chunks[n]; old != nil {
			for i := range groundSlotCount {
				if &groundSlots[i] == old {
					groundOf[i] = -1
				}
			}
		}
		ground.Chunks[n] = &groundSlots[s]
		groundOf[s] = int32(n)
	}
	return addr(unsafe.Pointer(&groundSlots[s]))
}

// shelterChunk gives slot s to chunk n's shelter, as groundChunk does, and
// returns the address of its table.
//
//go:wasmexport shelterChunk
func shelterChunk(s, n uint32) uint32 {
	s = min(s, groundSlotCount-1)
	if old := shelterOf[s]; old >= 0 {
		shelter.Chunks[old] = nil
	}
	shelterOf[s] = -1
	if n < physics.ChunkCount {
		if old := shelter.Chunks[n]; old != nil {
			for i := range groundSlotCount {
				if &shelterSlots[i] == old {
					shelterOf[i] = -1
				}
			}
		}
		shelter.Chunks[n] = &shelterSlots[s]
		shelterOf[s] = int32(n)
	}
	return addr(unsafe.Pointer(&shelterSlots[s]))
}

// groundUse says whether steps sail on the ground: 1 on, 0 the open sea.
//
//go:wasmexport groundUse
func groundUse(on uint32) { groundOn = on != 0 }

// shelterUse says whether windAt reads the land's shelter.
//
//go:wasmexport shelterUse
func shelterUse(on uint32) { shelterOn = on != 0 }

// hexAt writes to hexValues the hexagon that holds (x, y), q then r.
//
//go:wasmexport hexAt
func hexAt(x, y float64) {
	hexValues[0], hexValues[1] = physics.HexAt(x, y)
}

//go:wasmexport hexValues
func hexValuesAddr() uint32 { return addr(unsafe.Pointer(&hexValues)) }

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

//go:wasmexport weatherParams
func weatherParamsAddr() uint32 { return addr(unsafe.Pointer(&weatherParams)) }

//go:wasmexport regime
func regimeAddr() uint32 { return addr(unsafe.Pointer(&regime)) }

//go:wasmexport spell
func spellAddr() uint32 { return addr(unsafe.Pointer(&spell)) }

// wind is the record windPoint writes.
//
//go:wasmexport wind
func windAddr() uint32 { return addr(unsafe.Pointer(&wind)) }

// gustFrame is the record gustFrameAt writes.
//
//go:wasmexport gustFrame
func gustFrameAddr() uint32 { return addr(unsafe.Pointer(&gustFrame)) }

// weatherPrepare derives the wind's constants from weatherParams. Call it
// after writing weatherParams and before setting spells.
//
//go:wasmexport weatherPrepare
func weatherPrepare() {
	physics.PrepareWeather(&weatherParams, &weatherPrepared)
	stepFresh = false
}

// spellDraw writes to the spell record a spell of the regime in the regime
// record, drawn from its number and a seed as the server draws its spells.
// Its times, direction and regime's index are left as the record had them.
//
//go:wasmexport spellDraw
func spellDraw(number, seed uint32) {
	physics.DrawSpell(&weatherPrepared, &regime, number, seed, &spell)
}

// spellSet makes the spell record spell i of those in play.
//
//go:wasmexport spellSet
func spellSet(i uint32) {
	weather.SetSpell(int32(min(i, physics.WeatherSpells)), &spell)
	stepFresh = false
}

// spellGet writes spell i of those in play to the spell record.
//
//go:wasmexport spellGet
func spellGet(i uint32) { spell = weather.Spells[min(i, physics.WeatherSpells-1)] }

// spellCount says how many of the spells set are in play: the first n.
//
//go:wasmexport spellCount
func spellCount(n uint32) {
	weather.SetCount(int32(min(n, physics.WeatherSpells)))
	stepFresh = false
}

// windAt sets env to the wind at the state's place at a tick: what the next
// step sails in.
//
//go:wasmexport windAt
func windAt(tick float64) {
	if !stepFresh || stepWeather.Tick != tick {
		physics.WeatherAt(&weather, &stepWeather, tick)
		stepFresh = true
	}
	var sh *physics.Shelter
	if shelterOn {
		sh = &shelter
	}
	env = physics.WindAt(&stepWeather, state.X, state.Y, sh)
}

// windDrawAt sets the time windPoint, windSample and gustFrameAt answer
// for, in ticks, which need not be whole.
//
//go:wasmexport windDrawAt
func windDrawAt(tick float64) { physics.WeatherAt(&weather, &drawWeather, tick) }

// windPoint writes to the wind record the wind at (x, y) in full, at the
// time windDrawAt set.
//
//go:wasmexport windPoint
func windPoint(x, y float64) { physics.WindPointAt(&drawWeather, x, y, &wind, nil) }

//go:wasmexport windValues
func windValuesAddr() uint32 { return addr(unsafe.Pointer(&windValues)) }

// windSample writes the wind at the first n of samplePoints to windValues,
// at the time windDrawAt set.
//
//go:wasmexport windSample
func windSample(n uint32) {
	var p physics.WindPoint
	for i := uint32(0); i < n && i < sampleCapacity; i++ {
		physics.WindPointAt(&drawWeather, samplePoints[2*i], samplePoints[2*i+1], &p, nil)
		v := windValues[windValuesEach*i : windValuesEach*(i+1)]
		v[0], v[1], v[2], v[3], v[4], v[5] = p.Speed, p.From, p.MeanSpeed, p.MeanFrom, p.Gust, p.Factor
	}
}

// gustFrameAt writes to the gustFrame record the gust field's frame at the
// time windDrawAt set.
//
//go:wasmexport gustFrameAt
func gustFrameAt() { physics.GustFrameAt(&drawWeather, &gustFrame) }

//go:wasmexport waveValues
func waveValuesAddr() uint32 { return addr(unsafe.Pointer(&waveValues)) }

// waveWind writes to waveValues the wind that raises the waves at (x, y)
// at a tick, from the spells in play: for a client that makes its own sea.
//
//go:wasmexport waveWind
func waveWind(x, y, tick float64) {
	waveValues[0], waveValues[1] = physics.WaveWindAt(&weather, x, y, tick, &waveScratch, &waveRing)
}

//go:wasmexport other
func otherAddr() uint32 { return addr(unsafe.Pointer(&other)) }

//go:wasmexport encounterParams
func encounterParamsAddr() uint32 { return addr(unsafe.Pointer(&encounterParams)) }

// encounterPrepare derives the encounters' constants from encounterParams.
// Call it after writing them, and after prepare.
//
//go:wasmexport encounterPrepare
func encounterPrepare() { physics.PrepareEncounters(&encounterParams, &encounterPrepared) }

// wake is the record wakeOf writes.
//
//go:wasmexport wake
func wakeAddr() uint32 { return addr(unsafe.Pointer(&wake1)) }

// wakeOf writes to the wake record the wake of a boat of the prepared kind
// at (x, y) heading heading, heeled heel with its boom at boom, moving at
// (vx, vy), in a true wind of speed from from.
//
//go:wasmexport wakeOf
func wakeOf(x, y, heading, heel, boom, vx, vy, speed, from float64) {
	wake1 = physics.WakeAt(x, y, heading, heel, boom, vx, vy, speed, from, &prepared, &encounterPrepared)
}

// wakeOfState writes to the wake record the wake the state leaves in the
// wind of env, as the server's step leaves it.
//
//go:wasmexport wakeOfState
func wakeOfState() { wake1 = physics.WakeOf(&state, &env, &prepared, &encounterPrepared) }

// wakes is wakeCapacity wake records, the wakes shadowAt considers.
//
//go:wasmexport wakes
func wakesAddr() uint32 { return addr(unsafe.Pointer(&wakes)) }

//go:wasmexport wakeCapacity
func wakeCapacityValue() uint32 { return wakeCapacity }

// shadowAt changes env, the wind at the state's place, by the first n of
// wakes: the nearest that reach it, each numbered by its place in wakes
// for breaking ties. It returns how many reach.
//
//go:wasmexport shadowAt
func shadowAt(n uint32) uint32 {
	sources.Reset()
	for i := uint32(0); i < n && i < wakeCapacity; i++ {
		sources.Consider(&wakes[i], int32(i), state.X, state.Y, &encounterPrepared)
	}
	physics.ShadowAt(&env, state.X, state.Y, &sources, &encounterPrepared)
	return uint32(sources.Len())
}

//go:wasmexport course
func courseAddr() uint32 { return addr(unsafe.Pointer(&course)) }

// courseTrack brings the course record to the state, in the true wind from
// windFrom.
//
//go:wasmexport courseTrack
func courseTrack(windFrom float64) {
	physics.TrackCourse(&course, &state, windFrom, &prepared, &encounterPrepared)
}

// courseOf brings the course record to a boat heading heading with its
// boom at boom, in the true wind from windFrom: another boat's, drawn from
// its samples.
//
//go:wasmexport courseOf
func courseOf(heading, boom, windFrom float64) {
	s := physics.State{Heading: heading, Boom: boom}
	physics.TrackCourse(&course, &s, windFrom, &prepared, &encounterPrepared)
}

//go:wasmexport encounter
func encounterAddr() uint32 { return addr(unsafe.Pointer(&encounter)) }

//go:wasmexport verdict
func verdictAddr() uint32 { return addr(unsafe.Pointer(&verdict)) }

// articlesJudge writes to the verdict record the Articles' verdict on the
// encounter record's two boats, both of the prepared kind.
//
//go:wasmexport articlesJudge
func articlesJudge() {
	verdict = physics.Judge(&encounter, &prepared, &prepared, &encounterPrepared)
}

//go:wasmexport contact
func contactAddr() uint32 { return addr(unsafe.Pointer(&contact)) }

// collide resolves a contact between the state and other records, boats of
// the prepared kind, writing the contact record; it returns 1 if they
// touched.
//
//go:wasmexport collide
func collide() uint32 {
	if hulls.Collide(&state, &other, &prepared, &prepared, &encounterPrepared, &contact) {
		return 1
	}
	return 0
}

// skyParams is the sky's numbers: sky.ParamsSize float64s, in the
// catalog's order.
//
//go:wasmexport skyParams
func skyParamsAddr() uint32 { return addr(unsafe.Pointer(&skyParams)) }

// skyPrepare readies the sky from skyParams. Call it after writing them
// and before asking about the sky.
//
//go:wasmexport skyPrepare
func skyPrepare() { sky.Prepare(&skyParams, &skyPrepared) }

// sky is the record skyAt writes: sky.SkySize float64s, the sun's Body,
// the moon's, the moon's lit share and the stars' matrix.
//
//go:wasmexport sky
func skyAddr() uint32 { return addr(unsafe.Pointer(&skyNow)) }

// skyBody is the record skyStar writes: sky.BodySize float64s.
//
//go:wasmexport skyBody
func skyBodyAddr() uint32 { return addr(unsafe.Pointer(&skyBody)) }

// skySize is how many float64s the sky record holds, which the client
// compares with its own before reading it.
//
//go:wasmexport skySize
func skySize() uint32 { return uint32(unsafe.Sizeof(skyNow) / 8) }

// skyTime is sky time, in whole microseconds, at a world's time: the
// world's epoch in microseconds of UTC since 1970, and the microseconds
// the world has run since.
//
//go:wasmexport skyTime
func skyTime(worldEpoch, worldTime float64) float64 {
	return sky.Time(&skyPrepared, worldEpoch, worldTime)
}

// skyAt writes to the sky record the sky at sky time t, in microseconds,
// from the place east and north of the centre, in metres.
//
//go:wasmexport skyAt
func skyAt(t, east, north float64) { sky.At(&skyPrepared, t, east, north, &skyNow) }

// skyStar writes to skyBody where the star of a right ascension and
// declination, in degrees, stands at sky time t from a place.
//
//go:wasmexport skyStar
func skyStar(t, east, north, ra, dec float64) {
	sky.Star(&skyPrepared, t, east, north, ra, dec, &skyBody)
}

// skyVector writes to skyBody's first three floats the catalogue vector of
// a right ascension and declination, in degrees: the vector the stars'
// matrix turns.
//
//go:wasmexport skyVector
func skyVector(ra, dec float64) {
	skyBody.East, skyBody.North, skyBody.Up = sky.Vector(ra, dec)
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
