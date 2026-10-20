// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"math/bits"
)

// The sea that moves boats is a sum of SeaComponents waves, each
//
//	h = a sin(φ₀ + k d·x − ω t)
//
// with a direction d, a frequency ω and a wavenumber k = ω²/g (deep water).
// The directions and the frequencies are the same over the whole world and
// never change: only the amplitudes follow the weather. A wave whose
// frequency or direction moved would sweep its phase through whole cycles,
// by t dω after t seconds and by k r dθ at r metres from where its phase is
// anchored, so the wind sets how high each fixed wave is, as it does on the
// grid of Tessendorf's sea ("Simulating Ocean Water", 2001).
//
// The world is cut into square areas, SeaAreaSize on a side. Each has its
// own wind and fetch, and from them its own amplitude for every wave, by the
// JONSWAP spectrum. A point between the centres of four areas blends their
// amplitudes, not their surfaces: every place sums the same sines, so the
// sea stays one coherent surface and keeps its height where areas meet.

const (
	// SeaComponents is how many waves the sea is a sum of.
	SeaComponents = 256
	// SeaAreaSize is the side of a sea area, a quarter of a nautical mile, m.
	SeaAreaSize = 463
	// SeaAreas is how many areas the world has on a side. The middle one is
	// centred on the world's centre.
	SeaAreas = 37

	// SeaClientWindow is how many areas a side a client holds about its
	// boat, and SeaClientSlots how many such windows: the one in effect and
	// the one to come.
	SeaClientWindow = 5
	SeaClientSlots  = 2
	// SeaSampleCapacity is how many points a client's module samples the
	// sea at in one call.
	SeaSampleCapacity = 512

	// SeaWords is how many words of an area's Bits hold its waves.
	SeaWords = SeaComponents / 64

	seaMiddle    = SeaAreas / 2
	seaRule      = 64
	nauticalMile = 1852.0
)

// The steps a sea area's inputs are rounded to: the same on the wire, so a
// client derives the server's amplitudes, bit for bit, from what it is sent.
const (
	SeaSpeedStep = 0.01                // m/s
	SeaFromSteps = 65536               // steps in a whole turn
	seaFromStep  = 2 * math.Pi / 65536 // rad
	seaSpeedMax  = 100 / SeaSpeedStep  // 100 m/s
	seaFetchMax  = 1 << 24             // m
)

// The steps of an area's swell and current.
const (
	SeaSwellHeightStep = 0.01 // m
	SeaSwellPeriodStep = 0.01 // s
	SeaCurrentStep     = 0.01 // m/s
	seaSwellMax        = 1 << 16
	seaCurrentMax      = 1000 // 10 m/s
)

// SeaInput is what raises the waves of one area, in whole steps.
type SeaInput struct {
	Speed uint32 // the wind that raises the waves, 10 m up, in steps of SeaSpeedStep
	From  uint32 // the direction it comes from, clockwise from north, in steps of a turn / SeaFromSteps
	Fetch uint32 // the open water the wind has blown over, m
	// The swell that reaches the area from a storm: its significant height
	// in steps of SeaSwellHeightStep, none if 0; its peak period in steps
	// of SeaSwellPeriodStep; and the direction it comes from, as From.
	SwellHeight uint32
	SwellPeriod uint32
	SwellFrom   uint32
	// The current at the area's centre on the open sea, east and north, in
	// steps of SeaCurrentStep.
	CurrentEast  int32
	CurrentNorth int32
}

// Swell is a storm's swell at a place.
type Swell struct {
	Height float64 // its significant height, m
	Period float64 // its peak period, s
	From   float64 // the direction it comes from, rad clockwise from north
	Far    float64 // how far it has come from where its storm was when it left, m
}

// SetSwell gives the inputs a swell, rounded to their steps: a swell with
// no height, or none whose period is a number, is none.
func (in *SeaInput) SetSwell(s Swell) {
	h := toInt32(math.Floor(s.Height/SeaSwellHeightStep + 0.5))
	p := toInt32(math.Floor(s.Period/SeaSwellPeriodStep + 0.5))
	if h <= 0 || p <= 0 {
		in.SwellHeight, in.SwellPeriod, in.SwellFrom = 0, 0, 0
		return
	}
	d := toInt32(math.Floor(float64(wrapAngle(s.From)*(1/seaFromStep)) + 0.5))
	in.SwellHeight = uint32(min(h, seaSwellMax))
	in.SwellPeriod = uint32(min(p, seaSwellMax))
	in.SwellFrom = uint32(d) & (SeaFromSteps - 1)
}

// Swell is the inputs' swell, as its steps stand for.
func (in *SeaInput) Swell() Swell {
	return Swell{
		Height: float64(float64(in.SwellHeight) * SeaSwellHeightStep),
		Period: float64(float64(in.SwellPeriod) * SeaSwellPeriodStep),
		From:   float64(float64(in.SwellFrom) * seaFromStep),
	}
}

