// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The validator: rules a world must pass, each with a name, what it
// measured and what it asks, run in order. A world that fails any is made
// again from the next seed.

// Rule is one rule's result.
type Rule struct {
	Name     string `json:"name"`
	Measured string `json:"measured"`
	Wants    string `json:"wants"`
	Pass     bool   `json:"pass"`
}

// world is a made world as the validator sees it.
type world struct {
	islands []*made
	names   []string
	groups  []groupSpot
	ground  *physics.Ground
	coarse  *coarse
	start   Start
	reach   []uint64 // the hexagons reached from the start, by flood
	hazards []*hazard
	places  []Place
	lights  []Light
	pw      *placesWork
	// lightWork are the lights as they were found: what each is named after.
	lightWork []*lightWork
	towns     []Town
	buildings []Building
}

// validate runs every rule over a world.
func (c *config) validate(w *world) []Rule {
	var rules []Rule
	add := func(name string, pass bool, measured, wants string, args ...any) {
		rules = append(rules, Rule{Name: name, Measured: measured, Wants: fmt.Sprintf(wants, args...), Pass: pass})
	}
	v := &c.validator
	port := w.islands[0]

	// The main port's island: its size, height and cliffs, and the disk's
	// centre on it.
	// Its width, of its land and its basin together.
	width := float64(2 * sqrtArea(port.area+port.basin))
	lo, hi := float64(c.port.across[0]*0.85), float64(c.port.across[1]*1.15)
	add("main port's width", width >= lo && width <= hi, fmt.Sprintf("%.0f m, its basin counted", width), "%.0f–%.0f m", lo, hi)
	add("main port's height", port.highest >= c.port.height[0]-0.5 && port.highest <= c.port.height[1]+0.5,
		fmt.Sprintf("%.1f m", port.highest), "%.0f–%.0f m", c.port.height[0], c.port.height[1])
	add("main port's cliffs", port.cliffs >= 1.0/3, fmt.Sprintf("%.2f of its outer coast", port.cliffs), "at least a third")
	off := hypot(port.x, port.y)
	centre := landAt(w.ground, 0, 0) || port.harbour != nil && port.harbour.inHarbour(0, 0)
	add("main port at the centre", centre && off <= v.CentreOffset,
		fmt.Sprintf("centre %.0f m off, the disk's centre %s", off, map[bool]string{true: "on it", false: "in the open sea"}[centre]),
		"within %.0f m, the disk's centre on its land or in its harbour", v.CentreOffset)

	// The calm water: no land but the main port's within its radius.
	nearest := math.Inf(1)
	for _, m := range w.islands[1:] {
		nearest = min(nearest, m.nearestLand())
	}
	add("calm water", nearest >= c.calm, fmt.Sprintf("other land %.0f m from the centre", nearest), "none within %.0f m", c.calm)

	// The start area.
	add("start area", len(w.start.Places) == c.start.Places, fmt.Sprintf("%d places", len(w.start.Places)), "%d", c.start.Places)

	// Every landmark reachable from the start in enough water: from the
	// roads, whose water the moorings' must reach (townRules).
	if w.reach == nil {
		w.reach = c.flood(w.ground, w.start, v.ReachDepth)
	}
	unreached := c.unreachable(w)
	add("landmarks reachable", len(unreached) == 0, fmt.Sprintf("%d not reached", len(unreached)),
		"every one, in %.1f m of water", v.ReachDepth)

	// No open water far from land inside the mist band.
	far := c.largestOpen(w.coarse)
	add("open water", far <= v.OpenWater, fmt.Sprintf("%.0f m from land at most", far), "at most %.0f m", v.OpenWater)

	// The share of the disk that is land.
	share := c.landShare(w.ground)
	add("land share", share >= v.LandShare[0] && share <= v.LandShare[1], fmt.Sprintf("%.2f%%", share), "%.1f–%.1f%%", v.LandShare[0], v.LandShare[1])

	// Islands by size class, near the layout's expectation.
	counts := map[string]int{}
	for _, m := range w.islands[1:] {
		if m.kind != kindRock {
			counts[c.sizeOf(m.area)]++
		}
	}
	expect := c.expected()
	var off2 []string
	for _, s := range c.sizes {
		e := expect[s.class]
		if e < 3 {
			continue
		}
		got := float64(counts[s.class])
		if math.Abs(got-e) > float64(v.Counts*e) {
			off2 = append(off2, fmt.Sprintf("%s %d (expected %.1f)", s.class, counts[s.class], e))
		}
	}
	measured := make([]string, 0, len(c.sizes))
	for _, s := range c.sizes {
		measured = append(measured, fmt.Sprintf("%s %d", s.class, counts[s.class]))
	}
	add("counts by size", len(off2) == 0, strings.Join(measured, ", "), "each within %.0f%% of its expectation%s", float64(v.Counts*100), suffix(off2))

	// The landmarks' shores.
	least := math.Inf(1)
	for _, m := range w.islands {
		if m.kind == kindLandmark {
			least = min(least, m.shoreline)
		}
	}
	if math.IsInf(least, 1) {
		least = 0
	}
	add("landmarks' shores", least >= v.Shoreline || c.layout.landmarks == 0, fmt.Sprintf("least index %.2f", least), "at least %.2f", v.Shoreline)

	// Every island named, none twice.
	seen := map[string]bool{}
	dup, missing := 0, 0
	for _, n := range w.names {
		if n == "" {
			missing++
			continue
		}
		k := strings.ToLower(n)
		if seen[k] {
			dup++
		}
		seen[k] = true
	}
	add("names", dup == 0 && missing == 0, fmt.Sprintf("%d unnamed, %d twice", missing, dup), "every island named, none twice")

	// The land's height.
	lowest, highest := math.Inf(1), 0.0
	for _, m := range w.islands {
		lowest = min(lowest, m.lowestLand())
		highest = max(highest, m.highest)
	}
	add("land's height", lowest >= c.land[0]-1e-9 && highest <= c.land[1]+1e-9, fmt.Sprintf("%.1f–%.1f m", lowest, highest), "%.1f–%.0f m", c.land[0], c.land[1])
	if w.pw != nil {
		rules = append(rules, c.placeRules(w)...)
		rules = append(rules, c.townRules(w)...)
	}
	return rules
}

