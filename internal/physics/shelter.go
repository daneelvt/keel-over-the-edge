// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Islands shelter the wind. Behind a barrier the wind is slowed most at
// three to five of its heights downwind and recovers over about ten
// (windbreak studies: USDA NRCS; Cleugh 1998); beside a hill, and between
// islands, it is faster, by up to 1.6–2.0 h/L over a hill of height h whose
// slope falls to half height over L (Jackson and Hunt 1975, as Kaimal and
// Finnigan 1994 give it); and along a coast it turns toward the open side,
// as scatterometers see in an island's wake flanked by stronger wind
// (Chavanne and others 2002).
//
// So the wind at a place has a shelter: a factor on its speed and a turn of
// its direction, for each of ShelterDirections directions the wind may come
// from. They are worked out once, when the world is made, from the land up
// to the table's reach upwind, for cells of ShelterCell by ShelterCell
// hexagons near land, and travel with the chunks, so every reader of a chunk
// has the same bits. Between cells' centres the factor and the turn are
// bilinear, and between directions linear, so the wind has no step where
// cells meet. A cell with no table, or a chunk not held, is open water: a
// factor of 1 and no turn.

const (
	// ShelterCell is a cell's side, in hexagons: about 27.7 m by 32 m.
	ShelterCell = 8
	// ShelterColumns and ShelterRows are a chunk's cells.
	ShelterColumns = ChunkColumns / ShelterCell
	ShelterRows    = ChunkRows / ShelterCell
	ShelterCells   = ShelterColumns * ShelterRows
	// ShelterDirections is how many directions a cell's table holds, from
	// north clockwise.
	ShelterDirections = 16
	// shelterGridColumns and shelterGridRows are the whole grid's cells.
	shelterGridColumns = HexColumns / ShelterCell
	shelterGridRows    = HexRows / ShelterCell
)

// A cell's table holds, for each direction, ShelterStride bytes: the
// factor in steps of 1/ShelterFactorOne, the turn as a signed byte in steps
// of ShelterTurnStep radians, and the lee's fetch for the waves (lee.go):
// 255 less the fetch in steps of ShelterLeeStep metres, so that 0, a table
// without it, is open water.
const (
	ShelterStride    = 3
	ShelterFactorOne = 196
	ShelterTurnStep  = math.Pi / 720 // a quarter of a degree
	ShelterLeeStep   = 4             // m
	ShelterLeeOpen   = 0
	shelterLeeMost   = 254 // steps
)

// ShelterChunk is one chunk's shelter: for each cell, column by column, and
// each direction, the factor's byte, the turn's and the lee's.
type ShelterChunk struct {
	Values [ShelterCells * ShelterDirections * ShelterStride]uint8
}

// Shelter is a view of the chunks' shelter; a nil chunk is open water.
type Shelter struct {
	Chunks [ChunkCount]*ShelterChunk
}

// ShelterCellOf is the cell's chunk and its index there, from its column a
// and row b on the whole grid; ok is false off the grid.
func ShelterCellOf(a, b int32) (chunk, index int32, ok bool) {
	if a < 0 || b < 0 || a >= shelterGridColumns || b >= shelterGridRows {
		return 0, 0, false
	}
	return (b/ShelterRows)*ChunkSide + a/ShelterColumns, (a%ShelterColumns)*ShelterRows + b%ShelterRows, true
}

// ShelterCellCentre is the centre of cell (a, b): the middle of its
// columns, and of its rows with odd columns half a hexagon north.
func ShelterCellCentre(a, b int32) (x, y float64) {
	u := float64(a*ShelterCell) + (ShelterCell-1)/2.0 - columnZero
	v := float64(b*ShelterCell) + (ShelterCell-1)/2.0 - rowZero
	return float64(u * hexStep), float64(v*HexAcross) + HexAcross/4
}

// value is cell (a, b)'s factor and turn for direction k.
func (sh *Shelter) value(a, b, k int32) (factor, turn float64) {
	n, i, ok := ShelterCellOf(a, b)
	if !ok || sh.Chunks[n] == nil {
		return 1, 0
	}
	v := sh.Chunks[n].Values[(i*ShelterDirections+k)*ShelterStride:]
	return float64(v[0]) / ShelterFactorOne, float64(float64(int8(v[1])) * ShelterTurnStep)
}

