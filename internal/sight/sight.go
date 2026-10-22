// SPDX-License-Identifier: AGPL-3.0-only

// Package sight decides what a boat's lookout sees of the world: its
// islands, its places, its features and its lights. The world's horizon is
// the dome's: a thing H high shows over it to an eye h high out to
// √(2 R h) + √(2 R H), R the dome's radius (Bowditch's geographic range,
// "the maximum distance at which the curvature of the earth permits a
// light to be seen from a particular height of eye", on the world's own
// sphere). Within it a thing is seen while the optical depth along the
// line from the eye to it is at most the contrast, 3.912, Koschmieder's
// 2%: the clear air's, the fog banks', the rain's and the mist band's,
// physics.OpticalDepth, as the page draws them. "An island in fog is not
// charted until a boat is close", and a fog bank between a boat and an
// island hides it.
//
//   - An island is seen when any cell of its land is over the horizon: its
//     ground, and the trees, roofs and buildings on it, as a wood rises over
//     the horizon before the summit behind it; and the air lets it be seen
//     along the line to its nearest such cell or to its highest, so that a
//     summit near a fog bank's edge shows over the bank. Another island
//     seldom hides one, and only for a moment, so there is no line of sight
//     through land.
//   - A place or a feature that stands high (a port's town and light, a
//     lighthouse's tower, a stranded wreck's masts, a cave's roof) is seen
//     along its view: on each of the table's bearings from it, the water
//     from which nothing of the land stands above the line from the eye to
//     its top, its own hexagons aside. Its own island hides the far side.
//   - A cove, an anchorage or a lagoon is seen into: within its reach, along
//     its view at the water.
//   - A reef, a sandbar or a sunk wreck is seen by the water breaking on it,
//     within its reach.
//   - A lighthouse is seen by its light, while the light is lit: Allard's
//     law, its intensity's illuminance at the eye, I e^(−τ) / d² for the
//     optical depth τ along the line (IALA R0202), above the threshold, at
//     night's or by day's, and no further than its nominal range. Its
//     intensity is the one that reaches its nominal range in the clear air
//     at night. Its island is not: a light is seen "without revealing the
//     islands around it".
//
// The table is built once from the world (Build), then only read. A look
// reads the table, the lookout's place and the weather at the tick,
// allocates nothing, and follows the physics package's float rules, so a
// replay sees what the world saw on any machine. Where no fog, rain or
// mist lies within reach of the lookout, the air is the clear air's and a
// line's optical depth its length times the clear air's extinction,
// exactly what OpticalDepth would give.
package sight

