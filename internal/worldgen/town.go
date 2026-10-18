// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Towns. Each is laid out as the period's harbour towns grew, streets
// first, then buildings along them facing them, then the ground levelled:
// at St George's, Bermuda, settled in 1612, "King's Square … adjacent to
// the harbour, and providing the link between the harbour and the two main
// east–west roads … Water Street, giving access to the quays, and York
// Street … the main street. The streets to the north … began as narrow,
// winding lanes and alleys" (its nomination to UNESCO). So a town has a
// quay street along its water, contour streets behind it that follow the
// shore's shape and wander, and lanes up the slope between them, each the
// easiest way up (Galin and others, Procedural Generation of Roads, 2010:
// a shortest path whose cost rises with the slope and with turning, the
// streets already made reused at a fraction of their cost); a square on
// the quay; and its buildings along both sides of every way, each facing
// it, the larger and the special ones where Emilien and others' rules put
// them (Procedural Generation of Villages on Arbitrary Terrains, 2012):
// nearer the water the larger, the church in an overlooking place. Each
// plot is levelled to one of the land's terraces, so the town is the
// ground the physics knows; a quay is a wall of dressed stone, a pier a
// strip of planking on piles along one of the lattice's three axes.
//
// A fishing village is "the room" of Newfoundland's fishing premises:
// "stages, sheds and wharves", the stage "the shed at its seaward end where
// fish were landed and split", flakes "raised platforms set on wooden
// posts" behind them, its houses apart, up the slope (Heritage NL).

// Town is a town of a made world: Port Royal's, a port's or a fishing
// village's.
type Town struct {
	Number int32  `json:"number"`
	Kind   string `json:"kind"`  // main, port or village
	Place  int32  `json:"place"` // its place's number; -1 for Port Royal
	Island int32  `json:"island"`
	Name   string `json:"name"`
	// X and Y are its waterfront's middle; Heading the way out to its
	// water, rad clockwise from north.
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Heading float64 `json:"heading"`
	// Quay is its quay's edge along the water, in order; Piers its piers,
	// jetty and mole.
	Quay  [][2]float64 `json:"quay"`
	Piers []Pier       `json:"piers"`
	// Harbour is the water that is in port: discs, a point in one of which
	// and in water is in port.
	Harbour []Disc `json:"harbour"`
	// Square is its square's middle, if it has one.
	Square *[2]float64 `json:"square,omitempty"`
	// Buildings is how many it has, props not counted; Counts each kind's,
	// props counted, by the kind's index in the catalog's list.
	Buildings int   `json:"buildings"`
	Counts    []int `json:"counts"`
	// Streets is how many hexagons of street, lane and square it has.
	Streets int `json:"streets"`
	// Flag is its colours, by their index in the catalog's list; -1 for
	// Port Royal's own.
	Flag int32 `json:"flag"`
}

// Pier is a pier, a jetty or a mole: a strip of hexagons from its root out
// along one of the lattice's axes.
type Pier struct {
	X       float64 `json:"x"` // its root, at the shore
	Y       float64 `json:"y"`
	Heading float64 `json:"heading"` // the way it runs out, rad
	Length  float64 `json:"length"`  // m
	Width   float64 `json:"width"`   // m
	Mole    bool    `json:"mole,omitempty"`
}

// Disc is a disc of water: its centre and radius, m.
type Disc struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	R float64 `json:"r"`
}

// Building is a building or a prop of a town.
type Building struct {
	Kind uint8 // its kind, by its index in the catalog's list
	Kit  uint8 // its kit, by its index in the catalog's list
	// X and Y are its middle, m east and north of the world's centre;
	// Heading the way its front faces, rad clockwise from north.
	X, Y     float64
	Heading  float64
	Level    int16 // its plot's elevation, dm
	Storeys  uint8
	Frontage float64 // m, along its front
	Depth    float64 // m, back from it
	// Its colours, by their index in its kit's palettes; its flag's
	// colours, by the catalog's list's index and one (0: none; Port
	// Royal's is the list's length and one); and a number of its own, for
	// its windows, smoke and lantern.
	Wall, Roof, Shutter uint8
	Flag                uint8
	Seed                uint8
	Town                int32
	// Top is how high it stands, m above the sea.
	Top float64
}

