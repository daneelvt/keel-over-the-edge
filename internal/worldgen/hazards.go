// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Offshore hazards: reefs and sandbanks in open water, away from every
// island's shelf, which the lighthouses mark. A reef is a platform of coral
// whose crest lies awash, with a fore reef falling outside it to the depth
// a fringing reef's does and the shelf beyond; a bank is a smooth hump of
// sand with a few metres over it, falling away gently. Each is an ellipse,
// its outline roughened by noise, on a grid of its own that the raster lays
// over the sea bed, the higher ground winning, as an island's is. Each has
// a rock of a few hexagons, a few metres above the sea, that its light
// stands on: real hazard lights stand on the hazard (the Bahamas' Hogsty
// Reef, Elbow Reef and Memory Rock).
//
// A fringing reef far enough out to be lit gets a rock on its crest too,
// on the side toward the rim, before the islands are rastered.

// The kinds of offshore hazard.
const (
	hazardReef = iota
	hazardBank
)

// hazard is an offshore hazard as made: its outline, its rock, and its own
// grid.
type hazard struct {
	kind          int
	x, y          float64 // its centre
	axis          float64 // its long axis, rad clockwise from north
	length, width float64 // m
	depth         float64 // its crest's or the bank's least depth, m
	rockX, rockY  float64 // its rock's highest hexagon
	rock          float64 // its height, m
	grid          islandGrid
}

// hazardReach is how far a hazard's bed reaches beyond its outline, m: the
// fore reef and the shelf to the deep, or the bank's slope.
const hazardReach = 360

// hazardsOf places the offshore hazards in the world whose ground is g:
// the outer ones of each kind first, beyond the catalog's distance, then
// the rest anywhere in the ring; each at the best of several candidates,
// the one furthest from land, clear of land and of the other hazards and
// over deep water. A hazard with no place that fits is left out, which the
// validator's counts catch.
func (c *config) hazardsOf(seed uint64, g *physics.Ground, k *coarse) []*hazard {
	h := &c.hazards
	s := newStream(seed, streamHazards)
	var out []*hazard
	ring := [2]float64{float64(h.Ring[0] * nauticalMile), float64(h.Ring[1] * nauticalMile)}
	beyond := float64(h.Beyond * nauticalMile)
	type want struct {
		kind  int
		inner float64
	}
	var wants []want
	for kind, n := range [2]int{h.Reefs, h.Banks} {
		for i := range n {
			inner := ring[0]
			if i < h.Outer {
				inner = max(beyond, ring[0])
			}
			wants = append(wants, want{kind, inner})
		}
	}
	// The outer ones first, so that the ring's inner waters do not take
	// their room.
	for pass := range 2 {
		for _, wt := range wants {
			if (wt.inner > ring[0]) != (pass == 0) {
				continue
			}
			if hz := c.placeHazard(s, wt.kind, wt.inner, ring[1], g, k, out); hz != nil {
				out = append(out, hz)
			}
		}
	}
	for i, hz := range out {
		c.makeHazard(newStream(seed, streamHazards+uint64(i+1)<<8), hz)
	}
	return out
}

