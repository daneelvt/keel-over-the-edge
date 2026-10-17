// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Each island is made on its own piece of the lattice, from its own stream,
// so it comes out the same whatever its neighbours, and a test can make one
// alone.
//
// Its shape is a field, land where the field is above nought: a few
// overlapping lobes, each an anisotropic Euclidean-squared distance from a
// point, 1 − ((u/a)² + (v/b)²); the first octaves of noise added to it; the
// whole sampled at points displaced by more noise (domain warping; Quilez),
// which bends the lobes' round coasts into bays and capes; and a finer
// noise added after, so that the reshaping does not flatten it (Red Blob
// Games, "Island shaping functions", 2022). The field is offset so that the
// island's area is that of a circle of its radius. Its height rises inland
// by its biome's profile, rolling hills, ridges or a cone; cliffs stand on
// stretches of its coast, beaches on the rest; then thermal weathering and
// droplets of rain wear it. The sea bed falls away from its coast by Dean's
// profile (seabed.go).

// islandGrid is an island's piece of the lattice: w columns from column c0
// and h rows from row j0, column by column, each hexagon's elevation in
// decimetres and surface.
type islandGrid struct {
	c0, j0, w, h int32
	elev         []int16
	surf         []uint8
}

// made is an island as made: its grid and what it shows.
type made struct {
	spot
	number    int32
	grid      islandGrid
	area      float64 // land, m²
	highest   float64 // m
	hx, hy    float64 // where its highest point is
	cliffs    float64 // the share of its coast with cliffs
	stacks    int32
	reef      bool
	lagoon    float64 // the lagoon's width behind its reef, m
	reefAt    float64 // how far its reef's crest is from its coast, m
	barAt     float64 // how far its bar is from its coast, m; 0 for none
	crest     []int32 // its reef's crest: the hexagons of its grid awash
	bar       []int32 // its bar's hexagons, the shallowest across it
	reefRock  int32   // the hexagon of its grid its reef's rock stands on, or -1
	bays      int     // how many bays its shape has bitten into its coast
	twin      bool
	shoreline float64 // its shoreline development index, on the smoothed coast
	// approach is the water within approachReach of its coast, as columns
	// and rows of the lattice: where a boat has reached it.
	approach [][2]int32
	// harbour is Port Royal's harbour, nil on any other island, and
	// harbourWater which of its grid's hexagons are the harbour's water;
	// basin its basin's area, m².
	harbour      *harbour
	harbourWater []bool
	basin        float64
	// own is which of its grid's hexagons are its own land: not a stack's.
	own []bool
}

// harbourShapes is how many shapes Port Royal's island is drawn in, at
// most, until its harbour fits.
const harbourShapes = 16

// approachReach is how near its coast a boat must come to have reached an
// island, m.
const approachReach = 150

// hexArea is a hexagon's area, m²: √3/2 × 4².
const hexArea = 13.856406460551018

// work is the room an island is made in, kept between islands so that
// making the next allocates little.
type work struct {
	land              []bool
	height, din, dout []float64
	near              []int32
	cliff             []bool
	xs                []float64
	field             []float64
	coarse            []float64
	harbour           []bool
}

// grow returns s with length n, reusing its storage.
func grow[T any](s []T, n int) []T {
	if cap(s) < n {
		return make([]T, n)
	}
	s = s[:n]
	clear(s)
	return s
}

// lobe is one of a shape's lobes, in units of the island's radius.
type lobe struct {
	x, y     float64
	a, b     float64 // its semi-axes
	sin, cos float64 // of its turn
}

// shape is an island's field.
type shape struct {
	radius         float64
	lobes          []lobe
	bays           []lobe
	warp           float64
	seeds          [4]uint32
	detail         float64 // the fine noise's weight
	detailFreq     float64 // and its first octave's frequency, per radius
	bias           float64
	extent         float64 // the field is nought beyond this many radii
	shorelineIndex float64
}

