// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Weather systems: squalls, showers, storms, fog banks and patches of light
// air, moving over the disk. Each is a pressure shape that moves with it,
// and its wind blows toward lower pressure, turned clockwise by its kind's
// turning angle, as the northern hemisphere's winds are: at 90° the
// geostrophic wind, which blows along the isobars with low pressure on the
// left (Buys Ballot's law), and less where friction turns the wind toward
// the low, 10–25° over water (American Meteorological Society, Glossary of
// Meteorology, cross-isobar angle). So the wind, the pressure and the rules
// a sailor learns agree.
//
// A dome (a squall, a shower) is a Gaussian, steeper on its leading edge,
// where its outflow meets the wind as a gust front; a low (a storm) is a
// core Gaussian, whose width is the ring of its strongest wind, and a broad
// shallow low about it, so that the barometer falls well before its wind
// arrives, a sum of Gaussians in place of Holland's profile (Holland 1980),
// whose wind falls off too fast beyond two or three radii (Willoughby and
// Rahn 2004); a patch (fog, light air) has no pressure and scales the wind.
// Every shape ends a few of its widths from its centre, where its wind is a
// few hundredths of a percent of its peak.
//
// The server reads each system's place, motion, strength and size from the
// world's week at keyframes ten seconds apart (SystemAt), and the server
// and a client interpolate between the two about a tick from the same whole
// numbers, so both get the same bits.

// MaxSystems is the most systems a keyframe holds: the week's, at most
// WeekSystems on the disk at once, in the slots below it, and 4 a developer
// places, in the slots above.
const (
	MaxSystems  = 20
	WeekSystems = 16
)

// KeySets is the most keyframes a Weather holds: the two about the tick it
// is asked of, and those either side, for a client that steps ahead and
// replays behind.
const KeySets = 4

// MaxKinds is the most kinds of system.
const MaxKinds = 8

// Units of a System's whole numbers.
const (
	quarterMetre  = 0.25
	strengthSteps = 4096
	strengthStep  = 1.0 / strengthSteps
	hundredthHPa  = 0.01
	thousandth    = 0.001
	standardPress = 1013.25 // hPa: a spell with no level of its own
	invSqrtE      = 0.6065306597126334
	sqrtE         = 1.6487212707001282
	gustRingInner = 0.6 // a system's gusts are whole within this share of its size
	gustRingOuter = 1.6 // and nothing beyond this
	minArcRadius  = 0.1 // an arc closes on the centre no nearer than this share of its first radius
)

// Keyframe is the systems at a tick: each slot's system, or none.
type Keyframe struct {
	Tick    float64
	Systems [MaxSystems]System
}

// systemKind is a SystemKind as the wind is computed with it.
type systemKind struct {
	shape            int32
	sinT, cosT       float64 // of the turning angle
	width            float64
	ahead            float64
	broad, broadSize float64
	stretch          float64
	inward           int32
	gusts            float64
	swell            swellKind
}

// SetKind sets kind i of the systems. It is called after PrepareWeather,
// once for each of the catalog's kinds.
func (w *WeatherPrepared) SetKind(i int32, k *SystemKind) {
	if i < 0 || i >= MaxKinds {
		return
	}
	o := &w.kinds[i]
	o.shape = toInt32(k.Shape)
	o.sinT, o.cosT = SinCos(float64(k.Turning * degree))
	o.width = max2(k.Width, 1e-3)
	o.ahead = max2(k.Ahead, 1)
	o.broad = max2(k.Broad, 0)
	o.broadSize = max2(k.BroadWidth, 1)
	o.stretch = max2(k.Stretch, 1)
	o.inward = toInt32(k.Inward)
	o.gusts = max2(k.Gusts, 0)
	o.setSwell(k)
	w.nkinds = max(w.nkinds, i+1)
}

// kindOf is kind i, or nil if there is none.
func (w *WeatherPrepared) kindOf(i float64) *systemKind {
	k := toInt32(i)
	if k < 0 || k >= w.nkinds {
		return nil
	}
	return &w.kinds[k]
}

// systemTick is a system at a tick, ready for the wind at each point.
type systemTick struct {
	k        *systemKind
	cx, cy   float64 // its centre, m
	ux, uy   float64 // the direction it moves toward
	w        float64 // its Gaussian width, m
	inv2w2   float64 // 1 / (2w²)
	inv2b2   float64 // a low's broad part: 1 / (2b²)
	broadW   float64 // its share of the depth over b², per the core's over w²
	cut2     float64 // m²: nothing beyond the square root of this
	norm     float64 // a dome's or a low's wind per unit of its shape's slope, m/s
	depth    float64 // its pressure at its centre, hPa, at its strength
	patch    float64 // a patch: the share of the wind it takes away at its core
	gusts    float64 // the gust factor's excess it adds near its core
	gustIn   float64 // m: within this the gusts are whole
	gustOut2 float64 // m²: beyond the square root of this there are none
	invGusts float64 // 1 / the ring over which they fall off, 1/m
}