// placeRules are the places' and lights' rules.
func (c *config) placeRules(w *world) []Rule {
	var rules []Rule
	add := func(name string, pass bool, measured, wants string, args ...any) {
		rules = append(rules, Rule{Name: name, Measured: measured, Wants: fmt.Sprintf(wants, args...), Pass: pass})
	}
	l := &c.lights
	nm := float64(nauticalMile)

	// Each kind's count.
	counts := map[string]int{}
	for _, p := range w.places {
		counts[p.Kind]++
	}
	var measured, off []string
	for _, k := range c.places.Kinds {
		n := counts[string(k.ID)]
		measured = append(measured, fmt.Sprintf("%s %d", k.ID, n))
		if n < k.Count[0] || n > k.Count[1] {
			off = append(off, fmt.Sprintf("%s %d (wants %d–%d)", k.ID, n, k.Count[0], k.Count[1]))
		}
	}
	inMist := 0
	for _, p := range w.places {
		if p.Kind == c.kinds[catalog.SiteWreck] && hypot(p.X, p.Y) >= c.mist {
			inMist++
		}
	}
	measured = append(measured, fmt.Sprintf("%d wrecks in the mist band", inMist))
	if inMist < c.places.Wreck.Mist {
		off = append(off, fmt.Sprintf("%d wrecks in the mist band (wants %d)", inMist, c.places.Wreck.Mist))
	}
	add("places", len(off) == 0, strings.Join(measured, ", "), "each kind within its count, and wrecks in the mist band%s", suffix(off))

	// Every port reached from the start in enough water, and lit.
	marked := map[int32]bool{}
	for _, lt := range w.lights {
		marked[lt.Marks] = true
	}
	unreached, unlit := 0, 0
	for _, p := range w.places {
		if p.Kind != c.kinds[catalog.SiteHarbour] {
			continue
		}
		reached := false
		w.pw.hexesWithin(p.X, p.Y, c.places.Harbour.Within, func(hx, hy float64, _ int16) bool {
			reached = w.pw.reached(hx, hy)
			return !reached
		})
		if !reached {
			unreached++
		}
		if !marked[p.Number] {
			unlit++
		}
	}
	add("ports reachable", unreached == 0, fmt.Sprintf("%d not reached", unreached), "every one, in %.1f m of water", c.validator.ReachDepth)
	add("ports lit", unlit == 0, fmt.Sprintf("%d unlit", unlit), "every one")

	// Every hazard toward the rim lit: the offshore ones anywhere, and the
	// groups of rocks and fringing reefs beyond the lights' distance.
	lit := func(x, y float64) bool {
		for _, lt := range w.lights {
			if hypot(x-lt.X, y-lt.Y) <= l.Hazards.Merge {
				return true
			}
		}
		return false
	}
	beyond := float64(l.Hazards.Beyond * nm)
	dark := 0
	for _, hz := range w.hazards {
		if !lit(hz.rockX, hz.rockY) {
			dark++
		}
	}
	for _, m := range w.islands {
		if m.reefRock >= 0 {
			if x, y := m.grid.centre(m.reefRock); !lit(x, y) {
				dark++
			}
		}
	}
	for _, g := range w.groups {
		if hypot(g.x, g.y) <= beyond {
			continue
		}
		var top *made
		for _, n := range g.members {
			if int(n) < len(w.islands) && (top == nil || w.islands[n].highest > top.highest) {
				top = w.islands[n]
			}
		}
		if top != nil && !lit(top.hx, top.hy) {
			dark++
		}
	}
	add("hazards lit", dark == 0, fmt.Sprintf("%d unlit", dark), "every offshore hazard, and the rocks and reefs beyond %.1f NM, a light within %.0f m", l.Hazards.Beyond, l.Hazards.Merge)

	// The edge ring: a light within reach of each of its bearings.
	first := w.pw.lightStream().angle()
	missing := 0
	for k := range l.Edge.Count {
		bearing := first + float64(float64(k)*(2*math.Pi/float64(l.Edge.Count)))
		found := false
		for _, lt := range w.lights {
			if lt.Role == RoleEdge && math.Abs(angleBetween(physics.Atan2(lt.X, lt.Y), bearing)) <= float64(l.Edge.Within*degree)+1e-9 {
				found = true
			}
		}
		if !found {
			missing++
		}
	}
	add("edge ring", missing == 0, fmt.Sprintf("%d bearings without a light", missing), "a light within %.0f° of each of %d bearings", l.Edge.Within, l.Edge.Count)

	// Characters: one each, of the list, white unless a hazard's, Port
	// Royal's the catalog's, none like a light whose range overlaps.
	bad := 0
	given := map[int32]bool{}
	for i, a := range w.lights {
		if a.Character < 0 || int(a.Character) >= len(l.Characters) || given[a.Character] {
			bad++
			continue
		}
		given[a.Character] = true
		ch := &l.Characters[a.Character]
		if a.Role == RoleMain && int(a.Character) != c.mainLight ||
			a.Role != RoleHazard && ch.Colour != catalog.LightCharacterColourWhite {
			bad++
		}
		for _, b := range w.lights[:i] {
			if b.Character < 0 || int(b.Character) >= len(l.Characters) {
				continue
			}
			if signature(ch) == signature(&l.Characters[b.Character]) && hypot(a.X-b.X, a.Y-b.Y) < a.Range+b.Range {
				bad++
			}
		}
	}
	add("characters", bad == 0, fmt.Sprintf("%d amiss", bad), "one each, of the list, told apart from every light whose range overlaps")

	// Two lights in range everywhere inside the mist band.
	least := math.MaxInt
	step := c.validator.LightGrid
	n := toInt32(c.mist/step) + 1
	for a := -n; a <= n; a++ {
		for b := -n; b <= n; b++ {
			x, y := float64(float64(a)*step), float64(float64(b)*step)
			if hypot(x, y) > c.mist || landAt(w.ground, x, y) {
				continue
			}
			k := 0
			for _, lt := range w.lights {
				if hypot(x-lt.X, y-lt.Y) <= lt.Range {
					k++
				}
			}
			least = min(least, k)
		}
	}
	add("lights everywhere", least >= c.validator.LightsInRange, fmt.Sprintf("at least %d in range", least), "at least %d in range on a %.0f m grid inside the mist band", c.validator.LightsInRange, step)

	// Every place named, none twice in the world.
	seen := map[string]bool{}
	for _, name := range w.names {
		seen[strings.ToLower(name)] = true
	}
	dup, missing2 := 0, 0
	for _, p := range w.places {
		if p.Name == "" {
			missing2++
			continue
		}
		k := strings.ToLower(p.Name)
		if seen[k] {
			dup++
		}
		seen[k] = true
	}
	add("place names", dup == 0 && missing2 == 0, fmt.Sprintf("%d unnamed, %d twice", missing2, dup), "every place named, none twice in the world")
	return rules
}

