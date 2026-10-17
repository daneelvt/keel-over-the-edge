// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Lighthouses: Port Royal's, the tallest, on its island's highest ground
// near the coast; one at every port, on the point nearest it; one on every
// offshore hazard's rock, and on the rocks and fringing reefs toward the
// rim, one light for hazards near each other; and a ring of lights on the
// approach to the edge, each on the outermost land near its bearing. Each
// has a character of its own from the catalog's list, IALA's classes
// within the limits of Recommendation E-110, and lights whose ranges
// overlap differ in class, in the number in a group or in colour, not by
// period alone, as IALA's Guideline G1116 asks ("significant difference
// from nearby marks"; rates nearer than three to one are hard to tell
// apart). Port Royal's is the same in every world. Each light's phase is
// drawn, so that lights do not flash together.

// Light is a lighthouse's light.
type Light struct {
	Number int32  `json:"number"`
	Place  int32  `json:"place"` // its lighthouse, by place number
	Role   string `json:"role"`  // main, port, edge or hazard
	// Marks is what it marks, by its number among the world's places
	// (islands, then groups, then places): Port Royal's island, a port, a
	// hazard; -1 for an edge light, which marks the approach to the edge.
	Marks  int32   `json:"marks"`
	X      float64 `json:"x"`      // the tower, m east of the world's centre
	Y      float64 `json:"y"`      // and north
	Ground float64 `json:"ground"` // m: the ground under the tower
	Tower  float64 `json:"tower"`  // m
	Focal  float64 `json:"focal"`  // m: the light above the sea
	// Character is the catalog's character's index; Notation, its notation
	// as charts write it, so that the record reads without the catalog.
	Character int32   `json:"character"`
	Notation  string  `json:"notation"`
	Phase     int64   `json:"phase"` // µs: the light's character at world time t is its steps at t + Phase
	Range     float64 `json:"range"` // m: its nominal range
	Daymark   int32   `json:"daymark"`
}

// The lights' roles.
const (
	RoleMain   = "main"
	RolePort   = "port"
	RoleEdge   = "edge"
	RoleHazard = "hazard"
)

// lightWork is a light as it is found, before its lighthouse is numbered.
type lightWork struct {
	role      string
	x, y      float64
	island    int32 // the island its tower stands on, or -1
	ground    float64
	tower     float64
	white     float64 // its range as a white light, m
	character int
	phase     int64
	daymark   int
	// What it is named after: a site, an island, a group, or a point on
	// its island.
	site  int
	group int
	point bool
}

// lightsOf finds the world's lighthouses, gives each its character, phase
// and daymark, and adds each as a site.
func (pw *placesWork) lightsOf(groups []groupSpot) []*lightWork {
	c := pw.c
	l := &c.lights
	var out []*lightWork
	nm := float64(nauticalMile)
	add := func(lw *lightWork) {
		lw.ground = max(-pw.depth(lw.x, lw.y), 0)
		out = append(out, lw)
	}
	near := func(x, y, r float64) bool {
		for _, o := range out {
			if hypot(x-o.x, y-o.y) < r {
				return true
			}
		}
		return false
	}

	// Port Royal's, on its island's highest ground near its coast.
	if len(pw.islands) > 0 {
		cg := pw.coast(0)
		g := &cg.g
		best, top := int32(-1), 0.0
		for i := range g.w * g.h {
			if cg.land[i] && cg.din[i] <= l.MainPortCoast && float64(g.elev[i]) > top {
				best, top = i, float64(g.elev[i])
			}
		}
		if best >= 0 {
			x, y := g.centre(best)
			add(&lightWork{role: RoleMain, x: x, y: y, island: 0, tower: l.Towers.MainPort,
				white: float64(l.Range.MainPort * nm), site: -1, group: -1, point: true})
		}
	}

	// Each port's, on the point nearest it.
	for i, s := range pw.sites {
		if s.rule != catalog.SiteHarbour {
			continue
		}
		x, y, ok := pw.pointNear(s.island, s.x, s.y)
		if !ok {
			continue
		}
		add(&lightWork{role: RolePort, x: x, y: y, island: s.island, tower: l.Towers.Port, white: float64(l.Range.Port * nm), site: i, group: -1})
	}

	// The edge ring.
	for _, lw := range pw.edgeRing() {
		add(lw)
	}

	// The hazards: each offshore one on its rock; each fringing reef and
	// group of rocks toward the rim on its rock or its highest rock; none
	// within the merging distance of a light already.
	hazard := func(lw *lightWork) {
		if near(lw.x, lw.y, l.Hazards.Merge) {
			return
		}
		lw.role, lw.tower, lw.white = RoleHazard, l.Towers.Hazard, float64(l.Range.Hazard*nm)
		add(lw)
	}
	for i, s := range pw.sites {
		if s.hazard >= 0 {
			hazard(&lightWork{x: s.x, y: s.y, island: -1, site: i, group: -1})
		}
	}
	beyond := float64(l.Hazards.Beyond * nm)
	for i, s := range pw.sites {
		if s.rule == catalog.SiteReef && s.island >= 0 {
			m := pw.islands[s.island]
			if m.reefRock >= 0 && hypot(m.x, m.y) > beyond {
				x, y := m.grid.centre(m.reefRock)
				hazard(&lightWork{x: x, y: y, island: m.number, site: i, group: -1})
			}
		}
	}
	for gi, gr := range groups {
		if hypot(gr.x, gr.y) <= beyond || len(gr.members) == 0 {
			continue
		}
		top := pw.islands[gr.members[0]]
		for _, n := range gr.members[1:] {
			if pw.islands[n].highest > top.highest {
				top = pw.islands[n]
			}
		}
		hazard(&lightWork{x: top.hx, y: top.hy, island: top.number, site: -1, group: gi})
	}

	c.characters(pw.lightStream(), out)
	for _, lw := range out {
		s := pw.newSite(catalog.SiteLight, nil, lw.x, lw.y)
		if lw.island >= 0 {
			s = pw.newSite(catalog.SiteLight, pw.islands[lw.island], lw.x, lw.y)
		}
		s.light = slices.Index(out, lw)
		if lw.point && lw.island >= 0 {
			s.offer(pw.pointHeight(lw))
		}
		pw.sites = append(pw.sites, s)
	}
	return out
}

