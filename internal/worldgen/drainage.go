// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// An island's water. Its land is drained by Priority-Flood (Barnes, Lehman
// and Mulla, Computers & Geosciences 62, 2014): flooded inward from the
// coast, lowest first, each hexagon draining to the one it was reached
// from, so that a pit does not stop the flow but fills to its rim and
// spills where the flood came in. A hexagon's catchment is its own area
// and its donors'. A stream runs where the land drained to one hexagon of
// the coast passes its biome's stream, from its spring, where its
// catchment first passed the spring's, Smyth's aguada, "a
// watering-place"; and where it reaches a coast high enough it falls.
// Today's cliffs stand on stretches of coast drawn apart from the
// drainage, so a stream nearly always meets the sea on a beach; on an
// island given a waterfall the coast at its mouth is raised into a cliff
// and the stream's last stretch kept level: a hanging valley, left where
// the cliff retreats faster than the stream can cut down (Leyland and
// Darby, Geomorphology, 2008), which needs "a drainage basin large enough
// for steady flow but not so large that it out-competes sea-cliff
// formation" (USGS, coastal knickpoints, 2018), and so is rare.

// drainage is an island's drainage on its grid.
type drainage struct {
	to    []int32   // each land hexagon's receiver; -1 on the coast, which drains to the sea
	sea   []int32   // a coastal hexagon's water, which it drains into
	order []int32   // the land in the order the flood reached it, from the coast
	area  []float64 // each land hexagon's catchment, m²
}

// floodItem is a hexagon on the flood's front: its level, and the order
// it came in, which settles a tie the same way every time.
type floodItem struct {
	level float64
	seq   int32
	i     int32
}

// floodHeap is the flood's front, lowest first.
type floodHeap []floodItem

func (h floodHeap) less(a, b int) bool {
	if h[a].level != h[b].level {
		return h[a].level < h[b].level
	}
	return h[a].seq < h[b].seq
}

func (h *floodHeap) push(it floodItem) {
	*h = append(*h, it)
	k := len(*h) - 1
	for k > 0 {
		p := (k - 1) / 2
		if !h.less(k, p) {
			break
		}
		(*h)[k], (*h)[p] = (*h)[p], (*h)[k]
		k = p
	}
}

func (h *floodHeap) pop() floodItem {
	old := *h
	top := old[0]
	n := len(old) - 1
	old[0] = old[n]
	*h = old[:n]
	k := 0
	for {
		l, r := 2*k+1, 2*k+2
		m := k
		if l < n && h.less(l, m) {
			m = l
		}
		if r < n && h.less(r, m) {
			m = r
		}
		if m == k {
			break
		}
		(*h)[k], (*h)[m] = (*h)[m], (*h)[k]
		k = m
	}
	return top
}

// drain works out island m's drainage from its heights as they stand.
func (m *made) drain(w *work) *drainage {
	g := &m.grid
	total := g.w * g.h
	d := &drainage{to: make([]int32, total), sea: make([]int32, total), area: make([]float64, total)}
	level := make([]float64, total)
	seen := make([]bool, total)
	var front floodHeap
	var seq int32
	var nb [6]int32
	// The coast: land beside water, each draining into its deepest water.
	for i := range total {
		d.to[i], d.sea[i] = -1, -1
		if !w.land[i] {
			continue
		}
		k := g.neighbours(i, &nb)
		best := int32(-1)
		for _, j := range nb[:k] {
			if !w.land[j] && (best < 0 || w.height[j] < w.height[best]) {
				best = j
			}
		}
		if best >= 0 {
			d.sea[i] = best
			seen[i] = true
			level[i] = w.height[i]
			front.push(floodItem{level: level[i], seq: seq, i: i})
			seq++
		}
	}
	for len(front) > 0 {
		it := front.pop()
		d.order = append(d.order, it.i)
		k := g.neighbours(it.i, &nb)
		for _, j := range nb[:k] {
			if !w.land[j] || seen[j] {
				continue
			}
			seen[j] = true
			d.to[j] = it.i
			level[j] = max(w.height[j], level[it.i])
			front.push(floodItem{level: level[j], seq: seq, i: j})
			seq++
		}
	}
	for _, i := range d.order {
		d.area[i] = hexArea
	}
	for k := len(d.order) - 1; k >= 0; k-- {
		if i := d.order[k]; d.to[i] >= 0 {
			d.area[d.to[i]] += d.area[i]
		}
	}
	return d
}

