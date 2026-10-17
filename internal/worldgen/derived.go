// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// What follows from the terrain: each sea area's fetch, the land's shelter
// for the wind, and where boats start.

// fetchOf works out every sea area's fetch for a wind from each of the 16
// directions: the Shore Protection Manual's effective fetch, the mean of
// radials a few degrees apart about the wind's direction, each run upwind
// from the area's centre to the first land (Rohweder and others 2012),
// never past the cap; only land ends a radial, not the rim. A radial that
// starts on land is measured from where it first reaches water. Over open
// water a radial strides as far as the coarse grid says no land can be.
func (c *config) fetchOf(g *physics.Ground, k *coarse) []physics.Fetch {
	out := make([]physics.Fetch, physics.SeaAreas*physics.SeaAreas)
	n := c.fetch.radials
	for r := range int32(physics.SeaAreas) {
		for col := range int32(physics.SeaAreas) {
			x, y := physics.SeaAreaCentre(col, r)
			f := &out[r*physics.SeaAreas+col]
			for d := range int32(physics.FetchDirections) {
				var sum float64
				for i := range n {
					a := float64(float64(d)*(2*math.Pi/physics.FetchDirections)) +
						float64(float64(float64(i)-float64(float64(n-1)/2))*c.fetch.spread)
					sum += c.radial(g, k, x, y, a)
				}
				f[d] = math.Floor(sum/float64(n) + 0.5)
			}
		}
	}
	return out
}

// radial is how far upwind of (x, y), toward direction a, the first land
// is, at most the cap.
func (c *config) radial(g *physics.Ground, k *coarse, x, y, a float64) float64 {
	return c.radialTo(g, k, x, y, a, c.fetch.cap)
}

// radialTo is how far from (x, y), toward direction a, the first land is,
// at most most m.
func (c *config) radialTo(g *physics.Ground, k *coarse, x, y, a, most float64) float64 {
	sa, ca := sincos(a)
	step := c.fetch.step
	start, wet := 0.0, false
	for d := 0.0; d < start+most; {
		px, py := x+float64(d*sa), y+float64(d*ca)
		if wet {
			if skip := k.clearance(px, py); skip > step {
				d += skip
				continue
			}
		}
		if landAt(g, px, py) {
			if wet {
				return d - start
			}
		} else if !wet {
			wet, start = true, d
		}
		d += step
	}
	return most
}

// shelterHeights is the highest land in each cell of the shelter's grid.
func shelterHeights(g *physics.Ground) physics.ShelterHeights {
	h := make(physics.ShelterHeights, physics.ShelterFieldSize)
	for n := range int32(physics.ChunkCount) {
		ch := g.Chunks[n]
		if ch == nil {
			continue
		}
		c0, j0 := physics.ChunkCorner(n)
		for i := range int32(physics.ChunkHexes) {
			e := ch.Elevation[i]
			if e <= 0 {
				continue
			}
			c, j := c0+i/physics.ChunkRows, j0+i%physics.ChunkRows
			s := physics.ShelterIndex(c/physics.ShelterCell, j/physics.ShelterCell)
			h[s] = max(h[s], float32(float64(e)*0.1))
		}
	}
	return h
}

// shelterOf works out the land's shelter for each of the directions and
// writes it into each chunk's table: a cell gets a table if the land does
// anything to the wind there from any direction.
func (c *config) shelterOf(g *physics.Ground) *physics.Shelter {
	h := shelterHeights(g)
	field := physics.ShelterField{
		Lee:   make([]float32, physics.ShelterFieldSize),
		Right: make([]float32, physics.ShelterFieldSize),
		Left:  make([]float32, physics.ShelterFieldSize),
	}
	sh := new(physics.Shelter)
	cols, rows := physics.ShelterGrid()
	for k := range int32(physics.ShelterDirections) {
		for i := range field.Lee {
			field.Lee[i], field.Right[i], field.Left[i] = 1, 0, 0
		}
		physics.ShelterDirection(h, k, &c.shelter, &field)
		for a := range cols {
			for b := range rows {
				i := physics.ShelterIndex(a, b)
				factor, turn := physics.ShelterAt(&field, i, &c.shelter)
				fb, tb := physics.ShelterBytes(factor, turn)
				n, ci, ok := physics.ShelterCellOf(a, b)
				if !ok || fb == physics.ShelterFactorOne && tb == 0 {
					continue
				}
				if sh.Chunks[n] == nil {
					sh.Chunks[n] = newShelterChunk()
				}
				v := sh.Chunks[n].Values[(ci*physics.ShelterDirections+k)*2:]
				v[0], v[1] = fb, tb
			}
		}
	}
	return sh
}