// systemValues are a system's values as floats: what a keyframe's whole
// numbers stand for, or what SystemAt computes before rounding. peak is
// still in the keyframe's steps, whose unit is its kind's.
type systemValues struct {
	kind              float64
	east, north       float64 // m
	heading           float64 // rad
	strength          float64
	size, peak, depth float64 // m, steps, hPa
}

// valuesOf is a keyframe's system as floats.
func valuesOf(s *System) systemValues {
	return systemValues{
		kind:     s.Kind,
		east:     float64(s.East * quarterMetre),
		north:    float64(s.North * quarterMetre),
		heading:  float64(s.Heading * turnStep),
		strength: float64(s.Strength * strengthStep),
		size:     s.Size,
		peak:     s.Peak,
		depth:    float64(s.Depth * hundredthHPa),
	}
}

// lerpValues is a + u (b − a), the heading along the shorter arc.
func lerpValues(a, b systemValues, u float64) systemValues {
	return systemValues{
		kind:     a.kind,
		east:     a.east + float64(u*(b.east-a.east)),
		north:    a.north + float64(u*(b.north-a.north)),
		heading:  a.heading + float64(u*wrapAngle(b.heading-a.heading)),
		strength: a.strength + float64(u*(b.strength-a.strength)),
		size:     a.size + float64(u*(b.size-a.size)),
		peak:     a.peak + float64(u*(b.peak-a.peak)),
		depth:    a.depth + float64(u*(b.depth-a.depth)),
	}
}

// set makes st ready from a system's values, with the kinds of p, and
// reports whether it adds anything. A dome's or a low's peak is a wind in
// steps of SeaSpeedStep, a patch's the wind's share at its core in
// thousandths.
func (st *systemTick) set(p *WeatherPrepared, v *systemValues) bool {
	k := p.kindOf(v.kind)
	strength := max2(v.strength, 0)
	size := max2(v.size, 1)
	if k == nil || !(strength > 0) {
		return false
	}
	st.k = k
	st.cx, st.cy = v.east, v.north
	st.ux, st.uy = SinCos(v.heading)
	st.w = float64(k.width * size)
	st.inv2w2 = 1 / float64(2*float64(st.w*st.w))
	reach := st.w
	switch k.shape {
	case ShapeDome:
		peak := float64(v.peak * SeaSpeedStep)
		st.norm = float64(float64(peak*strength)*sqrtE) / float64(k.ahead*st.w)
		st.depth = float64(v.depth * strength)
	case ShapeLow:
		peak := float64(v.peak * SeaSpeedStep)
		b := float64(st.w * k.broadSize)
		st.inv2b2 = 1 / float64(2*float64(b*b))
		st.broadW = float64(k.broad*float64(st.w*st.w)) / float64(b*b)
		st.norm = float64(float64(peak*strength)*sqrtE) * st.w
		st.depth = -float64(v.depth * strength)
		reach = b
	default:
		st.patch = float64(clamp(1-float64(v.peak*thousandth), 0, 1) * min2(strength, 1))
		reach = float64(st.w * k.stretch)
	}
	reach = float64(reach * p.cut)
	st.cut2 = float64(reach * reach)
	st.gusts = float64(k.gusts * strength)
	st.gustIn = float64(gustRingInner * size)
	out := float64(gustRingOuter * size)
	st.gustOut2 = float64(out * out)
	st.invGusts = 1 / float64((gustRingOuter-gustRingInner)*size)
	return true
}

// inwardOf is how much of itself a system of kind k keeps at r from the
// centre.
func (p *WeatherPrepared) inwardOf(k *systemKind, r float64) float64 {
	return p.inwardAt(r).of(k)
}

// inward is how much of itself each way of weakening keeps at a point.
type inward struct{ weak, gone float64 }

// inwardAt is how much each keeps at r from the centre.
func (p *WeatherPrepared) inwardAt(r float64) inward {
	g := smooth(float64((r - p.inwardFrom) * p.invInwardSpan))
	return inward{weak: p.inwardLeast + float64((1-p.inwardLeast)*g), gone: g}
}

