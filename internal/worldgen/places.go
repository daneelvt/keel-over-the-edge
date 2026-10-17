// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Places: what a sailor finds besides islands, each put where the land and
// the sea bed make it true, by its kind's site rule, after the definitions
// of Smyth's Sailor's Word-Book (1867):
//
//   - a port, "a place of resort for vessels", on a landmark island where
//     its coast is most sheltered, the least fetch over the 16 directions,
//     with deep water near the shore: a harbour's "security from the
//     effects of the wind and sea";
//   - a fishing village on a beach or in a cove of a large island, with
//     shallows off it for its fishing ground;
//   - an anchorage, "ground … neither too deep, shallow, or exposed for
//     ships to ride in safety upon", on sand, with room to swing, snug or
//     good by how many directions its fetch is short in;
//   - a cove, an inlet narrower at its mouth than it is deep, found where
//     closing the coast with a disc fills a bay;
//   - a lagoon, the water behind a fringing reef; a reef, a fringing reef's
//     crest or an offshore reef; a sandbar, a sandy island's bar or an
//     offshore bank;
//   - a wreck, a ship lost on a reef, a rock or a bar, or sunk near one.
//
// Lighthouses are places too, each where its light stands (lights.go).
// Each kind draws from a stream of its own, so tuning one moves no other.

// Place is a place of a made world.
type Place struct {
	// Number is its number among the world's places, which come after its
	// islands and its groups of rocks.
	Number int32   `json:"number"`
	Kind   string  `json:"kind"` // the catalog's kind of place
	Name   string  `json:"name"`
	Island int32   `json:"island"` // the island it is on or by; -1 for none
	X      float64 `json:"x"`      // m east of the world's centre
	Y      float64 `json:"y"`      // and north
	// Heading is the way it faces, rad clockwise from north: a port's or a
	// cove's mouth, a reef's seaward side, a wreck's bow.
	Heading float64      `json:"heading"`
	Zone    string       `json:"zone"`
	Details PlaceDetails `json:"details"`
}

// PlaceDetails are what a place's kind measures of it.
type PlaceDetails struct {
	Depth    float64 `json:"depth,omitempty"`    // m: a port's or an anchorage's water
	Shelter  string  `json:"shelter,omitempty"`  // an anchorage's: snug or good
	Across   float64 `json:"across,omitempty"`   // m: a cove's or a lagoon's width
	Mouth    float64 `json:"mouth,omitempty"`    // m: a cove's mouth
	Length   float64 `json:"length,omitempty"`   // m: a reef's crest, a bar
	Offshore bool    `json:"offshore,omitempty"` // a reef or bar of its own, on no island's shelf
	// Offers is what its site offers a name: its qualities, and what it
	// shows that names may need.
	Offers []string `json:"offers"`
	Ship   *Ship    `json:"ship,omitempty"`
}

// Ship is a wrecked ship: her name, the language it is in, her rig, her
// cargo, how long she has lain, and how she lies: stranded on the reef,
// rock or bar, heeled, or sunk in a few metres of water.
type Ship struct {
	Name     string  `json:"name"`
	Language string  `json:"language"`
	Rig      string  `json:"rig"`
	Cargo    string  `json:"cargo"`
	Age      string  `json:"age"`
	Sunk     bool    `json:"sunk"`
	Heel     float64 `json:"heel"` // rad, to starboard
}

// The qualities a site offers names, besides what it shows.
const (
	qualitySmall    = "small"
	qualityLarge    = "large"
	qualityFringing = "fringing"
	qualityOffshore = "offshore"
	qualityShore    = "shore"
	qualitySnug     = "snug"
	qualityGood     = "good"
	qualityLow      = "low"
	qualityHigh     = "high"
)

// What a site shows that names may need, besides the island's features.
const (
	needBeach    = "beach"
	needMangrove = "mangrove"
	needSand     = "sandbed"
	needRock     = "rockbed"
	needDeep     = "deep"
	needWreck    = "wreck"
)

// site is a place as the sites find it, before it is named.
type site struct {
	rule    catalog.Site
	island  int32 // -1 offshore
	hazard  int   // the offshore hazard it is, or -1
	x, y    float64
	heading float64
	biome   string // its island's, or anyTag offshore
	offers  []string
	details PlaceDetails
	wreck   int // the wreck on it, by its index among the sites, or -1
	light   int // a lighthouse's light, by its index, or -1
	name    string
}

// placesWork is what the sites share as they are found.
type placesWork struct {
	c       *config
	seed    uint64
	ground  *physics.Ground
	coarse  *coarse
	islands []*made
	hazards []*hazard
	shows   [][]string   // each island's features
	reach   []uint64     // the hexagons reached from the start in enough water
	coasts  []*coastGrid // each island's coast, made when first asked for
	sites   []*site
}

// sitesOf finds the world's places, kind by kind.
func (c *config) sitesOf(seed uint64, g *physics.Ground, k *coarse, islands []*made, hazards []*hazard, start Start) *placesWork {
	pw := &placesWork{c: c, seed: seed, ground: g, coarse: k, islands: islands, hazards: hazards,
		coasts: make([]*coastGrid, len(islands))}
	for _, m := range islands {
		pw.shows = append(pw.shows, c.shows(m))
	}
	pw.reach = c.flood(g, start, c.validator.ReachDepth)
	pw.ports()
	pw.villages()
	pw.anchorages()
	pw.coves()
	pw.lagoons()
	pw.reefs()
	pw.bars()
	pw.wrecks()
	return pw
}

