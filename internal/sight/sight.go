// SPDX-License-Identifier: AGPL-3.0-only

// Package sight decides what a boat's lookout sees of the world: its
// islands, its places, its features and its lights. The world's horizon is
// the dome's: a thing H high shows over it to an eye h high out to
// √(2 R h) + √(2 R H), R the dome's radius (Bowditch's geographic range,
// "the maximum distance at which the curvature of the earth permits a
// light to be seen from a particular height of eye", on the world's own
// sphere). Each reach is the lesser of that and the visual range at the
// lookout and at the thing: the mist band's, physics.VisualRangeAt.
//
//   - An island is seen when any cell of its land is over the horizon: its
//     ground, and the trees, roofs and buildings on it, as a wood rises over
//     the horizon before the summit behind it. Another island seldom hides
//     one, and only for a moment, so there is no line of sight.
//   - A place or a feature that stands high (a port's town and light, a
//     lighthouse's tower, a stranded wreck's masts, a cave's roof) is seen
//     along its view: on each of the table's bearings from it, the water
//     from which nothing of the land stands above the line from the eye to
//     its top, its own hexagons aside. Its own island hides the far side.
//   - A cove, an anchorage or a lagoon is seen into: within its reach, along
//     its view at the water.
//   - A reef, a sandbar or a sunk wreck is seen by the water breaking on it,
//     within its reach.
//   - A lighthouse is seen by its light at night, while the light is lit:
//     Allard's law, its intensity's illuminance at the eye above the
//     threshold, in air of the visual range at the eye and the light, and no
//     further than its nominal range. Its island is not: a light is seen
//     "without revealing the islands around it".
//
// The table is built once from the world (Build), then only read. A look
// reads the table and the lookout's place, allocates nothing, and follows
// the physics package's float rules, so a replay sees what the world saw
// on any machine.
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

// Light is a lighthouse's light: where it is, its nominal range, m, and
// its lighthouse's subject index.
type Light struct {
	X, Y, Range float64
	Subject     int32
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
	// worked out on; Grid the side of the grid's squares, m.
	Dome float64
	Rays int
	Grid float64
	// Visibility is the mist band's, the clear air's the lights' too.
	Visibility physics.Visibility
	// Threshold is the illuminance a light is seen at, lux.
	Threshold float64
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
	x, y, high, vis float64
	subject         int32
}

// view is a subject seen along its view: on each bearing, for each eye,
// the nearest and furthest water it is seen from, m, both −1 for none.
type view struct {
	x, y, vis, far2 float64
	subject         int32
	near, far       []float32 // [eye × rays + ray]
}

// awash is a subject seen within a reach.
type awash struct {
	x, y, reach float64
	subject     int32
}

// light is a light as a look reads it: ln of its intensity's
// threshold-crossing constant, its range, and the visual range at it.
type light struct {
	x, y, rng, vis, lnI float64
	subject             int32
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
	vis      physics.Visibility
	dome     float64
	lnThr    float64
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
	// distance from the eye (EyeReach).
	Eye   int
	Reach float64
}

// Seen is a subject a look saw, and the square of its distance, m².
type Seen struct {
	Subject int32
	D2      float64
}