// At is the shelter at (x, y) of a wind from from: its factor on the
// wind's speed and its turn, positive veering.
func (sh *Shelter) At(x, y, from float64) (factor, turn float64) {
	fa := float64(float64(float64(x/hexStep)+columnZero-(ShelterCell-1)/2.0) / ShelterCell)
	fb := float64(float64(float64((y-HexAcross/4)/HexAcross)+rowZero-(ShelterCell-1)/2.0) / ShelterCell)
	a0, b0 := math.Floor(fa), math.Floor(fb)
	ta, tb := fa-a0, fb-b0
	a, b := toInt32(a0), toInt32(b0)
	turns := float64(wrapAngle(from)*(ShelterDirections/(2*math.Pi))) + ShelterDirections
	k0 := math.Floor(turns)
	tk := turns - k0
	k := toInt32(k0) % ShelterDirections
	for i := range int32(2) {
		kk := (k + i) % ShelterDirections
		f00, t00 := sh.value(a, b, kk)
		f10, t10 := sh.value(a+1, b, kk)
		f01, t01 := sh.value(a, b+1, kk)
		f11, t11 := sh.value(a+1, b+1, kk)
		f := lerp(tb, lerp(ta, f00, f10), lerp(ta, f01, f11))
		t := lerp(tb, lerp(ta, t00, t10), lerp(ta, t01, t11))
		w := 1 - tk
		if i == 1 {
			w = tk
		}
		factor += float64(w * f)
		turn += float64(w * t)
	}
	return factor, turn
}

// ShelterPrepared holds the constants a shelter table is worked out with,
// derived from ShelterParams by PrepareShelter.
type ShelterPrepared struct {
	reach          float64 // m
	step           float64 // m
	near, far      float64 // in heights
	least, most    float64
	speedUp        float64
	flank          float64 // in heights
	turn           float64 // rad
	offsets        [4]float64
	sinDir, cosDir [ShelterDirections]float64
	farRange       float64
}

// PrepareShelter derives the shelter's constants from its parameters.
func PrepareShelter(p *ShelterParams, s *ShelterPrepared) {
	s.reach = p.Reach
	s.step = p.Step
	s.near, s.far = p.Near, p.Far
	s.least, s.most = p.Least, p.Most
	s.speedUp = p.SpeedUp
	s.flank = p.Flank
	s.turn = float64(p.Turn * degree)
	s.offsets = p.Offsets
	s.farRange = 1 / (p.Far - p.Near)
	for k := range int32(ShelterDirections) {
		s.sinDir[k], s.cosDir[k] = SinCos(float64(float64(k) * (2 * math.Pi / ShelterDirections)))
	}
}

// ShelterHeights is what a table is worked out from: the height of the
// highest land in each cell of the whole grid, m, 0 where it is all water,
// at ShelterIndex.
type ShelterHeights []float32

// ShelterIndex is cell (a, b)'s index in ShelterHeights and in a
// ShelterField.
func ShelterIndex(a, b int32) int32 { return a*shelterGridRows + b }

// ShelterGrid is the whole grid's size in cells.
func ShelterGrid() (columns, rows int32) { return shelterGridColumns, shelterGridRows }

// shelterCellAt is the cell that holds (x, y), and whether it is on the
// grid.
func shelterCellAt(x, y float64) (int32, bool) {
	q, r := HexAt(x, y)
	c, j := HexCell(q, r)
	if c < 0 || j < 0 || c >= HexColumns || j >= HexRows {
		return 0, false
	}
	return ShelterIndex(c/ShelterCell, j/ShelterCell), true
}

// ShelterField is what the land does to a wind from one direction, cell by
// cell, before it is made a factor and a turn: the lee's factor, and how
// much land on the right and on the left of the wind's path, looking
// downwind, speeds it.
type ShelterField struct {
	Lee, Right, Left []float32
}

// ShelterFieldSize is how many cells a ShelterField's slices hold: the
// whole grid's.
const ShelterFieldSize = shelterGridColumns * shelterGridRows