// placeHazard finds a place for a hazard of the kind given between the two
// distances from the centre: its outline drawn, then the best of the
// layout's candidates. nil if none fits.
func (c *config) placeHazard(s stream, kind int, inner, outer float64, g *physics.Ground, k *coarse, placed []*hazard) *hazard {
	h := &c.hazards
	length := s.in(h.ReefLength[0], h.ReefLength[1])
	depth := s.in(h.ReefCrest[0], h.ReefCrest[1])
	if kind == hazardBank {
		length = s.in(h.BankLength[0], h.BankLength[1])
		depth = s.in(h.BankDepth[0], h.BankDepth[1])
	}
	hz := &hazard{kind: kind, length: length, width: float64(length * s.in(0.3, 0.5)), depth: depth, axis: s.angle()}
	half := float64(length / 2)
	best, found := math.Inf(-1), false
	for try := range c.layout.candidates * 16 {
		if found && try >= c.layout.candidates {
			break
		}
		u := s.float()
		d := math.Sqrt(float64(inner*inner) + float64(u*(float64(outer*outer)-float64(inner*inner))))
		sa, ca := sincos(s.angle())
		x, y := float64(d*sa), float64(d*ca)
		clear := k.clearance(x, y)
		if clear < h.Clear+half || !c.hazardDeep(g, x, y, hz.axis, half) {
			continue
		}
		apart := true
		for _, o := range placed {
			if hypot(x-o.x, y-o.y) < h.Apart {
				apart = false
				break
			}
		}
		if apart && clear > best {
			best, hz.x, hz.y, found = clear, x, y, true
		}
	}
	if !found {
		return nil
	}
	return hz
}

// hazardDeep reports whether the sea bed is the deep along a hazard's axis
// and across its middle, and beyond its ends by its reach: it lies on no
// island's shelf.
func (c *config) hazardDeep(g *physics.Ground, x, y, axis, half float64) bool {
	sa, ca := sincos(axis)
	deep := -float64(c.seabed.Deep*10) + 10 // dm: within a metre of the deep
	for _, t := range [...]float64{-1, -0.5, 0, 0.5, 1} {
		for _, side := range [...]float64{-1, 0, 1} {
			along := float64(t * (half + hazardReach))
			across := float64(side * hazardReach)
			px := x + float64(along*sa) + float64(across*ca)
			py := y + float64(along*ca) - float64(across*sa)
			q, r := physics.HexAt(px, py)
			cc, jj := physics.HexCell(q, r)
			if float64(elevationAt(g, cc, jj)) > deep {
				return false
			}
		}
	}
	return true
}

// makeHazard lays a hazard's bed and rock on a grid of its own.
func (c *config) makeHazard(s stream, hz *hazard) {
	a, b := float64(hz.length/2), float64(hz.width/2)
	g := gridFor(hz.x, hz.y, a+hazardReach+physics.HexAcross)
	total := g.w * g.h
	g.elev = make([]int16, total)
	g.surf = make([]uint8, total)
	sa, ca := sincos(hz.axis)
	rough := s.seed32()
	detail := s.seed32()
	deep := c.seabed.Deep
	for i := range total {
		px, py := g.centre(i)
		dx, dy := px-hz.x, py-hz.y
		u := dot(dx, dy, sa, ca)             // along the axis
		v := float64(dx*ca) - float64(dy*sa) // across it
		r := math.Sqrt(float64(float64(u/a)*float64(u/a)) + float64(float64(v/b)*float64(v/b)))
		// The outline roughened, so that a reef is not an egg.
		r = r * (1 + float64(0.22*fbm(float64(px/60), float64(py/60), rough, 0, 3)))
		dist := hypot(dx, dy)
		out := 0.0 // m outside the outline along the ray from the centre
		if r > 1 {
			out = float64(dist * (1 - 1/r))
		}
		var d float64
		switch hz.kind {
		case hazardReef:
			if r <= 1 {
				// The platform: awash, a few heads and hollows.
				d = hz.depth + float64(0.6*max(fbm(float64(px/25), float64(py/25), detail, 0, 2), 0))
			} else {
				fore := lerp(smoothstep(0, c.reef.ForeWidth, out), hz.depth, c.reef.Fore)
				d = max(fore, c.reef.Fore+(out-c.reef.ForeWidth)/c.seabed.Shelf)
			}
		default:
			// A low dome of sand: least at its middle, falling one in
			// eight beyond its outline.
			d = hz.depth + float64(float64(min(r, 1)*min(r, 1))*1.5)
			if r > 1 {
				d = hz.depth + 1.5 + float64(out/8)
			}
			d = float64(d * (1 + float64(0.08*fbm(float64(px/40), float64(py/40), detail, 0, 2))))
		}
		g.elev[i] = int16(toInt32(clamp(float64(round(float64(-clamp(d, 0.1, deep)*10))), -float64(deep*10), -1)))
	}
	// The rock: a few hexagons about the middle, standing above the sea.
	q, rr := physics.HexAt(hz.x, hz.y)
	cc, jj := physics.HexCell(q, rr)
	centre := (cc-g.c0)*g.h + (jj - g.j0)
	h := &c.hazards
	hz.rock = s.in(h.RockHeight[0], h.RockHeight[1])
	hz.rockX, hz.rockY = g.centre(centre)
	raiseRock(s, &g, centre, s.pick(h.RockHexes[0], h.RockHexes[1]), hz.rock, c.rockSurface, c.land[0])
	hz.grid = g
}

