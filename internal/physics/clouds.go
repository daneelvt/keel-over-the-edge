// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Clouds: what the weather shows in the sky, computed from the same spells
// and systems as the wind, by the server and by every phone, so what one
// player sees another sees, and the rules that read the sky (visibility,
// the forecast's sky, star sights) read what is drawn.
//
// Heaped cloud is a system's: squalls, showers and storms. Its cloud
// strength is its strength times its kind's lead, at most 1, so it is
// whole when its wind is half grown and lingers while its wind decays, as
// a thunderstorm's cumulus stage, towering with no rain or outflow, comes
// before its mature stage, when its downdraft and gust front begin (NOAA
// JetStream, the life cycle of a thunderstorm): its tower is the warning.
//
// Sheet cloud lies in three layers, each at one height: cirrus, a middle
// sheet and low cloud. A front carries the sequence of a warm front ahead
// of its line, "first, cirrus appear. These give way successively to
// cirrostratus, altostratus, altocumulus, and nimbostratus" (Bowditch
// 3410), and the clearing of a cold front behind it; a storm carries the
// sheets of its outflow about it. Each layer's cover is held at the corners
// of a world-fixed lattice and is bilinear between them, so a phone's
// texture of the lattice draws the very field the server has.
//
// Fair-weather cumulus is each spell's: a lattice of cells in a frame that
// drifts with the spell's wind as one body, a closed form of the tick as
// the gust field is, each cell's cloud living in slots of its life and
// shown where its hash is under the spell's cover, less where the sheets
// are thick. By day each island raises a cap and a street of cumulus
// downwind of it (Matthews and others 2007, on Nauru).

// The sizes of what the clouds' functions answer for at once.
const (
	// MaxRegimes is the most regimes whose cumulus is held.
	MaxRegimes = 16
	// MaxClouds is the most heaped clouds at a tick: one a system blowing.
	MaxClouds = 2 * MaxSystems
	// MaxCumulus is the most cumulus one call of CumulusAt gives.
	MaxCumulus = 512
	// MaxCaps is the most islands' caps a client holds.
	MaxCaps = 64
	// SheetSide is the most lattice points a side one call of SheetGrid
	// answers for.
	SheetSide = 48
	// maxFrontLines is the most fronts' sheets in sight at once: the two
	// latest in play, and the one coming.
	maxFrontLines = 3
)

// The layers of sheet cloud, in their order in a grid's values.
const (
	LayerCirrus = 0
	LayerMiddle = 1
	LayerLow    = 2
	Layers      = 3
)

// cloudKind is a kind's cloud and rain as they are computed with.
type cloudKind struct {
	form          int32
	base, top     float64 // m
	behind, ahead float64 // shares of its size
	deck, deckTop float64 // a share of its size, m
	lead, dark    float64
	sheets        bool
	sheet         [Layers][2]float64 // from and whole, shares of its size
	rate, width   float64            // mm an hour, a share of its size
	bands         float64
	bandTurns     float64 // turns a tick
}

func (c *cloudKind) set(k *SystemKind) {
	c.form = toInt32(k.CloudForm)
	c.base, c.top = max2(k.CloudBase, 0), max2(k.CloudTop, 0)
	c.behind, c.ahead = max2(k.CloudReach[0], 0), max2(k.CloudReach[1], 0)
	c.deck, c.deckTop = max2(k.CloudDeck[0], 0), max2(k.CloudDeck[1], 0)
	c.lead, c.dark = max2(k.CloudLead, 1), clamp(k.CloudDark, 0, 1)
	c.sheet = [Layers][2]float64{k.SheetCirrus, k.SheetMiddle, k.SheetLow}
	c.sheets = false
	for _, s := range c.sheet {
		if s[0] > 0 {
			c.sheets = true
		}
	}
	c.rate, c.width = max2(k.RainRate, 0), max2(k.RainWidth, 0)
	c.bands = max2(k.RainBands, 0)
	c.bandTurns = 0
	if k.RainTurn > 0 {
		c.bandTurns = 1 / float64(k.RainTurn*minuteTicks)
	}
}

