// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Swell: the long waves a storm raises, which outrun it. Away from the
// wind that raised them they travel at their group speed, half their phase
// speed in deep water, gT/4π (Stewart, Introduction to Physical
// Oceanography, 16.1; Bowditch, The American Practical Navigator, 37), and
// come from the general direction of the storm (Bowditch, Tropical
// Cyclones). So the swell at a place at a tick left its storm when the
// storm was as far away as the swell has travelled since: the retarded
// time τ, with |A − P(τ)| = c_g (t − τ), which a few of Newton's steps
// find, since the storm moves slower than its swell.
//
// The longest waves travel fastest and arrive first (Snodgrass and others
// 1966): where the storm was born too recently for its whole band to have
// come, only the waves long enough to have covered the distance since are
// there, and its height grows as the rest arrive. So the period shortens
// as a storm nears, as it does before a hurricane (NOAA AOML Hurricane
// Research Division).
//
// Far from its source a swell weakens by spreading alone: over the disk
// dissipation takes nothing (Ardhuin, Chapron and Collard 2009, an
// e-folding of thousands of kilometres), and on a plane the height falls as
// the square root of the distance. So at its storm's edge it is the
// storm's own, by its strength when it left, and beyond it falls as
// √(R / d).

// swellKind is a kind's swell, as SwellAt computes with it.
type swellKind struct {
	period [2]float64 // s
	band   [2]float64 // s
	height [2]float64 // m
	wind   [2]float64 // m/s
}

// setSwell sets a kind's swell from its SystemKind.
func (k *systemKind) setSwell(s *SystemKind) {
	k.swell = swellKind{
		period: s.SwellPeriod,
		band:   s.SwellBand,
		height: s.SwellHeight,
		wind:   [2]float64{float64(s.SwellWind[0] * knotSpeed), float64(s.SwellWind[1] * knotSpeed)},
	}
}

// swellSamples is how many periods across a kind's band the swell at a
// place is summed over.
const swellSamples = 5

// SwellAt is the swell at (x, y) at a tick, which need not be whole, from
// the system of record r, whose kind the weather p holds. A kind that
// raises none, a system not yet born or long gone, or a swell lower than
// the sea's least, is none: a Swell of no height.
//
// The swell is summed over a few periods across the kind's band, each
// weighed by the swell's spectrum about the system's own peak period. Each
// period's waves at the place left the system at their own time, at their
// own group speed, and carry its strength then, spread beyond its edge by
// the distance they came: so a growing storm's longest waves, which left it
// last, arrive first and strongest, and the swell's period shortens as the
// rest arrive. Its height is the spectrum's share that has come at the
// storm's strength; its period that of the mean frequency of what has come,
// by energy; its direction toward where its strongest part left.
func SwellAt(w *Waves, p *WeatherPrepared, r *SystemRecord, x, y, tick float64) Swell {
	k := p.kindOf(r.Kind)
	if k == nil || !(k.swell.height[1] > 0) || !(tick > r.Born) {
		return Swell{}
	}
	sk := &k.swell
	// Its peak period, drawn per system from its seed; its height at its
	// edge by its peak wind.
	u := float64(float64(hash32(seedBits(r.Seed)^0x5bd1e995)) * (1.0 / (1 << 32)))
	peak := float64(2*math.Pi) / lerp(u, sk.period[0], sk.period[1])
	h0 := SwellHeight(p, r)
	inv := 1 / float64(w.swellSigma*peak)
	lo, hi := float64(2*math.Pi)/sk.band[1], float64(2*math.Pi)/sk.band[0]
	step := (hi - lo) * (1.0 / swellSamples)
	var total, sum, omega, best float64
	var out Swell
	for i := range int32(swellSamples) {
		om := lo + float64(step*(float64(i)+0.5))
		d := float64((om - peak) * inv)
		weight := Exp(float64(-0.5 * d * d))
		total += weight
		perTick := float64(float64(gravity/float64(2*om)) * Dt)
		tau, far, dx, dy := retarded(r, x, y, tick, perTick, w.swellSteps)
		if !(tau >= r.Born) {
			continue
		}
		s := SystemAt(r, tau)
		if s.On == 0 {
			continue
		}
		a := float64(s.Strength * strengthStep)
		if far > s.Size {
			a = float64(a * math.Sqrt(s.Size/far))
		}
		e := float64(weight * float64(a*a))
		sum += e
		omega += float64(e * om)
		if e > best {
			best = e
			out.Far = far
			out.From = 0
			if dx != 0 || dy != 0 {
				out.From = Atan2(dx, dy)
			}
		}
	}
	if !(sum > 0) {
		return Swell{}
	}
	out.Height = float64(h0 * math.Sqrt(sum/total))
	if !(out.Height >= w.swellLeast) {
		return Swell{}
	}
	out.Period = float64(2*math.Pi) / (omega / sum)
	return out
}

