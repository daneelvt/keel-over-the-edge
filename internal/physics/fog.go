// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Visibility: how far a thing is seen through the air, computed from the
// same spells and systems as the wind, by the server and by every phone,
// so what a boat's lookout charts is what its sailor sees drawn.
//
// The air's extinction at a point, per metre, is a sum: the clear air's,
// Koschmieder's 3.912 over its visibility; each fog bank's; the rain's,
// Shipley's 0.16 R^0.74 per km (Shipley and others 1974) taken over the
// game's stage; and the mist band's at the edge. A fog bank's is its
// core's extinction times its strength, at most 1, times the stretched
// Gaussian its wind's patch has, times e^(−h / H) at h above the curved
// sea. Its core's visibility is drawn from its seed: "fog … reduce[s]
// horizontal visibility at the Earth's surface to less than 1 km" (WMO),
// on this stage a few hundred metres, and "dense fog" is under 100 m (Met
// Office). Rain falls below its cloud's base.
//
// The optical depth along a line is the integral of the extinction along
// it, and a thing is seen while it is at most 3.912, a contrast of 2%
// (Koschmieder), the light it sends keeping e^(−τ) (Beer–Lambert). Along
// a straight line over the dome every exponent of a fog bank's density,
// the Gaussian's terms in plan and its height above the sea, h₀ + u (h₁ −
// h₀) − (D² / 2R) u (1 − u) at u of the way, is a quadratic in u, so its
// integral is a Gaussian's: a difference of erfc, by Numerical Recipes'
// erfcc (Press and others, 6.2; its fractional error is under 1.2 × 10⁻⁷
// everywhere), each with the peak's exponent folded into its own so that
// no exponent is positive. Shipley's R^0.74 of a Gaussian core is a
// Gaussian √0.74 narrower, so rain's cores and a front's band integrate
// the same way, cut at their cloud's base. Quílez's analytic fog, Wenzel's
// (SIGGRAPH 2006) and Unreal's Local Fog Volumes integrate bounded fog in
// closed form the same way, with no march. A storm's spiral bands and the
// mist band are summed at sixteen points along the line, as the page sums
// the mist (client/src/edge/mist.ts). The page draws the same sum from the
// sources AirSources gives it.
//
// The visibility at a point is 3.912 over the extinction there, 2 m up;
// its words are the Met Office's marine ones on the game's stage, 0.4 of
// the real.

// The words for visibility, from VisibilityWord.
const (
	VisibilityGood     = 0
	VisibilityModerate = 1
	VisibilityPoor     = 2
	VisibilityVeryPoor = 3
)

// The most sources AirSources gives: fog banks, then rain's cores and
// bands.
const (
	MaxFogSources  = 4
	MaxRainSources = 6
	MaxAirSources  = MaxFogSources + MaxRainSources
)

const (
	// airSamples is how many points along a line the mist band and the
	// storms' bands are summed at, as the page sums the mist.
	airSamples = 16
	// airCut is a source's exponent in plan beyond which it is left out:
	// e^(−16), a ten-millionth of its peak.
	airCut = 16
	// lookHeight is the height the visibility at a point is taken at, m:
	// an eye on deck.
	lookHeight = 2
	// noTop is a source's top when it has none, m.
	noTop = 1e9
	// fogSalt draws a fog bank's core from its seed apart from its other
	// draws.
	fogSalt = 0x5f0c3a61
	// airMost is the most an exponent is let rise above nothing: a line
	// through the sea, which nothing is seen along, has a large optical
	// depth, not an infinite one.
	airMost = 80
)

// visibilityPrepared holds the constants visibility and lightning are
// computed with, derived from VisibilityParams by PrepareVisibility.
type visibilityPrepared struct {
	contrast    float64
	words       [3]float64 // m
	clear       float64    // the clear air's extinction, 1/m
	invTwoR     float64    // 1 / (2 × the dome's radius), 1/m
	mistBand    float64    // m
	invMistSpan float64    // 1/m
	mistSigma   float64    // the mist's own extinction at the lip at the sea, 1/m
	invMistH    float64    // 1/m
	rainK       float64    // rain's extinction per (mm an hour)^rainB, 1/m
	rainB       float64
	slot        float64 // ticks
	slotSeconds float64
	sea, single float64
	most        int32
	apart       float64 // s
}