// heaped reports whether a kind's cloud is a heaped one.
func (c *cloudKind) heaped() bool {
	return c.form == FormCumulus || c.form == FormCumulonimbus || c.form == FormStorm
}

// cloudsPrepared holds the constants clouds and rain are computed with,
// derived from CloudParams by PrepareClouds.
type cloudsPrepared struct {
	heights    [Layers]float64 // m
	lattice    float64         // m
	invLattice float64

	cell, invCell, jitter float64 // m, 1/m, m
	cuBase                float64 // m
	cuTops, cuSize        [2]float64
	cuLife, invCuLife     float64 // s, 1/s

	capSun    [2]float64 // rad
	capTops   [2]float64 // m
	capWidth  float64
	capStreet int32

	// A front's: its cirrus and middle sheet's begin and whole ahead of the
	// line, and clearing and gone behind it, m; its low cloud's and rain's
	// band, m behind the line and 1 / its width; its rain's rate.
	front    [2][4]float64
	lowAt    float64
	invLow   float64
	rainAt   float64
	invRain  float64
	rainRate float64
	past     float64 // m: a front whose line is this far beyond the centre has nothing in sight

	words      [3]float64 // mm an hour
	extA, extB float64
	invScale   float64

	cumulus [MaxRegimes]float64
}

// PrepareClouds derives the clouds' and rain's constants from their
// parameters. It is called after PrepareWeather, then SetRegimeCumulus
// once for each of the catalog's regimes.
func (w *WeatherPrepared) PrepareClouds(p *CloudParams) {
	c := &w.clouds
	c.heights = [Layers]float64{p.Cirrus, p.Middle, p.Low}
	c.lattice = max2(p.Lattice, 1)
	c.invLattice = 1 / c.lattice
	c.cell = max2(p.CumulusCell, 1)
	c.invCell = 1 / c.cell
	c.jitter = float64(clamp(p.CumulusJitter, 0, 0.5) * c.cell)
	c.cuBase = p.CumulusBase
	c.cuTops, c.cuSize = p.CumulusTops, p.CumulusSize
	c.cuLife = max2(float64(p.CumulusLife*60), 1)
	c.invCuLife = 1 / c.cuLife
	c.capSun = [2]float64{float64(p.CapSun[0] * degree), float64(p.CapSun[1] * degree)}
	c.capTops = p.CapTops
	c.capWidth = p.CapWidth
	c.capStreet = toInt32(p.CapStreet)
	for i, f := range [2][4]float64{p.FrontCirrus, p.FrontMiddle} {
		for j := range f {
			c.front[i][j] = float64(f[j] * nauticalMile)
		}
	}
	c.lowAt = float64(p.FrontLow[0] * nauticalMile)
	c.invLow = 1 / max2(float64(p.FrontLow[1]*nauticalMile), 1)
	c.rainRate = max2(p.FrontRain[0], 0)
	c.rainAt = float64(p.FrontRain[1] * nauticalMile)
	c.invRain = 1 / max2(float64(p.FrontRain[2]*nauticalMile), 1)
	c.past = w.frontReach + float64(2*c.front[0][0]) + c.front[0][3]
	c.words = p.RainWords
	c.extA, c.extB = p.RainExtinction[0], p.RainExtinction[1]
	c.invScale = 1 / max2(p.RainScale, 1e-3)
	c.cumulus = [MaxRegimes]float64{}
}

// SetRegimeCumulus sets how much of the sky regime i's fair-weather
// cumulus covers.
func (w *WeatherPrepared) SetRegimeCumulus(i int32, cover float64) {
	if i < 0 || i >= MaxRegimes {
		return
	}
	w.clouds.cumulus[i] = clamp(cover, 0, 1)
}

// LayerHeight is the height of a layer of sheet cloud, m.
func (w *WeatherPrepared) LayerHeight(layer int32) float64 {
	if layer < 0 || layer >= Layers {
		return 0
	}
	return w.clouds.heights[layer]
}

// SheetLattice is how far apart the sheets' lattice points are, m.
func (w *WeatherPrepared) SheetLattice() float64 { return w.clouds.lattice }

// frontLine is a front's line at a tick: it lies line m from the centre
// along (fe, fn), the way it moves.
type frontLine struct {
	fe, fn, line float64
}