// SetCurrent gives the inputs a current, east and north, m/s, rounded to
// its steps.
func (in *SeaInput) SetCurrent(east, north float64) {
	in.CurrentEast = currentSteps(east)
	in.CurrentNorth = currentSteps(north)
}

func currentSteps(v float64) int32 {
	s := toInt32(math.Floor(v/SeaCurrentStep + 0.5))
	return min(max(s, -seaCurrentMax), seaCurrentMax)
}

// SeaCurrent is the current of the area in a column and row, as its inputs
// hold it: at its centre on the open sea, for the world's way round
// (CurrentAt), so that a client works it out as the server does.
func SeaCurrent(w *WeatherPrepared, way float64, col, row int32) (east, north float64) {
	x, y := SeaAreaCentre(col, row)
	return CurrentAt(w, way, x, y, nil)
}

// SeaParts are what an area's waves are made of: its wind sea's and its
// swell's significant heights and peaks, each partition's alone, the
// height its waves would have with no current, and its wind sea's variance
// over the band as its spectrum has it.
type SeaParts struct {
	WindHs    float64 // m
	WindPeak  float64 // rad/s, 0 for none
	SwellHs   float64 // m
	SwellPeak float64 // rad/s, 0 for none
	StillHs   float64 // m
	WindBand  float64 // the wind sea's variance over the band, before the cull and the current, m²
}

// Components are the sea's waves, for whoever draws them.
type Components struct {
	Omega [SeaComponents]float64 // angular frequency, rad/s
	K     [SeaComponents]float64 // wavenumber, rad/m
	East  [SeaComponents]float64 // the direction the wave travels toward: a unit vector's east part
	North [SeaComponents]float64 // and its north part
	Phase [SeaComponents]float64 // phase at the world's centre at tick 0, rad, in [0, 2π)
	// Turns is the frequency in turns per tick: what the time phase is
	// computed from, exactly, here and wherever the sea is drawn.
	Turns [SeaComponents]float64
}

// Waves is the sea's fixed part: the waves and the spectrum's constants,
// derived from the catalog's values by PrepareSea.
type Waves struct {
	Components
	kEast  [SeaComponents]float64 // k d, east and north, rad/m
	kNorth [SeaComponents]float64
	speed  [SeaComponents]float64 // ω / k: how fast the wave travels, m/s

	// slice is twice the area of the (ln ω, θ) plane each wave stands for:
	// a wave's amplitude is √(slice · S(ω) D(θ) ω).
	slice float64
	// rule is the frequencies at which the spectrum is summed for its
	// variance over the band, evenly spaced in ln ω, and ruleStep their
	// spacing.
	rule          [seaRule]float64
	ruleStep      float64
	lnGamma       float64
	invSigmaBelow float64
	invSigmaAbove float64
	spreading     int32   // s
	spreadNorm    float64 // 1 / ∫ cos²ˢ(θ/2) dθ
	fetchCap      float64 // m
	cull          float64
	breaking      float64 // γ: the most Hs a depth keeps, as a share of it

	// The swell's partition: its spreading's exponent, its width, the
	// least of it, and the waves by frequency, ascending, which it visits
	// only near its peak.
	swellSpreading int32
	swellSigma     float64
	swellLeast     float64
	swellSteps     int32
	byOmega        [SeaComponents]int32
	omegaSorted    [SeaComponents]float64
	// The current's cap, the shadow's floor and the lee's reach.
	currentMost float64
	shadowLeast float64
	leeReach    float64
	leeBand     [leeSpeeds][leeFetches]float64
}

// R2's two steps: the powers 1/φ and 1/φ² of the plastic number
// φ = 1.3247…, the root of x³ = x + 1 (Roberts, "The Unreasonable
// Effectiveness of Quasirandom Sequences", 2018). Successive points
// frac(½ + i·r2a), frac(½ + i·r2b) fill the unit square evenly without the
// rows of a grid.
const (
	r2a = 0.7548776662466927
	r2b = 0.5698402909980532
)

// fullFetch is the dimensionless fetch g F / U² at which the fetch-limited
// peak, 22 (g²/(U F))^⅓, has come down to the fully developed sea's,
// 0.877 g / U (Pierson and Moskowitz 1964): (22 / 0.877)³.
const fullFetch = (22 / 0.877) * (22 / 0.877) * (22 / 0.877)