// value is the field at (u, v), in radii from the island's centre.
func (s *shape) value(u, v float64) float64 {
	r := hypot(u, v)
	if r >= s.extent {
		return -1
	}
	wu := u + float64(s.warp*fbm(float64(u*1.6)+3.1, float64(v*1.6)-1.7, s.seeds[0], 0, 4))
	wv := v + float64(s.warp*fbm(float64(u*1.6)-5.3, float64(v*1.6)+2.9, s.seeds[1], 0, 4))
	best := math.Inf(-1)
	for i := range s.lobes {
		best = max(best, 1-s.lobes[i].distance(wu, wv))
	}
	// Bays bite into the coast.
	for i := range s.bays {
		if d := s.bays[i].distance(wu, wv); d < 1 {
			best -= float64(1.6 * (1 - d))
		}
	}
	f := best + float64(0.45*fbm(float64(wu*2.2), float64(wv*2.2), s.seeds[2], 0, 3))
	f += float64(s.detail * fbm(float64(wu*s.detailFreq), float64(wv*s.detailFreq), s.seeds[3], 0, 3))
	// Nothing reaches its edge.
	f -= float64(2 * smoothstep(s.extent-0.3, s.extent, r))
	return f + s.bias
}

// distance is the lobe's anisotropic Euclidean-squared distance at (u, v):
// 1 on its edge.
func (l *lobe) distance(u, v float64) float64 {
	du, dv := u-l.x, v-l.y
	lu := dot(du, dv, l.cos, l.sin) / l.a
	lv := (float64(dv*l.cos) - float64(du*l.sin)) / l.b
	return float64(lu*lu) + float64(lv*lv)
}

// coarseSide is how many samples a side the shape is first sampled at, to
// set its area and measure its coast.
const coarseSide = 64

// newShape draws an island's shape: its lobes, warp and noise, offset so
// that its area is a circle's of its radius.
func newShape(s stream, radius float64, b *biome, w *work) *shape {
	sh := &shape{radius: radius, warp: b.warp, extent: 1.75}
	for k := range sh.seeds {
		sh.seeds[k] = s.seed32()
	}
	// The finest detail is about 24 m across; on a small island it is
	// fainter, so that it does not break the island up.
	sh.detailFreq = max(radius/24, 1.5)
	sh.detail = float64(0.12 * smoothstep(8, 60, radius))
	n := s.pick(b.lobes[0], b.lobes[1])
	if radius < 40 {
		n = min(n, 2)
	}
	elong := s.in(b.elongation[0], b.elongation[1])
	for i := range n {
		var l lobe
		k := s.in(0.45, 0.7)
		if i == 0 {
			k = s.in(0.75, 0.95)
		} else {
			d := s.in(0.3, 0.6)
			sa, ca := sincos(s.angle())
			l.x, l.y = float64(d*sa), float64(d*ca)
		}
		e := math.Sqrt(lerp(s.float(), 1, elong))
		if i == 0 {
			e = math.Sqrt(elong)
		}
		l.a, l.b = float64(k*e), k/e
		l.sin, l.cos = sincos(s.angle())
		sh.lobes = append(sh.lobes, l)
	}
	// Bays: ellipses about the coast, each a third to a half of the
	// radius long, which the field is lowered within.
	if radius >= 40 {
		for range s.pick(b.bays[0], b.bays[1]) {
			sa, ca := sincos(s.angle())
			d := s.in(0.75, 1.05)
			k := s.in(0.25, 0.45)
			e := math.Sqrt(s.in(1, 2.5))
			var l lobe
			l.x, l.y = float64(d*sa), float64(d*ca)
			l.a, l.b = float64(k*e), k/e
			l.sin, l.cos = sincos(s.angle())
			sh.bays = append(sh.bays, l)
		}
	}
	// The lobes are drawn to keep within 1.25 radii.
	reach := 0.0
	for _, l := range sh.lobes {
		reach = max(reach, hypot(l.x, l.y)+max(l.a, l.b))
	}
	if reach > 1.25 {
		f := 1.25 / reach
		for _, ls := range [][]lobe{sh.lobes, sh.bays} {
			for i := range ls {
				l := &ls[i]
				l.x, l.y, l.a, l.b = float64(l.x*f), float64(l.y*f), float64(l.a*f), float64(l.b*f)
			}
		}
	}
	sh.fit(w)
	return sh
}