// fogKind is a kind's fog, as it is computed with.
type fogKind struct {
	on   bool
	core [2]float64 // m
	invH float64    // 1/m
}

// lightningKind is a kind's lightning, as it is computed with.
type lightningKind struct {
	above, rate    float64
	inner2, outer2 float64 // squared shares of its size
}

func (f *fogKind) set(k *SystemKind) {
	f.on = k.FogCore[0] > 0 && k.FogCore[1] > 0
	f.core = k.FogCore
	f.invH = 1 / max2(k.FogHeight, 1)
}

func (l *lightningKind) set(k *SystemKind) {
	l.above = k.LightningAbove
	l.rate = max2(k.LightningRate, 0)
	l.inner2 = float64(k.LightningWithin[0] * k.LightningWithin[0])
	l.outer2 = float64(k.LightningWithin[1] * k.LightningWithin[1])
}

// PrepareVisibility derives visibility's and lightning's constants from
// their parameters. It is called after PrepareClouds, whose rain it takes.
func (w *WeatherPrepared) PrepareVisibility(p *VisibilityParams) {
	v := &w.vis
	v.contrast = p.Contrast
	if !(v.contrast > 0) {
		v.contrast = Koschmieder
	}
	v.words = p.Words
	v.clear = 0
	if p.Clear > 0 {
		v.clear = v.contrast / p.Clear
	}
	v.invTwoR = 0
	if p.Dome > 0 {
		v.invTwoR = 1 / float64(2*p.Dome)
	}
	v.mistBand = p.MistBand
	v.invMistSpan = 1 / max2(p.MistLip-p.MistBand, 1)
	v.mistSigma = 0
	if p.MistRange > 0 && p.MistLip > p.MistBand {
		v.mistSigma = max2(v.contrast/p.MistRange-v.clear, 0)
	}
	v.invMistH = 1 / max2(p.MistHeight, 1)
	c := &w.clouds
	v.rainK = float64(float64(c.extA*0.001) * c.invScale)
	v.rainB = c.extB
	v.slot = max2(float64(p.Slot*StepsPerSecond), 1)
	v.slotSeconds = float64(v.slot * Dt)
	v.sea = clamp(p.Sea, 0, 1)
	v.single = clamp(p.Single, 0, 1)
	v.most = min(max(toInt32(p.Strokes), 1), MaxStrokes)
	v.apart = float64(max2(p.Apart, 0) * 0.001)
}

// Contrast is the optical depth a thing is seen through at most.
func (w *WeatherPrepared) Contrast() float64 { return w.vis.contrast }

// ClearExtinction is the clear air's extinction, 1/m.
func (w *WeatherPrepared) ClearExtinction() float64 { return w.vis.clear }

// FogCoreOf is the visibility at the core of a fog bank of a kind and
// seed at full strength, at the sea, m; 0 for a kind with no fog.
func (w *WeatherPrepared) FogCoreOf(kind, seed float64) float64 {
	k := w.kindOf(kind)
	if k == nil || !k.fog.on {
		return 0
	}
	return lerp(unit(hash32(seedBits(seed)^fogSalt)), k.fog.core[0], k.fog.core[1])
}

// VisibilityWord is the word for a visibility, m: VisibilityGood to
// VisibilityVeryPoor.
func (w *WeatherPrepared) VisibilityWord(v float64) int32 {
	words := &w.vis.words
	switch {
	case v < words[0]:
		return VisibilityVeryPoor
	case v < words[1]:
		return VisibilityPoor
	case v < words[2]:
		return VisibilityModerate
	}
	return VisibilityGood
}