// fallBanks is how high over its lip a fall is seen, m: over its
// valley's banks.
const fallBanks = 4

// streamWork is a stream on its island's grid.
type streamWork struct {
	cells     []int32 // from its spring to its mouth
	catchment float64 // at its mouth, m²
}

// mouth is the stream's last hexagon of land, on the coast.
func (st *streamWork) mouth() int32 { return st.cells[len(st.cells)-1] }

// streams are the island's streams: from every hexagon of its coast that
// drains at least least m², up the largest of its donors to where they
// drain less than spring, the largest first.
func (d *drainage) streams(g *islandGrid, least, spring float64) []streamWork {
	total := g.w * g.h
	// Each hexagon's donors, as a list per receiver.
	first := make([]int32, total)
	next := make([]int32, total)
	for i := range first {
		first[i], next[i] = -1, -1
	}
	for _, i := range d.order {
		if r := d.to[i]; r >= 0 {
			next[i] = first[r]
			first[r] = i
		}
	}
	var mouths []int32
	for _, i := range d.order {
		if d.to[i] < 0 && d.area[i] >= least {
			mouths = append(mouths, i)
		}
	}
	slices.SortStableFunc(mouths, func(a, b int32) int { return cmpDesc(d.area[a], d.area[b]) })
	var out []streamWork
	for _, mouth := range mouths {
		path := []int32{mouth}
		at := mouth
		for {
			best := int32(-1)
			for j := first[at]; j >= 0; j = next[j] {
				if best < 0 || d.area[j] > d.area[best] || d.area[j] == d.area[best] && j < best {
					best = j
				}
			}
			if best < 0 || d.area[best] < spring {
				break
			}
			path = append(path, best)
			at = best
		}
		slices.Reverse(path)
		out = append(out, streamWork{cells: path, catchment: d.area[mouth]})
	}
	return out
}

// streamsOf makes island m's streams, springs and waterfalls: a spring at
// every stream's head, a fall where one reaches a coast high enough, and
// on an island the waterfall's chance gives one whose streams all reach
// beaches, a hanging valley at the largest it can be raised for.
func (c *config) streamsOf(s stream, m *made, b *biome, w *work, z int32) {
	fk := c.features.kind(catalog.FeatureSiteWaterfall, m.biome)
	sk := c.features.kind(catalog.FeatureSiteSpring, m.biome)
	if fk < 0 && sk < 0 {
		return
	}
	cs := &c.features.streams
	d := m.drain(w)
	sts := d.streams(&m.grid, b.stream, cs.Spring)
	if len(sts) == 0 {
		return
	}
	falls := func() bool {
		for i := range sts {
			if w.height[sts[i].mouth()] >= cs.Fall {
				return true
			}
		}
		return false
	}
	if fk >= 0 && !falls() && s.chanceOf(&c.features.kinds[fk], z) {
		for i := range sts {
			if c.hangingValley(s, m, b, w, &sts[i]) {
				d = m.drain(w)
				sts = d.streams(&m.grid, b.stream, cs.Spring)
				break
			}
		}
	}
	look := &c.features.look
	for i := range sts {
		st := &sts[i]
		m.streams = append(m.streams, st.cells)
		if sk >= 0 {
			head := st.cells[0]
			m.addFeature(sk, head, 0, 0, max(w.height[head], 0)).catchment = round1(d.area[head])
		}
		mouth := st.mouth()
		lip := w.height[mouth]
		if fk < 0 || lip < cs.Fall {
			continue
		}
		// The fall faces its water; its width grows with what it drains,
		// from its biome's least stream to ten times it.
		mx, my := m.grid.centre(mouth)
		sx, sy := m.grid.centre(d.sea[mouth])
		heading := headingTo(mx, my, sx, sy)
		t := clamp(float64(st.catchment-b.stream)/float64(9*b.stream), 0, 1)
		width := lerp(float64(t*(2-t)), look.Fall[0], look.Fall[1])
		f := m.addFeature(fk, mouth, heading, width, lip)
		f.catchment = round1(st.catchment)
		// It is seen over the valley's banks beside its lip.
		f.seen = lip + fallBanks
		sa, ca := sincos(heading)
		f.parts = append(f.parts, Part{
			X: mx + float64(sa*(physics.HexAcross/2)), Y: my + float64(ca*(physics.HexAcross/2)),
			Level: lip, Heading: heading, Size: width, Count: uint16(min(round(st.catchment/100), 65535)),
		})
	}
}