// fineShoreline is the shape's shoreline development index on its coast
// sampled every few metres: what a landmark's is judged by.
func (sh *shape) fineShoreline(w *work) float64 {
	side := float64(2 * sh.extent)
	n := min(max(int(toInt32(float64(side*sh.radius)/6)), coarseSide), 1024)
	step := side / float64(n)
	w.field = grow(w.field, n*n)
	for i := range n {
		for j := range n {
			u := float64((float64(i)+0.5)*step) - sh.extent
			v := float64((float64(j)+0.5)*step) - sh.extent
			w.field[i*n+j] = sh.value(u, v)
		}
	}
	return shoreline(w.field, n, step)
}

// fit offsets the field so that its area is π radii², by bisection on a
// coarse sampling of it, and measures its smoothed coast there.
func (sh *shape) fit(w *work) {
	side := float64(2 * sh.extent)
	step := side / coarseSide
	w.coarse = grow(w.coarse, coarseSide*coarseSide)
	for i := range coarseSide {
		for j := range coarseSide {
			u := float64((float64(i)+0.5)*step) - sh.extent
			v := float64((float64(j)+0.5)*step) - sh.extent
			w.coarse[i*coarseSide+j] = sh.value(u, v)
		}
	}
	want := math.Pi / float64(step*step)
	lo, hi := -1.5, 1.5
	for range 40 {
		mid := float64((lo + hi) / 2)
		n := 0
		for _, f := range w.coarse {
			if f+mid > 0 {
				n++
			}
		}
		if float64(n) < want {
			lo = mid
		} else {
			hi = mid
		}
	}
	sh.bias = (lo + hi) / 2
	for i := range w.coarse {
		w.coarse[i] += sh.bias
	}
	sh.shorelineIndex = shoreline(w.coarse, coarseSide, step)
}

// shoreline is the shoreline development index of the field's land, L /
// (2√(πA)): its coast's length by marching squares, which lays the coast
// between samples where the field crosses nought, over the circumference of
// a circle of its area.
func shoreline(f []float64, n int, step float64) float64 {
	var length, area float64
	at := func(i, j int) float64 { return f[i*n+j] }
	for i := range n {
		for j := range n {
			if at(i, j) > 0 {
				area += float64(step * step)
			}
		}
	}
	cross := func(a, b float64) float64 { return a / (a - b) }
	for i := range n - 1 {
		for j := range n - 1 {
			a, b, c, d := at(i, j), at(i+1, j), at(i+1, j+1), at(i, j+1)
			var px, py [4]float64
			k := 0
			if (a > 0) != (b > 0) {
				px[k], py[k] = cross(a, b), 0
				k++
			}
			if (b > 0) != (c > 0) {
				px[k], py[k] = 1, cross(b, c)
				k++
			}
			if (c > 0) != (d > 0) {
				px[k], py[k] = 1-cross(c, d), 1
				k++
			}
			if (d > 0) != (a > 0) {
				px[k], py[k] = 0, 1-cross(d, a)
				k++
			}
			for e := 0; e+1 < k; e += 2 {
				length += float64(step * hypot(px[e+1]-px[e], py[e+1]-py[e]))
			}
		}
	}
	if !(area > 0) {
		return 0
	}
	return length / float64(2*math.Sqrt(float64(math.Pi*area)))
}