// siteRules are the sites' rules, in the order their streams are keyed.
var siteRules = []catalog.Site{catalog.SiteHarbour, catalog.SiteVillage, catalog.SiteLight, catalog.SiteAnchorage,
	catalog.SiteCove, catalog.SiteLagoon, catalog.SiteReef, catalog.SiteBar, catalog.SiteWreck}

// stream is a kind's own stream.
func (pw *placesWork) stream(rule catalog.Site) stream {
	return newStream(pw.seed, streamPlaces+uint64(slices.Index(siteRules, rule)+1)<<8)
}

// count is how many sites of a rule have been found.
func (pw *placesWork) count(rule catalog.Site) int {
	n := 0
	for _, s := range pw.sites {
		if s.rule == rule {
			n++
		}
	}
	return n
}

// kindCount is the catalog's count of a rule's kind: the least and the most.
func (c *config) kindCount(rule catalog.Site) (int, int) {
	for _, k := range c.places.Kinds {
		if k.Site == rule {
			return k.Count[0], k.Count[1]
		}
	}
	return 0, 0
}

// newSite is a site on island m (nil offshore) at (x, y), with what the
// island shows and what the ground there shows.
func (pw *placesWork) newSite(rule catalog.Site, m *made, x, y float64) *site {
	s := &site{rule: rule, island: -1, hazard: -1, x: x, y: y, biome: anyTag, wreck: -1, light: -1}
	bed := uint8(0) // offshore, the deep's bed
	if m != nil {
		s.island = m.number
		b := &pw.c.biomes[m.biome]
		s.biome = pw.c.biomeIDs[m.biome]
		s.offers = append(s.offers, pw.shows[m.number]...)
		bed = b.surfaces.bed
		// A tropical shore, where a fringing reef grows, has mangroves.
		if b.reef {
			s.offers = append(s.offers, needMangrove)
		}
	}
	// The deep's bed, the first surface, is sand.
	if bed == 0 {
		s.offers = append(s.offers, needSand)
	} else {
		s.offers = append(s.offers, needRock)
	}
	if pw.deepNear(x, y, 60) {
		s.offers = append(s.offers, needDeep)
	}
	return s
}

// reefWord is the feature a reef shows, the word names need it by.
func (pw *placesWork) reefWord() string {
	if f := pw.c.feature(func(f *nameFeature) bool { return f.reef }); f != nil {
		return f.word
	}
	return ""
}

// offer adds what a site offers, once.
func (s *site) offer(words ...string) {
	for _, w := range words {
		if !slices.Contains(s.offers, w) {
			s.offers = append(s.offers, w)
		}
	}
}

// depth is the water's depth at (x, y), m; negative on land.
func (pw *placesWork) depth(x, y float64) float64 {
	e, _ := pw.ground.At(x, y)
	return -e
}

// deepNear reports whether water a tall ship can lie in is within r of
// (x, y).
func (pw *placesWork) deepNear(x, y, r float64) bool {
	found := false
	pw.hexesWithin(x, y, r, func(hx, hy float64, e int16) bool {
		if float64(-e) >= float64(pw.c.places.Deep*10) {
			found = true
			return false
		}
		return true
	})
	return found
}

// hexesWithin calls f with the centre and elevation, dm, of every hexagon
// whose centre is within r of (x, y), until f returns false.
func (pw *placesWork) hexesWithin(x, y, r float64, f func(hx, hy float64, e int16) bool) {
	q0, r0 := physics.HexAt(x, y)
	rings := toInt32(math.Ceil(r/(0.866*physics.HexAcross))) + 1
	for dq := -rings; dq <= rings; dq++ {
		for dr := max(-rings, -dq-rings); dr <= min(rings, -dq+rings); dr++ {
			hx, hy := physics.HexCentre(q0+dq, r0+dr)
			if hypot(hx-x, hy-y) > r {
				continue
			}
			cc, jj := physics.HexCell(q0+dq, r0+dr)
			if !f(hx, hy, elevationAt(pw.ground, cc, jj)) {
				return
			}
		}
	}
}

// reached reports whether the hexagon at (x, y) is reached from the start.
func (pw *placesWork) reached(x, y float64) bool {
	q, r := physics.HexAt(x, y)
	cc, jj := physics.HexCell(q, r)
	if cc < 0 || jj < 0 || cc >= physics.HexColumns || jj >= physics.HexRows {
		return false
	}
	i := cc*physics.HexRows + jj
	return pw.reach[i>>6]&(1<<(i&63)) != 0
}

// meanFetch is the mean of the fetch at (x, y) over the 16 directions, each
// one radial to the first land, at most most m.
func (pw *placesWork) meanFetch(x, y, most float64) float64 {
	var sum float64
	for d := range int32(physics.FetchDirections) {
		sum += pw.c.radialTo(pw.ground, pw.coarse, x, y, float64(float64(d)*(2*math.Pi/physics.FetchDirections)), most)
	}
	return sum / physics.FetchDirections
}

// sheltered is how many of the 16 directions the fetch at (x, y) is under
// most m in.
func (pw *placesWork) sheltered(x, y, most float64) int {
	n := 0
	for d := range int32(physics.FetchDirections) {
		if pw.c.radialTo(pw.ground, pw.coarse, x, y, float64(float64(d)*(2*math.Pi/physics.FetchDirections)), most) < most {
			n++
		}
	}
	return n
}