// Look appends to out each subject not yet charted that the lookout sees:
// once each, by any of its cells, its view or its reach; lit says which of
// the lights are lit, by index, and charted which subjects are charted, a
// bit each. It allocates nothing once out has room.
func (t *Table) Look(l *Lookout, charted []uint64, lit []bool, out []Seen) []Seen {
	vis := physics.VisualRangeAt(&t.vis, math.Sqrt(float64(l.X*l.X)+float64(l.Y*l.Y)))
	start := len(out)
	add := func(s int32, d2 float64) {
		for i := start; i < len(out); i++ {
			if out[i].Subject == s {
				out[i].D2 = min(out[i].D2, d2)
				return
			}
		}
		out = append(out, Seen{Subject: s, D2: d2})
	}
	if sq, ok := t.square(l.X, l.Y); ok {
		for _, ref := range t.refs[t.starts[sq]:t.starts[sq+1]] {
			i := ref & entryMask
			switch ref &^ entryMask {
			case entryCell:
				c := &t.cells[i]
				if isCharted(charted, c.subject) {
					continue
				}
				dx, dy := c.x-l.X, c.y-l.Y
				d2 := float64(dx*dx) + float64(dy*dy)
				r := min(l.Reach+c.high, vis, c.vis)
				if d2 <= float64(r*r) {
					add(c.subject, d2)
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
				if d > vis || d > v.vis {
					continue
				}
				k := l.Eye*t.rays + t.ray(dx, dy)
				if near, far := float64(v.near[k]), float64(v.far[k]); near >= 0 && d >= near && d <= far {
					add(v.subject, d2)
				}
			case entryAwash:
				a := &t.awash[i]
				if isCharted(charted, a.subject) {
					continue
				}
				dx, dy := a.x-l.X, a.y-l.Y
				d2 := float64(dx*dx) + float64(dy*dy)
				r := min(a.reach, vis)
				if d2 <= float64(r*r) {
					add(a.subject, d2)
				}
			}
		}
	}
	for i := range t.lights {
		lt := &t.lights[i]
		if i >= len(lit) || !lit[i] || isCharted(charted, lt.subject) {
			continue
		}
		dx, dy := lt.x-l.X, lt.y-l.Y
		d2 := float64(dx*dx) + float64(dy*dy)
		if d2 > float64(lt.rng*lt.rng) {
			continue
		}
		if t.lightSeen(lt, math.Sqrt(d2), min(vis, lt.vis)) {
			add(lt.subject, d2)
		}
	}
	return out
}

// lightSeen is Allard's law: a light of intensity I seen at d in air of
// visual range v, its transmissivity over a nautical mile 0.05^(1852 / v),
// shows while I T^(d / 1852) / d² is above the threshold.
func (t *Table) lightSeen(lt *light, d, v float64) bool {
	if d < 1 {
		return true
	}
	lnT := float64(lnTwentieth*nauticalMile) / v
	return lt.lnI+float64(d/nauticalMile*lnT)-float64(2*physics.Log(d)) >= t.lnThr
}

// nauticalMile is a nautical mile, m; lnTwentieth is ln 0.05, the
// transmissivity's over a distance of the visual range (Koschmieder's 2%,
// as the light lists take it).
const (
	nauticalMile = 1852
	lnTwentieth  = -2.995732273553991
)

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
		subjects: in.Subjects, eyes: in.Eyes, rays: in.Rays, vis: in.Visibility,
		grid: in.Grid, dome: in.Dome, with: make([][]int32, len(in.Subjects)),
		lnThr: physics.Log(in.Threshold),
	}
	if len(t.eyes) == 0 {
		t.eyes = []float64{2}
	}
	visAt := func(x, y float64) float64 { return physics.VisualRangeAt(&t.vis, hypot(x, y)) }
	high := func(h float64) float64 { return horizon(in.Dome, h) }
	eyeMost := 0.0
	for _, e := range t.eyes {
		eyeMost = max(eyeMost, high(e))
	}
	for _, c := range in.Cells {
		t.cells = append(t.cells, cell{x: c.X, y: c.Y, high: high(c.Top), vis: visAt(c.X, c.Y), subject: c.Subject})
	}
	var viewed []int32
	for i, s := range in.Subjects {
		switch s.Seen {
		case ByView, ByWater:
			viewed = append(viewed, int32(i))
		case Awash:
			t.awash = append(t.awash, awash{x: s.X, y: s.Y, reach: s.Reach, subject: int32(i)})
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
				s := &in.Subjects[viewed[k]]
				t.views[k].vis = visAt(s.X, s.Y)
			}
		})
	}
	for k := range viewed {
		next <- k
	}
	close(next)
	wg.Wait()
	clearAir := t.vis.Clear
	for _, l := range in.Lights {
		// The intensity whose light is seen at its nominal range in clear air.
		lnT := float64(lnTwentieth*nauticalMile) / clearAir
		lnI := t.lnThr + float64(2*physics.Log(l.Range)) - float64(l.Range/nauticalMile*lnT)
		t.lights = append(t.lights, light{x: l.X, y: l.Y, rng: l.Range, vis: visAt(l.X, l.Y), lnI: lnI, subject: l.Subject})
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
	t.half = float64(math.Ceil((t.vis.Lip+t.grid)/t.grid) * t.grid)
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
