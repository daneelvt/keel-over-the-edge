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

// A cell's table holds, for each direction, two bytes: the factor in
// steps of 1/ShelterFactorOne and the turn as a signed byte in steps of
// ShelterTurnStep radians.
const (
	ShelterFactorOne = 196
	ShelterTurnStep  = math.Pi / 720 // a quarter of a degree
)

// ShelterChunk is one chunk's shelter: for each cell, column by column, and
// each direction, the factor's byte and the turn's.
type ShelterChunk struct {
	Values [ShelterCells * ShelterDirections * 2]uint8
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
	v := sh.Chunks[n].Values[(i*ShelterDirections+k)*2:]
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
	reach            float64 // m
	step             float64 // m
	near, far        float64 // in heights
	least, most      float64
	speedUp          float64
	flank            float64 // in heights
	turn             float64 // rad
	offsets          [4]float64
	sinDir, cosDir   [ShelterDirections]float64
	farRange         float64
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
