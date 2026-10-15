// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"
)

// The layout: where each island lies and how big it is. The main port's
// island first, its centre within a little of the disk's; then the
// landmarks, largest first; then the other islands, their areas drawn by
// Korčák's law and placed largest first; then the groups of rocks. Each is
// placed at the best of several candidate places, the one furthest from
// the land already placed (Mitchell's best-candidate sampling), keeping a
// gap between coasts; so the islands spread over the disk without a grid's
// rows, and fill its widest stretches of open water first.

// The kinds of island: a group's are its rocks and islets.
const (
	kindMain     = "main"
	kindLandmark = "landmark"
	kindIsland   = "island"
	kindRock     = "group"
)

// spot is a placed island before it is made: its centre, its radius, half
// its nominal width, and how far its shape may reach, as a multiple of it.
type spot struct {
	kind   string
	x, y   float64
	radius float64
	biome  int32
	group  int32
}

// reachOf is how far an island's land may reach from its centre: its lobes
// and warp reach past its radius.
const reachOf = 1.3

// layout places the islands of a world.
func layout(c *config, seed uint64) ([]spot, []groupSpot) {
	s := newStream(seed, streamLayout)
	var spots []spot

	// The main port's island.
	ps := newStream(seed, streamMainPort)
	r := ps.in(c.port.across[0], c.port.across[1]) / 2
	a, d := ps.angle(), float64(c.port.offset*math.Sqrt(ps.float()))
	sa, ca := sincos(a)
	spots = append(spots, spot{kind: kindMain, x: float64(d * sa), y: float64(d * ca), radius: r, biome: c.port.biome, group: -1})

	// The landmarks, largest first.
	// Stratified over their range, so that each world has its share of
	// large and of middling ones.
	radii := make([]float64, c.layout.landmarks)
	for i := range radii {
		u := (float64(i) + s.float()) / float64(len(radii))
		radii[i] = lerp(u, c.layout.landmarkAcross[0], c.layout.landmarkAcross[1]) / 2
	}
	slices.SortFunc(radii, func(a, b float64) int { return cmpDesc(a, b) })
	for _, r := range radii {
		x, y, ok := c.place(s, spots, r, c.layout.landmarkRing, func(x, y float64) bool {
			for _, o := range spots {
				if o.kind == kindLandmark && hypot(x-o.x, y-o.y) < c.layout.landmarkApart {
					return false
				}
			}
			return true
		})
		if ok {
			spots = append(spots, spot{kind: kindLandmark, x: x, y: y, radius: r, biome: c.drawBiome(s, x, y), group: -1})
		}
	}

	// The rest, by Korčák's law on their areas, stratified so that a
	// world's counts by size are as the law expects: the number larger
	// than a falls as a^−b, so a = (a₀^−b − u (a₀^−b − a₁^−b))^(−1/b).
	n := c.layout.islands
	b := c.layout.korcak
	a0 := float64(math.Pi*0.25) * float64(c.layout.islandAcross[0]*c.layout.islandAcross[0])
	a1 := float64(math.Pi*0.25) * float64(c.layout.islandAcross[1]*c.layout.islandAcross[1])
	p0, p1 := pow(a0, -b), pow(a1, -b)
	radii = radii[:0]
	for i := range n {
		u := (float64(i) + s.float()) / float64(n)
		area := pow(p0-float64(u*(p0-p1)), -1/b)
		radii = append(radii, math.Sqrt(area/math.Pi))
	}
	slices.SortFunc(radii, func(a, b float64) int { return cmpDesc(a, b) })
	for _, r := range radii {
		x, y, ok := c.place(s, spots, r, c.layout.islandRing, nil)
		if ok {
			spots = append(spots, spot{kind: kindIsland, x: x, y: y, radius: r, biome: c.drawBiome(s, x, y), group: -1})
		}
	}

	// The groups of rocks and islets, each a biome of its own.
	gs := newStream(seed, streamGroups)
	var groups []groupSpot
	for g := range gs.pick(c.layout.groups[0], c.layout.groups[1]) {
		x, y, ok := c.place(gs, spots, c.layout.groupSpread, c.layout.islandRing, nil)
		if !ok {
			continue
		}
		biome := c.drawBiome(gs, x, y)
		grp := groupSpot{x: x, y: y, biome: biome}
		members := gs.pick(c.layout.groupSize[0], c.layout.groupSize[1])
		for range members * 8 {
			if len(grp.members) == members {
				break
			}
			r := gs.in(c.layout.rockAcross[0], c.layout.rockAcross[1]) / 2
			if len(grp.members) == 0 || gs.chance(0.2) {
				// The largest few are islets.
				r = gs.in(c.layout.rockAcross[1], 2*c.layout.rockAcross[1]) / 2
			}
			ra, rd := gs.angle(), float64(c.layout.groupSpread*math.Sqrt(gs.float()))
			sa, ca := sincos(ra)
			mx, my := x+float64(rd*sa), y+float64(rd*ca)
			if !c.fits(spots, mx, my, r, int32(g)) {
				continue
			}
			grp.members = append(grp.members, int32(len(spots)))
			spots = append(spots, spot{kind: kindRock, x: mx, y: my, radius: r, biome: biome, group: int32(g)})
		}
		if len(grp.members) > 0 {
			groups = append(groups, grp)
		}
	}
	c.fillGaps(s, &spots)
	return spots, groups
}