// What a hexagon of a town's grid is used for.
const (
	useFree uint8 = iota
	useWater
	useQuay
	useStreet
	useSquare
	useBuilding
	useGarden
	usePier
	useTower // a lighthouse's
	usePath
)

// townWork is a town as it is laid out: a piece of the lattice about it,
// copied from the world's ground and written back when it is done.
type townWork struct {
	c      *config
	s      stream
	kind   string
	island *made
	g      islandGrid
	use    []uint8
	water  []bool    // the town's water
	shore  []float64 // each hexagon's distance to it, m
	near   []int32
	xs     []float64
	// The town's frame: its origin, out on its water; the bearing from it
	// toward the town; half the arc the town covers about it.
	ox, oy float64
	sx, sy float64 // its site, on the shore
	around float64 // how far from its site it may spread, short of its least, m
	facing float64
	half   float64
	reach  float64
	// ways are its streets and lanes, each its points in order, and
	// whether it has buildings along both sides or the inland side only.
	ways      []way
	town      *Town
	buildings []Building
	target    int // how many buildings it is to have
	least     int // and the least it may have
	// steep, if not 0, is the steepest plot taken, as 1 in steep: a town
	// short of its least terraces steeper ground.
	steep float64
	count int // how many it has
	// last is the last plot levelled, as it was before: its hexagons, and
	// their elevations, surfaces and uses; so a building can be taken back.
	last   []plotWas
	counts []int
	kit    uint8
	flag   uint8
}

// way is a street, a lane or the quay: its points in order, its width,
// and the sides buildings may stand on (1 the left, 2 the right, 3 both).
type way struct {
	pts   [][2]float64
	width float64
	sides int
	quay  bool
	rank  float64 // how near the water it is: the lower the earlier
}

// townGrid copies the piece of the world's ground within r of (x, y).
func (c *config) townGrid(g *physics.Ground, x, y, r float64) islandGrid {
	tg := gridFor(x, y, r)
	total := tg.w * tg.h
	tg.elev = make([]int16, total)
	tg.surf = make([]uint8, total)
	for i := range total {
		cc, jj := tg.c0+i/tg.h, tg.j0+i%tg.h
		n, k, ok := physics.ChunkOf(cc, jj)
		if !ok || g.Chunks[n] == nil {
			tg.elev[i] = physics.DeepWater
			continue
		}
		tg.elev[i], tg.surf[i] = g.Chunks[n].Elevation[k], g.Chunks[n].Surface[k]
	}
	return tg
}

// writeBack writes the town's grid into the world's ground.
func (tw *townWork) writeBack(g *physics.Ground) {
	t := &tw.g
	for i := range t.w * t.h {
		cc, jj := t.c0+i/t.h, t.j0+i%t.h
		n, k, ok := physics.ChunkOf(cc, jj)
		if !ok || g.Chunks[n] == nil {
			continue
		}
		g.Chunks[n].Elevation[k], g.Chunks[n].Surface[k] = t.elev[i], t.surf[i]
	}
}

// newTownWork makes a town's work about (x, y), within r, whose water is
// what isWater says.
func (c *config) newTownWork(g *physics.Ground, s stream, kind string, m *made, x, y, r float64, isWater func(i int32, x, y float64) bool) *townWork {
	tw := &townWork{c: c, s: s, kind: kind, island: m, g: c.townGrid(g, x, y, r), counts: make([]int, len(c.buildings))}
	t := &tw.g
	total := t.w * t.h
	tw.use = make([]uint8, total)
	tw.water = make([]bool, total)
	tw.shore = make([]float64, total)
	tw.near = make([]int32, total)
	tw.xs = make([]float64, t.w)
	for cc := range t.w {
		tw.xs[cc], _ = physics.CellCentre(t.c0+cc, 0)
	}
	for i := range total {
		hx, hy := t.centre(i)
		if t.elev[i] <= 0 {
			tw.use[i] = useWater
			tw.water[i] = isWater(i, hx, hy)
		}
	}
	t.distances(tw.water, tw.shore, tw.near, tw.xs)
	tw.kit = c.kitOf[m.biome]
	return tw
}

