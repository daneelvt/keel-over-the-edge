// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

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

// SeaInput is what raises the waves of one area, in whole steps.
type SeaInput struct {
	Speed uint32 // the wind that raises the waves, 10 m up, in steps of SeaSpeedStep
	From  uint32 // the direction it comes from, clockwise from north, in steps of a turn / SeaFromSteps
	Fetch uint32 // the open water the wind has blown over, m
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
	Peak   []float64 // the frequency of the area's spectral peak, rad/s
	// Active lists the waves with an amplitude in any of the window's
	// areas, ascending; Count is how many. Seal fills them.
	Active [SeaComponents]int32
	Count  int32

	last  int32 // the area computed last, whose amplitudes one with the same inputs copies
	stale bool  // Active is out of date
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
		return
	}
	win.Hs[i], win.Peak[i] = w.amplitudes(in, amp)
	win.last = i
}

// Seal makes the window ready for steps, after its areas are set.
func (win *SeaWindow) Seal() {
	if !win.stale {
		return
	}
	win.stale = false
	var used [SeaComponents]bool
	for i, a := range win.Amp {
		if a > 0 {
			used[i%SeaComponents] = true
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

// amplitudes writes the amplitude of every wave under a wind over a fetch,
// and returns the significant height of their sum and the frequency of the
// spectrum's peak.
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
// variance the spectrum has over the band. Then those below the cull
// fraction of the highest are left out.
func (w *Waves) amplitudes(in SeaInput, amp []float64) (hs, peak float64) {
	u := float64(float64(in.Speed) * SeaSpeedStep)
	f := float64(in.Fetch)
	if !(u > 0) || !(f > 0) {
		for i := range amp {
			amp[i] = 0
		}
		return 0, 0
	}
	x := min2(float64(gravity*f)/float64(u*u), fullFetch)
	alpha := float64(0.076 * Exp(float64(-0.22*Log(x))))
	// g² / (U F) = (g / U)³ / x.
	peak = float64(float64(22*gravity) / u * Exp(float64(Log(x)*(-1.0/3))))
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
	// The spectrum's variance over the band, ∫ S dω = ∫ S ω d(ln ω), by the
	// midpoint rule.
	m0 := 0.0
	for _, om := range w.rule {
		m0 += w.shape(om, peak)
	}
	m0 = float64(float64(m0*level) * w.ruleStep)
	fit := 0.0
	if sum > 0 {
		fit = 2 * m0 / sum
	}
	highest := 0.0
	for i, a2 := range amp {
		a := math.Sqrt(float64(a2 * fit))
		amp[i] = a
		if a > highest {
			highest = a
		}
	}
	floor := float64(w.cull * highest)
	sum = 0
	for i, a := range amp {
		if a < floor {
			amp[i] = 0
			continue
		}
		sum += float64(a * a)
	}
	return float64(4 * math.Sqrt(float64(0.5*sum))), peak
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
// the boat, and the time. A nil *Sea is flat water.
type Sea struct {
	Waves  *Waves
	Window *SeaWindow
	Tick   *SeaTick
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
	Hs     float64 // the significant height of the waves here, m
}

// SeaSample returns the sea's height and slope at the point x metres east
// and y north of the world's centre. The slope is that of the waves alone:
// the blend between areas changes the amplitudes over hundreds of metres,
// which adds at most a ten-thousandth to it, and is left out here as it is
// wherever the sea is drawn.
func SeaSample(sea *Sea, x, y float64) SeaPoint {
	var p SeaPoint
	w, win, t := sea.Waves, sea.Window, sea.Tick
	sw, se, nw, ne, wx, wy := win.corners(x, y)
	for _, i := range win.Active[:win.Count] {
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
	hs := win.Hs
	a, b, c, d := sw/SeaComponents, se/SeaComponents, nw/SeaComponents, ne/SeaComponents
	s := hs[a] + float64(wx*(hs[b]-hs[a]))
	n := hs[c] + float64(wx*(hs[d]-hs[c]))
	p.Hs = s + float64(wy*(n-s))
	return p
}