// raiseRock raises n hexagons of grid g, from hexagon i and on to its
// neighbours, to rocks: the first height m above the sea, the rest a little
// lower, of the surface given.
func raiseRock(s stream, g *islandGrid, i int32, n int, height float64, surface uint8, low float64) {
	var nb [6]int32
	g.elev[i] = int16(toInt32(float64(round(float64(height * 10)))))
	g.surf[i] = surface
	k := g.neighbours(i, &nb)
	for e := range max(n-1, 0) {
		j := nb[(e*2)%k]
		h := max(float64(height*s.in(0.5, 0.85)), low)
		g.elev[j] = int16(toInt32(float64(round(float64(h * 10)))))
		g.surf[j] = surface
	}
}

// reefRocks stands a rock on the crest of every fringing reef far enough
// out to be lit, at the crest's hexagon furthest from the centre of the
// disk: the side a ship comes on it from the rim.
func (c *config) reefRocks(seed uint64, islands []*made) {
	beyond := float64(c.lights.Hazards.Beyond * nauticalMile)
	h := &c.hazards
	for _, m := range islands {
		if !m.reef || len(m.crest) == 0 || m.kind == kindRock || hypot(m.x, m.y) <= beyond {
			continue
		}
		s := newStream(seed, streamHazards^(streamIsland+uint64(m.number)))
		best, far := int32(-1), 0.0
		for _, i := range m.crest {
			x, y := m.grid.centre(i)
			if d := hypot(x, y); d > far {
				best, far = i, d
			}
		}
		raiseRock(s, &m.grid, best, s.pick(h.RockHexes[0], h.RockHexes[1]), s.in(h.RockHeight[0], h.RockHeight[1]), c.rockSurface, c.land[0])
		m.reefRock = best
	}
}

// rasterHazards lays the hazards' grids over the ground's chunks they
// touch, made again from every grid.
func (c *config) rasterHazards(g *physics.Ground, islands []*made, hazards []*hazard) {
	if len(hazards) == 0 {
		return
	}
	grids := gridsOf(islands, hazards)
	touched := make([]bool, physics.ChunkCount)
	for _, hz := range hazards {
		gr := &hz.grid
		for col := gr.c0; col < gr.c0+gr.w; col = min(col+64, max(col+1, gr.c0+gr.w-1)) {
			for row := gr.j0; row < gr.j0+gr.h; row = min(row+64, max(row+1, gr.j0+gr.h-1)) {
				if n, _, ok := physics.ChunkOf(col, row); ok {
					touched[n] = true
				}
			}
		}
	}
	for n := range int32(physics.ChunkCount) {
		if touched[n] {
			g.Chunks[n] = c.raster(n, grids)
		}
	}
}

// gridsOf is every island's and hazard's grid.
func gridsOf(islands []*made, hazards []*hazard) []*islandGrid {
	out := make([]*islandGrid, 0, len(islands)+len(hazards))
	for _, m := range islands {
		out = append(out, &m.grid)
	}
	for _, hz := range hazards {
		out = append(out, &hz.grid)
	}
	return out
}
