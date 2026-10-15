// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"fmt"
	"math"
	"strings"

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
	width := float64(2 * sqrtArea(port.area))
	lo, hi := float64(c.port.across[0]*0.85), float64(c.port.across[1]*1.15)
	add("main port's width", width >= lo && width <= hi, fmt.Sprintf("%.0f m", width), "%.0f–%.0f m", lo, hi)
	add("main port's height", port.highest >= c.port.height[0]-0.5 && port.highest <= c.port.height[1]+0.5,
		fmt.Sprintf("%.1f m", port.highest), "%.0f–%.0f m", c.port.height[0], c.port.height[1])
	add("main port's cliffs", port.cliffs >= 1.0/3, fmt.Sprintf("%.2f of its coast", port.cliffs), "at least a third")
	off := hypot(port.x, port.y)
	centre := landAt(w.ground, 0, 0)
	add("main port at the centre", centre && off <= v.CentreOffset,
		fmt.Sprintf("centre %.0f m off, the disk's centre %s", off, map[bool]string{true: "on land", false: "in water"}[centre]),
		"within %.0f m, the disk's centre on land", v.CentreOffset)

	// The calm water: no land but the main port's within its radius.
	nearest := math.Inf(1)
	for _, m := range w.islands[1:] {
		nearest = min(nearest, m.nearestLand())
	}
	add("calm water", nearest >= c.calm, fmt.Sprintf("other land %.0f m from the centre", nearest), "none within %.0f m", c.calm)

	// The start area.
	add("start area", len(w.start.Places) == c.start.Places, fmt.Sprintf("%d places", len(w.start.Places)), "%d", c.start.Places)

	// Every landmark reachable from the start in enough water.
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
// on the coarse grid.
func (c *config) largestOpen(k *coarse) float64 {
	far := 0.0
	for a := range k.side {
		for b := range k.side {
			x := float64(float64(a)+0.5)*coarseCell - coarseHalf
			y := float64(float64(b)+0.5)*coarseCell - coarseHalf
			if hypot(x, y) <= c.mist {
				far = max(far, k.dist[a*k.side+b])
			}
		}
	}
	return far
}

// unreachable lists the landmarks no water deep enough leads to from the
// start's first place: a flood over the lattice's hexagons with that much
// water, then each landmark is reached if any water beside its land was.
func (c *config) unreachable(w *world) []int32 {
	var out []int32
	if len(w.start.Places) == 0 {
		for _, m := range w.islands {
			if m.kind == kindLandmark {
				out = append(out, m.number)
			}
		}
		return out
	}
	deep := int16(-round(float64(c.validator.ReachDepth * 10)))
	g := w.ground
	seen := make([]uint64, (physics.HexColumns*physics.HexRows+63)/64)
	idx := func(c, j int32) int32 { return c*physics.HexRows + j }
	mark := func(i int32) bool {
		if seen[i>>6]&(1<<(i&63)) != 0 {
			return false
		}
		seen[i>>6] |= 1 << (i & 63)
		return true
	}
	q, r := physics.HexAt(w.start.Places[0][0], w.start.Places[0][1])
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
	for _, m := range w.islands {
		if m.kind != kindLandmark {
			continue
		}
		reached := false
		for _, a := range m.approach {
			if k := idx(a[0], a[1]); seen[k>>6]&(1<<(k&63)) != 0 {
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