// gridFor is the piece of the lattice about (x, y) that reaches e metres
// each way, within the world's grid.
func gridFor(x, y, e float64) islandGrid {
	qa, _ := physics.HexAt(x-e, y)
	qb, _ := physics.HexAt(x+e, y)
	ca, _ := physics.HexCell(qa, 0)
	cb, _ := physics.HexCell(qb, 0)
	c0 := max(ca-1, 0)
	c1 := min(cb+1, physics.HexColumns-1)
	j0 := max(round((y-e)/physics.HexAcross)+physics.HexRows/2-2, 0)
	j1 := min(round((y+e)/physics.HexAcross)+physics.HexRows/2+2, physics.HexRows-1)
	g := islandGrid{c0: c0, j0: j0, w: max(c1-c0+1, 0), h: max(j1-j0+1, 0)}
	return g
}

// centre is the centre of the grid's hexagon at index i.
func (g *islandGrid) centre(i int32) (x, y float64) {
	return physics.CellCentre(g.c0+i/g.h, g.j0+i%g.h)
}

// neighbours writes the indices of hexagon i's neighbours on the grid to
// out and returns how many there are: an even column's are the columns
// either side at its row and the row below, an odd column's at its row and
// the row above.
func (g *islandGrid) neighbours(i int32, out *[6]int32) int {
	cc, jj := i/g.h, i%g.h
	n := 0
	add := func(c, j int32) {
		if c >= 0 && j >= 0 && c < g.w && j < g.h {
			out[n] = c*g.h + j
			n++
		}
	}
	add(cc, jj-1)
	add(cc, jj+1)
	d := int32(-1)
	if (g.c0+cc)&1 == 1 {
		d = 1
	}
	add(cc-1, jj)
	add(cc-1, jj+d)
	add(cc+1, jj)
	add(cc+1, jj+d)
	return n
}

// distances sets d to each hexagon's distance to the nearest hexagon where
// seed is true, centre to centre: the nearest seed is passed from
// neighbour to neighbour in passes forward and back over the grid until
// none improves (a vector propagation; Danielsson 1980).
func (g *islandGrid) distances(seed []bool, d []float64, near []int32, xs []float64) {
	n := g.w * g.h
	for i := range n {
		d[i], near[i] = math.Inf(1), -1
		if seed[i] {
			d[i], near[i] = 0, i
		}
	}
	ys := func(i int32) float64 {
		c, j := g.c0+i/g.h, g.j0+i%g.h
		return float64(physics.HexAcross*float64(j)) + float64(2*float64(c&1))
	}
	try := func(i, from int32) bool {
		s := near[from]
		if s < 0 || s == near[i] {
			return false
		}
		dx := xs[i/g.h] - xs[s/g.h]
		dy := ys(i) - ys(s)
		dd := math.Sqrt(float64(dx*dx) + float64(dy*dy))
		if dd < d[i] {
			d[i], near[i] = dd, s
			return true
		}
		return false
	}
	var nb [6]int32
	for pass := range 8 {
		changed := false
		for k := range n {
			i := k
			if pass%2 == 1 {
				i = n - 1 - k
			}
			m := g.neighbours(i, &nb)
			for _, j := range nb[:m] {
				if try(i, j) {
					changed = true
				}
			}
		}
		if !changed && pass > 0 {
			break
		}
	}
}