// retarded is when the waves at (x, y) at a tick that travel perTick m a
// tick left the system of record r: by Newton's steps on |A − P(τ)| −
// c_g (t − τ) from the tick itself, the system's motion over a tick for
// the slope, which is never less than the difference of their speeds as
// long as it moves slower than they do. It returns the time, how far the
// waves came, and the way from the place to where they left, east and
// north.
func retarded(r *SystemRecord, x, y, tick, perTick float64, steps int32) (tau, far, dx, dy float64) {
	tau = tick
	for range steps {
		ex, ey := swellSource(r, tau)
		nx, ny := swellSource(r, tau+1)
		dx, dy = ex-x, ey-y
		far = math.Sqrt(float64(dx*dx) + float64(dy*dy))
		miss := far - float64(perTick*(tick-tau))
		slope := perTick
		if far > 0 {
			slope += float64(float64(dx*(nx-ex))+float64(dy*(ny-ey))) / far
		}
		tau -= miss / slope
	}
	ex, ey := swellSource(r, tau)
	dx, dy = ex-x, ey-y
	return tau, math.Sqrt(float64(dx*dx) + float64(dy*dy)), dx, dy
}

// swellSource is where a system is at a tick, by its track and its wobble,
// m east and north of the centre: where its swell leaves from. Before its
// birth and after its end its track goes on.
func swellSource(r *SystemRecord, tick float64) (east, north float64) {
	t := min2(max2(tick, r.Born), r.Gone)
	if v, on := recordAt(r, t); on {
		return v.east, v.north
	}
	return SystemTrack(r, t)
}

// CombineSwell is two storms' swell at a place as one: their variances
// added, with the period and the direction of the higher.
func CombineSwell(a, b Swell) Swell {
	if b.Height > a.Height {
		a, b = b, a
	}
	if !(b.Height > 0) {
		return a
	}
	a.Height = math.Sqrt(float64(a.Height*a.Height) + float64(b.Height*b.Height))
	return a
}

// Shadow is the share of a swell that reaches an area whose fetch is f,
// behind the land between it and where the swell left its storm: the open
// water toward where the swell comes from over how far it has come, at
// least the sea's least, which diffraction fills behind any island ("never
// completely devoid of waves", Arthur 1951; behind the Channel Islands
// Violante-Carvalho and others 2021 find the swell recovering only slowly).
// A nil fetch is open water's.
func (w *Waves) Shadow(f *Fetch, s Swell) float64 {
	if f == nil || !(s.Far > 0) {
		return 1
	}
	open := min2(FetchFor(f, s.From), w.fetchCap)
	return w.shadowLeast + float64((1-w.shadowLeast)*min2(open/s.Far, 1))
}

// swellSea writes the amplitudes of the area's swell, scaled to the
// variance it has over the band, and returns its peak frequency; with none
// it writes nothing and returns 0.
//
// A swell's spectrum is narrow: a Gaussian in frequency about its peak,
// σ of the peak frequency wide (Torsethaugen and Haver give a swell's peak
// a shape factor of 1, no enhancement), spread as cos²ˢ(θ/2) about the way
// it travels, s large (Goda and Suzuki 1975: 75 for swell). Only the waves
// within four widths of its peak are visited.
func (w *Waves) swellSea(in SeaInput, amp *[SeaComponents]float64) (peak float64) {
	if in.SwellHeight == 0 || in.SwellPeriod == 0 {
		return 0
	}
	hs := float64(float64(in.SwellHeight) * SeaSwellHeightStep)
	period := float64(float64(in.SwellPeriod) * SeaSwellPeriodStep)
	peak = float64(2*math.Pi) / period
	width := float64(w.swellSigma * peak)
	inv := 1 / width
	// The Gaussian's share inside the band: ∫ G dω = ∫ G ω d(ln ω), by the
	// midpoint rule, over its whole, σ √(2π).
	inside := 0.0
	for _, om := range w.rule {
		d := float64((om - peak) * inv)
		inside += float64(Exp(float64(-0.5*d*d)) * om)
	}
	inside = float64(float64(inside*w.ruleStep)*inv) * (1 / math.Sqrt(2*math.Pi))
	m0 := float64(float64(float64(hs*hs)*(1.0/16)) * min2(inside, 1))
	sinFrom, cosFrom := SinCos(float64(float64(in.SwellFrom) * seaFromStep))
	sinTo, cosTo := -sinFrom, -cosFrom
	lo, hi := peak-float64(4*width), peak+float64(4*width)
	first := w.omegaIndex(lo)
	last := w.omegaIndex(hi)
	sum := 0.0
	for j := first; j < last; j++ {
		i := w.byOmega[j]
		om := w.Omega[i]
		d := float64((om - peak) * inv)
		half := float64(0.5 * (1 + (float64(w.North[i]*cosTo) + float64(w.East[i]*sinTo))))
		a2 := float64(float64(Exp(float64(-0.5*d*d))*om) * power(half, w.swellSpreading))
		amp[i] = a2
		sum += a2
	}
	if !(sum > 0) {
		return 0
	}
	fit := 2 * m0 / sum
	for j := first; j < last; j++ {
		i := w.byOmega[j]
		amp[i] = math.Sqrt(float64(amp[i] * fit))
	}
	return peak
}