// fogOf is a fog bank's extinction at its core at the sea now, 1/m, from
// its kind's fog, its seed and its strength; 0 for a system with no fog.
func (st *systemTick) fogOf(p *WeatherPrepared) float64 {
	k := &st.k.fog
	if !k.on || !(p.vis.contrast > 0) {
		return 0
	}
	vc := lerp(unit(hash32(st.seed^fogSalt)), k.core[0], k.core[1])
	return float64(p.vis.contrast/vc) * min2(st.strength, 1)
}

// fogSource sets s to a system's fog, and reports whether it has any.
func (st *systemTick) fogSource(s *AirSource) bool {
	if !(st.fog > 0) {
		return false
	}
	str := st.k.stretch
	along := st.inv2w2 / float64(str*str)
	*s = AirSource{
		East: st.cx, North: st.cy, Sin: st.ux, Cos: st.uy,
		Along: along, Across: st.inv2w2, InvHeight: st.k.fog.invH,
		Sigma: st.fog, Top: noTop, Reach: math.Sqrt(airCut / along),
	}
	return true
}

// rainSource sets s to a system's core of rain, and reports whether it has
// one: rain of R mm an hour has an extinction of k R^b, so a Gaussian core
// of rain, R = rate e^(−d² / w²), has a Gaussian extinction b / w² wide.
func (st *systemTick) rainSource(v *visibilityPrepared, s *AirSource) bool {
	k := &st.k.cloud
	if !(k.rate > 0) || k.bands > 0 || !(v.rainK > 0) {
		return false
	}
	rate := float64(k.rate * st.strength)
	if !(rate >= rainLeast) {
		return false
	}
	w := float64(k.width * st.size)
	g := v.rainB / max2(float64(w*w), 1)
	top := float64(noTop)
	if k.base > 0 {
		top = k.base
	}
	*s = AirSource{
		East: st.cx, North: st.cy, Sin: st.ux, Cos: st.uy,
		Along: g, Across: g, Sigma: rainExtinction(v, rate), Top: top,
		Reach: math.Sqrt(airCut / max2(g, 1e-12)),
	}
	return true
}

// bandSource sets s to a front's band of rain behind its line, and
// reports whether it rains: R = rate e^(−q²), q its distance from the
// band's middle over its width, so its extinction is a Gaussian across the
// band, b / width² wide, and none along it.
func (t *WeatherTick) bandSource(f *frontLine, s *AirSource) bool {
	c := &t.p.clouds
	v := &t.p.vis
	if !(c.rainRate > 0) || !(v.rainK > 0) {
		return false
	}
	g := float64(v.rainB*c.invRain) * c.invRain
	middle := f.line - c.rainAt
	*s = AirSource{
		East: float64(middle * f.fe), North: float64(middle * f.fn), Sin: f.fe, Cos: f.fn,
		Along: g, Sigma: rainExtinction(v, c.rainRate), Top: c.heights[LayerLow],
		Reach: math.Sqrt(airCut / max2(g, 1e-12)),
	}
	return true
}

// rainExtinction is the extinction of rain of a rate, mm an hour, 1/m.
func rainExtinction(v *visibilityPrepared, rate float64) float64 {
	if !(rate >= rainLeast) {
		return 0
	}
	return float64(v.rainK * Exp(float64(v.rainB*Log(rate))))
}

// At is the source's extinction at (x, y), h m above the sea, 1/m.
func (s *AirSource) At(x, y, h float64) float64 {
	if !(h < s.Top) {
		return 0
	}
	dx, dy := x-s.East, y-s.North
	a := float64(dx*s.Sin) + float64(dy*s.Cos)
	c := float64(dx*s.Cos) - float64(dy*s.Sin)
	e := float64(s.Along*float64(a*a)) + float64(s.Across*float64(c*c)) + float64(s.InvHeight*max2(h, 0))
	return float64(s.Sigma * Exp(-min2(e, 745)))
}

// near reports whether the line from (x0, y0) by (dx, dy) comes within the
// source's reach: of its centre, or of a band's middle.
func (s *AirSource) near(x0, y0, dx, dy, d2 float64) bool {
	ox, oy := x0-s.East, y0-s.North
	if !(s.Across > 0) {
		a0 := float64(ox*s.Sin) + float64(oy*s.Cos)
		a1 := a0 + float64(dx*s.Sin) + float64(dy*s.Cos)
		return a0*a1 <= 0 || min2(math.Abs(a0), math.Abs(a1)) <= s.Reach
	}
	return segmentWithin(ox, oy, dx, dy, d2, s.Reach)
}