// at is the hexagon of the town's grid that holds (x, y), or -1.
func (tw *townWork) at(x, y float64) int32 {
	if i, ok := tw.g.index(x, y); ok {
		return i
	}
	return -1
}

// bearing is the bearing of (x, y) from the town's origin, and how far
// off the middle of the town's arc it is, rad.
func (tw *townWork) bearing(x, y float64) (float64, float64) {
	a := physics.Atan2(x-tw.ox, y-tw.oy)
	return a, angleBetween(a, tw.facing)
}

// inArc reports whether (x, y) is within the share of the town's arc
// given.
func (tw *townWork) inArc(x, y, share float64) bool {
	_, off := tw.bearing(x, y)
	return math.Abs(off) <= float64(tw.half*share)
}

// slopeOK reports whether the ground under hexagons is gentle enough to
// level: its highest and lowest no further apart than span over the plot
// rule.
func (tw *townWork) slopeOK(hexes []int32, span float64) bool {
	lo, hi := int16(math.MaxInt16), int16(math.MinInt16)
	for _, i := range hexes {
		lo, hi = min(lo, tw.g.elev[i]), max(hi, tw.g.elev[i])
	}
	rule := tw.c.towns.Plan.Plot
	if tw.steep > 0 {
		rule = tw.steep
	}
	return float64(hi-lo) <= float64(10*max(span, physics.HexAcross)/rule)
}

// terrace is an elevation, dm, rounded to the land's terraces, never
// lower than the lowest.
func (c *config) terrace(e float64) int16 {
	step := float64(c.terraceDm)
	return int16(max(round(e/step), 1)) * c.terraceDm
}

// underFootprint lists the hexagons, axial, whose centres lie under a
// building of the size given at (x, y) facing h, grown by margin m; or the
// one it is in, if it is smaller than a hexagon.
func underFootprint(x, y, h, frontage, depth, margin float64) [][2]int32 {
	sh, ch := sincos(h)
	hf, hd := float64(frontage/2)+margin, float64(depth/2)+margin
	reach := hypot(hf, hd) + physics.HexAcross
	var out [][2]int32
	q0, r0 := physics.HexAt(x, y)
	rings := toInt32(reach/(0.866*physics.HexAcross)) + 1
	for dq := -rings; dq <= rings; dq++ {
		for dr := max(-rings, -dq-rings); dr <= min(rings, -dq+rings); dr++ {
			hx, hy := physics.HexCentre(q0+dq, r0+dr)
			dx, dy := hx-x, hy-y
			// Along its depth (the way it faces) and across its front.
			a := dot(dx, dy, sh, ch)
			b := float64(dx*ch) - float64(dy*sh)
			if math.Abs(a) > hd || math.Abs(b) > hf {
				continue
			}
			out = append(out, [2]int32{q0 + dq, r0 + dr})
		}
	}
	if len(out) == 0 {
		out = append(out, [2]int32{q0, r0})
	}
	return out
}

// footprint lists the hexagons of the town's grid under a building of the
// size given at (x, y) facing h, grown by margin m; nil if any is off the
// grid.
func (tw *townWork) footprint(x, y, h, frontage, depth, margin float64) []int32 {
	under := underFootprint(x, y, h, frontage, depth, margin)
	out := make([]int32, 0, len(under))
	for _, a := range under {
		hx, hy := physics.HexCentre(a[0], a[1])
		i := tw.at(hx, hy)
		if i < 0 {
			return nil
		}
		out = append(out, i)
	}
	return out
}