// omegaIndex is how many of the waves have a frequency below om.
func (w *Waves) omegaIndex(om float64) int32 {
	lo, hi := int32(0), int32(SeaComponents)
	for lo < hi {
		m := (lo + hi) / 2
		if w.omegaSorted[m] < om {
			lo = m + 1
		} else {
			hi = m
		}
	}
	return lo
}

// power is x to the whole power n ≥ 0, by squaring.
func power(x float64, n int32) float64 {
	r := 1.0
	for n > 0 {
		if n&1 != 0 {
			r = float64(r * x)
		}
		x = float64(x * x)
		n >>= 1
	}
	return r
}

// currentFactor is how much a current (ue, un), m/s, raises wave i, as
// wave action is kept on it. For a current U along a wave's path, its
// amplitude goes as
//
//	a / a₀ = c₀ / √((2U + c) c),  c = ½ c₀ (1 + √(1 + 4U / c₀))
//
// (Longuet-Higgins and Stewart 1961, as Phillips, The Dynamics of the
// Upper Ocean, 1977, gives it), which is 2 / ((1 + r) √r) with
// r = √(1 + 4U / c₀). Against the current (U < 0) the wave is raised,
// blocked at U = −c₀/4; with it, lowered. Its length is kept: the sea's
// waves are fixed, so the current raises them rather than shortening them
// too. A blocked wave, and any raised more, is raised by the sea's most.
func (w *Waves) currentFactor(i int32, ue, un float64) float64 {
	along := float64(ue*w.East[i]) + float64(un*w.North[i])
	if along == 0 {
		return 1
	}
	q := 1 + float64(4*along)/w.speed[i]
	if !(q > 0) {
		return w.currentMost
	}
	r := math.Sqrt(q)
	return min2(2/float64((1+r)*math.Sqrt(r)), w.currentMost)
}

// CurrentFactor is how much a current (east, north), m/s, raises the
// waves of a sea whose peak is at peak rad/s travelling toward to, rad
// clockwise from north: the factor for a wave of that frequency and way,
// for drawing and the developer's instruments.
func (w *Waves) CurrentFactor(east, north, peak, to float64) float64 {
	if !(peak > 0) {
		return 1
	}
	sin, cos := SinCos(to)
	along := float64(east*sin) + float64(north*cos)
	if along == 0 {
		return 1
	}
	q := 1 + float64(float64(4*along)*peak)/gravity
	if !(q > 0) {
		return w.currentMost
	}
	r := math.Sqrt(q)
	return min2(2/float64((1+r)*math.Sqrt(r)), w.currentMost)
}

// RaisesSwell says whether a system of kind raises swell.
func (w *WeatherPrepared) RaisesSwell(kind float64) bool {
	k := w.kindOf(kind)
	return k != nil && k.swell.height[1] > 0
}

// SwellLinger is how long after its end a system of kind's swell may still
// be on the disk, ticks: the time the band's shortest, slowest waves take
// to cross it.
func (w *WeatherPrepared) SwellLinger(kind float64) float64 {
	k := w.kindOf(kind)
	if k == nil || !(k.swell.height[1] > 0) || !(k.swell.band[0] > 0) {
		return 0
	}
	speed := float64(gravity*k.swell.band[0]) / (4 * math.Pi)
	return math.Ceil(float64(float64(2*w.Edge())/speed) * StepsPerSecond)
}

// SwellHeight is the significant height of the swell a system of record r
// raises at its edge at full strength, m: by its kind's swell and its peak
// wind; 0 for a kind that raises none.
func SwellHeight(p *WeatherPrepared, r *SystemRecord) float64 {
	k := p.kindOf(r.Kind)
	if k == nil || !(k.swell.height[1] > 0) {
		return 0
	}
	sk := &k.swell
	share := 1.0
	if span := sk.wind[1] - sk.wind[0]; span > 0 {
		share = clamp(float64((float64(r.Peak*SeaSpeedStep)-sk.wind[0])/span), 0, 1)
	}
	return lerp(share, sk.height[0], sk.height[1])
}
