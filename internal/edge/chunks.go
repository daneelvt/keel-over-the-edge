// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"math"
	"math/bits"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// A connection is handed the address of a chunk of the land only once its
// boat could see something in it: the chart stays blank until it is sailed,
// and an address is the only way to the chunk. The server cannot know where
// the camera is, only how high it can go, so a chunk is handed when
//
//   - its outline is within Near of the boat: the ground under the hull and
//     the shelter about it, and the near sea's tiles, with room to spare;
//   - or one of its cells holds land H high within the dome's sight of it
//     from the highest the camera goes, √(2 R h) + √(2 R H), plus Margin:
//     land that high shows over the horizon from there;
//   - or one of its cells holds sea bed shallower than Shallows within the
//     far sea's reach from there, plus Margin: shallows show through it.
//
// Cells are the shelter's, 8 by 8 hexagons, each with its highest land and
// shallowest bed found once, when the handout is made. A connection is
// handed each chunk once, nearest first, when it joins and whenever its boat
// has moved Look since it was last looked at. A chunk is about a kilometre
// square, so whoever holds it holds all of it: a modified client may know of
// land a few hundred metres, and at most a kilometre and a half, before an
// honest player could see it, and never further.

// HandoutRule is how far a boat sees the land, in metres.
type HandoutRule struct {
	Near    float64 // a chunk whose outline is within this is handed
	Camera  float64 // the highest the camera goes above the sea
	Dome    float64 // the dome's radius
	FarSea  float64 // how far the far sea reaches from the camera at Camera
	Margin  float64 // added to every reach
	Shallow float64 // sea bed shallower than this is seen
	Look    float64 // the boat is looked at again once it has moved this far
}

// handCell is a cell of a chunk the boat can see from afar: its centre, and
// the square of the furthest it is seen from.
type handCell struct {
	x, y, reach2 float64
}

// handChunk is what the rule knows of a chunk: its outline's bounds, the
// furthest any of its cells is seen from, and those cells.
type handChunk struct {
	minX, maxX, minY, maxY float64
	reach                  float64
	cells                  []handCell
}

// Handout hands out a world's chunks by the rule: made once from the world's
// ground and the chunks' addresses, then only read, by every encoder. With
// each chunk go the places in it, and as the eye moves, the lights in range.
type Handout struct {
	rule   HandoutRule
	paths  []string
	chunks [physics.ChunkCount]handChunk
	places [physics.ChunkCount][]*pb.Place
	lights *Lights
}

// NewHandout makes the handout of the world whose ground is g, its chunks at
// the addresses paths names by number.
func NewHandout(g *physics.Ground, paths []string, rule HandoutRule) *Handout {
	h := &Handout{rule: rule, paths: paths}
	sight := math.Sqrt(2 * rule.Dome * rule.Camera)
	shallows := rule.FarSea + rule.Margin
	shallow := int16(math.Floor(rule.Shallow*10 + 0.5)) // dm
	for n := range int32(physics.ChunkCount) {
		hc := &h.chunks[n]
		c0, j0 := physics.ChunkCorner(n)
		x0, _ := physics.CellCentre(c0, j0)
		x1, _ := physics.CellCentre(c0+physics.ChunkColumns-1, j0)
		_, ya := physics.CellCentre(c0, j0)
		_, yb := physics.CellCentre(c0+1, j0)
		_, yc := physics.CellCentre(c0, j0+physics.ChunkRows-1)
		_, yd := physics.CellCentre(c0+1, j0+physics.ChunkRows-1)
		hc.minX, hc.maxX = x0-hexRadius, x1+hexRadius
		hc.minY, hc.maxY = min(ya, yb)-physics.HexAcross/2, max(yc, yd)+physics.HexAcross/2
		ch := g.Chunks[n]
		if ch == nil {
			continue
		}
		// Each cell's highest land and shallowest bed, in decimetres.
		var high [physics.ShelterCells]int16
		var low [physics.ShelterCells]int16
		for i := range low {
			low[i] = math.MaxInt16
		}
		for i := range int32(physics.ChunkHexes) {
			c, j := i/physics.ChunkRows, i%physics.ChunkRows
			k := (c/physics.ShelterCell)*physics.ShelterRows + j/physics.ShelterCell
			e := ch.Elevation[i]
			high[k] = max(high[k], e)
			if e <= 0 {
				low[k] = min(low[k], -e)
			}
		}
		a0, b0 := c0/physics.ShelterCell, j0/physics.ShelterCell
		for k := range int32(physics.ShelterCells) {
			reach := -1.0
			if high[k] > 0 {
				reach = sight + math.Sqrt(2*rule.Dome*float64(high[k])*0.1) + rule.Margin
			}
			if low[k] < shallow {
				reach = max(reach, shallows)
			}
			if reach < 0 {
				continue
			}
			x, y := physics.ShelterCellCentre(a0+k/physics.ShelterRows, b0+k%physics.ShelterRows)
			hc.cells = append(hc.cells, handCell{x: x, y: y, reach2: reach * reach})
			hc.reach = max(hc.reach, reach)
		}
	}
	return h
}