// setFronts sets the fronts whose sheets may be in sight at a tick: the
// latest two of the spells in play that come by a front, announced or
// begun, and the coming front if its spell is not among them. The line of
// each is where it is at the tick, ahead of the disk before its spell
// begins, so a coming front and the spell it brings give the same line.
func (t *WeatherTick) setFronts(w *Weather, tick float64) {
	t.nf = 0
	p := w.Prepared
	var begun [2]float64
	for j := w.Count - 1; j >= 0 && t.nf < 2; j-- {
		s := &w.spells[j]
		if !s.front {
			continue
		}
		line := float64(s.fspeed*(tick-s.begin)) - p.frontReach
		if !(line < p.clouds.past) {
			break
		}
		t.fronts[t.nf] = frontLine{fe: s.fsin, fn: s.fcos, line: line}
		begun[t.nf] = s.begin
		t.nf++
	}
	c := &w.coming
	if !c.front || (t.nf > 0 && begun[0] == c.begin) || (t.nf > 1 && begun[1] == c.begin) {
		return
	}
	t.fronts[t.nf] = frontLine{fe: c.fsin, fn: c.fcos, line: float64(c.fspeed*(tick-c.begin)) - p.frontReach}
	t.nf++
}

// fall is 1 at d ≤ whole, 0 at d ≥ from, and smooth between.
func fall(d, whole, from float64) float64 {
	if !(from > whole) {
		if d < from {
			return 1
		}
		return 0
	}
	return 1 - smooth(float64((d-whole)/(from-whole)))
}

// CloudStrength is a system's cloud strength from its strength and its
// kind's lead: whole when its strength reaches 1 / lead.
func CloudStrength(strength, lead float64) float64 {
	return clamp(float64(strength*lead), 0, 1)
}

// HeapedClouds writes to out the heaped clouds at the tick t was set to,
// one a system whose kind has one, and returns how many.
func HeapedClouds(t *WeatherTick, out []Cloud) int {
	n := 0
	for i := range t.ns {
		st := &t.sys[i]
		k := &st.k.cloud
		if !k.heaped() || n >= len(out) {
			continue
		}
		cs := CloudStrength(st.strength, k.lead)
		c := &out[n]
		*c = Cloud{
			Slot: float64(st.slot), Kind: st.kind, Form: float64(k.form), Seed: float64(st.seed),
			East: st.cx, North: st.cy, Heading: Atan2(st.ux, st.uy), Speed: st.speed,
			Size: st.size, Strength: st.strength, Cloud: cs,
			Base:    k.base,
			Top:     k.base + float64((k.top-k.base)*cs),
			Behind:  float64(float64(k.behind*st.size) * cs),
			Ahead:   float64(float64(k.ahead*st.size) * cs),
			Deck:    float64(float64(k.deck*st.size) * cs),
			DeckTop: k.base + float64((k.deckTop-k.base)*cs),
			Dark:    k.dark,
		}
		c.Rain, c.RainReach = st.rainCore()
		n++
	}
	return n
}

// RegimeAt is the catalog's index of the regime of the spell in effect at
// the tick t was set to, or −1 for none.
func RegimeAt(t *WeatherTick) float64 {
	if t.n == 0 {
		return -1
	}
	return t.at[t.n-1].s.regime
}

// What is near a point, by the form of its cloud: bits of NearAt.
const (
	NearShower = 1 // a heap of cumulus raining as a shower
	NearSquall = 2 // a cumulonimbus
	NearStorm  = 4 // a storm's deck
	NearFog    = 8 // a fog bank
)

// NearAt is what is near (x, y) at the tick t was set to: a sum of the
// Near bits of the systems within their size of it, by their clouds'
// forms, the words a place's box and its outlook name.
func NearAt(t *WeatherTick, x, y float64) int32 {
	var near int32
	for i := range t.ns {
		st := &t.sys[i]
		dx, dy := x-st.cx, y-st.cy
		if float64(dx*dx)+float64(dy*dy) > float64(st.size*st.size) {
			continue
		}
		switch st.k.cloud.form {
		case FormCumulus:
			near |= NearShower
		case FormCumulonimbus:
			near |= NearSquall
		case FormStorm:
			near |= NearStorm
		case FormFog:
			near |= NearFog
		}
	}
	return near
}