// PrepareSea derives the sea's waves from its parameters. It is called
// once, by the server at start and by the client after writing SeaParams.
//
// The waves sample the plane of (ln ω, θ) by the R2 sequence: frequencies
// between those of the longest and the shortest wavelength, directions all
// the way round. Each stands for the same area of that plane, so each
// carries the energy the spectrum has there. Phases come from a hash of the
// wave's index.
func PrepareSea(p *SeaParams, w *Waves) {
	lo := math.Sqrt(float64(gravity*2*math.Pi) / p.Longest)
	hi := math.Sqrt(float64(gravity*2*math.Pi) / p.Shortest)
	span := Log(hi / lo)
	for i := range int32(SeaComponents) {
		n := float64(i)
		u := float64(n*r2a) + 0.5
		u -= math.Floor(u)
		v := float64(n*r2b) + 0.5
		v -= math.Floor(v)
		omega := float64(lo * Exp(float64(u*span)))
		k := omega * omega / gravity
		sin, cos := SinCos(float64(v * (2 * math.Pi)))
		w.Omega[i] = omega
		w.K[i] = k
		w.East[i] = sin
		w.North[i] = cos
		w.Phase[i] = float64(float64(hash32(uint32(i))) * (2 * math.Pi / (1 << 32)))
		w.Turns[i] = omega / (2 * math.Pi * StepsPerSecond)
		w.kEast[i] = float64(k * sin)
		w.kNorth[i] = float64(k * cos)
		w.speed[i] = gravity / omega
	}
	w.slice = 2 * (2 * math.Pi) * span / SeaComponents
	w.ruleStep = span / seaRule
	for j := range int32(seaRule) {
		w.rule[j] = float64(lo * Exp(float64((float64(j)+0.5)*w.ruleStep)))
	}
	w.lnGamma = Log(p.Gamma)
	w.invSigmaBelow = 1 / p.SigmaBelow
	w.invSigmaAbove = 1 / p.SigmaAbove
	// ∫ cos²ˢ(θ/2) dθ over a turn is 2π (2s)! / (4ˢ s!²), and
	// 4ˢ s!² / (2s)! is the product of 2j/(2j − 1) for j from 1 to s.
	w.spreading = toInt32(p.Spreading)
	norm := 1 / (2 * math.Pi)
	for j := int32(1); j <= w.spreading; j++ {
		norm = norm * float64(2*j) / float64(2*j-1)
	}
	w.spreadNorm = norm
	w.fetchCap = float64(p.FetchCap * nauticalMile)
	w.cull = p.Cull
	w.breaking = p.Breaking
	w.swellSpreading = max(toInt32(p.SwellSpreading), 1)
	w.swellSigma = max2(p.SwellSigma, 1e-3)
	w.swellLeast = p.SwellLeast
	w.swellSteps = max(toInt32(p.SwellSteps), 1)
	w.currentMost = max2(p.CurrentMost, 1)
	w.shadowLeast = clamp(p.ShadowLeast, 0, 1)
	w.leeReach = max2(p.LeeReach, 1)
	// The waves by frequency: an insertion sort, the same on every machine.
	for i := range int32(SeaComponents) {
		j := i
		for j > 0 && w.omegaSorted[j-1] > w.Omega[i] {
			w.omegaSorted[j], w.byOmega[j] = w.omegaSorted[j-1], w.byOmega[j-1]
			j--
		}
		w.omegaSorted[j], w.byOmega[j] = w.Omega[i], i
	}
	w.prepareLee()
}

// hash32 mixes the bits of x (Wellons's lowbias32).
func hash32(x uint32) uint32 {
	x ^= x >> 16
	x *= 0x7feb352d
	x ^= x >> 15
	x *= 0x846ca68b
	x ^= x >> 16
	return x
}

// SeaInputOf rounds a wind and a fetch to an area's inputs. A wind that is
// not a number, or blows backwards, is no wind.
func SeaInputOf(speed, from, fetch float64) SeaInput {
	s := toInt32(math.Floor(speed/SeaSpeedStep + 0.5))
	f := toInt32(math.Floor(fetch + 0.5))
	d := toInt32(math.Floor(float64(wrapAngle(from)*(1/seaFromStep)) + 0.5))
	return SeaInput{
		Speed: uint32(min(max(s, 0), seaSpeedMax)),
		From:  uint32(d) & (SeaFromSteps - 1),
		Fetch: uint32(min(max(f, 0), seaFetchMax)),
	}
}

// OpenSea is the inputs of an area of open water under a wind: its fetch is
// the catalog's cap.
func (w *Waves) OpenSea(speed, from float64) SeaInput {
	return SeaInputOf(speed, from, w.fetchCap)
}

// FetchDirections is how many directions an area's fetch is known for,
// from north clockwise.
const FetchDirections = 16

// Fetch is an area's fetch for a wind from each of FetchDirections
// directions: the open water upwind of its centre, m.
type Fetch [FetchDirections]float64

// FetchFor is an area's fetch for a wind from from: linear between the two
// nearest directions it is known for.
func FetchFor(f *Fetch, from float64) float64 {
	turns := float64(wrapAngle(from)*(FetchDirections/(2*math.Pi))) + FetchDirections
	k0 := math.Floor(turns)
	t := turns - k0
	k := toInt32(k0) % FetchDirections
	return lerp(t, f[k], f[(k+1)%FetchDirections])
}