// Top is a building's top: where it stands and how high, m above the sea.
type Top struct{ X, Y, Height float64 }

// WithTops counts buildings' tops in their cells' heights: a chunk is
// handed once a tower in it stands over the horizon from the boat, as land
// as high would be. It returns h.
func (h *Handout) WithTops(tops []Top) *Handout {
	sight := math.Sqrt(2 * h.rule.Dome * h.rule.Camera)
	for _, t := range tops {
		c, j := physics.HexCell(physics.HexAt(t.X, t.Y))
		n, _, ok := physics.ChunkOf(c, j)
		if !ok || t.Height <= 0 {
			continue
		}
		reach := sight + math.Sqrt(2*h.rule.Dome*t.Height) + h.rule.Margin
		hc := &h.chunks[n]
		x, y := physics.ShelterCellCentre(c/physics.ShelterCell, j/physics.ShelterCell)
		hc.cells = append(hc.cells, handCell{x: x, y: y, reach2: reach * reach})
		hc.reach = max(hc.reach, reach)
	}
	return h
}

// hexRadius is a hexagon's centre to a corner, m.
const hexRadius = physics.HexAcross / 1.7320508075688772

// outline is how far (x, y) is from chunk n's outline, 0 inside it.
func (h *Handout) outline(n int, x, y float64) float64 {
	c := &h.chunks[n]
	dx := max(c.minX-x, 0, x-c.maxX)
	dy := max(c.minY-y, 0, y-c.maxY)
	return math.Hypot(dx, dy)
}

// sees reports whether a boat at (x, y) could see something in chunk n.
func (h *Handout) sees(n int, x, y float64) bool {
	d := h.outline(n, x, y)
	if d <= h.rule.Near {
		return true
	}
	c := &h.chunks[n]
	if d > c.reach {
		return false
	}
	for _, cell := range c.cells {
		dx, dy := cell.x-x, cell.y-y
		if dx*dx+dy*dy <= cell.reach2 {
			return true
		}
	}
	return false
}

// connChunks is what a connection has been handed: a bitmap of the
// chunks, and where its boat was when last looked at.
type connChunks struct {
	handed  [physics.ChunkCount / 64]uint64
	looked  bool
	x, y    float64
	pending [physics.ChunkCount]uint16 // scratch: the chunks to hand, by number
	dist    [physics.ChunkCount]float64
}

// chunks hands the connection the chunks h says its eye at (x, y) could
// see that it has not been handed, with the places in them, and the lights
// in range, if its eye has moved far enough since it was last looked at, or
// never was. It reports whether the connection is still good. Looking, and
// finding nothing new, allocates nothing.
func (c *conn) chunks(h *Handout, x, y float64) bool {
	if h == nil {
		return true
	}
	st := &c.handout
	if st.looked && math.Hypot(x-st.x, y-st.y) < h.rule.Look {
		return true
	}
	st.looked, st.x, st.y = true, x, y
	if !c.lights(h.lights, x, y) {
		return false
	}
	n := 0
	for k := range physics.ChunkCount {
		if st.handed[k/64]&(1<<(k%64)) != 0 || !h.sees(k, x, y) {
			continue
		}
		// Nearest first: insertion by the outline's distance.
		d := h.outline(k, x, y)
		i := n
		for ; i > 0 && st.dist[i-1] > d; i-- {
			st.pending[i], st.dist[i] = st.pending[i-1], st.dist[i-1]
		}
		st.pending[i], st.dist[i] = uint16(k), d
		n++
	}
	if n == 0 {
		return true
	}
	m := &pb.Chunks{Number: make([]uint32, n), Path: make([]string, n)}
	var places []*pb.Place
	for i, k := range st.pending[:n] {
		st.handed[k/64] |= 1 << (k % 64)
		m.Number[i], m.Path[i] = uint32(k), h.paths[k]
		places = append(places, h.places[k]...)
	}
	c.e.m.chunksHanded.Add(float64(n))
	if !c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Chunks{Chunks: m}}, outChunks) {
		return false
	}
	return len(places) == 0 || c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Places{Places: &pb.Places{Places: places}}}, outPlaces)
}

// handedCount is how many chunks the connection has been handed.
func (st *connChunks) handedCount() int {
	n := 0
	for _, w := range st.handed {
		n += bits.OnesCount64(w)
	}
	return n
}