// newShelterChunk is a chunk's shelter with every cell open water.
func newShelterChunk() *physics.ShelterChunk {
	ch := new(physics.ShelterChunk)
	for i := 0; i < len(ch.Values); i += 2 {
		ch.Values[i] = physics.ShelterFactorOne
	}
	return ch
}

// shelterHas reports whether cell i of a chunk's shelter is anything but
// open water.
func shelterHas(ch *physics.ShelterChunk, i int32) bool {
	v := ch.Values[i*physics.ShelterDirections*2 : (i+1)*physics.ShelterDirections*2]
	for k := 0; k < len(v); k += 2 {
		if v[k] != physics.ShelterFactorOne || v[k+1] != 0 {
			return true
		}
	}
	return false
}

// Start is where boats start: their places, in order, and the heading they
// face: the moorings in Port Royal's basin first, each facing the narrows,
// then the roads outside, facing Heading.
type Start struct {
	Heading float64      `json:"heading"`
	Places  [][2]float64 `json:"places"`
	// Out is the direction the start area lies in from the main port's
	// centre, rad clockwise from north.
	Out float64 `json:"out"`
	// Moorings is how many of the first places are moorings, and Headings
	// the heading each of them faces.
	Moorings int       `json:"moorings,omitempty"`
	Headings []float64 `json:"headings,omitempty"`
}

// HeadingOf is the heading place i faces.
func (s *Start) HeadingOf(i int) float64 {
	if i < len(s.Headings) {
		return s.Headings[i]
	}
	return s.Heading
}

// withMoorings puts the moorings before the roads' places: in rows across
// Port Royal's basin, spacing apart, clear of land, quays and piers and
// outside the turning circle, nearest the narrows first, each facing the
// narrows' inner end, so that a beginner's first course is out to sea;
// then the roads, to as many places as the start had.
func (c *config) withMoorings(g *physics.Ground, port *made, roads Start) Start {
	h := port.harbour
	if h == nil {
		return roads
	}
	mo := &c.moorings
	type mooring struct {
		x, y  float64
		along float64
		side  float64
	}
	var ms []mooring
	ex, ey := h.x+float64(h.edge*h.sin), h.y+float64(h.edge*h.cos)
	n := toInt32(float64(2*h.radius)/mo.Spacing) + 2
	for a := -n; a <= n; a++ {
		for b := -n; b <= n; b++ {
			// Rows across the basin, every other one staggered by half a
			// place, so that each boat is spacing from its neighbours.
			along := float64(float64(a) * float64(mo.Spacing*0.8660254037844386))
			side := float64(float64(b) * mo.Spacing)
			if a&1 == 1 {
				side += float64(mo.Spacing / 2)
			}
			x := h.x + float64(along*h.sin) + float64(side*h.cos)
			y := h.y + float64(along*h.cos) - float64(side*h.sin)
			if !h.inBasin(x, y) || hypot(x-h.x, y-h.y) < h.turning {
				continue
			}
			if e, _ := g.At(x, y); e > -c.start.Depth || c.landNear(g, x, y, mo.Clear) {
				continue
			}
			ms = append(ms, mooring{x, y, along, math.Abs(side)})
		}
	}
	slices.SortStableFunc(ms, func(p, q mooring) int {
		if p.along != q.along {
			return cmpDesc(p.along, q.along)
		}
		return cmpAsc(p.side, q.side)
	})
	out := Start{Heading: roads.Heading, Out: roads.Out, Moorings: len(ms)}
	total := len(roads.Places)
	for _, m := range ms {
		if len(out.Places) == total {
			break
		}
		out.Places = append(out.Places, [2]float64{m.x, m.y})
		heading := physics.Atan2(ex-m.x, ey-m.y)
		if heading >= math.Pi {
			heading -= 2 * math.Pi
		}
		out.Headings = append(out.Headings, heading)
	}
	out.Moorings = len(out.Places)
	for _, p := range roads.Places {
		if len(out.Places) == total {
			break
		}
		out.Places = append(out.Places, p)
	}
	return out
}