// of is how much a system of kind k keeps.
func (in inward) of(k *systemKind) float64 {
	switch k.inward {
	case InwardWeak:
		return in.weak
	case InwardGone:
		return in.gone
	}
	return 1
}

// wind adds to (ve, vn), the air's velocity at (x, y), the wind of a dome
// or a low, weakened toward the centre as in says, and returns the gust
// factor's excess it adds there; a patch's wind is a factor, from factor.
func (st *systemTick) wind(x, y float64, in inward, ve, vn *float64) float64 {
	dx, dy := x-st.cx, y-st.cy
	d2 := float64(dx*dx) + float64(dy*dy)
	if !(d2 < st.cut2) {
		return 0
	}
	k := st.k
	var ge, gn float64 // the shape's slope downhill, turned below
	switch k.shape {
	case ShapeDome:
		a := float64(dx*st.ux) + float64(dy*st.uy)
		c := float64(dx*st.uy) - float64(dy*st.ux)
		ka := 1.0
		if a > 0 {
			ka = k.ahead
		}
		a2 := float64(a * ka)
		e := expShape(-float64((float64(a2*a2) + float64(c*c)) * st.inv2w2))
		// −∇ of e^(−q), q = (a′² + c²) / 2w², with a′ = ka·a: e (a′ ka u
		// + c (uy, −ux)) / w², whose steepest ahead is ka e^(−½) / w: norm is
		// the peak times w e^(½) / ka over w².
		along := float64(a2 * ka)
		f := float64(e * st.norm)
		ge = float64(f * (float64(along*st.ux) + float64(c*st.uy)))
		gn = float64(f * (float64(along*st.uy) - float64(c*st.ux)))
	case ShapeLow:
		e1 := expShape(-float64(d2 * st.inv2w2))
		e2 := expShape(-float64(d2 * st.inv2b2))
		// −∇ of −(e1 + β e2): toward the centre, e1 / w² + β e2 / b².
		f := -float64(st.norm * float64(2*st.inv2w2) * (e1 + float64(st.broadW*e2)))
		ge, gn = float64(f*dx), float64(f*dy)
	default:
		return 0
	}
	f := in.of(k)
	ge, gn = float64(ge*f), float64(gn*f)
	// Turned clockwise by the kind's angle.
	*ve += float64(ge*k.cosT) + float64(gn*k.sinT)
	*vn += float64(gn*k.cosT) - float64(ge*k.sinT)
	if !(st.gusts > 0) || !(d2 < st.gustOut2) {
		return 0
	}
	d := math.Sqrt(d2)
	return float64(float64(st.gusts*f) * (1 - smooth(float64((d-st.gustIn)*st.invGusts))))
}

// factor is the share of the wind a patch leaves at (x, y), or 1.
func (st *systemTick) factor(x, y float64) float64 {
	if st.k.shape != ShapeNone || !(st.patch > 0) {
		return 1
	}
	dx, dy := x-st.cx, y-st.cy
	d2 := float64(dx*dx) + float64(dy*dy)
	if !(d2 < st.cut2) {
		return 1
	}
	a := float64(float64(dx*st.ux)+float64(dy*st.uy)) / st.k.stretch
	c := float64(dx*st.uy) - float64(dy*st.ux)
	return 1 - float64(st.patch*expShape(-float64((float64(a*a)+float64(c*c))*st.inv2w2)))
}

// pressure is a dome's or a low's pressure at (x, y), hPa.
func (st *systemTick) pressure(x, y float64) float64 {
	dx, dy := x-st.cx, y-st.cy
	d2 := float64(dx*dx) + float64(dy*dy)
	if !(d2 < st.cut2) {
		return 0
	}
	switch st.k.shape {
	case ShapeDome:
		a := float64(dx*st.ux) + float64(dy*st.uy)
		if a > 0 {
			a = float64(a * st.k.ahead)
		}
		c := float64(dx*st.uy) - float64(dy*st.ux)
		return float64(st.depth * expShape(-float64((float64(a*a)+float64(c*c))*st.inv2w2)))
	case ShapeLow:
		e1 := expShape(-float64(d2 * st.inv2w2))
		e2 := expShape(-float64(d2 * st.inv2b2))
		return float64(st.depth * (e1 + float64(st.k.broad*e2)))
	}
	return 0
}

// SetKeyframe makes keyframe k one at a tick with no systems.
func (w *Weather) SetKeyframe(k int32, tick float64) {
	if k < 0 || k >= KeySets {
		return
	}
	w.Keys[k] = Keyframe{Tick: tick}
}