// clearOf reports whether the source is out of reach of every line within
// r of (x, y).
func (s *AirSource) clearOf(x, y, r float64) bool {
	ox, oy := x-s.East, y-s.North
	if !(s.Across > 0) {
		a := float64(ox*s.Sin) + float64(oy*s.Cos)
		return math.Abs(a) > s.Reach+r+1
	}
	return math.Sqrt(float64(ox*ox)+float64(oy*oy)) > s.Reach+r+1
}

// segmentWithin reports whether the segment from (ox, oy) by (dx, dy),
// relative to a point, of squared length d2, comes within r of it.
func segmentWithin(ox, oy, dx, dy, d2, r float64) bool {
	u := 0.0
	if d2 > 0 {
		u = clamp(-(float64(ox*dx)+float64(oy*dy))/d2, 0, 1)
	}
	ex, ey := ox+float64(u*dx), oy+float64(u*dy)
	return float64(ex*ex)+float64(ey*ey) <= float64(r*r)
}

// Depth is the source's optical depth along the line from (x0, y0, h0) by
// (dx, dy, dh), of length l, whose height above the sea at u of the way is
// h0 + u dh − g u (1 − u), g the dome's sag over it.
func (s *AirSource) Depth(x0, y0, h0, dx, dy, dh, g, l float64) float64 {
	u0, u1, ok := below(h0, dh, g, s.Top)
	if !ok {
		return 0
	}
	ox, oy := x0-s.East, y0-s.North
	a0 := float64(ox*s.Sin) + float64(oy*s.Cos)
	a1 := float64(dx*s.Sin) + float64(dy*s.Cos)
	c0 := float64(ox*s.Cos) - float64(oy*s.Sin)
	c1 := float64(dx*s.Cos) - float64(dy*s.Sin)
	qa := float64(s.Along*float64(a1*a1)) + float64(s.Across*float64(c1*c1)) + float64(g*s.InvHeight)
	qb := float64(2*(float64(s.Along*float64(a0*a1))+float64(s.Across*float64(c0*c1)))) + float64((dh-g)*s.InvHeight)
	qc := float64(s.Along*float64(a0*a0)) + float64(s.Across*float64(c0*c0)) + float64(h0*s.InvHeight)
	return float64(float64(s.Sigma*l) * gaussInt(qa, qb, qc, u0, u1))
}

// below is the stretch of a line, from u0 to u1 of the way, that lies
// below top, its height h0 + u dh − g u (1 − u), and whether there is any.
// The height is convex in u, so the stretch is one.
func below(h0, dh, g, top float64) (u0, u1 float64, ok bool) {
	h1 := h0 + dh
	if !(top < noTop) || h0 <= top && h1 <= top {
		return 0, 1, true
	}
	// g u² + (dh − g) u + (h0 − top) = 0.
	b, c := dh-g, h0-top
	var r0, r1 float64
	if !(g > 1e-9) {
		if dh == 0 {
			return 0, 0, false
		}
		r := -c / b
		if dh > 0 {
			r0, r1 = math.Inf(-1), r
		} else {
			r0, r1 = r, math.Inf(1)
		}
	} else {
		disc := float64(b*b) - float64(4*float64(g*c))
		if !(disc > 0) {
			return 0, 0, false
		}
		q := math.Sqrt(disc)
		r0, r1 = (-b-q)/float64(2*g), (-b+q)/float64(2*g)
	}
	u0, u1 = max2(r0, 0), min2(r1, 1)
	return u0, u1, u1 > u0
}

// Gauss–Legendre's four points and weights on [−1, 1].
const (
	glX0 = 0.3399810435848563
	glX1 = 0.8611363115940526
	glW0 = 0.6521451548625461
	glW1 = 0.3478548451374538
)