// LandSea is the inputs of an area under a wind whose fetch the land
// limits: its fetch for the wind's direction, never more than the
// catalog's cap.
func (w *Waves) LandSea(speed, from float64, f *Fetch) SeaInput {
	return SeaInputOf(speed, from, min2(FetchFor(f, from), w.fetchCap))
}

// FetchCap is the fetch of open water, m.
func (w *Waves) FetchCap() float64 { return w.fetchCap }

// SeaAreaOf is the column of the area whose centre is nearest a point x
// metres east of the world's centre, or the row of the one nearest a point
// that far north: the middle area is SeaAreas / 2. It is not clamped to the
// world.
func SeaAreaOf(v float64) int32 {
	return toInt32(math.Floor(float64(v*(1.0/SeaAreaSize)) + (seaMiddle + 0.5)))
}

// SeaAreaCentre is the centre of the area in a column and row, metres east
// and north of the world's centre.
func SeaAreaCentre(col, row int32) (x, y float64) {
	return float64((col - seaMiddle) * SeaAreaSize), float64((row - seaMiddle) * SeaAreaSize)
}

// SeaWindow holds the amplitudes of a square of areas: the whole world's on
// the server, the few around the boat in a client. Whoever makes one gives
// it its storage, Size² areas of each, zeroed; a step only reads it, so the
// goroutines that step boats share one.
type SeaWindow struct {
	Col, Row int32 // the column (from the west) and the row (from the south) of its first area
	Size     int32 // areas on a side
	// Per area, row by row from the south-west:
	Inputs []SeaInput
	Amp    []float64 // SeaComponents amplitudes each, m
	Hs     []float64 // the significant height of the area's waves, m
	Peak   []float64 // the frequency of the spectral peak of its partition with more energy, rad/s
	// Parts are each partition's: what the lee weighs them by. A window
	// without them is all wind sea.
	Parts []SeaParts
	// Bits are, for each area, SeaWords words whose bits say which waves
	// have an amplitude there: a point sums only those of the four areas
	// about it. A window without them sums every wave of Active.
	Bits []uint64
	// Factors are, for each area, how much its current raises each wave,
	// and FactorKeys the current they are for: an area's current changes
	// seldom, so they are worked out once. A window without them works
	// them out each time.
	Factors    []float64
	FactorKeys []uint64
	// Active lists the waves with an amplitude in any of the window's
	// areas, ascending; Count is how many. Seal fills them.
	Active [SeaComponents]int32
	Count  int32

	last  int32 // the area computed last, whose amplitudes one with the same inputs copies
	stale bool  // Active is out of date
	// Room for an area's swell's amplitudes and each wave's current factor
	// while they are made: a module's allocator never frees.
	swell, factor [SeaComponents]float64
	// The spectra of the area made last, before its current: an area that
	// differs from it only by its current, as most do in a steady wind,
	// takes them and is spared the spectra's sums.
	spectra spectra
}

// spectra are an area's partitions' amplitudes before its current, for the
// inputs but the current in.
type spectra struct {
	in                            SeaInput
	have                          bool
	wind, swell                   [SeaComponents]float64
	windPeak, windBand, swellPeak float64
	first, last                   int32 // the swell's waves, by frequency
}

// SeaArea sets the inputs of the window's area i, and with them its
// amplitudes. An area that already has those inputs is left alone, and one
// whose inputs are those of the area computed before it copies that area's
// amplitudes: under one wind the whole sea costs one computation.
func SeaArea(w *Waves, win *SeaWindow, i int32, in SeaInput) {
	if win.Inputs[i] == in {
		return
	}
	win.Inputs[i] = in
	win.stale = true
	amp := win.Amp[i*SeaComponents : (i+1)*SeaComponents]
	if j := win.last; j != i && win.Inputs[j] == in {
		copy(amp, win.Amp[j*SeaComponents:(j+1)*SeaComponents])
		win.Hs[i], win.Peak[i] = win.Hs[j], win.Peak[j]
		if win.Parts != nil {
			win.Parts[i] = win.Parts[j]
		}
		return
	}
	factor := win.factor[:]
	if in.CurrentEast != 0 || in.CurrentNorth != 0 {
		ue := float64(float64(in.CurrentEast) * SeaCurrentStep)
		un := float64(float64(in.CurrentNorth) * SeaCurrentStep)
		if win.Factors == nil {
			w.currentFactors(ue, un, factor)
		} else {
			factor = win.Factors[i*SeaComponents : (i+1)*SeaComponents]
			// 0 is no key: a current's steps lie within ±seaCurrentMax.
			key := uint64(in.CurrentEast+seaCurrentMax+1)<<32 | uint64(in.CurrentNorth+seaCurrentMax+1)
			if win.FactorKeys[i] != key {
				w.currentFactors(ue, un, factor)
				win.FactorKeys[i] = key
			}
		}
	}
	hs, peak, parts := w.amplitudes(in, amp, &win.swell, factor, &win.spectra)
	win.Hs[i], win.Peak[i] = hs, peak
	if win.Parts != nil {
		win.Parts[i] = parts
	}
	win.last = i
}

