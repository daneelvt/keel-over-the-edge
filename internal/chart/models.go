// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// The islands' land on a coarse grid: cells of a few hexagons a side, each
// with its highest ground and that ground's surface, the highest anything
// on it stands (its ground, its trees, a building, a roof), and the island
// it is part of. A cell is an island's when it is land joined to the
// island's highest point within the island's bounds, or land not so joined
// (a stack, a rock off its coast) nearer that island's cells than any
// other's, within strayCells.
//
// Each island's model is its cells: a header, then each cell's height and
// surface, row by row from the south-west, gzipped, served at an address
// handed out with the island's charting. The format:
//
//	byte    format, 1
//	byte    hexagons a cell's side
//	uint16  columns, rows
//	int32   the first cell's centre, cm east and north of the world's centre
//	uint16  a column's and a row's step, mm
//	uint32  the island's number
//	byte    × columns × rows: each cell's highest ground, m, rounded up; 0 for none of its land
//	byte    × columns × rows: that ground's surface, by the catalog's index
//
// little-endian.

// ModelFormat is the models' format.
const ModelFormat = 1

// strayCells is how far a cell of land not joined to an island may lie from
// its cells and still be its, in cells.
const strayCells = 8

// IslandModel is an island's model as served: its number and its payload.
type IslandModel struct {
	Island  int32
	Payload []byte
}

type landGrid struct {
	cell       int32
	cols, rows int32
	ground     []float32 // the highest ground, m
	top        []float32 // the highest anything stands, m
	surface    []uint8
	owner      []int32 // the island's index and one; 0 for none
	islands    [][]int32
}

// newLandGrid lays the bundle's land on a grid of cells cell hexagons a
// side, and finds each island's.
func newLandGrid(b *worldgen.Bundle, cat *catalog.Catalog, cell int) *landGrid {
	g := &landGrid{cell: int32(max(cell, 1))}
	g.cols = (physics.HexColumns + g.cell - 1) / g.cell
	g.rows = (physics.HexRows + g.cell - 1) / g.cell
	n := int(g.cols) * int(g.rows)
	g.ground, g.top = make([]float32, n), make([]float32, n)
	g.surface, g.owner = make([]uint8, n), make([]int32, n)
	var canopy [physics.GroundSurfaces]float64
	for i, s := range cat.World.Surfaces {
		if i < physics.GroundSurfaces {
			canopy[i] = s.Canopy
		}
	}
	for ch := range int32(physics.ChunkCount) {
		gc := b.Ground.Chunks[ch]
		if gc == nil {
			continue
		}
		c0, j0 := physics.ChunkCorner(ch)
		for i := range int32(physics.ChunkHexes) {
			e := gc.Elevation[i]
			if e <= 0 {
				continue
			}
			k := g.at(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
			h := float32(e) / 10
			s := gc.Surface[i]
			if h > g.ground[k] {
				g.ground[k], g.surface[k] = h, s
			}
			g.top[k] = max(g.top[k], h+float32(canopy[s]))
		}
	}
	raise := func(x, y, top float64) {
		c, j := physics.HexCell(physics.HexAt(x, y))
		if c < 0 || j < 0 || c >= physics.HexColumns || j >= physics.HexRows {
			return
		}
		k := g.at(c, j)
		g.top[k] = max(g.top[k], float32(top))
	}
	for _, bd := range b.Buildings {
		raise(bd.X, bd.Y, bd.Top)
	}
	for _, r := range b.Roofs {
		x, y := physics.CellCentre(r.C, r.J)
		raise(x, y, float64(r.Top)/10)
	}
	g.own(b)
	return g
}

// at is the cell of hexagon column c, row j.
func (g *landGrid) at(c, j int32) int32 { return (j/g.cell)*g.cols + c/g.cell }

// centre is cell k's centre, m: the mean of its hexagons'.
func (g *landGrid) centre(k int32) (x, y float64) {
	a, b := k%g.cols, k/g.cols
	for dc := range g.cell {
		for dj := range g.cell {
			hx, hy := physics.CellCentre(a*g.cell+dc, b*g.cell+dj)
			x += hx
			y += hy
		}
	}
	n := float64(g.cell * g.cell)
	return x / n, y / n
}

// own finds each island's cells.
func (g *landGrid) own(b *worldgen.Bundle) {
	g.islands = make([][]int32, len(b.Islands))
	var queue []int32
	land := func(k int32) bool { return g.ground[k] > 0 }
	for i := range b.Islands {
		is := &b.Islands[i]
		// Its bounds, in cells.
		a0, b0 := is.Box[0]/g.cell, is.Box[1]/g.cell
		a1, b1 := (is.Box[0]+is.Box[2])/g.cell, (is.Box[1]+is.Box[3])/g.cell
		inBox := func(k int32) bool {
			a, bb := k%g.cols, k/g.cols
			return a >= a0 && a <= a1 && bb >= b0 && bb <= b1
		}
		c, j := physics.HexCell(physics.HexAt(is.HighX, is.HighY))
		if c < 0 || j < 0 || c >= physics.HexColumns || j >= physics.HexRows {
			continue
		}
		start := g.at(c, j)
		if !land(start) || g.owner[start] != 0 {
			continue
		}
		owner := int32(i + 1)
		g.owner[start] = owner
		queue = append(queue[:0], start)
		for len(queue) > 0 {
			k := queue[0]
			queue = queue[1:]
			g.islands[i] = append(g.islands[i], k)
			g.neighbours(k, func(m int32) {
				if land(m) && g.owner[m] == 0 && inBox(m) {
					g.owner[m] = owner
					queue = append(queue, m)
				}
			})
		}
	}
	// The land joined to none: the nearest island's within strayCells, by
	// a search out from every island's cells at once.
	dist := make([]int8, len(g.owner))
	from := make([]int32, len(g.owner))
	queue = queue[:0]
	for _, cells := range g.islands {
		for _, k := range cells {
			dist[k], from[k] = 1, g.owner[k]
			queue = append(queue, k)
		}
	}
	for len(queue) > 0 {
		k := queue[0]
		queue = queue[1:]
		d := dist[k]
		if d > strayCells {
			continue
		}
		g.neighbours(k, func(m int32) {
			if dist[m] != 0 {
				return
			}
			dist[m], from[m] = d+1, from[k]
			if land(m) && g.owner[m] == 0 {
				g.owner[m] = from[k]
				g.islands[from[k]-1] = append(g.islands[from[k]-1], m)
			}
			queue = append(queue, m)
		})
	}
}

// neighbours calls f with each of cell k's eight neighbours on the grid.
func (g *landGrid) neighbours(k int32, f func(int32)) {
	a, b := k%g.cols, k/g.cols
	for db := int32(-1); db <= 1; db++ {
		for da := int32(-1); da <= 1; da++ {
			if da == 0 && db == 0 {
				continue
			}
			x, y := a+da, b+db
			if x >= 0 && y >= 0 && x < g.cols && y < g.rows {
				f(y*g.cols + x)
			}
		}
	}
}

// island is island i's cells.
func (g *landGrid) island(i int32) []int32 { return g.islands[i] }

// model is island i's model, from its cells.
func (g *landGrid) model(i int32, cells []int32, number int32) IslandModel {
	a0, b0 := int32(math.MaxInt32), int32(math.MaxInt32)
	a1, b1 := int32(-1), int32(-1)
	for _, k := range cells {
		a, b := k%g.cols, k/g.cols
		a0, b0, a1, b1 = min(a0, a), min(b0, b), max(a1, a), max(b1, b)
	}
	cols, rows := a1-a0+1, b1-b0+1
	x0, y0 := g.centre(b0*g.cols + a0)
	dx := 0.0
	if a0+1 < g.cols {
		x1, _ := g.centre(b0*g.cols + a0 + 1)
		dx = x1 - x0
	}
	dy := float64(g.cell * physics.HexAcross)
	out := make([]byte, 0, 20+2*cols*rows)
	out = append(out, ModelFormat, byte(g.cell))
	out = binary.LittleEndian.AppendUint16(out, uint16(cols))
	out = binary.LittleEndian.AppendUint16(out, uint16(rows))
	out = binary.LittleEndian.AppendUint32(out, uint32(int32(math.Round(x0*100))))
	out = binary.LittleEndian.AppendUint32(out, uint32(int32(math.Round(y0*100))))
	out = binary.LittleEndian.AppendUint16(out, uint16(math.Round(dx*1000)))
	out = binary.LittleEndian.AppendUint16(out, uint16(math.Round(dy*1000)))
	out = binary.LittleEndian.AppendUint32(out, uint32(number))
	heights := make([]byte, cols*rows)
	surfaces := make([]byte, cols*rows)
	owner := i + 1
	for _, k := range cells {
		if g.owner[k] != owner {
			continue
		}
		a, b := k%g.cols-a0, k/g.cols-b0
		heights[b*cols+a] = byte(min(max(math.Ceil(float64(g.ground[k])), 1), 255))
		surfaces[b*cols+a] = g.surface[k]
	}
	out = append(append(out, heights...), surfaces...)
	var z bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&z, gzip.BestCompression)
	_, _ = zw.Write(out)
	_ = zw.Close()
	return IslandModel{Island: number, Payload: z.Bytes()}
}