// SetSystem sets slot's system in keyframe k.
func (w *Weather) SetSystem(k, slot int32, s *System) {
	if k < 0 || k >= KeySets || slot < 0 || slot >= MaxSystems {
		return
	}
	w.Keys[k].Systems[slot] = *s
}

// SetKeyCount says how many keyframes are in use: the first n set.
func (w *Weather) SetKeyCount(n int32) { w.NKeys = min(max(n, 0), KeySets) }

// SetKeys makes keys the keyframes in use.
func (w *Weather) SetKeys(keys []Keyframe) {
	n := min(int32(len(keys)), KeySets)
	copy(w.Keys[:n], keys)
	w.SetKeyCount(n)
}

// SetRecord makes slot's system one computed from its record at each tick,
// in place of keyframes: for a client with no server, that makes its own
// systems and its own sea. SetRecordCount 0 goes back to keyframes.
func (w *Weather) SetRecord(slot int32, r *SystemRecord) {
	if slot < 0 || slot >= MaxSystems {
		return
	}
	w.Records[slot] = *r
}

// SetRecordCount says how many records are in use: the first n set.
func (w *Weather) SetRecordCount(n int32) { w.NRecords = min(max(n, 0), MaxSystems) }

// systemsAt sets t's systems at a tick: from the records if any are in use,
// or else interpolated between the keyframes about the tick, the week's
// left out if still. A system in one keyframe of the two and not the other
// is being born or has gone in between: its strength fades from or to
// nothing.
func systemsAt(w *Weather, t *WeatherTick, tick float64, still bool) {
	t.ns = 0
	p := w.Prepared
	first := int32(0)
	if still {
		first = WeekSystems
	}
	if w.NRecords > 0 {
		for i := first; i < w.NRecords; i++ {
			v, on := recordAt(&w.Records[i], tick)
			if on && t.sys[t.ns].set(p, &v) {
				t.ns++
			}
		}
		return
	}
	k0, k1 := int32(-1), int32(-1)
	for k := range w.NKeys {
		at := w.Keys[k].Tick
		if at <= tick && (k0 < 0 || at > w.Keys[k0].Tick) {
			k0 = k
		}
		if at > tick && (k1 < 0 || at < w.Keys[k1].Tick) {
			k1 = k
		}
	}
	switch {
	case k0 < 0 && k1 < 0:
		return
	case k0 < 0:
		k0, k1 = k1, -1
	}
	a := &w.Keys[k0]
	if k1 < 0 {
		for i := first; i < MaxSystems; i++ {
			if s := &a.Systems[i]; s.On != 0 {
				v := valuesOf(s)
				if t.sys[t.ns].set(p, &v) {
					t.ns++
				}
			}
		}
		return
	}
	b := &w.Keys[k1]
	u := clamp(float64((tick-a.Tick)/(b.Tick-a.Tick)), 0, 1)
	for i := first; i < MaxSystems; i++ {
		sa, sb := &a.Systems[i], &b.Systems[i]
		va, vb := valuesOf(sa), valuesOf(sb)
		var v [2]systemValues
		n := 0
		switch {
		case sa.On != 0 && sb.On != 0 && sa.Kind == sb.Kind && sa.Seed == sb.Seed:
			v[0], n = lerpValues(va, vb, u), 1
		default:
			if sa.On != 0 {
				va.strength = float64(va.strength * (1 - u))
				v[n] = va
				n++
			}
			if sb.On != 0 {
				vb.strength = float64(vb.strength * u)
				v[n] = vb
				n++
			}
		}
		for j := range n {
			if t.ns < int32(len(t.sys)) && t.sys[t.ns].set(p, &v[j]) {
				t.ns++
			}
		}
	}
}

// SystemsAt is how many systems blow at the tick t was set to.
func SystemsAt(t *WeatherTick) int32 { return t.ns }

// SystemAt is the keyframe of a system of the week at a tick, from its
// record: its planned track with its wobble, its strength by its life and
// its throb, in whole numbers. A system not alive at the tick is not on.
func SystemAt(r *SystemRecord, tick float64) System {
	v, on := recordAt(r, tick)
	if !on {
		return System{}
	}
	_, _, _, speed := trackAt(r, tick)
	stage := float64(StageGrowing)
	if tick >= r.Decays {
		stage = StageDecaying
	} else if tick >= r.Mature {
		stage = StageMature
	}
	return System{
		On:       1,
		Kind:     r.Kind,
		Seed:     r.Seed,
		Stage:    stage,
		East:     float64(steps(v.east, 1/quarterMetre)),
		North:    float64(steps(v.north, 1/quarterMetre)),
		Heading:  float64(wrapSteps(steps(v.heading, 1/turnStep))),
		Speed:    float64(steps(speed, 1/SeaSpeedStep)),
		Strength: float64(steps(v.strength, strengthSteps)),
		Size:     float64(steps(v.size, 1)),
		Peak:     r.Peak,
		Depth:    r.Depth,
	}
}