func suffix(list []string) string {
	if len(list) == 0 {
		return ""
	}
	return "; off: " + strings.Join(list, ", ")
}

// nearestLand is the distance from the disk's centre to the island's
// nearest land.
func (m *made) nearestLand() float64 {
	g := &m.grid
	best := math.Inf(1)
	for i := range g.w * g.h {
		if g.elev[i] > 0 {
			x, y := g.centre(i)
			best = min(best, hypot(x, y))
		}
	}
	return best
}

// lowestLand is the island's lowest land, m.
func (m *made) lowestLand() float64 {
	g := &m.grid
	low := math.Inf(1)
	for i := range g.w * g.h {
		if g.elev[i] > 0 {
			low = min(low, float64(float64(g.elev[i])*0.1))
		}
	}
	return low
}

// expected is how many islands of each size class the layout expects:
// the landmarks' widths are uniform over their range, the rest's areas
// follow Korčák's law.
func (c *config) expected() map[string]float64 {
	out := map[string]float64{}
	l := &c.layout
	b := l.korcak
	area := func(d float64) float64 { return float64(math.Pi*0.25) * float64(d*d) }
	a0, a1 := area(l.islandAcross[0]), area(l.islandAcross[1])
	cdf := func(d float64) float64 {
		a := clamp(area(d), a0, a1)
		return (pow(a0, -b) - pow(a, -b)) / (pow(a0, -b) - pow(a1, -b))
	}
	prev := 0.0
	for _, s := range c.sizes {
		lo, hi := prev, s.below
		prev = s.below
		k := float64(float64(l.islands) * (cdf(hi) - cdf(lo)))
		la, lb := l.landmarkAcross[0], l.landmarkAcross[1]
		if lb > la {
			k += float64(float64(l.landmarks) * clamp((min(hi, lb)-max(lo, la))/(lb-la), 0, 1))
		}
		out[s.class] = k
	}
	return out
}