// free reports whether every hexagon is free land.
func (tw *townWork) free(hexes []int32) bool {
	if len(hexes) == 0 {
		return false
	}
	for _, i := range hexes {
		if tw.use[i] != useFree || tw.g.elev[i] <= 0 {
			return false
		}
	}
	return true
}

// plotWas is a hexagon of a plot as it was before the plot was levelled.
type plotWas struct {
	i    int32
	elev int16
	surf uint8
	use  uint8
}

// unplace takes back the last building added and its plot.
func (tw *townWork) unplace() {
	b := tw.buildings[len(tw.buildings)-1]
	tw.buildings = tw.buildings[:len(tw.buildings)-1]
	tw.counts[b.Kind]--
	if !tw.c.buildings[b.Kind].prop {
		tw.count--
	}
	for _, w := range tw.last {
		tw.g.elev[w.i], tw.g.surf[w.i], tw.use[w.i] = w.elev, w.surf, w.use
	}
	tw.last = tw.last[:0]
}

// levelPlot levels hexagons to one terrace, the nearest to their mean,
// and marks them used as given, of the surface given.
func (tw *townWork) levelPlot(hexes []int32, use, surface uint8) int16 {
	tw.last = tw.last[:0]
	for _, i := range hexes {
		tw.last = append(tw.last, plotWas{i, tw.g.elev[i], tw.g.surf[i], tw.use[i]})
	}
	var sum float64
	for _, i := range hexes {
		sum += float64(tw.g.elev[i])
	}
	level := tw.c.terrace(sum / float64(len(hexes)))
	for _, i := range hexes {
		tw.g.elev[i] = level
		tw.g.surf[i] = surface
		tw.use[i] = use
	}
	return level
}

// add adds a building of kind k at (x, y) facing h, of the size given, on
// the plot given, levelled; and counts it.
func (tw *townWork) add(k *buildingKind, x, y, h, frontage, depth float64, plot []int32) *Building {
	var level int16
	if k.prop {
		// A prop stands on what is there, and claims nothing.
		for _, i := range plot {
			level = max(level, tw.g.elev[i])
		}
	} else {
		level = tw.levelPlot(plot, useBuilding, tw.c.townSurface.yard)
	}
	st := tw.s.pick(k.storeys[0], k.storeys[1])
	kit := &tw.c.towns.Kits[tw.kit]
	x, y, h, frontage, depth = quantise(x, y, h, frontage, depth)
	b := Building{
		Kind: k.index, Kit: tw.kit, X: x, Y: y, Heading: h, Level: level, Storeys: uint8(st),
		Frontage: frontage, Depth: depth,
		Wall:    uint8(tw.s.r.IntN(len(kit.Walls))),
		Roof:    uint8(tw.s.r.IntN(len(kit.Roofs))),
		Shutter: uint8(tw.s.r.IntN(len(kit.Shutters))),
		Seed:    uint8(tw.s.r.IntN(64)),
		Town:    tw.town.Number,
	}
	if k.flag {
		b.Flag = tw.flag
	}
	b.Top = round1(float64(float64(level)*0.1) + k.height(st))
	tw.buildings = append(tw.buildings, b)
	tw.counts[k.index]++
	if !k.prop {
		tw.count++
	}
	return &tw.buildings[len(tw.buildings)-1]
}

// prop adds a prop of kind k at (x, y) facing h, if the ground there is
// land; it claims no ground.
func (tw *townWork) prop(k *buildingKind, x, y, h float64) bool {
	i := tw.at(x, y)
	if i < 0 || tw.g.elev[i] <= 0 {
		return false
	}
	f := tw.s.in(k.frontage[0], k.frontage[1])
	d := tw.s.in(k.depth[0], k.depth[1])
	x, y, h, f, d = quantise(x, y, h, f, d)
	tw.add(k, x, y, h, f, d, []int32{i})
	return true
}