// word is word k of the waves with an amplitude in any of the four areas
// corners found: the union of their Bits, every wave for a window without
// them.
func (win *SeaWindow) word(k, sw, se, nw, ne int32) uint64 {
	if win.Bits == nil {
		return ^uint64(0)
	}
	return win.Bits[sw/SeaComponents*SeaWords+k] | win.Bits[se/SeaComponents*SeaWords+k] |
		win.Bits[nw/SeaComponents*SeaWords+k] | win.Bits[ne/SeaComponents*SeaWords+k]
}

// Seal makes the window ready for steps, after its areas are set.
func (win *SeaWindow) Seal() {
	if !win.stale {
		return
	}
	win.stale = false
	var used [SeaComponents]bool
	if win.Bits != nil {
		clear(win.Bits)
	}
	for i, a := range win.Amp {
		if a > 0 {
			c := i % SeaComponents
			used[c] = true
			if win.Bits != nil {
				win.Bits[i/SeaComponents*SeaWords+c>>6] |= 1 << (c & 63)
			}
		}
	}
	n := int32(0)
	for c := range int32(SeaComponents) {
		if used[c] {
			win.Active[n] = c
			n++
		}
	}
	win.Count = n
}

// amplitudes writes the amplitude of every wave of an area, and returns the
// significant height of their sum, the frequency of the spectral peak of
// its partition with more energy, and its partitions: with swell for room,
// factor each wave's current factor, read only if the area has a current,
// and last the spectra of the area made before, which it takes if only the
// current differs, and else replaces.
//
// The sea is two partitions, as a spectrum with two peaks is (Ochi and
// Hubble 1976; the WMO's Guide to Wave Analysis and Forecasting, 2018): the
// wind sea the area's wind raises, and the swell that reaches it from a
// storm. Each is scaled to its own variance and culled against its own
// highest wave, so that a swell does not take a light wind's sea away; a
// wave's amplitude is then √(a_w² + a_s²), and the variances add. Each wave
// is raised or lowered by the current along its path first.
func (w *Waves) amplitudes(in SeaInput, amp []float64, swell *[SeaComponents]float64, factor []float64, last *spectra) (hs, peak float64, parts SeaParts) {
	current := in.CurrentEast != 0 || in.CurrentNorth != 0
	var f []float64
	if current {
		f = factor
	}
	hasSwell := in.SwellHeight != 0 && in.SwellPeriod != 0
	calm := in
	calm.CurrentEast, calm.CurrentNorth = 0, 0
	var highW, highS float64
	if last.have && last.in == calm {
		parts.WindPeak, parts.WindBand, parts.SwellPeak = last.windPeak, last.windBand, last.swellPeak
		highW = raise(amp, last.wind[:], f)
		if hasSwell {
			clear(swell[:])
			for j := last.first; j < last.last; j++ {
				i := w.byOmega[j]
				v := last.swell[i]
				if f != nil {
					v = float64(v * f[i])
				}
				swell[i] = v
				highS = max2(highS, v)
			}
		}
	} else {
		parts.WindPeak, parts.WindBand, highW = w.windSea(in, amp, f, last.wind[:])
		last.in, last.have = calm, true
		last.windPeak, last.windBand, last.swellPeak, last.first, last.last = parts.WindPeak, parts.WindBand, 0, 0, 0
		if hasSwell {
			clear(swell[:])
			parts.SwellPeak, last.first, last.last, highS = w.swellSea(in, swell, f, &last.swell)
			last.swellPeak = parts.SwellPeak
		}
	}
	floorW, floorS := float64(w.cull*highW), float64(w.cull*highS)
	sumW, sumS, still := 0.0, 0.0, 0.0
	for i, a := range amp {
		if a < floorW {
			a = 0
		}
		s := 0.0
		if hasSwell {
			if s = swell[i]; s < floorS {
				s = 0
			}
		}
		a2, s2 := float64(a*a), float64(s*s)
		sumW += a2
		sumS += s2
		if current && a2+s2 > 0 {
			still += float64(a2+s2) / float64(f[i]*f[i])
		}
		if s > 0 {
			a = math.Sqrt(a2 + s2)
		}
		amp[i] = a
	}
	parts.WindHs = float64(4 * math.Sqrt(float64(0.5*sumW)))
	parts.SwellHs = float64(4 * math.Sqrt(float64(0.5*sumS)))
	hs = float64(4 * math.Sqrt(float64(0.5*(sumW+sumS))))
	parts.StillHs = hs
	if current {
		parts.StillHs = float64(4 * math.Sqrt(float64(0.5*still)))
	}
	peak = parts.WindPeak
	if sumS > sumW {
		peak = parts.SwellPeak
	}
	return hs, peak, parts
}