// startOf finds the start area: of the stretches of water off the main
// port's coast, in each of 16 directions from its centre, the one where the
// spawn grid's rows, laid along the coast from the first water deep and
// clear enough within reach of the coast, hold all the places in the
// fewest rows, the deepest on a tie. A place is used only with enough
// water and no land near it.
func (c *config) startOf(g *physics.Ground, port *made) Start {
	st := &c.start
	var best Start
	bestRows, bestDepth := math.MaxInt32, 0.0
	maxRows := int32(max(3*st.Places/max(st.Row, 1), 1))
	for d := range int32(16) {
		out := float64(float64(d) * (2 * math.Pi / 16))
		so, co := sincos(out)
		// From the centre out to the coast, then to the first place
		// that will do, within reach of the coast.
		coast := -1.0
		origin := -1.0
		for r := 0.0; r < float64(2.5*port.radius)+st.Within; r += physics.HexAcross / 2 {
			px, py := port.x+float64(r*so), port.y+float64(r*co)
			if coast < 0 {
				if !landAt(g, px, py) && !c.landNear(g, px, py, physics.HexAcross) {
					coast = r
				}
				continue
			}
			if r-coast > st.Within {
				break
			}
			if c.placeFits(g, px, py) {
				origin = r
				break
			}
		}
		if origin < 0 {
			continue
		}
		// Rows along the coast: across the outward direction.
		ax, ay := co, -so
		places := make([][2]float64, 0, st.Places)
		var depth float64
		rows := int32(0)
		for ; rows < maxRows && len(places) < st.Places; rows++ {
			r := origin + float64(float64(rows)*st.Spacing)
			cx, cy := port.x+float64(r*so), port.y+float64(r*co)
			for col := range st.Row {
				off := float64((float64(col) - float64(float64(st.Row-1)/2)) * st.Spacing)
				px, py := cx+float64(off*ax), cy+float64(off*ay)
				if len(places) == st.Places || !c.placeFits(g, px, py) {
					continue
				}
				places = append(places, [2]float64{px, py})
				e, _ := g.At(px, py)
				depth -= e
			}
		}
		if len(places) == 0 {
			continue
		}
		depth /= float64(len(places))
		full := int(rows)
		if len(places) < st.Places {
			full = math.MaxInt32 - st.Places + len(places)
		}
		if full < bestRows || full == bestRows && depth > bestDepth {
			bestRows, bestDepth = full, depth
			// A state's heading is in [−π, π).
			heading := out + math.Pi/2
			if heading >= math.Pi {
				heading -= 2 * math.Pi
			}
			best = Start{Heading: heading, Places: places, Out: out}
		}
	}
	return best
}

// placeFits reports whether a boat may start at (x, y): water deep enough
// and no land within the clearance.
func (c *config) placeFits(g *physics.Ground, x, y float64) bool {
	e, _ := g.At(x, y)
	if e > -c.start.Depth {
		return false
	}
	return !c.landNear(g, x, y, c.start.Clear)
}

// landNear reports whether any hexagon whose centre is within r of (x, y)
// is land.
func (c *config) landNear(g *physics.Ground, x, y, r float64) bool {
	q0, r0 := physics.HexAt(x, y)
	rings := toInt32(math.Ceil((r+physics.HexAcross)/(0.866*physics.HexAcross))) + 1
	for dq := -rings; dq <= rings; dq++ {
		for dr := max(-rings, -dq-rings); dr <= min(rings, -dq+rings); dr++ {
			hx, hy := physics.HexCentre(q0+dq, r0+dr)
			if hypot(hx-x, hy-y) > r+physics.HexAcross/2 {
				continue
			}
			cc, jj := physics.HexCell(q0+dq, r0+dr)
			if elevationAt(g, cc, jj) > 0 {
				return true
			}
		}
	}
	return false
}