// hangingValley raises the coast at stream st's mouth into a cliff of the
// island's cliffs' height, for a stretch either side, and its last stretch
// up to where it already runs that high, rising gently, with its banks
// above it: the stream then leaves the land over the cliff's lip. It
// reports whether it could: the stream must reach the cliff's height
// within the reach.
func (c *config) hangingValley(s stream, m *made, b *biome, w *work, st *streamWork) bool {
	cs := &c.features.streams
	g := &m.grid
	mouth := st.mouth()
	mx, my := g.centre(mouth)
	// The lip at the island's cliffs' height, no higher than the stream
	// climbs within the reach, and high enough to fall.
	climbs := 0.0
	for n := len(st.cells) - 1; n >= 0; n-- {
		x, y := g.centre(st.cells[n])
		if hypot(x-mx, y-my) > cs.Reach {
			break
		}
		climbs = max(climbs, w.height[st.cells[n]])
	}
	lip := min(max(s.in(b.cliffHeight[0], b.cliffHeight[1]), cs.Fall+1), climbs)
	if lip < cs.Fall+1 {
		return false
	}
	// The stretch from the mouth up to where the stream runs as high.
	k := -1
	for n := len(st.cells) - 1; n >= 0; n-- {
		if w.height[st.cells[n]] >= lip {
			k = n
			break
		}
	}
	if k < 0 || k == len(st.cells)-1 {
		return false
	}
	stretch := st.cells[k:]
	top := w.height[stretch[0]]
	bed := make(map[int32]float64, len(stretch))
	last := len(stretch) - 1
	for n, i := range stretch {
		// From the lip at the mouth up to the stream's own height at the
		// stretch's head.
		t := float64(last-n) / float64(last)
		bed[i] = lerp(t, lip, top)
	}
	half := s.in(cs.Valley[0], cs.Valley[1])
	const blend = 20.0 // m over which the raise fades into the land beside it
	// The hexagons near the stretch, and the nearest of its own to each.
	within := map[int32]int32{}
	for _, at := range stretch {
		for _, i := range m.near(at, half+blend, func(i int32) bool { return w.land[i] }) {
			if o, ok := within[i]; !ok || m.apart(i, at) < m.apart(i, o) {
				within[i] = at
			}
		}
	}
	var cells []int32
	done := map[int32]bool{}
	for _, at := range stretch {
		for _, i := range m.near(at, half+blend, func(i int32) bool { return w.land[i] }) {
			if within[i] == at && !done[i] {
				done[i] = true
				cells = append(cells, i)
			}
		}
	}
	for _, i := range cells {
		near := within[i]
		dd := m.apart(i, near)
		floor := bed[near]
		want := floor
		if dd > 0 {
			// The valley's sides rise from its bed.
			want = floor + min(0.8+float64(0.1*dd), 5)
		}
		if dd > half {
			want = lerp(smoothstep(half, half+blend, dd), want, w.height[i])
		}
		if want > w.height[i] {
			w.height[i] = min(want, c.land[1])
		}
		// The coast along it is cliff.
		if dd <= half && w.din[i] < physics.HexAcross*1.5 {
			w.cliff[i] = true
		}
	}
	return true
}