// SheetAt is the cover of the three layers at (x, y): bilinear between the
// lattice's corners about it.
func SheetAt(t *WeatherTick, x, y float64) Sheets {
	c := &t.p.clouds
	u, v := float64(x*c.invLattice), float64(y*c.invLattice)
	i, j := math.Floor(u), math.Floor(v)
	fu, fv := u-i, v-j
	x0, y0 := float64(i*c.lattice), float64(j*c.lattice)
	x1, y1 := float64((i+1)*c.lattice), float64((j+1)*c.lattice)
	a, b := t.sheetPoint(x0, y0), t.sheetPoint(x1, y0)
	d, e := t.sheetPoint(x0, y1), t.sheetPoint(x1, y1)
	var s [Layers]float64
	for l := range Layers {
		lo := a[l] + float64(fu*(b[l]-a[l]))
		hi := d[l] + float64(fu*(e[l]-d[l]))
		s[l] = lo + float64(fv*(hi-lo))
	}
	return Sheets{Cirrus: s[LayerCirrus], Middle: s[LayerMiddle], Low: s[LayerLow]}
}

// SheetGrid writes to out the cover of the three layers at the lattice's
// points (i0 + i, j0 + j) for i and j below n, n at most SheetSide: for
// each point east then north, its cirrus, middle and low cover, so a
// texture of it bilinear between its texels is SheetAt.
func SheetGrid(t *WeatherTick, i0, j0, n int32, out []float64) {
	n = min(max(n, 0), SheetSide)
	c := &t.p.clouds
	for j := range n {
		y := float64(float64(j0+j) * c.lattice)
		for i := range n {
			k := int(Layers * (j*n + i))
			if k+Layers > len(out) {
				return
			}
			s := t.sheetPoint(float64(float64(i0+i)*c.lattice), y)
			out[k], out[k+1], out[k+2] = s[0], s[1], s[2]
		}
	}
}

// sheetPoint is the three layers' cover at (x, y) itself: the most of each
// front's and each storm's.
func (t *WeatherTick) sheetPoint(x, y float64) [Layers]float64 {
	var s [Layers]float64
	c := &t.p.clouds
	for i := range t.nf {
		f := &t.fronts[i]
		d := float64(x*f.fe) + float64(y*f.fn) - f.line
		for l := range 2 {
			g := &c.front[l]
			var v float64
			if d > -g[2] {
				v = fall(d, g[1], g[0])
			} else {
				v = fall(-d, g[2], g[3])
			}
			s[l] = max2(s[l], v)
		}
		q := float64((d + c.lowAt) * c.invLow)
		s[LayerLow] = max2(s[LayerLow], Exp(-float64(q*q)))
	}
	for i := range t.ns {
		st := &t.sys[i]
		k := &st.k.cloud
		if !k.sheets {
			continue
		}
		dx, dy := x-st.cx, y-st.cy
		r2 := float64(dx*dx) + float64(dy*dy)
		far := 0.0
		for l := range Layers {
			far = max2(far, k.sheet[l][0])
		}
		reach := float64(far * st.size)
		if !(r2 < float64(reach*reach)) {
			continue
		}
		d := math.Sqrt(r2)
		cs := CloudStrength(st.strength, k.lead)
		for l := range Layers {
			v := float64(cs * fall(d, float64(k.sheet[l][1]*st.size), float64(k.sheet[l][0]*st.size)))
			s[l] = max2(s[l], v)
		}
	}
	return s
}

// Cap is an island's cap of cumulus: the island's centre, m east and north
// of the world's, and its width, m.
type Cap struct {
	East, North, Width float64
}