// raise writes to amp the amplitudes from, each raised by its current
// factor in f if f is not nil, and returns the highest.
func raise(amp, from, f []float64) (high float64) {
	for i, v := range from {
		if f != nil {
			v = float64(v * f[i])
		}
		amp[i] = v
		high = max2(high, v)
	}
	return high
}

// windSea writes the amplitude of every wave under a wind over a fetch,
// scaled to the variance its spectrum has over the band and not yet
// culled, and returns the frequency of the spectrum's peak.
//
// The spectrum is JONSWAP's (Hasselmann and others 1973):
//
//	S(ω) = α g² ω⁻⁵ exp(−5/4 (ω_p/ω)⁴) γ^r,  r = exp(−(ω − ω_p)² / (2 σ² ω_p²))
//
// with the fits to fetch F and wind U, α = 0.076 (g F / U²)^−0.22 and
// ω_p = 22 (g² / (U F))^⅓. A sea cannot grow past full development, so the
// fetch counts only up to where the peak reaches Pierson and Moskowitz's.
// Energy spreads about the wind's direction as cos²ˢ(θ/2) (Mitsuyasu and
// others 1975). A wave's amplitude is √(2 S D ω Δ), Δ the area of the
// (ln ω, θ) plane it stands for.
//
// A few hundred waves sample that plane coarsely: where the spectrum is
// steep their sum would be a tenth higher or lower as the wind swings
// round. So the amplitudes are scaled together to carry exactly the
// variance the spectrum has over the band. Each is written to pre as it is,
// and to amp raised by its current factor, if factor is not nil; it returns
// the highest of amp too.
func (w *Waves) windSea(in SeaInput, amp, factor, pre []float64) (peak, m0, high float64) {
	u := float64(float64(in.Speed) * SeaSpeedStep)
	f := float64(in.Fetch)
	if !(u > 0) || !(f > 0) {
		clear(amp)
		clear(pre)
		return 0, 0, 0
	}
	alpha, peak := jonswapFit(u, f)
	// Waves travel toward where the wind blows to: a half turn from where
	// it comes from, which only changes the signs.
	sinFrom, cosFrom := SinCos(float64(float64(in.From) * seaFromStep))
	sinTo, cosTo := -sinFrom, -cosFrom
	level := float64(alpha * (gravity * gravity))
	scale := float64(float64(w.slice*level) * w.spreadNorm)
	sum := 0.0
	for i := range amp {
		om := w.Omega[i]
		// cos²(θ/2) = (1 + cos θ)/2, θ the wave's direction off the wind's.
		half := float64(0.5 * (1 + (float64(w.North[i]*cosTo) + float64(w.East[i]*sinTo))))
		spread := 1.0
		for range w.spreading {
			spread *= half
		}
		a2 := float64(float64(scale*w.shape(om, peak)) * spread)
		amp[i] = a2
		sum += a2
	}
	m0 = w.bandVariance(level, peak)
	fit := 0.0
	if sum > 0 {
		fit = 2 * m0 / sum
	}
	for i, a2 := range amp {
		v := math.Sqrt(float64(a2 * fit))
		pre[i] = v
		if factor != nil {
			v = float64(v * factor[i])
		}
		amp[i] = v
		high = max2(high, v)
	}
	return peak, m0, high
}

// jonswapFit is the JONSWAP fits' α and peak frequency for a wind of u m/s
// over a fetch of f m, the fetch counting only up to full development.
func jonswapFit(u, f float64) (alpha, peak float64) {
	x := min2(float64(gravity*f)/float64(u*u), fullFetch)
	alpha = float64(0.076 * Exp(float64(-0.22*Log(x))))
	// g² / (U F) = (g / U)³ / x.
	peak = float64(float64(22*gravity) / u * Exp(float64(Log(x)*(-1.0/3))))
	return alpha, peak
}

// bandVariance is the variance over the band of a spectrum of level α g²
// whose peak is at peak, ∫ S dω = ∫ S ω d(ln ω), by the midpoint rule.
func (w *Waves) bandVariance(level, peak float64) float64 {
	m0 := 0.0
	for _, om := range w.rule {
		m0 += w.shape(om, peak)
	}
	return float64(float64(m0*level) * w.ruleStep)
}