// gaussInt is the integral of e^(−(a u² + b u + c)) over u from u0 to u1.
// Where the exponent changes by less than a tenth over the stretch the
// integrand is near a low polynomial, and four points of Gauss–Legendre
// are exact to a part in ten million, where a difference of erfc would
// lose its digits; elsewhere the closed form.
func gaussInt(a, b, c, u0, u1 float64) float64 {
	e0, e1 := quad(a, b, c, u0), quad(a, b, c, u1)
	lo, hi := min2(e0, e1), max2(e0, e1)
	m := 0.0
	if a > 0 {
		m = -b / float64(2*a)
		if m > u0 && m < u1 {
			lo = min2(lo, quad(a, b, c, m))
		}
	}
	w := u1 - u0
	if hi-lo < 0.1 {
		mid, half := float64(0.5*(u0+u1)), float64(0.5*w)
		d0, d1 := float64(half*glX0), float64(half*glX1)
		sum := float64(glW0*(expNeg(quad(a, b, c, mid-d0))+expNeg(quad(a, b, c, mid+d0)))) +
			float64(glW1*(expNeg(quad(a, b, c, mid-d1))+expNeg(quad(a, b, c, mid+d1))))
		return float64(half * sum)
	}
	if !(float64(a*float64(w*w)) > float64(1e-6*(hi-lo))) {
		// Near linear: e^(−e0) − e^(−e1) over its slope.
		return float64(w*(expNeg(e0)-expNeg(e1))) / (e1 - e0)
	}
	s := math.Sqrt(a)
	k := c - float64(b*b)/float64(4*a)
	x0, x1 := float64(s*(u0-m)), float64(s*(u1-m))
	var diff float64
	switch {
	case x0 >= 0:
		diff = erfcFolded(x0, k) - erfcFolded(x1, k)
	case x1 <= 0:
		diff = erfcFolded(-x1, k) - erfcFolded(-x0, k)
	default:
		diff = float64(2*expNeg(k)) - erfcFolded(x1, k) - erfcFolded(-x0, k)
	}
	return float64(sqrtPi/float64(2*s)) * diff
}

// quad is a u² + b u + c.
func quad(a, b, c, u float64) float64 { return float64(float64(a*u)*u) + float64(b*u) + c }

// sqrtPi is √π.
const sqrtPi = 1.7724538509055159

// expNeg is e^(−x), the exponent held below airMost.
func expNeg(x float64) float64 { return Exp(-max2(x, -airMost)) }

// erfcFolded is erfc(x) e^(−k), for x ≥ 0: Numerical Recipes' erfcc, its
// e^(−x²) and e^(−k) taken as one exponent.
func erfcFolded(x, k float64) float64 {
	t := 1 / (1 + float64(0.5*x))
	p := float64(t*0.17087277) - 0.82215223
	p = float64(t*p) + 1.48851587
	p = float64(t*p) - 1.13520398
	p = float64(t*p) + 0.27886807
	p = float64(t*p) - 0.18628806
	p = float64(t*p) + 0.09678418
	p = float64(t*p) + 0.37409196
	p = float64(t*p) + 1.00002368
	p = float64(t*p) - 1.26551223
	return float64(t * expNeg(float64(x*x)+k-p))
}

// Air is the air's extinction at a point, by what makes it, 1/m.
type Air struct {
	Clear, Fog, Rain, Mist float64
}

// Total is the extinction of all of it.
func (a Air) Total() float64 { return a.Clear + a.Fog + a.Rain + a.Mist }

// AirAt is the extinction at (x, y), h m above the sea, at the tick t was
// set to, by what makes it.
func AirAt(t *WeatherTick, x, y, h float64) Air {
	v := &t.p.vis
	a := Air{Clear: v.clear, Fog: FogAt(t, x, y, h), Mist: v.mistAt(math.Sqrt(float64(x*x)+float64(y*y)), h)}
	var s AirSource
	for i := range t.ns {
		st := &t.sys[i]
		if st.rainSource(v, &s) {
			a.Rain += s.At(x, y, h)
		} else if st.k.cloud.bands > 0 && h < st.k.cloud.base {
			a.Rain += rainExtinction(v, st.rain(t.Tick, x, y))
		}
	}
	for i := range t.nf {
		if t.bandSource(&t.fronts[i], &s) {
			a.Rain += s.At(x, y, h)
		}
	}
	return a
}