// ReadModel reads a model's payload: its header's fields, and each cell's
// height and surface, row by row from the south-west.
func ReadModel(payload []byte) (h ModelHeader, heights, surfaces []byte, err error) {
	zr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return h, nil, nil, err
	}
	var raw bytes.Buffer
	if _, err := raw.ReadFrom(zr); err != nil {
		return h, nil, nil, err
	}
	b := raw.Bytes()
	if len(b) < modelHeader || b[0] != ModelFormat {
		return h, nil, nil, errModel
	}
	h.Cell = int(b[1])
	h.Columns, h.Rows = int(binary.LittleEndian.Uint16(b[2:])), int(binary.LittleEndian.Uint16(b[4:]))
	h.X, h.Y = float64(int32(binary.LittleEndian.Uint32(b[6:])))/100, float64(int32(binary.LittleEndian.Uint32(b[10:])))/100
	h.DX, h.DY = float64(binary.LittleEndian.Uint16(b[14:]))/1000, float64(binary.LittleEndian.Uint16(b[16:]))/1000
	h.Island = int32(binary.LittleEndian.Uint32(b[18:]))
	n := h.Columns * h.Rows
	if len(b) != modelHeader+2*n {
		return h, nil, nil, errModel
	}
	return h, b[modelHeader : modelHeader+n], b[modelHeader+n:], nil
}

// modelHeader is a model's header's size, bytes.
const modelHeader = 22

var errModel = errors.New("chart: not an island's model")

// ModelHeader is a model's header.
type ModelHeader struct {
	Cell, Columns, Rows int
	X, Y, DX, DY        float64
	Island              int32
}