// The waves' lee needs the band's variance of a wind sea over short water:
// a table of it by the wind's speed, every leeSpeedStep m/s up to
// leeSpeeds of them, and by the fetch, every leeFetchStep m up to the
// most a table's lee byte holds.
const (
	leeSpeeds    = 41
	leeSpeedStep = 1.0 // m/s
	leeFetches   = 17
	leeFetchStep = 16 * ShelterLeeStep // m
)

// prepareLee fills the table.
func (w *Waves) prepareLee() {
	for i := range int32(leeSpeeds) {
		u := float64(float64(i) * leeSpeedStep)
		for j := range int32(leeFetches) {
			f := float64(float64(j) * leeFetchStep)
			if !(u > 0) || !(f > 0) {
				w.leeBand[i][j] = 0
				continue
			}
			alpha, peak := jonswapFit(u, f)
			w.leeBand[i][j] = w.bandVariance(float64(alpha*(gravity*gravity)), peak)
		}
	}
}

// leeVariance is the band's variance of a wind sea of u m/s over f m of
// short water: bilinear in the table, held at its fastest wind.
func (w *Waves) leeVariance(u, f float64) float64 {
	su := min2(max2(u*(1/leeSpeedStep), 0), leeSpeeds-1)
	sf := min2(max2(f*(1.0/leeFetchStep), 0), leeFetches-1)
	i0, j0 := math.Floor(su), math.Floor(sf)
	tu, tf := su-i0, sf-j0
	i, j := toInt32(i0), toInt32(j0)
	i1, j1 := min(i+1, leeSpeeds-1), min(j+1, leeFetches-1)
	a := lerp(tf, w.leeBand[i][j], w.leeBand[i][j1])
	b := lerp(tf, w.leeBand[i1][j], w.leeBand[i1][j1])
	return lerp(tu, a, b)
}

// shape returns S(ω) ω / (α g²) for a spectrum whose peak is at peak: what
// a wave at ω carries per unit of ln ω.
func (w *Waves) shape(om, peak float64) float64 {
	inv := w.invSigmaAbove
	if om < peak {
		inv = w.invSigmaBelow
	}
	d := float64((om - peak) * inv / peak)
	r := Exp(float64(-0.5 * d * d))
	q := peak / om
	q *= q
	om2 := float64(om * om)
	return Exp(float64(-1.25*q*q)+float64(r*w.lnGamma)) / float64(om2*om2)
}

// SeaTick is the sea's time: each wave's phase from its frequency, at a
// tick.
type SeaTick struct {
	Tick  float64
	Phase [SeaComponents]float64 // 2π × the fraction of ω t / 2π, rad
}

// SeaAt sets t to the sea's time at a tick, which need not be whole: a
// client draws the sea between ticks.
//
// A tick is a large number, 2³¹ within three years of a world's first, and a
// wave turns through a few hundredths of a cycle in one, so the product is
// taken exactly (Dekker 1971) and only its fraction kept. It is good for
// ticks up to 2⁵³, and every machine gets the same bits.
func SeaAt(w *Waves, t *SeaTick, tick float64) {
	t.Tick = tick
	for i := range w.Turns {
		p, e := twoProd(w.Turns[i], tick)
		t.Phase[i] = float64(((p - math.Floor(p)) + e) * (2 * math.Pi))
	}
}

// SeaAtTick is SeaAt for a whole tick, as a simulation counts them.
func SeaAtTick(w *Waves, t *SeaTick, tick int64) { SeaAt(w, t, float64(tick)) }

// Sea is the sea a step reads: the waves, the amplitudes of the areas about
// the boat, the time, and the shelter whose tables calm the waves in the
// land's lee (lee.go), nil for none. A nil *Sea is flat water.
type Sea struct {
	Waves  *Waves
	Window *SeaWindow
	Tick   *SeaTick
	Lee    *Shelter
}

// corners finds the four areas whose centres surround (x, y), clamped to
// the window, and the weights of the eastern and the northern pair: the
// fractions of the way between centres, smoothed so that the blend's slope
// is continuous across every line of centres.
func (win *SeaWindow) corners(x, y float64) (sw, se, nw, ne int32, wx, wy float64) {
	fx := float64(x*(1.0/SeaAreaSize)) + seaMiddle
	fy := float64(y*(1.0/SeaAreaSize)) + seaMiddle
	cx, cy := math.Floor(fx), math.Floor(fy)
	wx, wy = smooth(fx-cx), smooth(fy-cy)
	last := win.Size - 1
	c0 := toInt32(cx) - win.Col
	r0 := toInt32(cy) - win.Row
	c1 := min(max(c0+1, 0), last)
	r1 := min(max(r0+1, 0), last)
	c0 = min(max(c0, 0), last)
	r0 = min(max(r0, 0), last)
	return (r0*win.Size + c0) * SeaComponents, (r0*win.Size + c1) * SeaComponents,
		(r1*win.Size + c0) * SeaComponents, (r1*win.Size + c1) * SeaComponents, wx, wy
}