// coastGrid is an island's coast: the box of its land grown by a margin,
// which of it is the island's own land, and each hexagon's distance to the
// land (in the water) or, for Port Royal, to the water (on the land).
type coastGrid struct {
	g         islandGrid
	land      []bool
	dout, din []float64
	near      []int32
	xs        []float64
}

// coast is island n's coast.
func (pw *placesWork) coast(n int32) *coastGrid {
	if cg := pw.coasts[n]; cg != nil {
		return cg
	}
	m := pw.islands[n]
	g0 := &m.grid
	c0, c1, j0, j1 := g0.c0+g0.w, g0.c0, g0.j0+g0.h, g0.j0
	for i := range g0.w * g0.h {
		if g0.elev[i] > 0 {
			c, j := g0.c0+i/g0.h, g0.j0+i%g0.h
			c0, c1, j0, j1 = min(c0, c), max(c1, c), min(j0, j), max(j1, j)
		}
	}
	// Room to close a bay: the closing disc's radius and a little.
	margin := pw.c.places.Cove.Closing + 5*physics.HexAcross
	mc := toInt32(margin/(0.866*physics.HexAcross)) + 1
	mj := toInt32(margin/physics.HexAcross) + 1
	cg := &coastGrid{}
	g := &cg.g
	g.c0, g.j0 = max(c0-mc, 0), max(j0-mj, 0)
	g.w = min(c1+mc, physics.HexColumns-1) - g.c0 + 1
	g.h = min(j1+mj, physics.HexRows-1) - g.j0 + 1
	if g.w <= 0 || g.h <= 0 {
		g.w, g.h = 0, 0
	}
	total := g.w * g.h
	g.elev = make([]int16, total)
	cg.land = make([]bool, total)
	cg.dout = make([]float64, total)
	cg.din = make([]float64, total)
	cg.near = make([]int32, total)
	cg.xs = make([]float64, g.w)
	for cc := range g.w {
		cg.xs[cc], _ = physics.CellCentre(g.c0+cc, 0)
	}
	sea := make([]bool, total)
	for i := range total {
		c, j := g.c0+i/g.h, g.j0+i%g.h
		g.elev[i] = elevationAt(pw.ground, c, j)
		cg.din[i] = math.Inf(1)
		// The island's own land, from its own grid: another's is water
		// here, so that no bay is found between two islands.
		oc, oj := c-g0.c0, j-g0.j0
		inGrid := oc >= 0 && oj >= 0 && oc < g0.w && oj < g0.h
		if inGrid && g0.elev[oc*g0.h+oj] > 0 {
			cg.land[i] = true
		}
		// Port Royal's light stands near its outer coast, not its
		// harbour's.
		sea[i] = !cg.land[i] && !(inGrid && m.harbourWater != nil && m.harbourWater[oc*g0.h+oj])
	}
	g.distances(cg.land, cg.dout, cg.near, cg.xs)
	if n == 0 {
		// Inland distances only for Port Royal, whose light stands near
		// its coast.
		g.distances(sea, cg.din, cg.near, cg.xs)
	}
	pw.coasts[n] = cg
	return cg
}

// shoreOf lists the water hexagons of island m's grid beside its land,
// and, if land, its land beside the water instead.
func shoreOf(m *made, land bool) []int32 {
	g := &m.grid
	var out []int32
	var nb [6]int32
	for i := range g.w * g.h {
		// Its land lies within its shape's reach of its centre.
		if (g.elev[i] > 0) != land {
			continue
		}
		if x, y := g.centre(i); hypot(x-m.x, y-m.y) > float64(1.8*m.radius)+stackReach+physics.HexAcross {
			continue
		}
		k := g.neighbours(i, &nb)
		for _, j := range nb[:k] {
			if (g.elev[j] > 0) != land {
				out = append(out, i)
				break
			}
		}
	}
	return out
}