// CumulusAt writes to out the fair-weather cumulus within reach of (x, y)
// at the tick t was set to, and returns how many: each spell's lattice's,
// and by day the islands' caps, the sun's height at them sun, rad. Each
// shows by the spell's cover at its place, its share of the spells there,
// and less under the middle and low sheets.
func CumulusAt(t *WeatherTick, x, y, reach, sun float64, caps []Cap, out []Cumulus) int {
	n := 0
	c := &t.p.clouds
	for i := range t.n {
		st := &t.at[i]
		s := st.s
		if s.steady || n >= len(out) {
			continue
		}
		cover := c.cumulus[min(max(toInt32(s.regime), 0), MaxRegimes-1)]
		if !(cover > 0) {
			continue
		}
		n += t.lattice(int32(i), st, cover, x, y, reach, out[n:])
	}
	if !(sun > c.capSun[0]) || t.n == 0 {
		return n
	}
	day := smooth(float64((sun - c.capSun[0]) / (c.capSun[1] - c.capSun[0])))
	for i := range caps {
		if n >= len(out) {
			break
		}
		n += t.cap(&caps[i], day, x, y, reach, out[n:])
	}
	return n
}

// lattice writes spell i's cumulus within reach of (x, y) to out.
func (t *WeatherTick) lattice(i int32, st *spellTick, cover, x, y, reach float64, out []Cumulus) int {
	c := &t.p.clouds
	s := st.s
	travel := float64(s.speed * st.seconds)
	// The frame: along the wind, drifting downwind, and across it.
	a0 := -(float64(x*st.sinD) + float64(y*st.cosD)) - travel
	c0 := float64(x*st.cosD) - float64(y*st.sinD)
	ia0, ia1 := toInt32(math.Floor(float64((a0-reach)*c.invCell))), toInt32(math.Floor(float64((a0+reach)*c.invCell)))
	ic0, ic1 := toInt32(math.Floor(float64((c0-reach)*c.invCell))), toInt32(math.Floor(float64((c0+reach)*c.invCell)))
	seed := hash32(s.seeds[0] ^ 0x2c1b3c6d)
	// The air moves away from where the wind comes from.
	ve, vn := -float64(s.speed*st.sinD), -float64(s.speed*st.cosD)
	reach2 := float64(reach * reach)
	n := 0
	for ia := ia0; ia <= ia1; ia++ {
		for ic := ic0; ic <= ic1; ic++ {
			if n >= len(out) {
				return n
			}
			h := hash32(seed ^ hash32(uint32(ia)*0x8da6b343^uint32(ic)*0xd8163841))
			// Each cell's slots of life begin at a time of its own.
			life := float64(st.seconds*c.invCuLife) + unit(h)
			slot := math.Floor(life)
			u := life - slot
			grow := float64(smooth(float64(4*u)) * smooth(float64(4*(1-u))))
			if !(grow > 0) {
				continue
			}
			k := hash32(h ^ uint32(toInt32(slot))*0xcb1ab31f)
			ja := float64((unit(hash32(k^1)) - 0.5) * float64(2*c.jitter))
			jc := float64((unit(hash32(k^2)) - 0.5) * float64(2*c.jitter))
			a := float64((float64(ia)+0.5)*c.cell) + ja + travel
			cr := float64((float64(ic)+0.5)*c.cell) + jc
			ex := -float64(a*st.sinD) + float64(cr*st.cosD)
			ey := -float64(a*st.cosD) - float64(cr*st.sinD)
			dx, dy := ex-x, ey-y
			if !(float64(dx*dx)+float64(dy*dy) < reach2) {
				continue
			}
			shares, _ := t.shares(ex, ey)
			sh := t.sheetPoint(ex, ey)
			here := float64(float64(cover*shares[i]) * (1 - min2(sh[LayerMiddle]+sh[LayerLow], 1)))
			// Centred on the cover, so a cover's share of the cells show,
			// and fading in under a cover of a tenth, so none show under
			// none.
			shown := float64(smooth(float64((here-unit(hash32(k^3)))*cumulusEdge)+0.5) * smooth(float64(here*cumulusEdge)))
			if !(shown > 0) {
				continue
			}
			out[n] = Cumulus{
				East: ex, North: ey,
				Base:     c.cuBase,
				Top:      lerp(unit(hash32(k^4)), c.cuTops[0], c.cuTops[1]),
				Radius:   lerp(unit(hash32(k^5)), c.cuSize[0], c.cuSize[1]),
				Grow:     float64(grow * shown),
				Seed:     float64(hash32(k ^ 6)),
				VelEast:  ve,
				VelNorth: vn,
			}
			n++
		}
	}
	return n
}