// wrapSteps is a direction in steps of a turn brought into [0, TurnSteps).
func wrapSteps(d int32) int32 {
	d %= TurnSteps
	if d < 0 {
		d += TurnSteps
	}
	return d
}

// SystemTrack is where a system of the week is at a tick by its planned
// track alone, without its wobble, m east and north of the centre: what a
// forecast moves it on by.
func SystemTrack(r *SystemRecord, tick float64) (east, north float64) {
	east, north, _, _ = trackAt(r, tick)
	return east, north
}

// recordAt is a system's values at a tick from its record, and whether it
// is alive then.
func recordAt(r *SystemRecord, tick float64) (systemValues, bool) {
	if !(tick >= r.Born) || !(tick < r.Gone) {
		return systemValues{}, false
	}
	east, north, heading, _ := trackAt(r, tick)
	if r.Wobble != 0 {
		w := float64(r.Wobble * quarterMetre)
		east += float64(w * Sin(float64(r.WobblePhase[0]*turnStep)+cycle(inverse(r.WobblePeriod[0]), tick)))
		north += float64(w * Sin(float64(r.WobblePhase[1]*turnStep)+cycle(inverse(r.WobblePeriod[1]), tick)))
	}
	life := 1.0
	switch {
	case tick < r.Mature:
		life = smooth(float64((tick - r.Born) * inverse(r.Mature-r.Born)))
	case tick >= r.Decays:
		life = 1 - smooth(float64((tick-r.Decays)*inverse(r.Gone-r.Decays)))
	}
	throb := 1 + float64(float64(r.Throb*strengthStep)*Sin(float64(r.ThrobPhase*turnStep)+cycle(inverse(r.ThrobPeriod), tick)))
	return systemValues{
		kind:     r.Kind,
		east:     east,
		north:    north,
		heading:  heading,
		strength: float64(life * throb),
		size:     r.Size,
		peak:     r.Peak,
		depth:    float64(r.Depth * hundredthHPa),
	}, true
}

// inverse is 1 / x, or 0 for no x.
func inverse(x float64) float64 {
	if x == 0 {
		return 0
	}
	return 1 / x
}

// trackAt is where a system's planned track has it at a tick, m east and
// north of the centre, the direction it moves toward, rad, and how fast,
// m/s.
func trackAt(r *SystemRecord, tick float64) (east, north, heading, speed float64) {
	dt := tick - r.Born
	speed = float64(r.Speed * SeaSpeedStep)
	perTick := float64(speed * Dt)
	if r.Track != TrackArc {
		heading = float64(r.Heading * turnStep)
		sin, cos := SinCos(heading)
		d := float64(perTick * dt)
		return float64(r.East*quarterMetre) + float64(d*sin), float64(r.North*quarterMetre) + float64(d*cos), heading, speed
	}
	r0 := float64(r.Radius * quarterMetre)
	in := float64(float64(r.Inward*SeaSpeedStep) * Dt)
	least := float64(minArcRadius * r0)
	radius, turned := r0, 0.0
	if r0 > 0 {
		if in > 0 {
			// Closing at an even speed while it goes round at another: the
			// angle swept is ∫ v / R(t) dt = (v / u) ln(R₀ / R).
			radius = max2(r0-float64(in*dt), least)
			until := float64((r0 - radius) / in)
			turned = float64(float64(perTick/in) * Log(r0/radius))
			turned += float64(perTick*(dt-until)) / radius
		} else {
			turned = float64(perTick*dt) / r0
		}
	}
	angle := float64(r.Angle*turnStep) + float64(sign(r.Sense)*turned)
	sin, cos := SinCos(angle)
	east, north = float64(radius*sin), float64(radius*cos)
	// Its motion: round the centre, and toward it while it closes.
	te, tn := float64(sign(r.Sense)*cos), -float64(sign(r.Sense)*sin)
	ve, vn := float64(perTick*te), float64(perTick*tn)
	if in > 0 && radius > least {
		ve -= float64(in * sin)
		vn -= float64(in * cos)
	}
	return east, north, Atan2(ve, vn), speed
}