// landShare is the land's share of the disk, in percent.
func (c *config) landShare(g *physics.Ground) float64 {
	land := 0
	for _, ch := range g.Chunks {
		if ch == nil {
			continue
		}
		for _, e := range ch.Elevation {
			if e > 0 {
				land++
			}
		}
	}
	disk := float64(math.Pi*c.disk) * c.disk
	return float64(100*float64(land)*hexArea) / disk
}

// largestOpen is the furthest any water inside the mist band is from land,
// on the coarse grid; but in the main port's calm water, which is open by
// design and which the layout's islets keep out of.
func (c *config) largestOpen(k *coarse) float64 {
	far := 0.0
	for a := range k.side {
		for b := range k.side {
			x := float64((float64(a)+0.5)*coarseCell) - coarseHalf
			y := float64((float64(b)+0.5)*coarseCell) - coarseHalf
			if d := hypot(x, y); d <= c.mist && d >= c.calm {
				far = max(far, k.dist[a*k.side+b])
			}
		}
	}
	return far
}

// unreachable lists the landmarks no water deep enough leads to from the
// start's first place: each is reached if any water beside its land was.
func (c *config) unreachable(w *world) []int32 {
	var out []int32
	seen := w.reach
	for _, m := range w.islands {
		if m.kind != kindLandmark {
			continue
		}
		reached := false
		for _, a := range m.approach {
			if k := a[0]*physics.HexRows + a[1]; seen != nil && seen[k>>6]&(1<<(k&63)) != 0 {
				reached = true
				break
			}
		}
		if !reached {
			out = append(out, m.number)
		}
	}
	return out
}

// flood is the hexagons water at least depth m deep leads to from the
// start's first place, a bit each, column by column: a flood over the
// lattice. nil if there is no start.
func (c *config) flood(g *physics.Ground, start Start, depth float64) []uint64 {
	if len(start.Places) == 0 {
		return nil
	}
	deep := int16(-round(float64(depth * 10)))
	seen := make([]uint64, (physics.HexColumns*physics.HexRows+63)/64)
	idx := func(c, j int32) int32 { return c*physics.HexRows + j }
	mark := func(i int32) bool {
		if seen[i>>6]&(1<<(i&63)) != 0 {
			return false
		}
		seen[i>>6] |= 1 << (i & 63)
		return true
	}
	q, r := physics.HexAt(start.Places[0][0], start.Places[0][1])
	sc, sj := physics.HexCell(q, r)
	queue := []int32{idx(sc, sj)}
	mark(queue[0])
	head := 0
	var nb [6][2]int32
	for head < len(queue) {
		i := queue[head]
		head++
		if head > 1<<20 && head*2 > len(queue) {
			queue = append(queue[:0], queue[head:]...)
			head = 0
		}
		cc, jj := i/physics.HexRows, i%physics.HexRows
		for _, n := range cellNeighbours(cc, jj, &nb) {
			if n[0] < 0 || n[1] < 0 || n[0] >= physics.HexColumns || n[1] >= physics.HexRows {
				continue
			}
			if elevationAt(g, n[0], n[1]) > deep {
				continue
			}
			if k := idx(n[0], n[1]); mark(k) {
				queue = append(queue, k)
			}
		}
	}
	return seen
}

// cellNeighbours are the column and row of the six neighbours of the
// hexagon at column c and row j.
func cellNeighbours(c, j int32, out *[6][2]int32) [][2]int32 {
	d := int32(-1)
	if c&1 == 1 {
		d = 1
	}
	*out = [6][2]int32{{c, j - 1}, {c, j + 1}, {c - 1, j}, {c - 1, j + d}, {c + 1, j}, {c + 1, j + d}}
	return out[:]
}