// blend mixes one wave's amplitude between the four areas. Where the four
// agree it returns their value exactly.
func blend(amp []float64, sw, se, nw, ne int32, wx, wy float64) float64 {
	s := amp[sw] + float64(wx*(amp[se]-amp[sw]))
	n := amp[nw] + float64(wx*(amp[ne]-amp[nw]))
	return s + float64(wy*(n-s))
}

// SeaPoint is the sea at a point.
type SeaPoint struct {
	Height float64 // m
	East   float64 // slope: the rise per metre eastward
	North  float64 // and northward
	Hs     float64 // the significant height of the waves here, m, in the lee and before the depth caps them
}

// SeaSample returns the sea's height and slope at the point x metres east
// and y north of the world's centre, scaled by the land's lee there
// (LeeAt) and then capped by the depth of the ground g there (DepthFactor),
// or nil for the open sea. The slope is that of the
// waves alone: the blend between areas changes the amplitudes over hundreds
// of metres, which adds at most a ten-thousandth to it, and is left out
// here as it is wherever the sea is drawn.
func SeaSample(sea *Sea, g *Ground, x, y float64) SeaPoint {
	var p SeaPoint
	w, win, t := sea.Waves, sea.Window, sea.Tick
	sw, se, nw, ne, wx, wy := win.corners(x, y)
	// The waves of the four areas, ascending.
	for k := range int32(SeaWords) {
		for word := win.word(k, sw, se, nw, ne); word != 0; word &= word - 1 {
			i := k*64 + int32(bits.TrailingZeros64(word))
			a := blend(win.Amp, sw+i, se+i, nw+i, ne+i, wx, wy)
			if !(a > 0) {
				continue
			}
			psi := (w.Phase[i] + (float64(w.kEast[i]*x) + float64(w.kNorth[i]*y))) - t.Phase[i]
			sin, cos := SinCos(psi)
			p.Height += float64(a * sin)
			ac := float64(a * cos)
			p.East += float64(ac * w.kEast[i])
			p.North += float64(ac * w.kNorth[i])
		}
	}
	p.Hs = win.hsAt(sw, se, nw, ne, wx, wy)
	if f := LeeAt(sea, x, y); f != 1 {
		p.Height, p.East, p.North = float64(p.Height*f), float64(p.East*f), float64(p.North*f)
		p.Hs = float64(p.Hs * f)
	}
	if f := depthFactor(w, g, x, y, p.Hs); f < 1 {
		p.Height, p.East, p.North = float64(p.Height*f), float64(p.East*f), float64(p.North*f)
	}
	return p
}

// hsAt is the significant height between the four areas corners found,
// blended with their weights.
func (win *SeaWindow) hsAt(sw, se, nw, ne int32, wx, wy float64) float64 {
	hs := win.Hs
	a, b, c, d := sw/SeaComponents, se/SeaComponents, nw/SeaComponents, ne/SeaComponents
	s := hs[a] + float64(wx*(hs[b]-hs[a]))
	n := hs[c] + float64(wx*(hs[d]-hs[c]))
	return s + float64(wy*(n-s))
}

// The waves feel the depth. In water shallower than they are high they
// break, and in the inner surf zone the significant height is about 0.4 to
// 0.5 of the depth, the largest waves being about twice Hs (Bosboom and
// Stive, Coastal Dynamics, 5.2.5; McCowan 1894 has a regular wave break at
// 0.78 of the depth, and Goda 2010 random waves begin to break about 30%
// lower). So where the water under a place is h deep and the sea's
// significant height there is Hs, its waves are scaled by
//
//	f = min(1, γ h / Hs)
//
// γ the catalog's breaking share, and on land by 0. Where h ≥ Hs / γ, or
// there is no ground, f is exactly 1 and nothing is scaled: the sea is bit
// for bit the deep sea's.

// DepthFactor is f at (x, y) for a sea whose significant height there is
// hs: by the depth of the hexagon that holds the point, 1 where g is nil.
func DepthFactor(w *Waves, g *Ground, x, y, hs float64) float64 {
	return depthFactor(w, g, x, y, hs)
}

func depthFactor(w *Waves, g *Ground, x, y, hs float64) float64 {
	if g == nil || !(hs > 0) {
		return 1
	}
	e, _ := g.cellAt(HexAt(x, y))
	keep := float64(w.breaking * float64(float64(-e)*0.1))
	if !(keep < hs) {
		return 1
	}
	return max2(keep/hs, 0)
}

// hsAt is the significant height of the sea at (x, y), for the depth's cap
// on the waves there.
func (sea *Sea) hsAt(x, y float64) float64 {
	sw, se, nw, ne, wx, wy := sea.Window.corners(x, y)
	return sea.Window.hsAt(sw, se, nw, ne, wx, wy)
}