// FogAt is the fog banks' extinction at (x, y), h m above the sea, at the
// tick t was set to, 1/m.
func FogAt(t *WeatherTick, x, y, h float64) float64 {
	f := 0.0
	var s AirSource
	for i := range t.ns {
		if st := &t.sys[i]; st.fogSource(&s) {
			f += s.At(x, y, h)
		}
	}
	return f
}

// VisibilityAt is the visibility at (x, y), 2 m above the sea, at the tick
// t was set to, m: the contrast over the extinction there.
func VisibilityAt(t *WeatherTick, x, y float64) float64 {
	e := AirAt(t, x, y, lookHeight).Total()
	if !(e > 0) {
		return math.Inf(1)
	}
	return t.p.vis.contrast / e
}

// mistAt is the mist band's own extinction r m from the centre, h m above
// the sea, 1/m.
func (v *visibilityPrepared) mistAt(r, h float64) float64 {
	if !(v.mistSigma > 0) || !(r > v.mistBand) {
		return 0
	}
	share := min2(float64((r-v.mistBand)*v.invMistSpan), 1)
	return float64(float64(v.mistSigma*share) * Exp(-float64(max2(h, 0)*v.invMistH)))
}

// OpticalDepth is the optical depth along the straight line from (x0, y0),
// h0 m above the sea, to (x1, y1), h1 m above it, over the dome, at the
// tick t was set to: the clear air's, the fog banks', the rain's and the
// mist band's.
func OpticalDepth(t *WeatherTick, x0, y0, h0, x1, y1, h1 float64) float64 {
	v := &t.p.vis
	dx, dy, dh := x1-x0, y1-y0, h1-h0
	d2 := float64(dx*dx) + float64(dy*dy)
	l := math.Sqrt(d2 + float64(dh*dh))
	tau := float64(v.clear * l)
	if !(l > 0) {
		return 0
	}
	g := float64(d2 * v.invTwoR)
	var s AirSource
	var banded [2 * MaxSystems]bool
	sample := false
	for i := range t.ns {
		st := &t.sys[i]
		if st.fogSource(&s) && s.near(x0, y0, dx, dy, d2) {
			tau += s.Depth(x0, y0, h0, dx, dy, dh, g, l)
		}
		if st.rainSource(v, &s) && s.near(x0, y0, dx, dy, d2) {
			tau += s.Depth(x0, y0, h0, dx, dy, dh, g, l)
		}
		if k := &st.k.cloud; k.bands > 0 && k.rate > 0 && v.rainK > 0 {
			reach := float64(k.width * st.size)
			banded[i] = segmentWithin(x0-st.cx, y0-st.cy, dx, dy, d2, reach)
			sample = sample || banded[i]
		}
	}
	for i := range t.nf {
		if t.bandSource(&t.fronts[i], &s) && s.near(x0, y0, dx, dy, d2) {
			tau += s.Depth(x0, y0, h0, dx, dy, dh, g, l)
		}
	}
	misty := v.mistSigma > 0 &&
		max2(float64(x0*x0)+float64(y0*y0), float64(x1*x1)+float64(y1*y1)) > float64(v.mistBand*v.mistBand)
	if !sample && !misty {
		return tau
	}
	// The mist and the storms' bands at sixteen points crowding toward the
	// eye: the k-th u² of the way, u the middle of the k-th sixteenth,
	// weighted 2u (the midpoint rule after t = u²).
	sum := 0.0
	for k := range airSamples {
		u := float64((float64(k) + 0.5) * (1.0 / airSamples))
		f := float64(u * u)
		x, y := x0+float64(f*dx), y0+float64(f*dy)
		h := h0 + float64(f*dh) - float64(float64(g*f)*(1-f))
		e := 0.0
		if misty {
			e = v.mistAt(math.Sqrt(float64(x*x)+float64(y*y)), h)
		}
		for i := range t.ns {
			if st := &t.sys[i]; banded[i] && h < st.k.cloud.base {
				e += rainExtinction(v, st.rain(t.Tick, x, y))
			}
		}
		sum += float64(float64(2*u) * e)
	}
	return tau + float64(float64(sum*l)*(1.0/airSamples))
}