// ShelterDirection works out the field of a wind from direction k, from
// each cell of land outward: downwind of land of height H, at d metres in
// steps of the march out to far·H or the reach, the lee's factor is the
// least at d ≤ near·H, rising to 1 at far·H, the strongest lee counting;
// and beside that line, at each of the offsets within flank·H of it, the
// wind is sped by up to speedUp, the more the nearer the land, with the
// land on that cell's other side.
func ShelterDirection(h ShelterHeights, k int32, s *ShelterPrepared, f *ShelterField) {
	upX, upY := s.sinDir[k], s.cosDir[k]
	// Looking downwind, the right-hand side is upwind turned to its left.
	rightX, rightY := -upY, upX
	for a := range int32(shelterGridColumns) {
		for b := range int32(shelterGridRows) {
			hh := float64(h[ShelterIndex(a, b)])
			if !(hh > 0) {
				continue
			}
			lx, ly := ShelterCellCentre(a, b)
			far := min2(float64(s.far*hh), s.reach)
			flank := float64(s.flank * hh)
			for d := s.step; d <= far; d += s.step {
				px, py := lx-float64(d*upX), ly-float64(d*upY)
				if t, ok := shelterCellAt(px, py); ok {
					f.Lee[t] = float32(min2(float64(f.Lee[t]), s.leeOf(d, hh)))
				}
				fade := 1 - float64(d/float64(s.far*hh))
				for _, w := range s.offsets {
					if w > flank {
						continue
					}
					v := float32(float64(s.speedUp * float64((1-w/flank)*fade)))
					ox, oy := float64(w*rightX), float64(w*rightY)
					// The cell to the right of the line has the land on its
					// left, and the one to the left has it on its right.
					if t, ok := shelterCellAt(px+ox, py+oy); ok && v > f.Left[t] {
						f.Left[t] = v
					}
					if t, ok := shelterCellAt(px-ox, py-oy); ok && v > f.Right[t] {
						f.Right[t] = v
					}
				}
			}
		}
	}
}

// ShelterAt is cell i's factor and turn in field f: the lee times the
// strongest speed-up, between the least and the most; and a turn toward the
// side with less land, since land on the right pushes the flow left and
// backs the wind.
func ShelterAt(f *ShelterField, i int32, s *ShelterPrepared) (factor, turn float64) {
	right, left := float64(f.Right[i]), float64(f.Left[i])
	factor = clamp(float64(float64(f.Lee[i])*(1+max2(right, left))), s.least, s.most)
	turn = clamp(float64(s.turn*(left-right))/s.speedUp, -s.turn, s.turn)
	return factor, turn
}

// leeOf is the factor of the lee of land of height hh, d metres upwind.
func (s *ShelterPrepared) leeOf(d, hh float64) float64 {
	n := d / hh
	switch {
	case n <= s.near:
		return s.least
	case n >= s.far:
		return 1
	}
	return s.least + float64((1-s.least)*float64((n-s.near)*s.farRange))
}

// ShelterBytes encodes a factor and a turn as a table holds them.
func ShelterBytes(factor, turn float64) (f, t uint8) {
	fi := toInt32(math.Floor(float64(factor*ShelterFactorOne) + 0.5))
	ti := toInt32(math.Floor(turn/ShelterTurnStep + 0.5))
	return uint8(min(max(fi, 0), 255)), uint8(int8(min(max(ti, -127), 127)))
}

// ShelterLand is what the waves' lee is worked out from: the cells of land
// of the whole grid, true at ShelterIndex, and room for the work. Each
// holds ShelterFieldSize cells.
type ShelterLand struct {
	Land, Across, Near []bool
}

// at says whether cell (a, b) is land; off the grid it is not.
func (l *ShelterLand) at(a, b int32) bool {
	return a >= 0 && b >= 0 && a < shelterGridColumns && b < shelterGridRows && l.Land[ShelterIndex(a, b)]
}