import (
	"math"
	"runtime"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The kinds of subject: what can be charted.
const (
	Island  uint8 = 1
	Place   uint8 = 2
	Feature uint8 = 3
)

// How a subject is seen.
const (
	// ByLand: an island, by any cell of its land.
	ByLand uint8 = iota
	// ByView: over the horizon along its view, at its top.
	ByView
	// ByWater: seen into within Reach, along its view at the water.
	ByWater
	// Awash: within Reach, by the water breaking on it.
	Awash
	// Hidden: seen from no water; charted with its island.
	Hidden
	// ByLight: a lighthouse whose light alone is looked for, its tower too
	// low or hidden to be seen by day from any water.
	ByLight
)

// Subject is a thing that can be charted, as the table is built from it.
type Subject struct {
	Kind   uint8
	Number int32 // its number among the world's islands, places or features
	// Island is the subject index of the island it is on or by, or -1.
	Island int32
	X, Y   float64 // m east and north of the world's centre
	// Top is how high it is seen, m above the sea: a place's or a
	// feature's top; an island's highest.
	Top float64
	// Seen is how it is seen; Reach the most it is seen from, m, for those
	// seen into or awash, and for those seen along their view (0 for no
	// more than the horizon).
	Seen  uint8
	Reach float64
}

// Cell is a cell of an island's land: where it is, how high its highest
// ground, tree or building stands, m, and the island's subject index.
type Cell struct {
	X, Y, Top float64
	Subject   int32
}

// Light is a lighthouse's light: where it is, its height above the sea
// and its nominal range, m, and its lighthouse's subject index.
type Light struct {
	X, Y, Focal, Range float64
	Subject            int32
}

// Input is what a table is built from.
type Input struct {
	Ground   *physics.Ground
	Subjects []Subject
	Cells    []Cell
	Lights   []Light
	// Eyes are the lookouts' heights, m: a view is worked out for each.
	Eyes []float64
	// Dome is the dome's radius, m; Rays how many bearings a view is
	// worked out on; Grid the side of the grid's squares, m; Lip the
	// disk's radius, m, which the grid covers with a square to spare.
	Dome float64
	Rays int
	Grid float64
	Lip  float64
	// Clear is the clear air's visibility, m, which sets each light's
	// intensity, and Contrast the optical depth a thing is seen through at
	// most.
	Clear, Contrast float64
	// Threshold is the illuminance a light is seen at at night, lux.
	Threshold float64
}

// Conditions are what a look sees by: the weather at the tick, which of
// the lights are lit, by index, and the threshold each is seen against,
// ln lux; nil for the night's for all.
type Conditions struct {
	Weather   *physics.WeatherTick
	Lit       []bool
	Threshold []float64
}

// The kinds of a grid's entry, in its top bits.
const (
	entryCell  = 0
	entryView  = 1 << 30
	entryAwash = 2 << 30
	entryMask  = 1<<30 - 1
)

// cell is a cell as a look reads it: the square of its reach from an eye at
// the sea is (eye + high)², high = √(2 R top).
type cell struct {
	x, y, high, top float64
	subject         int32
}

// view is a subject seen along its view: on each bearing, for each eye,
// the nearest and furthest water it is seen from, m, both −1 for none; and
// the height it is looked at.
type view struct {
	x, y, top, far2 float64
	subject         int32
	near, far       []float32 // [eye × rays + ray]
}

// awash is a subject seen within a reach.
type awash struct {
	x, y, reach float64
	subject     int32
}

// light is a light as a look reads it: its height, its range and ln of
// its intensity.
type light struct {
	x, y, focal, rng, lnI float64
	subject               int32
}

// Table is a world's sight table.
type Table struct {
	subjects []Subject
	with     [][]int32 // per subject: the subjects charted with it
	cells    []cell
	views    []view
	awash    []awash
	lights   []light
	eyes     []float64
	rays     int
	dome     float64
	lnThr    float64
	clear    float64 // the clear air's visibility, m
	lip      float64 // the disk's lip, m: the grid covers it
	// reachMost is the furthest a cell, a view or a reach is seen from,
	// and lightMost a light, m.
	reachMost, lightMost float64
	// The grid: squares of side grid over the disk and its margin, each
	// with the entries whose reach touches it.
	grid   float64
	side   int32
	half   float64
	starts []int32 // per square, and one more: where its entries begin
	refs   []uint32
}

// Subjects is the table's subjects, by index.
func (t *Table) Subjects() []Subject { return t.subjects }

// With is the subjects charted with subject s: an island's features seen
// from no water.
func (t *Table) With(s int32) []int32 { return t.with[s] }

// Lights is how many lights the table looks for.
func (t *Table) Lights() int { return len(t.lights) }

// LightAt is light i's place and its lighthouse's subject index.
func (t *Table) LightAt(i int) (x, y float64, subject int32) {
	l := &t.lights[i]
	return l.x, l.y, l.subject
}

// Eye is the index of the table's view for an eye h m high: the highest
// of its eyes no higher, or the lowest.
func (t *Table) Eye(h float64) int {
	best := 0
	for i, e := range t.eyes {
		if e <= h && e >= t.eyes[best] || t.eyes[best] > h && e < t.eyes[best] {
			best = i
		}
	}
	return best
}

// Lookout is a lookout whose eye is h m high, at the centre.
func (t *Table) Lookout(h float64) Lookout {
	return Lookout{Eye: t.Eye(h), Reach: t.EyeReach(h), Height: h}
}

// EyeReach is how far the horizon is from an eye h m high, m.
func (t *Table) EyeReach(h float64) float64 { return horizon(t.dome, h) }

// horizon is how far over the dome's horizon a thing h m high is seen from
// the sea, m: √(2 R h).
func horizon(dome, h float64) float64 { return math.Sqrt(float64(float64(2*dome) * max(h, 0))) }

// hypot is √(x² + y²), rounded alike on every machine: math.Hypot is not.
func hypot(x, y float64) float64 { return math.Sqrt(float64(x*x) + float64(y*y)) }

// Lookout is a boat's lookout as a look takes it.
type Lookout struct {
	X, Y float64
	// Eye is the table's view to look along (Eye); Reach the horizon's
	// distance from the eye (EyeReach); Height the eye's height, m.
	Eye    int
	Reach  float64
	Height float64
}

// Seen is a subject a look saw, and the square of its distance, m².
type Seen struct {
	Subject int32
	D2      float64
	// An island, while a look weighs it: its nearest cell over the
	// horizon and its highest, by index; −1 for no island.
	near, high int32
	highD2     float64
}

// Look appends to out each subject not yet charted that the lookout sees:
// once each, by any of its cells, its view or its reach; c says the
// weather and which lights are lit, and charted which subjects are
// charted, a bit each. It allocates nothing once out has room.
func (t *Table) Look(l *Lookout, charted []uint64, c *Conditions, out []Seen) []Seen {
	w := c.Weather
	p := w.Prepared()
	a := air{w: w, contrast: p.Contrast(), clear: p.ClearExtinction(), l: l}
	a.open = physics.AirClear(w, l.X, l.Y, t.reachMost)
	start := len(out)
	if sq, ok := t.square(l.X, l.Y); ok {
		for _, ref := range t.refs[t.starts[sq]:t.starts[sq+1]] {
			i := ref & entryMask
			switch ref &^ entryMask {
			case entryCell:
				cl := &t.cells[i]
				if isCharted(charted, cl.subject) {
					continue
				}
				dx, dy := cl.x-l.X, cl.y-l.Y
				d2 := float64(dx*dx) + float64(dy*dy)
				r := l.Reach + cl.high
				if d2 <= float64(r*r) {
					out = t.weigh(out, start, cl.subject, int32(i), d2)
				}
			case entryView:
				v := &t.views[i]
				if isCharted(charted, v.subject) {
					continue
				}
				dx, dy := l.X-v.x, l.Y-v.y
				d2 := float64(dx*dx) + float64(dy*dy)
				if d2 > v.far2 {
					continue
				}
				d := math.Sqrt(d2)
				k := l.Eye*t.rays + t.ray(dx, dy)
				if near, far := float64(v.near[k]), float64(v.far[k]); near >= 0 && d >= near && d <= far && a.seen(v.x, v.y, v.top) {
					out = add(out, start, v.subject, d2)
				}
			case entryAwash:
				aw := &t.awash[i]
				if isCharted(charted, aw.subject) {
					continue
				}
				dx, dy := aw.x-l.X, aw.y-l.Y
				d2 := float64(dx*dx) + float64(dy*dy)
				if d2 <= float64(aw.reach*aw.reach) && a.seen(aw.x, aw.y, waterTop) {
					out = add(out, start, aw.subject, d2)
				}
			}
		}
	}
	// Each island over the horizon: seen along the line to its nearest
	// cell over it, or else to its highest.
	n := start
	for i := start; i < len(out); i++ {
		s := out[i]
		if s.near >= 0 {
			nc := &t.cells[s.near]
			switch {
			case a.seen(nc.x, nc.y, nc.top):
			case s.high != s.near && a.seen(t.cells[s.high].x, t.cells[s.high].y, t.cells[s.high].top):
				s.D2 = s.highD2
			default:
				continue
			}
		}
		s.near, s.high = -1, -1
		out[n] = s
		n++
	}
	out = out[:n]
	looked := false
	for i := range t.lights {
		lt := &t.lights[i]
		if i >= len(c.Lit) || !c.Lit[i] || isCharted(charted, lt.subject) {
			continue
		}
		dx, dy := lt.x-l.X, lt.y-l.Y
		d2 := float64(dx*dx) + float64(dy*dy)
		if d2 > float64(lt.rng*lt.rng) {
			continue
		}
		if !looked {
			a.open, looked = physics.AirClear(w, l.X, l.Y, t.lightMost), true
		}
		thr := t.lnThr
		if i < len(c.Threshold) {
			thr = c.Threshold[i]
		}
		if t.lightSeen(lt, math.Sqrt(d2), a.depth(lt.x, lt.y, lt.focal), thr) {
			out = add(out, start, lt.subject, d2)
		}
	}
	return out
}

// add keeps subject s seen at d2 m² in out, once, from start on.
func add(out []Seen, start int, s int32, d2 float64) []Seen {
	for i := start; i < len(out); i++ {
		if out[i].Subject == s {
			out[i].D2 = min(out[i].D2, d2)
			return out
		}
	}
	return append(out, Seen{Subject: s, D2: d2, near: -1, high: -1})
}

// weigh keeps island cell i, d2 m² off and over the horizon, in out from
// start on: its island's nearest cell and its highest so far.
func (t *Table) weigh(out []Seen, start int, s, i int32, d2 float64) []Seen {
	for k := start; k < len(out); k++ {
		o := &out[k]
		if o.Subject != s {
			continue
		}
		if d2 < o.D2 {
			o.D2, o.near = d2, i
		}
		if t.cells[i].top > t.cells[o.high].top {
			o.high, o.highD2 = i, d2
		}
		return out
	}
	return append(out, Seen{Subject: s, D2: d2, near: i, high: i, highD2: d2})
}

// air is the air a look sees through.
type air struct {
	w               *physics.WeatherTick
	contrast, clear float64
	// open: no fog, rain or mist within reach of the lookout, so the air
	// is the clear air's.
	open bool
	l    *Lookout
}

// depth is the optical depth from the lookout's eye to (x, y), h m up.
func (a *air) depth(x, y, h float64) float64 {
	if !a.open {
		return physics.OpticalDepth(a.w, a.l.X, a.l.Y, a.l.Height, x, y, h)
	}
	// As OpticalDepth gives it in the clear air alone, op for op.
	dx, dy, dh := x-a.l.X, y-a.l.Y, h-a.l.Height
	d2 := float64(dx*dx) + float64(dy*dy)
	return float64(a.clear * math.Sqrt(d2+float64(dh*dh)))
}

// seen reports whether a thing at (x, y), h m up, is seen through the air.
func (a *air) seen(x, y, h float64) bool { return a.depth(x, y, h) <= a.contrast }

// lightSeen is Allard's law: a light of intensity I seen at d m through an
// optical depth tau shows while I e^(−tau) / d² is above the threshold,
// ln lux.
func (t *Table) lightSeen(lt *light, d, tau, thr float64) bool {
	if d < 1 {
		return true
	}
	return lt.lnI-tau-float64(2*physics.Log(d)) >= thr
}

// ray is the bearing nearest the way (dx, dy) points, clockwise from north.
func (t *Table) ray(dx, dy float64) int {
	a := physics.Atan2(dx, dy)
	if a < 0 {
		a += 2 * math.Pi
	}
	k := int(math.Floor(float64(a*float64(float64(t.rays)/(2*math.Pi))) + 0.5))
	if k >= t.rays {
		k -= t.rays
	}
	return k
}

// square is the grid's square at (x, y).
func (t *Table) square(x, y float64) (int32, bool) {
	a := math.Floor((x + t.half) / t.grid)
	b := math.Floor((y + t.half) / t.grid)
	if a < 0 || b < 0 || a >= float64(t.side) || b >= float64(t.side) {
		return 0, false
	}
	return int32(b)*t.side + int32(a), true
}

func isCharted(charted []uint64, s int32) bool {
	w := int(s >> 6)
	return w < len(charted) && charted[w]&(1<<(s&63)) != 0
}

// Words is how many words a bitmap of n subjects takes.
func Words(n int) int { return (n + 63) / 64 }

// Build makes the table from in. The views are worked out on every core.
func Build(in *Input) *Table {
	t := &Table{
		subjects: in.Subjects, eyes: in.Eyes, rays: in.Rays, clear: in.Clear,
		grid: in.Grid, dome: in.Dome, with: make([][]int32, len(in.Subjects)),
		lnThr: physics.Log(in.Threshold), lip: in.Lip,
	}
	if len(t.eyes) == 0 {
		t.eyes = []float64{2}
	}
	high := func(h float64) float64 { return horizon(in.Dome, h) }
	eyeMost := 0.0
	for _, e := range t.eyes {
		eyeMost = max(eyeMost, high(e))
	}
	for _, c := range in.Cells {
		t.cells = append(t.cells, cell{x: c.X, y: c.Y, high: high(c.Top), top: c.Top, subject: c.Subject})
		t.reachMost = max(t.reachMost, eyeMost+high(c.Top))
	}
	var viewed []int32
	for i, s := range in.Subjects {
		switch s.Seen {
		case ByView, ByWater:
			viewed = append(viewed, int32(i))
		case Awash:
			t.awash = append(t.awash, awash{x: s.X, y: s.Y, reach: s.Reach, subject: int32(i)})
			t.reachMost = max(t.reachMost, s.Reach)
		case Hidden:
			if s.Island >= 0 {
				t.with[s.Island] = append(t.with[s.Island], int32(i))
			}
		}
	}
	t.views = make([]view, len(viewed))
	var wg sync.WaitGroup
	next := make(chan int)
	for range runtime.GOMAXPROCS(0) {
		wg.Go(func() {
			for k := range next {
				t.views[k] = buildView(in, viewed[k], high)
			}
		})
	}
	for k := range viewed {
		next <- k
	}
	close(next)
	wg.Wait()
	for i := range t.views {
		t.reachMost = max(t.reachMost, math.Sqrt(t.views[i].far2))
	}
	// Each light's intensity, whose light is seen at its nominal range in
	// the clear air at night: ln I = ln E + 2 ln R + σ R.
	sigma := 0.0
	if in.Clear > 0 {
		sigma = in.Contrast / in.Clear
	}
	for _, l := range in.Lights {
		lnI := t.lnThr + float64(2*physics.Log(l.Range)) + float64(sigma*l.Range)
		t.lights = append(t.lights, light{x: l.X, y: l.Y, focal: l.Focal, rng: l.Range, lnI: lnI, subject: l.Subject})
		t.lightMost = max(t.lightMost, l.Range)
	}
	t.index(eyeMost)
	return t
}

// buildView works out subject s's view: along each ray, from each eye.
func buildView(in *Input, s int32, high func(float64) float64) view {
	sub := &in.Subjects[s]
	v := view{x: sub.X, y: sub.Y, subject: s,
		near: make([]float32, len(in.Eyes)*in.Rays), far: make([]float32, len(in.Eyes)*in.Rays)}
	top := sub.Top
	if sub.Seen == ByWater {
		top = waterTop
	}
	v.top = top
	most := 0.0
	for e, eye := range in.Eyes {
		reach := high(eye) + high(top)
		if sub.Seen == ByWater {
			reach = sub.Reach
		} else if sub.Reach > 0 {
			reach = min(reach, sub.Reach)
		}
		for r := range in.Rays {
			sa, ca := physics.SinCos(float64(float64(r)*(2*math.Pi)) / float64(in.Rays))
			near, far := -1.0, -1.0
			for k := 1; float64(k*viewStep) <= reach; k++ {
				d := float64(k * viewStep)
				px, py := sub.X+float64(d*sa), sub.Y+float64(d*ca)
				if g, _ := in.Ground.At(px, py); g > 0 {
					continue
				}
				if inView(in.Ground, px, py, sub.X, sub.Y, eye, top) {
					if near < 0 {
						near = d
					}
					far = d
				}
			}
			v.near[e*in.Rays+r], v.far[e*in.Rays+r] = float32(near), float32(far)
			most = max(most, far)
		}
	}
	// The furthest it is seen from, with half a step to spare.
	most += viewStep / 2
	v.far2 = most * most
	return v
}

// viewStep is how far apart a view's water is looked from, m; waterTop the
// height a cove's or a lagoon's water is looked at, m: its far shore.
const (
	viewStep = 8
	waterTop = 1
)

// inView reports whether a point top m up at (x1, y1) is in view of an eye
// m up over (x0, y0): the ground stands below the line between them, the
// last two hexagons before the point aside, its own.
func inView(g *physics.Ground, x0, y0, x1, y1, eye, top float64) bool {
	d := hypot(x1-x0, y1-y0)
	for k := 1; float64(k*physics.HexAcross) < d-2*physics.HexAcross; k++ {
		u := float64(k*physics.HexAcross) / d
		e, _ := g.At(x0+float64(u*(x1-x0)), y0+float64(u*(y1-y0)))
		if e > eye+float64(u*(top-eye)) {
			return false
		}
	}
	return true
}

// index puts each entry in the grid's squares its reach touches, from an
// eye whose horizon is eyeMost m off.
func (t *Table) index(eyeMost float64) {
	t.half = float64(math.Ceil((t.lip+t.grid)/t.grid) * t.grid)
	t.side = int32(2 * t.half / t.grid)
	n := int(t.side) * int(t.side)
	lists := make([][]uint32, n)
	put := func(ref uint32, x, y, reach float64) {
		a0 := max(int32(math.Floor((x-reach+t.half)/t.grid)), 0)
		a1 := min(int32(math.Floor((x+reach+t.half)/t.grid)), t.side-1)
		b0 := max(int32(math.Floor((y-reach+t.half)/t.grid)), 0)
		b1 := min(int32(math.Floor((y+reach+t.half)/t.grid)), t.side-1)
		for b := b0; b <= b1; b++ {
			for a := a0; a <= a1; a++ {
				// The square's nearest point to (x, y).
				sx := min(max(x, float64(float64(a)*t.grid)-t.half), float64(float64(a+1)*t.grid)-t.half)
				sy := min(max(y, float64(float64(b)*t.grid)-t.half), float64(float64(b+1)*t.grid)-t.half)
				if hypot(sx-x, sy-y) <= reach+1 {
					lists[b*t.side+a] = append(lists[b*t.side+a], ref)
				}
			}
		}
	}
	for i, c := range t.cells {
		put(entryCell|uint32(i), c.x, c.y, eyeMost+c.high)
	}
	for i, v := range t.views {
		put(entryView|uint32(i), v.x, v.y, math.Sqrt(v.far2))
	}
	for i, a := range t.awash {
		put(entryAwash|uint32(i), a.x, a.y, a.reach)
	}
	t.starts = make([]int32, n+1)
	for i, l := range lists {
		t.starts[i+1] = t.starts[i] + int32(len(l))
		t.refs = append(t.refs, l...)
	}
}

// Size is how many entries the table holds: cells, views, reaches and
// lights; and its grid's references.
func (t *Table) Size() (cells, views, awash, lights, refs int) {
	return len(t.cells), len(t.views), len(t.awash), len(t.lights), len(t.refs)
}

// Export is a table as the page's offline sandbox reads it: everything a
// look reads, by entry, without the grid, which it does without. The
// sandbox asks its physics module for the optical depth along each line.
type Export struct {
	Subjects int       `json:"subjects"`
	Rays     int       `json:"rays"`
	Dome     float64   `json:"dome"`
	Eyes     []float64 `json:"eyes"`
	LnThresh float64   `json:"lnThreshold"`
	// Cells are x, y, the horizon's distance from their top and their
	// top, m; CellSubjects their islands.
	Cells        [][4]float64    `json:"cells"`
	CellSubjects []int32         `json:"cellSubjects"`
	Views        []ExportView    `json:"views"`
	Awash        []ExportReach   `json:"awash"`
	Lights       []ExportLight   `json:"lights"`
	With         map[int][]int32 `json:"with"`
}

// ExportView is a view as Export holds it.
type ExportView struct {
	X, Y, Top, Far2 float64
	Subject         int32
	Near, Far       []float32
}

// ExportReach is a subject seen within a reach.
type ExportReach struct {
	X, Y, Reach float64
	Subject     int32
}

// ExportLight is a light as Export holds it.
type ExportLight struct {
	X, Y, Focal, Range, LnI float64
	Subject                 int32
}

// Export is the table as the sandbox reads it.
func (t *Table) Export() Export {
	e := Export{Subjects: len(t.subjects), Rays: t.rays, Dome: t.dome, Eyes: t.eyes, LnThresh: t.lnThr, With: map[int][]int32{}}
	for _, c := range t.cells {
		e.Cells = append(e.Cells, [4]float64{c.x, c.y, c.high, c.top})
		e.CellSubjects = append(e.CellSubjects, c.subject)
	}
	for _, v := range t.views {
		e.Views = append(e.Views, ExportView{X: v.x, Y: v.y, Top: v.top, Far2: v.far2, Subject: v.subject, Near: v.near, Far: v.far})
	}
	for _, a := range t.awash {
		e.Awash = append(e.Awash, ExportReach{X: a.x, Y: a.y, Reach: a.reach, Subject: a.subject})
	}
	for _, l := range t.lights {
		e.Lights = append(e.Lights, ExportLight{X: l.x, Y: l.y, Focal: l.focal, Range: l.rng, LnI: l.lnI, Subject: l.subject})
	}
	for s, w := range t.with {
		if len(w) > 0 {
			e.With[s] = w
		}
	}
	return e
}