// edgeRing is the ring of lights on the approach to the edge: the
// outermost land within reach of each of its bearings, the first drawn,
// far enough inside the lip.
func (pw *placesWork) edgeRing() []*lightWork {
	c := pw.c
	l := &c.lights
	type landHex struct {
		x, y, d, a float64
		island     int32
	}
	var outer []landHex
	inner := float64(3 * nauticalMile)
	limit := c.disk - l.Edge.Inside
	for _, m := range pw.islands {
		g := &m.grid
		for i := range g.w * g.h {
			if g.elev[i] <= 0 {
				continue
			}
			x, y := g.centre(i)
			if d := hypot(x, y); d >= inner && d <= limit {
				outer = append(outer, landHex{x, y, d, physics.Atan2(x, y), m.number})
			}
		}
	}
	var out []*lightWork
	first := pw.lightStream().angle()
	within := float64(l.Edge.Within * degree)
	for k := range l.Edge.Count {
		bearing := first + float64(float64(k)*(2*math.Pi/float64(l.Edge.Count)))
		best := -1
		for i, h := range outer {
			if math.Abs(angleBetween(h.a, bearing)) <= within && (best < 0 || h.d > outer[best].d) {
				best = i
			}
		}
		if best < 0 {
			continue
		}
		h := outer[best]
		m := pw.islands[h.island]
		lw := &lightWork{role: RoleEdge, x: h.x, y: h.y, island: h.island, tower: l.Towers.Edge,
			white: float64(l.Range.Edge * nauticalMile), site: -1, group: -1}
		// A rock or an islet gives its light its own name, as Bishop Rock
		// does; a larger island a point of its coast.
		switch {
		case m.group >= 0:
			lw.group = int(m.group)
		case m.kind == kindLandmark || m.kind == kindMain:
			lw.point = true
		}
		out = append(out, lw)
	}
	return out
}

// lightStream is the lights' own stream.
func (pw *placesWork) lightStream() stream { return newStream(pw.seed, streamLights) }

// angleBetween is a − b, wrapped to (−π, π].
func angleBetween(a, b float64) float64 {
	d := a - b
	for d > math.Pi {
		d -= 2 * math.Pi
	}
	for d <= -math.Pi {
		d += 2 * math.Pi
	}
	return d
}

// pointHeight is the height a light's point offers a name: high where the
// island has cliffs and the ground stands high, low elsewhere.
func (pw *placesWork) pointHeight(lw *lightWork) string {
	cliffs := pw.c.feature(func(f *nameFeature) bool { return f.cliffs > 0 })
	if lw.ground >= 8 && cliffs != nil && slices.Contains(pw.shows[lw.island], cliffs.word) {
		return qualityHigh
	}
	return qualityLow
}