// markTaken marks what is already built on the town's grid as taken: the
// buildings given, with half a metre about them, and every way.
func (tw *townWork) markTaken(buildings []Building) {
	t := &tw.g
	for i := range t.w * t.h {
		if t.elev[i] > 0 && tw.c.isTownSurface(t.surf[i]) {
			tw.use[i] = useStreet
		}
	}
	for _, b := range buildings {
		for _, a := range underFootprint(b.X, b.Y, b.Heading, b.Frontage, b.Depth, 0.5) {
			hx, hy := physics.HexCentre(a[0], a[1])
			if i := tw.at(hx, hy); i >= 0 {
				tw.use[i] = useBuilding
			}
		}
	}
}

// wrapAngle is a in [0, 2π).
func wrapAngle(a float64) float64 {
	const turn = 2 * math.Pi
	a -= float64(math.Floor(a/turn) * turn)
	if a < 0 {
		a += turn
	}
	if a >= turn {
		a -= turn
	}
	return a
}

// quantise is a building's middle, heading and size as they are kept:
// to a decimetre, a 256th of a turn and a fifth of a metre.
func quantise(x, y, h, frontage, depth float64) (float64, float64, float64, float64, float64) {
	turn := float64(2 * math.Pi)
	k := round(float64(wrapAngle(h)/turn) * 256)
	h = float64(float64(k&255) * (turn / 256))
	return round1(x), round1(y), h, max(float64(round(frontage*5))/5, 0.2), max(float64(round(depth*5))/5, 0.2)
}

// size draws a building's frontage and depth.
func (tw *townWork) size(k *buildingKind) (float64, float64) {
	return tw.s.in(k.frontage[0], k.frontage[1]), tw.s.in(k.depth[0], k.depth[1])
}

// counted is how many of kind k the town is to have, drawn.
func (tw *townWork) counted(k *buildingKind) int {
	c, ok := k.counts[tw.kind]
	if !ok {
		return 0
	}
	return tw.s.pick(c[0], c[1])
}

// markTowers keeps the lighthouses' ground clear.
func (tw *townWork) markTowers(lights []*lightWork) {
	for _, lw := range lights {
		for _, i := range tw.footprint(lw.x, lw.y, 0, 12, 12, 0) {
			tw.use[i] = useTower
		}
	}
}

// buildTowns lays out every town: Port Royal's, each port's and each
// fishing village's, and writes them into the ground.
func (c *config) buildTowns(seed uint64, g *physics.Ground, islands []*made, pw *placesWork, lights []*lightWork,
	names []string, base int32) ([]Town, []Building) {
	var towns []Town
	var buildings []Building
	s := newStream(seed, streamTowns)
	flags := s.r.Perm(len(c.towns.Flags.Colours))
	if port := islands[0]; port.harbour != nil {
		tw := c.mainTown(newStream(seed, streamTowns+1<<8), g, port, lights, names[0])
		tw.writeBack(g)
		towns = append(towns, *tw.town)
		buildings = append(buildings, tw.buildings...)
	}
	for k, si := range pw.sites {
		if si.rule != catalog.SiteHarbour && si.rule != catalog.SiteVillage {
			continue
		}
		ts := newStream(seed, streamTowns+uint64(k+2)<<8)
		m := islands[si.island]
		var tw *townWork
		number := int32(len(towns))
		if si.rule == catalog.SiteHarbour {
			flag := uint8(flags[int(number-1)%len(flags)] + 1)
			tw = c.portTown(ts, g, m, si, lights, number, flag)
		} else {
			tw = c.villageTown(ts, g, m, si, lights, number)
		}
		tw.town.Place = base + int32(k)
		tw.writeBack(g)
		towns = append(towns, *tw.town)
		buildings = append(buildings, tw.buildings...)
	}
	return towns, buildings
}