// AirClear reports whether every line within r of (x, y) sees through the
// clear air alone at the tick t was set to: no fog bank, rain or mist
// within reach, so that OpticalDepth along it is the clear air's
// extinction times its length.
func AirClear(t *WeatherTick, x, y, r float64) bool {
	v := &t.p.vis
	if v.mistSigma > 0 && math.Sqrt(float64(x*x)+float64(y*y))+r+1 >= v.mistBand {
		return false
	}
	var s AirSource
	for i := range t.ns {
		st := &t.sys[i]
		if st.fogSource(&s) && !s.clearOf(x, y, r) {
			return false
		}
		if st.rainSource(v, &s) && !s.clearOf(x, y, r) {
			return false
		}
		if k := &st.k.cloud; k.bands > 0 && k.rate > 0 && v.rainK > 0 {
			dx, dy := x-st.cx, y-st.cy
			if math.Sqrt(float64(dx*dx)+float64(dy*dy)) <= float64(k.width*st.size)+r+1 {
				return false
			}
		}
	}
	for i := range t.nf {
		if t.bandSource(&t.fronts[i], &s) && !s.clearOf(x, y, r) {
			return false
		}
	}
	return true
}

// AirSources writes to out the Gaussian sources of extinction whose reach
// comes within r of (x, y) at the tick t was set to, for a GPU to sum
// along each ray as OpticalDepth does: the nearest MaxFogSources fog banks
// first, then the nearest MaxRainSources cores and bands of rain. It
// returns how many fog banks and how many in all. Nearness is how far the
// source's reach lies from (x, y).
func AirSources(t *WeatherTick, x, y, r float64, out []AirSource) (fog, n int) {
	if len(out) < MaxAirSources {
		return 0, 0
	}
	v := &t.p.vis
	near := nearest{out: out, x: x, y: y, r: r}
	var s AirSource
	nf, nr := 0, 0
	for i := range t.ns {
		if st := &t.sys[i]; st.fogSource(&s) {
			near.put(&s, 0, MaxFogSources, &nf)
		}
	}
	for i := range t.ns {
		if st := &t.sys[i]; st.rainSource(v, &s) {
			near.put(&s, MaxFogSources, MaxRainSources, &nr)
		}
	}
	for i := range t.nf {
		if t.bandSource(&t.fronts[i], &s) {
			near.put(&s, MaxFogSources, MaxRainSources, &nr)
		}
	}
	copy(out[nf:], out[MaxFogSources:MaxFogSources+nr])
	return nf, nf + nr
}

// nearest keeps the nearest sources to (x, y) within r, in out by their
// nearness.
type nearest struct {
	out     []AirSource
	key     [MaxAirSources]float64
	x, y, r float64
}

// put keeps s among the most nearest of out's from on, count of them kept
// so far.
func (n *nearest) put(s *AirSource, from, most int, count *int) {
	k := s.distance(n.x, n.y)
	if k > n.r {
		return
	}
	i := from + *count
	if *count == most {
		if !(k < n.key[from+most-1]) {
			return
		}
		i--
	} else {
		*count++
	}
	for i > from && n.key[i-1] > k {
		n.key[i], n.out[i] = n.key[i-1], n.out[i-1]
		i--
	}
	n.key[i], n.out[i] = k, *s
}

// distance is how far the source's reach lies from (x, y), m: nothing
// within it.
func (s *AirSource) distance(x, y float64) float64 {
	ox, oy := x-s.East, y-s.North
	if !(s.Across > 0) {
		return max2(math.Abs(float64(ox*s.Sin)+float64(oy*s.Cos))-s.Reach, 0)
	}
	return max2(math.Sqrt(float64(ox*ox)+float64(oy*oy))-s.Reach, 0)
}