// pointNear is the point of island n's coast nearest (x, y): coast land
// with water over the catalog's share of the ground about it, as a
// headland has; the nearest coast if none is.
func (pw *placesWork) pointNear(n int32, x, y float64) (float64, float64, bool) {
	p := &pw.c.places.Point
	m := pw.islands[n]
	g := &m.grid
	type shore struct {
		i int32
		d float64
	}
	var coast []shore
	for _, i := range shoreOf(m, true) {
		hx, hy := g.centre(i)
		coast = append(coast, shore{i, hypot(hx-x, hy-y)})
	}
	if len(coast) == 0 {
		return 0, 0, false
	}
	slices.SortStableFunc(coast, func(a, b shore) int { return cmpDesc(b.d, a.d) })
	for _, s := range coast {
		hx, hy := g.centre(s.i)
		water, all := 0, 0
		pw.hexesWithin(hx, hy, p.Reach, func(_, _ float64, e int16) bool {
			all++
			if e <= 0 {
				water++
			}
			return true
		})
		if all > 0 && float64(water) >= float64(p.Water*float64(all)) {
			return hx, hy, true
		}
	}
	hx, hy := g.centre(coast[0].i)
	return hx, hy, true
}

// signature is what tells a character apart at a glance: its class, its
// number in a group and its colour.
func signature(ch *catalog.LightCharacter) string {
	return string(ch.Class) + " " + ch.Group + " " + string(ch.Colour)
}

// characters gives each light its character: Port Royal's the catalog's,
// the rest drawn from the list by backtracking, each a different one,
// white unless it marks a hazard, and none the same at a glance as a light
// whose range overlaps its own; then each its phase and daymark.
func (c *config) characters(s stream, lights []*lightWork) {
	chars := c.lights.Characters
	n := len(lights)
	rangeOf := func(i, k int) float64 {
		if chars[k].Colour != catalog.LightCharacterColourWhite {
			return float64(lights[i].white * c.lights.Range.Colour)
		}
		return lights[i].white
	}
	domains := make([][]int, n)
	for i, lw := range lights {
		if lw.role == RoleMain {
			domains[i] = []int{c.mainLight}
			continue
		}
		var d []int
		for k := range chars {
			if k != c.mainLight && (lw.role == RoleHazard || chars[k].Colour == catalog.LightCharacterColourWhite) {
				d = append(d, k)
			}
		}
		// In a drawn order.
		for a := len(d) - 1; a > 0; a-- {
			b := s.r.IntN(a + 1)
			d[a], d[b] = d[b], d[a]
		}
		domains[i] = d
	}
	given := make([]int, n)
	for i := range given {
		given[i] = -1
	}
	steps := 0
	var solve func(i int) bool
	solve = func(i int) bool {
		if i == n {
			return true
		}
		for _, k := range domains[i] {
			steps++
			if steps > 1000000 {
				return false
			}
			ok := true
			for j := range i {
				o := given[j]
				if o == k {
					ok = false
					break
				}
				if signature(&chars[o]) == signature(&chars[k]) &&
					hypot(lights[i].x-lights[j].x, lights[i].y-lights[j].y) < rangeOf(i, k)+rangeOf(j, o) {
					ok = false
					break
				}
			}
			if !ok {
				continue
			}
			given[i] = k
			if solve(i + 1) {
				return true
			}
			given[i] = -1
		}
		return false
	}
	if !solve(0) {
		// None fits: each the first of its domain no other has, which the
		// validator refuses, so that the world is made again.
		used := map[int]bool{}
		for i := range given {
			given[i] = domains[i][0]
			for _, k := range domains[i] {
				if !used[k] {
					given[i] = k
					break
				}
			}
			used[given[i]] = true
		}
	}
	for i, lw := range lights {
		lw.character = given[i]
		var period int64
		for _, st := range chars[given[i]].Steps {
			period += int64(st)
		}
		lw.phase = int64(s.r.IntN(int(period * 1000)))
		lw.daymark = s.r.IntN(len(c.lights.Look.Daymarks))
	}
}

// lightRange is a light's nominal range with its character, m.
func (c *config) lightRange(lw *lightWork) float64 {
	if c.lights.Characters[lw.character].Colour != catalog.LightCharacterColourWhite {
		return float64(lw.white * c.lights.Range.Colour)
	}
	return lw.white
}