// makeIsland makes island number n at its spot, from its own stream.
func (c *config) makeIsland(seed uint64, n int32, sp spot, w *work) *made {
	s := newStream(seed, streamIsland+uint64(n))
	b := &c.biomes[sp.biome]
	m := &made{spot: sp, number: n, reefRock: -1}
	var sh *shape
	tries := 1
	if sp.kind == kindLandmark {
		tries = 10
	}
	for range tries {
		cand := newShape(s, sp.radius, b, w)
		if sp.kind == kindLandmark || sp.kind == kindMain {
			cand.shorelineIndex = cand.fineShoreline(w)
		}
		if sh == nil || cand.shorelineIndex > sh.shorelineIndex {
			sh = cand
		}
		if sh.shorelineIndex >= float64(c.validator.Shoreline)+0.1 {
			break
		}
	}
	m.shoreline = sh.shorelineIndex
	m.bays = len(sh.bays)
	landReach := float64(sh.extent * sp.radius)
	bedReach := float64(min(c.seabed.ReachBase+float64(c.seabed.ReachPerRadius*sp.radius), c.seabed.ReachMost) *
		(1 + c.seabed.ReachVaries))
	g := gridFor(sp.x, sp.y, landReach+bedReach+physics.HexAcross)
	m.grid = g
	total := g.w * g.h
	w.land = grow(w.land, int(total))
	w.height = grow(w.height, int(total))
	w.din = grow(w.din, int(total))
	w.dout = grow(w.dout, int(total))
	w.near = grow(w.near, int(total))
	w.cliff = grow(w.cliff, int(total))
	w.xs = grow(w.xs, int(g.w))
	for cc := range g.w {
		w.xs[cc], _ = physics.CellCentre(g.c0+cc, 0)
	}
	inv := 1 / sp.radius
	fill := func(sh *shape) {
		for i := range total {
			x, y := g.centre(i)
			u, v := float64((x-sp.x)*inv), float64((y-sp.y)*inv)
			w.land[i] = math.Abs(u) < sh.extent && math.Abs(v) < sh.extent && sh.value(u, v) > 0
		}
	}
	fill(sh)
	w.harbour = grow(w.harbour, int(total))
	if sp.kind == kindMain {
		// Port Royal's island is drawn again, from its own stream, until
		// its harbour fits: room for the basin with land round it.
		for range harbourShapes {
			if h := c.drawHarbour(seed, m, w.land); h != nil {
				h.carve(&m.grid, w.land, w.harbour)
				m.harbour = h
				break
			}
			sh = newShape(s, sp.radius, b, w)
			sh.shorelineIndex = sh.fineShoreline(w)
			m.shoreline, m.bays = sh.shorelineIndex, len(sh.bays)
			fill(sh)
		}
	}
	// Inland, the distance to the sea; offshore, to the land.
	sea := grow(w.cliff, int(total)) // borrowed as the sea's mask
	for i := range total {
		sea[i] = !w.land[i]
	}
	g.distances(sea, w.din, w.near, w.xs)
	g.distances(w.land, w.dout, w.near, w.xs)
	w.cliff = grow(w.cliff, int(total))

	c.heights(s, m, sh, b, w)
	c.erode(s, m, w)
	c.seabedOf(s, m, b, w)
	c.stacksOf(s, m, b, w)
	c.surfaces(m, b, w)
	if m.harbour != nil {
		c.finishHarbour(m, w)
		m.harbourWater = append([]bool(nil), w.harbour...)
		for i := range total {
			if x, y := g.centre(i); w.harbour[i] && m.harbour.inBasin(x, y) {
				m.basin += hexArea
			}
		}
	}
	m.measure(c, w)
	for i := range total {
		if !w.land[i] && w.dout[i] <= approachReach && (i%g.h)%2 == 0 && (i/g.h)%2 == 0 {
			m.approach = append(m.approach, [2]int32{g.c0 + i/g.h, g.j0 + i%g.h})
		}
	}
	return m
}