// ShelterLee works out each cell's lee for the waves (lee.go) from the
// land: for each direction, how far upwind of its centre the first land
// is, at most reach m. A cell of water with land within the reach gets it,
// and so does a cell of land beside water, whose fetch is nothing, so that
// the lee falls to the shore between cells; chunk gives the table of
// chunk n to write it into, or nil to leave it. The cells inland and far
// out are left as they are, open water.
//
// Each cell's ray is walked across the cells it passes, as a grid is
// traversed by a ray (Amanatides and Woo 1987): the fetch is the distance
// to where the ray enters the first cell of land. A cell spans its columns'
// and rows' hexagons about its centre.
func ShelterLee(l *ShelterLand, reach float64, chunk func(n int32) *ShelterChunk) {
	cols, rows := ShelterGrid()
	x0, y0 := ShelterCellCentre(0, 0)
	x1, y1 := ShelterCellCentre(1, 1)
	width, height := x1-x0, y1-y0
	// near says a cell has land within the reach: the land spread across
	// a square of the reach's cells each way, along rows and then along
	// columns.
	spanA, spanB := toInt32(math.Ceil(reach/width)), toInt32(math.Ceil(reach/height))
	spreadCells(l.Land, l.Across, cols, rows, spanA, false)
	spreadCells(l.Across, l.Near, rows, cols, spanB, true)
	var sinDir, cosDir [ShelterDirections]float64
	for k := range int32(ShelterDirections) {
		sinDir[k], cosDir[k] = SinCos(float64(float64(k) * (2 * math.Pi / ShelterDirections)))
	}
	neighbours := [8][2]int32{{-1, -1}, {0, -1}, {1, -1}, {-1, 0}, {1, 0}, {-1, 1}, {0, 1}, {1, 1}}
	var lee [ShelterDirections]uint8
	for a := range cols {
		for b := range rows {
			if !l.Near[ShelterIndex(a, b)] {
				continue
			}
			open := true
			if l.at(a, b) {
				shore := false
				for _, d := range neighbours {
					shore = shore || !l.at(a+d[0], b+d[1])
				}
				if !shore {
					continue
				}
				for k := range lee {
					lee[k] = LeeByte(0)
				}
				open = false
			} else {
				for k := range ShelterDirections {
					lee[k] = ShelterLeeOpen
					if d, ok := l.ray(a, b, sinDir[k], cosDir[k], width, height, reach); ok {
						lee[k] = LeeByte(d)
						open = open && lee[k] == ShelterLeeOpen
					}
				}
			}
			n, i, ok := ShelterCellOf(a, b)
			if open || !ok {
				continue
			}
			ch := chunk(n)
			if ch == nil {
				continue
			}
			for k := range int32(ShelterDirections) {
				ch.Values[(i*ShelterDirections+k)*ShelterStride+2] = lee[k]
			}
		}
	}
}

// spreadCells sets out to set spread by up to span cells each way along
// its first coordinate, us of them, for each of the vs of its second: the
// grid's columns and rows, or with swap its rows and columns.
func spreadCells(set, out []bool, us, vs, span int32, swap bool) {
	for v := range vs {
		last := int32(-1 << 30)
		for u := range us {
			if set[cellIndex(u, v, swap)] {
				last = u
			}
			out[cellIndex(u, v, swap)] = u-last <= span
		}
		last = 1 << 30
		for u := us - 1; u >= 0; u-- {
			if set[cellIndex(u, v, swap)] {
				last = u
			}
			out[cellIndex(u, v, swap)] = out[cellIndex(u, v, swap)] || last-u <= span
		}
	}
}

// cellIndex is ShelterIndex(u, v), or with swap ShelterIndex(v, u).
func cellIndex(u, v int32, swap bool) int32 {
	if swap {
		return ShelterIndex(v, u)
	}
	return ShelterIndex(u, v)
}

// ray is how far from the centre of cell (a, b), toward the direction
// whose sine and cosine are sin and cos, the ray enters the first cell of
// land, if one is within reach: across cells width by height m.
func (l *ShelterLand) ray(a, b int32, sin, cos, width, height, reach float64) (float64, bool) {
	stepA, stepB := int32(1), int32(1)
	nextA, nextB := math.Inf(1), math.Inf(1)
	deltaA, deltaB := math.Inf(1), math.Inf(1)
	if sin < 0 {
		stepA = -1
	}
	if cos < 0 {
		stepB = -1
	}
	// A direction along a column or a row has a part across it of a
	// rounding's size: it never crosses into the next.
	if s := math.Abs(sin); s > 1e-9 {
		deltaA = width / s
		nextA = float64(0.5 * deltaA)
	}
	if c := math.Abs(cos); c > 1e-9 {
		deltaB = height / c
		nextB = float64(0.5 * deltaB)
	}
	for {
		d := nextA
		if nextB < nextA {
			d = nextB
			b += stepB
			nextB += deltaB
		} else {
			a += stepA
			nextA += deltaA
		}
		if d > reach {
			return 0, false
		}
		if l.at(a, b) {
			return d, true
		}
	}
}