// spread picks from the candidates, best first by score (higher better),
// those at least apart m from each other and from the points given, at
// most one an island, at most most of them.
func spread[T any](cands []T, score func(T) float64, at func(T) (float64, float64, int32), apart float64, from [][2]float64, most int) []T {
	order := make([]int, len(cands))
	for i := range order {
		order[i] = i
	}
	slices.SortStableFunc(order, func(a, b int) int { return cmpDesc(score(cands[a]), score(cands[b])) })
	var out []T
	taken := map[int32]bool{}
	pts := slices.Clone(from)
	for _, i := range order {
		if len(out) >= most {
			break
		}
		x, y, island := at(cands[i])
		if island >= 0 && taken[island] {
			continue
		}
		ok := true
		for _, p := range pts {
			if hypot(x-p[0], y-p[1]) < apart {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		out = append(out, cands[i])
		pts = append(pts, [2]float64{x, y})
		if island >= 0 {
			taken[island] = true
		}
	}
	return out
}

// portSides is how many sides of an island a port's site is found on.
const portSides = 6

// ports finds the ports: on each landmark island outside the mist band,
// the stretch of its coast with the least fetch where water deep enough
// lies near the shore, reached from the start; then the ports spread over
// the disk, farthest-point first.
func (pw *placesWork) ports() {
	c := pw.c
	h := &c.places.Harbour
	type cand struct {
		s     *site
		fetch float64
	}
	var cands []cand
	for _, m := range pw.islands {
		if m.kind != kindLandmark {
			continue
		}
		g := &m.grid
		// The best site on each side of the island: the lights' cover
		// chooses among them.
		var best [portSides]cand
		for k := range best {
			best[k].fetch = math.Inf(1)
		}
		for k, i := range shoreOf(m, false) {
			if k%5 != 0 {
				continue
			}
			x, y := g.centre(i)
			if hypot(x, y) >= c.mist {
				continue
			}
			side := min(int(toInt32(float64(wrapAngle(physics.Atan2(x-m.x, y-m.y))/(2*math.Pi))*portSides)), portSides-1)
			// The nearest water deep enough within reach of the shore, along
			// each of 16 directions.
			dx, dy, dd := 0.0, 0.0, math.Inf(1)
			for d := range int32(16) {
				sa, ca := sincos(float64(float64(d) * (2 * math.Pi / 16)))
				for r := float64(physics.HexAcross); r <= min(h.Within, dd); r += physics.HexAcross {
					px, py := x+float64(r*sa), y+float64(r*ca)
					if e := pw.depth(px, py); e < 0 {
						break // land
					} else if e >= h.Depth {
						dx, dy, dd = px, py, r
						break
					}
				}
			}
			if math.IsInf(dd, 1) || !pw.reached(dx, dy) {
				continue
			}
			f := pw.meanFetch(dx, dy, 1000)
			// A town's room: deep water within a pier's reach along one of
			// the lattice's axes, and gentle land about it.
			if f < best[side].fetch && pw.pierReach(x, y, physics.Atan2(dx-x, dy-y), h.Depth, h.Pier) &&
				roomOf(pw.ground, x, y, h.RoomWithin, h.Steep) >= h.Room {
				s := pw.newSite(catalog.SiteHarbour, m, x, y)
				s.heading = physics.Atan2(dx-x, dy-y)
				s.details.Depth = round1(pw.depth(dx, dy))
				best[side] = cand{s: s, fetch: f}
			}
		}
		for _, b := range best {
			if b.s != nil {
				cands = append(cands, b)
			}
		}
	}
	_, most := c.kindCount(catalog.SiteHarbour)
	for _, p := range cover(pw, cands, func(p cand) *site { return p.s }, func(p cand) float64 { return -p.fetch },
		float64(h.Apart*nauticalMile), float64(c.lights.Range.Port*nauticalMile), most) {
		pw.offerShore(p.s)
		pw.sites = append(pw.sites, p.s)
	}
}

// cover picks most of the candidates, each the one whose light, of the
// range given, would reach the most water inside the mist band no light
// but Port Royal's reaches yet, the edge ring's and the offshore hazards'
// counted, each point weighed by how few of the candidates reach it, so
// that the hardest water to reach is reached first; the better by score
// on a tie; none nearer than apart m to another. So that a second light is
// in range everywhere, for a fix by bearings.
func cover[T any](pw *placesWork, cands []T, at func(T) *site, score func(T) float64, apart, reach float64, most int) []T {
	c := pw.c
	step := c.validator.LightGrid
	var water [][2]float64
	n := toInt32(c.mist/step) + 1
	for a := -n; a <= n; a++ {
		for b := -n; b <= n; b++ {
			x, y := float64(float64(a)*step), float64(float64(b)*step)
			if hypot(x, y) <= c.mist && !landAt(pw.ground, x, y) {
				water = append(water, [2]float64{x, y})
			}
		}
	}
	covered := make([]bool, len(water))
	mark := func(x, y, r float64) {
		for i, p := range water {
			if hypot(p[0]-x, p[1]-y) <= r {
				covered[i] = true
			}
		}
	}
	for _, lw := range pw.edgeRing() {
		mark(lw.x, lw.y, lw.white)
	}
	least := float64(c.lights.Range.Hazard * c.lights.Range.Colour * nauticalMile)
	for _, hz := range pw.hazards {
		mark(hz.rockX, hz.rockY, least)
	}
	// How many candidates reach each point.
	reaches := make([]int, len(water))
	for _, cd := range cands {
		s := at(cd)
		for i, p := range water {
			if hypot(p[0]-s.x, p[1]-s.y) <= reach {
				reaches[i]++
			}
		}
	}
	used := make([]bool, len(cands))
	var out []T
	for len(out) < most {
		pick, gain := -1, -1.0
		for k, cd := range cands {
			s := at(cd)
			if used[k] {
				continue
			}
			ok := true
			for _, o := range out {
				if os := at(o); hypot(s.x-os.x, s.y-os.y) < apart {
					ok = false
					break
				}
			}
			if !ok {
				continue
			}
			g := 0.0
			for i, p := range water {
				if !covered[i] && hypot(p[0]-s.x, p[1]-s.y) <= reach {
					g += 1 / float64(reaches[i])
				}
			}
			if g > gain || g == gain && score(cd) > score(cands[pick]) {
				pick, gain = k, g
			}
		}
		if pick < 0 {
			break
		}
		used[pick] = true
		out = append(out, cands[pick])
		s := at(cands[pick])
		mark(s.x, s.y, reach)
	}
	return out
}

// offerShore adds what the shore at a site offers: a beach, if the land
// beside it is its island's beach.
func (pw *placesWork) offerShore(s *site) {
	if s.island < 0 {
		return
	}
	m := pw.islands[s.island]
	b := &pw.c.biomes[m.biome]
	if b.surfaces.beach == b.surfaces.steep {
		return // a rocky shore's "beach" is bare rock
	}
	beach := false
	pw.hexesWithin(s.x, s.y, 3*physics.HexAcross, func(hx, hy float64, e int16) bool {
		if e > 0 {
			if _, surf := pw.ground.At(hx, hy); uint8(surf) == b.surfaces.beach {
				beach = true
				return false
			}
		}
		return true
	})
	if beach {
		s.offer(needBeach)
	}
}

// sitePoint is a site's position, island and no more, for spread.
func sitePoint(s *site) (float64, float64, int32) { return s.x, s.y, s.island }

// placed is where the sites of the rules given are.
func (pw *placesWork) placed(rules ...catalog.Site) [][2]float64 {
	var out [][2]float64
	for _, s := range pw.sites {
		if slices.Contains(rules, s.rule) {
			out = append(out, [2]float64{s.x, s.y})
		}
	}
	return out
}

// villages finds the fishing villages: on islands of the sizes given with
// no port, at the beach or cove on their coast with the most shallows off
// it, their fishing ground.
func (pw *placesWork) villages() {
	c := pw.c
	v := &c.places.Village
	ported := map[int32]bool{}
	for _, s := range pw.sites {
		if s.rule == catalog.SiteHarbour {
			ported[s.island] = true
		}
	}
	type cand struct {
		s      *site
		ground float64
	}
	var cands []cand
	for _, m := range pw.islands {
		if m.kind == kindMain || m.kind == kindRock || ported[m.number] || !slices.Contains(v.Sizes, c.sizeOf(m.area)) {
			continue
		}
		g := &m.grid
		var best cand
		for k, i := range shoreOf(m, false) {
			if k%6 != 0 {
				continue
			}
			x, y := g.centre(i)
			if hypot(x, y) >= c.mist {
				continue
			}
			s := pw.newSite(catalog.SiteVillage, m, x, y)
			pw.offerShore(s)
			if !slices.Contains(s.offers, needBeach) {
				continue
			}
			if roomOf(pw.ground, x, y, c.places.Harbour.RoomWithin, c.places.Harbour.Steep) < v.Room {
				continue
			}
			// Its fishing ground: shallows off the beach, not the beach's
			// own edge.
			n := 0
			sx, sy := 0.0, 0.0
			pw.hexesWithin(x, y, v.Ground, func(hx, hy float64, e int16) bool {
				if d := hypot(hx-x, hy-y); e < 0 && float64(-e) < float64(v.Shallows*10) && d > v.Ground/3 {
					n++
					sx, sy = sx+hx, sy+hy
				}
				return true
			})
			if float64(n) > best.ground {
				s.heading = physics.Atan2(sx/float64(max(n, 1))-x, sy/float64(max(n, 1))-y)
				best = cand{s: s, ground: float64(n)}
			}
		}
		if best.s != nil && best.ground >= 30 {
			cands = append(cands, best)
		}
	}
	_, most := c.kindCount(catalog.SiteVillage)
	for _, p := range spread(cands, func(p cand) float64 { return p.ground }, func(p cand) (float64, float64, int32) { return sitePoint(p.s) },
		v.Apart, pw.placed(catalog.SiteHarbour), most) {
		pw.sites = append(pw.sites, p.s)
	}
}

// nearestIsland is the island whose coast is nearest (x, y), by its
// centre and radius, and how far.
func (pw *placesWork) nearestIsland(x, y float64) (*made, float64) {
	var best *made
	far := math.Inf(1)
	for _, m := range pw.islands {
		if d := hypot(x-m.x, y-m.y) - m.radius; d < far {
			best, far = m, d
		}
	}
	return best, far
}

// anchorages finds the anchorages: points on a grid in water deep enough
// and not too deep, near land, on sand, sheltered in enough directions and
// with room to swing; the snug ones first, spread.
func (pw *placesWork) anchorages() {
	c := pw.c
	a := &c.places.Anchorage
	lo, hi := float64(a.Depth[0]*10), float64(a.Depth[1]*10)
	clear := float64(a.Clear * 10)
	type cand struct {
		s     *site
		snug  int
		share float64
	}
	var cands []cand
	n := toInt32(c.mist/a.Step) + 1
	for ia := -n; ia <= n; ia++ {
		for ib := -n; ib <= n; ib++ {
			x, y := float64(float64(ia)*a.Step), float64(float64(ib)*a.Step)
			if hypot(x, y) >= c.mist || hypot(x, y) < c.calm {
				continue
			}
			q, r := physics.HexAt(x, y)
			cc, jj := physics.HexCell(q, r)
			e := float64(-elevationAt(pw.ground, cc, jj))
			if e < lo || e > hi {
				continue
			}
			if s, ok := pw.coarse.index(x, y); !ok || pw.coarse.dist[s] > a.Land {
				continue
			}
			m, _ := pw.nearestIsland(x, y)
			if m == nil || c.biomes[m.biome].surfaces.bed != 0 {
				continue // a rocky bed holds no anchor
			}
			snug := pw.sheltered(x, y, a.Fetch)
			if snug < a.Good {
				continue
			}
			room := true
			pw.hexesWithin(x, y, a.Swing, func(hx, hy float64, e int16) bool {
				if float64(-e) < clear {
					room = false
					return false
				}
				return true
			})
			if !room {
				continue
			}
			s := pw.newSite(catalog.SiteAnchorage, m, x, y)
			s.details.Depth = round1(e / 10)
			s.details.Shelter = qualityGood
			if snug >= a.Snug {
				s.details.Shelter = qualitySnug
			}
			s.offer(s.details.Shelter)
			// It faces the way it is open.
			s.heading = pw.openWay(x, y, a.Fetch)
			cands = append(cands, cand{s, snug, 0})
		}
	}
	_, most := c.kindCount(catalog.SiteAnchorage)
	r := pw.stream(catalog.SiteAnchorage)
	for i := range cands {
		cands[i].share = r.float()
	}
	// A large island may have an anchorage on each side.
	for _, p := range spread(cands, func(p cand) float64 { return float64(p.snug) + p.share }, func(p cand) (float64, float64, int32) { return p.s.x, p.s.y, -1 },
		a.Apart, nil, most) {
		pw.sites = append(pw.sites, p.s)
	}
}

// openWay is the direction from (x, y) with the longest fetch, at most
// most m: the way a place is open to the sea.
func (pw *placesWork) openWay(x, y, most float64) float64 {
	best, far := 0.0, -1.0
	for d := range int32(physics.FetchDirections) {
		a := float64(float64(d) * (2 * math.Pi / physics.FetchDirections))
		if f := pw.c.radialTo(pw.ground, pw.coarse, x, y, a, most); f > far {
			best, far = a, f
		}
	}
	return best
}

// coves finds the coves: on each island's coast, the bays a disc closing
// the coast fills, narrower at the mouth than they are deep, of the width
// the catalog gives, with water enough at the mouth.
func (pw *placesWork) coves() {
	c := pw.c
	cv := &c.places.Cove
	type cand struct {
		s     *site
		ratio float64
	}
	var cands []cand
	for _, m := range pw.islands {
		if m.kind == kindRock || m.bays == 0 {
			continue
		}
		cg := pw.coast(m.number)
		g := &cg.g
		total := g.w * g.h
		// Closing: the water within the disc's reach of the land, less
		// what is within its reach of the water beyond.
		far := make([]bool, total)
		for i := range total {
			far[i] = cg.dout[i] > cv.Closing
		}
		back := make([]float64, total)
		g.distances(far, back, cg.near, cg.xs)
		bay := make([]bool, total)
		for i := range total {
			bay[i] = !cg.land[i] && back[i] > cv.Closing
		}
		seen := make([]bool, total)
		var nb [6]int32
		for i0 := range total {
			if !bay[i0] || seen[i0] {
				continue
			}
			// One bay: its water, and its mouth, the water beside the
			// open sea.
			var water, mouth []int32
			queue := []int32{i0}
			seen[i0] = true
			for len(queue) > 0 {
				i := queue[0]
				queue = queue[1:]
				water = append(water, i)
				k := g.neighbours(i, &nb)
				open := false
				for _, j := range nb[:k] {
					if bay[j] && !seen[j] {
						seen[j] = true
						queue = append(queue, j)
					} else if !bay[j] && !cg.land[j] {
						open = true
					}
				}
				if open {
					mouth = append(mouth, i)
				}
			}
			if len(mouth) == 0 || len(water) < 8 {
				continue
			}
			// The mouth's width, its depth of water, and how deep the bay
			// runs from it.
			wide, deepest := 0.0, 0.0
			mx, my := 0.0, 0.0
			for _, a := range mouth {
				ax, ay := g.centre(a)
				mx, my = mx+ax, my+ay
				deepest = max(deepest, -float64(g.elev[a])*0.1)
				for _, b := range mouth {
					bx, by := g.centre(b)
					wide = max(wide, hypot(ax-bx, ay-by))
				}
			}
			wide += physics.HexAcross
			mx, my = mx/float64(len(mouth)), my/float64(len(mouth))
			inland, cx, cy := 0.0, 0.0, 0.0
			for _, i := range water {
				x, y := g.centre(i)
				cx, cy = cx+x, cy+y
				inland = max(inland, hypot(x-mx, y-my))
			}
			cx, cy = cx/float64(len(water)), cy/float64(len(water))
			area := float64(float64(len(water)) * hexArea)
			across := area / max(inland, physics.HexAcross)
			if wide >= inland || across < cv.Across[0] || across > cv.Across[1] || deepest < cv.Mouth {
				continue
			}
			// The cove's middle: its water nearest the mean of its water.
			mid, md := water[0], math.Inf(1)
			for _, i := range water {
				x, y := g.centre(i)
				if d := hypot(x-cx, y-cy); d < md {
					mid, md = i, d
				}
			}
			x, y := g.centre(mid)
			if hypot(x, y) >= c.disk {
				continue
			}
			s := pw.newSite(catalog.SiteCove, m, x, y)
			s.heading = physics.Atan2(mx-x, my-y)
			s.details.Across = round1(across)
			s.details.Mouth = round1(wide)
			s.offer(sizeWord(across, c.places.Small))
			pw.offerShore(s)
			cands = append(cands, cand{s, inland / wide})
		}
	}
	_, most := c.kindCount(catalog.SiteCove)
	for _, p := range spread(cands, func(p cand) float64 { return p.ratio }, func(p cand) (float64, float64, int32) { return sitePoint(p.s) },
		0, nil, most) {
		pw.sites = append(pw.sites, p.s)
	}
}

// sizeWord is small below the limit, large above.
func sizeWord(v, limit float64) string {
	if v < limit {
		return qualitySmall
	}
	return qualityLarge
}

// lagoons finds the lagoons: the water behind each fringing reef wide
// enough, at its widest, half way from the crest to the shore.
func (pw *placesWork) lagoons() {
	c := pw.c
	for _, m := range pw.islands {
		if !m.reef || m.lagoon < c.places.Lagoon.Width || len(m.crest) == 0 || m.kind == kindRock {
			continue
		}
		// Half way in from the crest's hexagon furthest from the centre of
		// the disk, toward the island's centre, to the water's middle.
		best, far := int32(-1), 0.0
		for _, i := range m.crest {
			x, y := m.grid.centre(i)
			if d := hypot(x, y); d > far {
				best, far = i, d
			}
		}
		x, y := m.grid.centre(best)
		ux, uy := m.x-x, m.y-y
		d := hypot(ux, uy)
		if d <= 0 {
			continue
		}
		t := float64(m.reefAt/2) / d
		sx, sy := x+float64(ux*t), y+float64(uy*t)
		if pw.depth(sx, sy) <= 0 {
			continue
		}
		s := pw.newSite(catalog.SiteLagoon, m, sx, sy)
		s.heading = physics.Atan2(x-m.x, y-m.y)
		s.details.Across = round1(m.lagoon)
		s.offer(sizeWord(m.lagoon, c.places.Small), pw.reefWord())
		pw.offerShore(s)
		pw.sites = append(pw.sites, s)
	}
}

// crestLength is how far a band of hexagons a hexagon wide runs, m.
func crestLength(hexes int) float64 { return float64(float64(hexes) * (hexArea / physics.HexAcross)) }

// reefs finds the reefs: each fringing reef whose crest runs far enough,
// at its rock if it has one, else at the crest's hexagon furthest from the
// centre; and each offshore reef, at its rock.
func (pw *placesWork) reefs() {
	c := pw.c
	for _, m := range pw.islands {
		if !m.reef || m.kind == kindRock {
			continue
		}
		length := crestLength(len(m.crest))
		if length < c.places.Reef.Crest {
			continue
		}
		at := m.reefRock
		if at < 0 {
			far := 0.0
			for _, i := range m.crest {
				x, y := m.grid.centre(i)
				if d := hypot(x, y); d > far {
					at, far = i, d
				}
			}
		}
		x, y := m.grid.centre(at)
		s := pw.newSite(catalog.SiteReef, m, x, y)
		s.heading = physics.Atan2(x-m.x, y-m.y)
		s.details.Length = round1(length)
		s.offer(qualityFringing, sizeWord(length, c.places.Long), pw.reefWord())
		pw.sites = append(pw.sites, s)
	}
	for i, hz := range pw.hazards {
		if hz.kind != hazardReef {
			continue
		}
		s := pw.newSite(catalog.SiteReef, nil, hz.rockX, hz.rockY)
		s.hazard = i
		s.heading = hz.axis
		s.details.Length = round1(hz.length)
		s.details.Offshore = true
		s.offer(qualityOffshore, sizeWord(hz.length, c.places.Long), pw.reefWord(), needRock)
		pw.sites = append(pw.sites, s)
	}
}

// bars finds the sandbars: each sandy island's bar long enough, at its
// shallowest; and each offshore bank, at its rock.
func (pw *placesWork) bars() {
	c := pw.c
	for _, m := range pw.islands {
		if m.barAt <= 0 || m.kind == kindRock || m.kind == kindMain {
			continue
		}
		g := &m.grid
		n, best, shallow := 0, int32(-1), math.Inf(1)
		for _, i := range m.bar {
			if g.elev[i] > 0 {
				continue
			}
			n++
			if d := -float64(g.elev[i]); d < shallow {
				best, shallow = i, d
			}
		}
		length := crestLength(n)
		if best < 0 || length < c.places.Bar.Length {
			continue
		}
		x, y := g.centre(best)
		s := pw.newSite(catalog.SiteBar, m, x, y)
		s.heading = physics.Atan2(x-m.x, y-m.y)
		s.details.Length = round1(length)
		s.offer(qualityShore, sizeWord(length, c.places.Long))
		pw.sites = append(pw.sites, s)
	}
	for i, hz := range pw.hazards {
		if hz.kind != hazardBank {
			continue
		}
		s := pw.newSite(catalog.SiteBar, nil, hz.rockX, hz.rockY)
		s.hazard = i
		s.heading = hz.axis
		s.details.Length = round1(hz.length)
		s.details.Offshore = true
		s.offer(qualityOffshore, sizeWord(hz.length, c.places.Long))
		pw.sites = append(pw.sites, s)
	}
}

// wreckHost is what a wreck may lie on or near: a reef, a bar, a rock, or
// in the mist band an island's shore.
type wreckHost struct {
	x, y   float64
	island *made
	site   int // the reef's or bar's site, or -1
}

// wrecks finds the wrecks: each a ship lost on a reef, a bar or a rock,
// lying stranded on it or sunk in a few metres of water near it; the first
// few in the mist band, where ships are lost, the rest anywhere.
func (pw *placesWork) wrecks() {
	c := pw.c
	wk := &c.places.Wreck
	r := pw.stream(catalog.SiteWreck)
	var hosts []wreckHost
	for i, s := range pw.sites {
		if s.rule == catalog.SiteReef || s.rule == catalog.SiteBar {
			var m *made
			if s.island >= 0 {
				m = pw.islands[s.island]
			}
			hosts = append(hosts, wreckHost{s.x, s.y, m, i})
		}
	}
	for _, m := range pw.islands {
		if m.kind == kindRock {
			hosts = append(hosts, wreckHost{m.hx, m.hy, m, -1})
		}
	}
	// In the mist band, where ships are lost, any island's shore will do:
	// its land furthest out within the band.
	limit := c.disk - c.lights.Edge.Inside
	for _, m := range pw.islands {
		g := &m.grid
		bx, by, far := 0.0, 0.0, 0.0
		for i := range g.w * g.h {
			if g.elev[i] <= 0 {
				continue
			}
			x, y := g.centre(i)
			if d := hypot(x, y); d >= c.mist && d <= limit && d > far {
				bx, by, far = x, y, d
			}
		}
		if far > 0 {
			hosts = append(hosts, wreckHost{bx, by, m, -1})
		}
	}
	_, most := c.kindCount(catalog.SiteWreck)
	used := make([]bool, len(hosts))
	var placed [][2]float64
	try := func(mist bool) bool {
		var pool []int
		for i, h := range hosts {
			if !used[i] && (!mist || hypot(h.x, h.y) >= c.mist) && hypot(h.x, h.y) < c.disk-c.lights.Edge.Inside {
				pool = append(pool, i)
			}
		}
		for len(pool) > 0 {
			k := r.r.IntN(len(pool))
			i := pool[k]
			pool = slices.Delete(pool, k, k+1)
			h := hosts[i]
			ok := true
			for _, p := range placed {
				if hypot(h.x-p[0], h.y-p[1]) < 300 {
					ok = false
					break
				}
			}
			if !ok {
				continue
			}
			s := pw.wreckOn(r, h, wk, mist)
			if s == nil {
				continue
			}
			used[i] = true
			placed = append(placed, [2]float64{s.x, s.y})
			if h.site >= 0 {
				pw.sites[h.site].wreck = len(pw.sites)
				pw.sites[h.site].offer(needWreck)
			}
			pw.sites = append(pw.sites, s)
			return true
		}
		return false
	}
	for range min(wk.Mist, most) {
		if !try(true) {
			break
		}
	}
	for pw.count(catalog.SiteWreck) < most {
		if !try(false) {
			break
		}
	}
}

// wreckOn lays a wreck on or near a host: stranded on it, where the water
// is under a metre and a half, or sunk in the catalog's depth within reach
// of it, in the mist band if mist. nil if neither has room.
func (pw *placesWork) wreckOn(r stream, h wreckHost, wk *catalog.PlaceWreck, mist bool) *site {
	sunk := r.chance(0.5)
	var p [2]float64
	found := false
	// Her lie drawn, and the other if hers has no room.
	for range 2 {
		lo, hi := float64(wk.Depth[0]*10), float64(wk.Depth[1]*10)
		if !sunk {
			lo, hi = 1, 15
		}
		var spots [][2]float64
		pw.hexesWithin(h.x, h.y, wk.Near, func(hx, hy float64, e int16) bool {
			if d := float64(-e); d >= lo && d <= hi && (!mist || hypot(hx, hy) >= pw.c.mist) {
				spots = append(spots, [2]float64{hx, hy})
			}
			return true
		})
		if len(spots) > 0 {
			p, found = spots[r.r.IntN(len(spots))], true
			break
		}
		sunk = !sunk
	}
	if !found {
		return nil
	}
	s := pw.newSite(catalog.SiteWreck, h.island, p[0], p[1])
	s.heading = r.angle()
	rig := &pw.c.places.Rigs[r.r.IntN(len(pw.c.places.Rigs))]
	age := &pw.c.places.Ages[r.r.IntN(len(pw.c.places.Ages))]
	cargo := pw.c.lists.cargoes[r.r.IntN(len(pw.c.lists.cargoes))]
	s.details.Ship = &Ship{Rig: string(rig.ID), Age: string(age.ID), Cargo: cargo.name, Sunk: sunk}
	if !sunk {
		s.details.Ship.Heel = round3(r.in(0.15, 0.45))
		if r.chance(0.5) {
			s.details.Ship.Heel = -s.details.Ship.Heel
		}
	}
	s.details.Depth = round1(pw.depth(p[0], p[1]))
	return s
}

// round1 is v to a tenth; round3 to a thousandth.
func round1(v float64) float64 { return float64(round(float64(v*10))) / 10 }
func round3(v float64) float64 { return float64(round(float64(v*1000))) / 1000 }

// pierReach reports whether water depth m deep lies within most m of
// (x, y) along one of the lattice's axes within 60° of out, with no land
// between: where a pier may run out to it.
func (pw *placesWork) pierReach(x, y, out, depth, most float64) bool {
	for _, a := range latticeAxes {
		if math.Abs(angleBetween(a, out)) > float64(61*degree) {
			continue
		}
		sa, ca := sincos(a)
		for t := 0.0; t <= most; t += physics.HexAcross / 2 {
			e := pw.depth(x+float64(t*sa), y+float64(t*ca))
			if e < 0 {
				break
			}
			if e >= depth {
				return true
			}
		}
	}
	return false
}