// fillGaps puts islets in the widest stretches of open water left inside
// the mist band, until none is wider than the validator allows, less a
// margin: the centre of the stretch, on a grid, furthest from any island's
// reach.
func (c *config) fillGaps(s stream, spots *[]spot) {
	const cell = 100.0
	limit := c.validator.OpenWater - 2*cell
	n := toInt32(2*c.mist/cell) + 1
	for range 40 {
		far, fx, fy := 0.0, 0.0, 0.0
		for a := range n {
			for b := range n {
				x := float64(float64(a)*cell) - c.mist
				y := float64(float64(b)*cell) - c.mist
				if hypot(x, y) > c.mist || hypot(x, y) < c.calm {
					continue
				}
				d := math.Inf(1)
				for _, o := range *spots {
					d = min(d, hypot(x-o.x, y-o.y)-o.radius)
				}
				if d > far {
					far, fx, fy = d, x, y
				}
			}
		}
		if far <= limit {
			return
		}
		r := s.in(c.layout.islandAcross[0], 2*c.layout.islandAcross[0]) / 2
		if !c.fits(*spots, fx, fy, r, -1) {
			// Somewhere near it that fits.
			ok := false
			for range 32 {
				sa, ca := sincos(s.angle())
				d := s.in(0, 4*cell)
				if x, y := fx+float64(d*sa), fy+float64(d*ca); c.fits(*spots, x, y, r, -1) {
					fx, fy, ok = x, y, true
					break
				}
			}
			if !ok {
				return
			}
		}
		*spots = append(*spots, spot{kind: kindIsland, x: fx, y: fy, radius: r, biome: c.drawBiome(s, fx, fy), group: -1})
	}
}

// groupSpot is a group of rocks: its centre, biome and members.
type groupSpot struct {
	x, y    float64
	biome   int32
	members []int32
}

func cmpDesc(a, b float64) int {
	switch {
	case a > b:
		return -1
	case a < b:
		return 1
	}
	return 0
}

// place finds the best of the layout's candidates for an island of radius
// r between the ring's two distances from the centre: the one furthest
// from the land placed, among those that fit and pass ok. It tries more
// candidates when none of the first fits.
func (c *config) place(s stream, spots []spot, r float64, ring [2]float64, ok func(x, y float64) bool) (float64, float64, bool) {
	inner := max(ring[0], c.calm+float64(reachOf*r)+c.layout.gap)
	outer := min(ring[1], c.disk-float64(reachOf*r)-c.layout.gap)
	if !(outer > inner) {
		return 0, 0, false
	}
	best, bx, by := math.Inf(-1), 0.0, 0.0
	found := false
	for try := range c.layout.candidates * 64 {
		if found && try >= c.layout.candidates {
			break
		}
		// Uniform over the ring's area.
		u := s.float()
		d := math.Sqrt(float64(inner*inner) + float64(u*(float64(outer*outer)-float64(inner*inner))))
		sa, ca := sincos(s.angle())
		x, y := float64(d*sa), float64(d*ca)
		if !c.fits(spots, x, y, r, -1) || ok != nil && !ok(x, y) {
			continue
		}
		clearance := math.Inf(1)
		for _, o := range spots {
			clearance = min(clearance, hypot(x-o.x, y-o.y)-float64(reachOf*o.radius))
		}
		if clearance > best {
			best, bx, by, found = clearance, x, y, true
		}
	}
	return bx, by, found
}

// fits reports whether an island of radius r at (x, y) keeps the gap from
// every island placed, but those of its own group, which keep a little.
func (c *config) fits(spots []spot, x, y, r float64, group int32) bool {
	if hypot(x, y)+float64(reachOf*r) > c.disk-c.layout.gap {
		return false
	}
	for _, o := range spots {
		gap := c.layout.gap
		if group >= 0 && o.group == group {
			gap = 8
		}
		// Its stacks stand up to stackReach off its coast.
		if o.kind == kindMain && hypot(x, y) < c.calm+float64(reachOf*r)+stackReach {
			return false
		}
		if hypot(x-o.x, y-o.y) < float64(reachOf*(r+o.radius))+gap {
			return false
		}
	}
	return true
}

// drawBiome draws an island's biome by the weights of the zone at (x, y).
func (c *config) drawBiome(s stream, x, y float64) int32 {
	z := c.zoneOf(hypot(x, y))
	w := make([]float64, len(c.biomes))
	for i := range c.biomes {
		w[i] = c.biomes[i].zones[z]
	}
	return int32(max(s.weighted(w), 0))
}

// The zones.
const (
	zoneCentre = iota
	zoneMiddle
	zoneRim
	zones
)

// zoneOf is the zone at d metres from the centre.
func (c *config) zoneOf(d float64) int32 {
	switch {
	case d < c.zones[0]:
		return zoneCentre
	case d < c.zones[1]:
		return zoneMiddle
	}
	return zoneRim
}