// heights raises the island's land: its biome's profile, cliffs on
// stretches of its coast and beaches on the rest.
func (c *config) heights(s stream, m *made, sh *shape, b *biome, w *work) {
	g := &m.grid
	total := g.w * g.h
	top := s.in(b.height[0], b.height[1])
	cliffShare := s.in(b.cliffs[0], b.cliffs[1])
	cliffHeight := s.in(b.cliffHeight[0], b.cliffHeight[1])
	switch m.kind {
	case kindMain:
		top = s.in(c.port.height[0], c.port.height[1])
		cliffShare = max(cliffShare, c.port.cliffs)
		cliffHeight = max(cliffHeight, s.in(10, 25))
	case kindRock:
		top = s.in(1.5, 12)
		cliffShare, cliffHeight = 0, 0
	}
	// A small island cannot stand as tall as a large one at the angle its
	// ground keeps.
	top = clamp(min(top, max(float64(0.6*m.radius), 1.5)), c.land[0]+0.2, c.land[1])
	cliffHeight = min(cliffHeight, top)
	seeds := [4]uint32{s.seed32(), s.seed32(), s.seed32(), s.seed32()}
	cu, cv := s.in(-0.15, 0.15), s.in(-0.15, 0.15) // the cone's centre, in radii
	crater := s.chance(b.crater)
	inland := 0.0
	for i := range total {
		if w.land[i] {
			inland = max(inland, w.din[i])
		}
	}
	inland = max(inland, physics.HexAcross)
	// The cliffs' stretches: a smooth function of the direction from the
	// island's centre, cliff where it is above the quantile that gives the
	// share drawn.
	var amp, phase [5]float64
	for k := range amp {
		amp[k], phase[k] = s.in(0.3, 1)/float64(k+1), s.angle()
	}
	cliffAt := func(x, y float64) float64 {
		a := physics.Atan2(x-m.x, y-m.y)
		var sum float64
		for k := range amp {
			sum += float64(amp[k] * physics.Sin(float64(float64(k+1)*a)+phase[k]))
		}
		return sum
	}
	// The threshold is the quantile of the function over the coast's own
	// hexagons, so that the share drawn is the share of the coast.
	var nb [6]int32
	var coast []float64
	for i := range total {
		if !w.land[i] {
			continue
		}
		if harbourShore(g, i, w.harbour, &nb) {
			continue
		}
		k := g.neighbours(i, &nb)
		for _, j := range nb[:k] {
			if !w.land[j] {
				x, y := g.centre(i)
				coast = append(coast, cliffAt(x, y))
				break
			}
		}
	}
	slices.Sort(coast)
	threshold := math.Inf(1)
	if cliffShare > 0 && len(coast) > 0 {
		threshold = coast[min(len(coast)-1, max(0, int(toInt32(float64(float64(1-cliffShare)*float64(len(coast)))))))]
	}
	inv := 1 / m.radius
	var peak float64
	for i := range total {
		if !w.land[i] {
			continue
		}
		x, y := g.centre(i)
		u, v := float64((x-m.x)*inv), float64((y-m.y)*inv)
		t := clamp(w.din[i]/inland, 0, 1)
		base := pow(max(t, 1e-6), b.rise)
		hills := 0.5 + float64(0.5*fbm(float64(u*2.5), float64(v*2.5), seeds[0], 0, 4))
		rid := ridged(float64(u*2), float64(v*2), seeds[1], 4)
		cone := pow(clamp(1-hypot(u-cu, v-cv)/0.95, 0, 1), 1.4)
		rest := max(1-(b.hills+b.ridges+b.cone), 0)
		h := float64(rest*base) + float64(b.hills*float64(base*(0.4+float64(0.6*hills)))) +
			float64(b.ridges*float64(pow(max(base, 1e-6), 0.7)*rid)) + float64(b.cone*cone)
		if crater {
			if r := hypot(u-cu, v-cv); r < 0.15 {
				h -= float64(0.4 * (1 - float64(r*r)/0.0225))
			}
		}
		w.height[i] = max(h, 0)
		peak = max(peak, w.height[i])
	}
	if !(peak > 0) {
		peak = 1
	}
	low := c.land[0]
	for i := range total {
		if !w.land[i] {
			continue
		}
		x, y := g.centre(i)
		h := low + float64((top-low)*(w.height[i]/peak))
		d := w.din[i]
		if cliffShare > 0 && cliffAt(x, y) >= threshold && !(m.harbour != nil && nearHarbour(g, i, w.harbour, 30)) {
			w.cliff[i] = true
			// A cliff stands at the coast, and the ground behind it
			// falls back to the profile's.
			h = max(h, float64(cliffHeight*(1-float64(0.5*smoothstep(8, 60, d)))))
		} else {
			// Low ground along the shore, rising to the profile.
			ramp := smoothstep(0, b.beach+12, d)
			h = lerp(ramp, low+float64(0.03*d), h)
		}
		w.height[i] = clamp(h, low, c.land[1])
	}
}