// cumulusEdge is how sharply a cell's cloud shows as the cover passes its
// hash: over a tenth of the cover.
const cumulusEdge = 10

// cap writes an island's cap and its street within reach of (x, y) to out,
// grown by day's share.
func (t *WeatherTick) cap(p *Cap, day, x, y, reach float64, out []Cumulus) int {
	c := &t.p.clouds
	// The street trails downwind of the spell with the most share at the
	// island.
	shares, _ := t.shares(p.East, p.North)
	st := &t.at[0]
	if t.n > 1 && shares[1] > shares[0] {
		st = &t.at[1]
	}
	sin, cos := SinCos(st.dir)
	sh := t.sheetPoint(p.East, p.North)
	open := 1 - min2(sh[LayerMiddle]+sh[LayerLow], 1)
	wide := clamp(float64((p.Width-capNarrow)/(capWide-capNarrow)), 0, 1)
	radius := max2(float64(c.capWidth*p.Width), c.cuSize[0])
	top := lerp(wide, c.capTops[0], c.capTops[1])
	seed := hash32(uint32(toInt32(math.Floor(p.East)))*0x8da6b343 ^ uint32(toInt32(math.Floor(p.North)))*0xd8163841)
	reach2 := float64(reach * reach)
	n := 0
	for k := range c.capStreet + 1 {
		if n >= len(out) {
			break
		}
		f := float64(k)
		d := float64(float64(f*c.cell) * capStreetStep)
		ex, ey := p.East-float64(d*sin), p.North-float64(d*cos)
		dx, dy := ex-x, ey-y
		if !(float64(dx*dx)+float64(dy*dy) < reach2) {
			continue
		}
		fade := 1 - float64(f*capStreetFade)
		out[n] = Cumulus{
			East: ex, North: ey,
			Base:   c.cuBase,
			Top:    c.cuBase + float64((top-c.cuBase)*fade),
			Radius: max2(float64(radius*fade), c.cuSize[0]),
			Grow:   float64(float64(day*open) * fade),
			Seed:   float64(hash32(seed ^ uint32(k))),
		}
		n++
	}
	return n
}

// CapReach is how far from an island's centre its cap or its street can
// be seen, m, on a dome of radius dome: the street's length, the cap's
// radius, and as far as its top shows.
func (w *WeatherPrepared) CapReach(width, dome float64) float64 {
	c := &w.clouds
	wide := clamp(float64((width-capNarrow)/(capWide-capNarrow)), 0, 1)
	street := float64(float64(float64(c.capStreet)*c.cell) * capStreetStep)
	return street + max2(float64(c.capWidth*width), c.cuSize[0]) + CloudSight(dome, lerp(wide, c.capTops[0], c.capTops[1]))
}

// An island's cap is its narrowest over an island capNarrow m wide and its
// tallest over one capWide m wide; its street's clouds stand capStreetStep
// of a cell apart, each capStreetFade less than the one before.
const (
	capNarrow     = 200
	capWide       = 3000
	capStreetStep = 0.8
	capStreetFade = 0.18
)

// unit is a hash as a number in [0, 1).
func unit(h uint32) float64 { return float64(float64(h>>8) * (1.0 / (1 << 24))) }

// CloudSight is how far a cloud whose top is h m above the sea shows above
// the horizon of an eye 2 m up on a dome of radius dome, m.
func CloudSight(dome, h float64) float64 {
	return cloudSightEye + math.Sqrt(float64(float64(2*dome)*max2(h, 0)))
}

// ComingAhead is how far beyond the disk's reach a front's line is when
// its cirrus can first be seen from the disk, m: the cirrus begins its
// distance ahead of the line, and shows from the lip as far as a cloud at
// its height can be seen, on a dome of radius dome. A coming front is sent
// from then.
func (w *WeatherPrepared) ComingAhead(dome float64) float64 {
	c := &w.clouds
	return max2(w.edge+CloudSight(dome, c.heights[LayerCirrus])+c.front[0][0]-w.frontReach, 0)
}

// cloudSightEye is the horizon's distance from an eye 2 m up, m, taken
// round.
const cloudSightEye = 100