// erode wears the island: thermal weathering moves ground steeper than the
// talus down to its lower neighbours, except at cliffs; droplets of rain
// run down from random places, taking ground where they fall fast and
// dropping it where they stop.
func (c *config) erode(s stream, m *made, w *work) {
	g := &m.grid
	total := g.w * g.h
	var nb [6]int32
	low := c.land[0]
	steep := func(i int32) bool { return w.cliff[i] && w.din[i] < 20 }
	for range c.erosion.Thermal {
		for i := range total {
			if !w.land[i] || steep(i) {
				continue
			}
			k := g.neighbours(i, &nb)
			for _, j := range nb[:k] {
				if !w.land[j] || steep(j) {
					continue
				}
				if diff := w.height[i] - w.height[j]; diff > c.talus {
					move := float64(0.25 * (diff - c.talus))
					w.height[i] -= move
					w.height[j] += move
				}
			}
		}
	}
	var cells []int32
	for i := range total {
		if w.land[i] && !steep(i) {
			cells = append(cells, i)
		}
	}
	if len(cells) == 0 {
		return
	}
	drops := min(c.erosion.Droplets, len(cells)/3)
	for range drops {
		i := cells[s.r.IntN(len(cells))]
		load := 0.0
		for range c.erosion.DropletSteps {
			k := g.neighbours(i, &nb)
			next, fall := int32(-1), 0.0
			for _, j := range nb[:k] {
				h := w.height[j]
				if !w.land[j] {
					h = 0
				}
				if f := w.height[i] - h; f > fall {
					next, fall = j, f
				}
			}
			if next < 0 {
				w.height[i] += float64(c.erosion.Deposit * load)
				break
			}
			if !w.land[next] {
				break // into the sea, with what it carries
			}
			take := min(float64(c.erosion.Erode*fall), float64(0.5*fall), max(w.height[i]-low-0.2, 0))
			if steep(i) {
				take = 0
			}
			w.height[i] -= take
			load += take
			if fall < 0.5 {
				drop := float64(0.1 * load)
				w.height[i] += drop
				load -= drop
			}
			i = next
		}
	}
	for i := range total {
		if w.land[i] {
			w.height[i] = clamp(w.height[i], low, c.land[1])
		}
	}
}

// surfaces covers the island's land: beaches by the shore where it is low,
// bare ground where it is steep, and the biome's low and high surfaces by
// height; and writes the grid's elevations.
func (c *config) surfaces(m *made, b *biome, w *work) {
	g := &m.grid
	total := g.w * g.h
	g.elev = make([]int16, total)
	g.surf = make([]uint8, total)
	top := 0.0
	for i := range total {
		if w.land[i] {
			top = max(top, w.height[i])
		}
	}
	steepSlope := float64(c.talus * 1.15)
	var nb [6]int32
	for i := range total {
		if !w.land[i] {
			g.elev[i] = int16(toInt32(clamp(float64(round(float64(w.height[i]*10))), -float64(c.seabed.Deep*10), -1)))
			continue
		}
		h := w.height[i]
		k := g.neighbours(i, &nb)
		slope := 0.0
		for _, j := range nb[:k] {
			o := w.height[j]
			if !w.land[j] {
				o = 0
			}
			slope = max(slope, math.Abs(h-o))
		}
		surf := b.surfaces.high
		switch {
		case m.kind == kindRock || w.cliff[i] && w.din[i] < 20 && h > 3 || slope > steepSlope:
			surf = b.surfaces.steep
		case !w.cliff[i] && w.din[i] < b.beach+physics.HexAcross && h < 2.5:
			surf = b.surfaces.beach
		case h < float64(b.split*top):
			surf = b.surfaces.low
		}
		g.surf[i] = surf
		g.elev[i] = int16(toInt32(clamp(float64(round(float64(h*10))), float64(c.land[0]*10), float64(c.land[1]*10))))
	}
}

// measure works out what the island shows: its area, its highest point,
// the share of its coast with cliffs, and whether it has twin summits.
func (m *made) measure(c *config, w *work) {
	g := &m.grid
	total := g.w * g.h
	var coast, cliff int
	var nb [6]int32
	type summit struct {
		h    float64
		x, y float64
	}
	var summits []summit
	m.highest = 0
	for i := range total {
		if g.elev[i] <= 0 {
			continue
		}
		// Stacks stand in what was water: they are not the island's own.
		own := w.land[i] && w.din[i] > 0
		if own {
			if m.own == nil {
				m.own = make([]bool, total)
			}
			m.own[i] = true
		}
		if own {
			m.area += hexArea
		}
		h := float64(float64(g.elev[i]) * 0.1)
		x, y := g.centre(i)
		if h > m.highest && own {
			m.highest, m.hx, m.hy = h, x, y
		}
		k := g.neighbours(i, &nb)
		isCoast, isTop := false, true
		for _, j := range nb[:k] {
			if g.elev[j] <= 0 {
				isCoast = true
			}
			if g.elev[j] > g.elev[i] {
				isTop = false
			}
		}
		if isCoast && own && !harbourShore(g, i, w.harbour, &nb) {
			coast++
			if w.cliff[i] {
				cliff++
			}
		}
		if isTop && own && h > 5 {
			summits = append(summits, summit{h, x, y})
		}
	}
	if coast > 0 {
		m.cliffs = float64(cliff) / float64(coast)
	}
	// Twin summits: two of nearly the same height, far enough apart, with
	// a saddle between them.
	twin := c.feature(func(f *nameFeature) bool { return f.twin > 0 })
	if twin != nil {
		slices.SortFunc(summits, func(a, b summit) int { return cmpDesc(a.h, b.h) })
		if len(summits) > 1 && summits[0].h > 0 {
			a := summits[0]
			for _, b := range summits[1:] {
				if b.h < float64(twin.twin*a.h) {
					break
				}
				if hypot(a.x-b.x, a.y-b.y) < twin.twinApart {
					continue
				}
				if m.saddle(a.x, a.y, b.x, b.y) < float64(0.85*b.h) {
					m.twin = true
					break
				}
			}
		}
	}
}

// saddle is the lowest ground on the straight line between two points of
// the island.
func (m *made) saddle(ax, ay, bx, by float64) float64 {
	g := &m.grid
	low := math.Inf(1)
	n := int32(max(round(hypot(bx-ax, by-ay)/2), 2))
	for k := range n + 1 {
		t := float64(k) / float64(n)
		q, r := physics.HexAt(lerp(t, ax, bx), lerp(t, ay, by))
		c, j := physics.HexCell(q, r)
		cc, jj := c-g.c0, j-g.j0
		if cc < 0 || jj < 0 || cc >= g.w || jj >= g.h {
			continue
		}
		low = min(low, float64(float64(g.elev[cc*g.h+jj])*0.1))
	}
	return low
}

// harbourShore reports whether hexagon i of the grid is beside the
// harbour's water.
func harbourShore(g *islandGrid, i int32, water []bool, nb *[6]int32) bool {
	k := g.neighbours(i, nb)
	for _, j := range nb[:k] {
		if water[j] {
			return true
		}
	}
	return false
}

// nearHarbour reports whether hexagon i of the grid is within r m of the
// harbour's water: no cliff stands there.
func nearHarbour(g *islandGrid, i int32, water []bool, r float64) bool {
	x, y := g.centre(i)
	n := toInt32(r/physics.HexAcross) + 1
	cc, jj := i/g.h, i%g.h
	for dc := -n - 1; dc <= n+1; dc++ {
		for dj := -n - 1; dj <= n+1; dj++ {
			c, j := cc+dc, jj+dj
			if c < 0 || j < 0 || c >= g.w || j >= g.h || !water[c*g.h+j] {
				continue
			}
			if hx, hy := g.centre(c*g.h + j); hypot(hx-x, hy-y) <= r {
				return true
			}
		}
	}
	return false
}

// ownLand reports whether hexagon i of its grid is the island's own land.
func (m *made) ownLand(i int32) bool { return m.own != nil && m.own[i] }
