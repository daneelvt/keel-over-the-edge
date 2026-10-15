// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"encoding/json"
	"math"
	"math/rand/v2"
	"os"
	"reflect"
	"testing"
)

func TestHexCentreMapsBack(t *testing.T) {
	for c := int32(0); c < HexColumns; c += 7 {
		for j := int32(0); j < HexRows; j += 5 {
			q, r := CellHex(c, j)
			x, y := HexCentre(q, r)
			if gq, gr := HexAt(x, y); gq != q || gr != r {
				t.Fatalf("the centre of (%d, %d) is in (%d, %d)", q, r, gq, gr)
			}
			if gc, gj := HexCell(q, r); gc != c || gj != j {
				t.Fatalf("column %d row %d is hexagon (%d, %d), which is column %d row %d", c, j, q, r, gc, gj)
			}
		}
	}
}

// nearestHex is the hexagon whose centre is nearest (x, y), by brute force
// over the neighbours of a guess, with the distances in exact arithmetic's
// order: what HexAt must agree with wherever the point is not on an edge.
func nearestHex(x, y float64) (q, r int32, gap float64) {
	gq := int32(math.Round(x / (1.5 * HexAcross / math.Sqrt(3))))
	gr := int32(math.Round(y/HexAcross - float64(gq)/2))
	best, second := math.Inf(1), math.Inf(1)
	for dq := int32(-2); dq <= 2; dq++ {
		for dr := int32(-3); dr <= 3; dr++ {
			cx, cy := HexCentre(gq+dq, gr+dr)
			d := math.Hypot(x-cx, y-cy)
			switch {
			case d < best:
				second, best, q, r = best, d, gq+dq, gr+dr
			case d < second:
				second = d
			}
		}
	}
	return q, r, second - best
}

func TestHexAtFindsTheNearestCentre(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	for range 1_000_000 {
		x, y := (rng.Float64()-0.5)*17000, (rng.Float64()-0.5)*17000
		q, r, gap := nearestHex(x, y)
		if gap < 1e-9 {
			continue // on an edge
		}
		if gq, gr := HexAt(x, y); gq != q || gr != r {
			t.Fatalf("(%v, %v) is in (%d, %d), HexAt says (%d, %d)", x, y, q, r, gq, gr)
		}
	}
}

func TestHexAtOnEdgesAndCorners(t *testing.T) {
	// The midpoints of each hexagon's edges and its corners: each goes to
	// one of the hexagons that meet there, the same every time.
	for _, h := range [][2]int32{{0, 0}, {1, 0}, {-1, 3}, {57, -200}, {-1200, 900}, {2431, -2000}} {
		cx, cy := HexCentre(h[0], h[1])
		for k := range 6 {
			a := float64(k) * math.Pi / 3
			corner := [2]float64{cx + hexRadius*math.Cos(a), cy + hexRadius*math.Sin(a)}
			mid := [2]float64{cx + HexAcross/2*math.Cos(a+math.Pi/6), cy + HexAcross/2*math.Sin(a+math.Pi/6)}
			for _, p := range [][2]float64{corner, mid} {
				q, r := HexAt(p[0], p[1])
				hx, hy := HexCentre(q, r)
				if d := math.Hypot(p[0]-hx, p[1]-hy); d > hexRadius+1e-9 {
					t.Errorf("(%v, %v) went to (%d, %d), %v m away", p[0], p[1], q, r, d)
				}
				if q2, r2 := HexAt(p[0], p[1]); q2 != q || r2 != r {
					t.Errorf("(%v, %v) went to two hexagons", p[0], p[1])
				}
			}
		}
	}
	// A point exactly between two columns' centres goes west; one exactly
	// between two hexagons of a column goes north.
	x0, _ := HexCentre(0, 0)
	x1, _ := HexCentre(1, 0)
	if q, _ := HexAt((x0+x1)/2, 1); q != 0 {
		t.Errorf("a point between columns 0 and 1 went to column %d", q)
	}
	if q, r := HexAt(0, 2); q != 0 || r != 1 {
		t.Errorf("(0, 2) went to (%d, %d), not (0, 1)", q, r)
	}
}

func TestChunks(t *testing.T) {
	var counts [ChunkCount]int32
	seen := make([]bool, ChunkCount*ChunkHexes)
	for c := int32(0); c < HexColumns; c++ {
		for j := int32(0); j < HexRows; j++ {
			n, i, ok := ChunkOf(c, j)
			if !ok {
				t.Fatalf("column %d row %d is on the grid", c, j)
			}
			if seen[n*ChunkHexes+i] {
				t.Fatalf("chunk %d's hexagon %d is held twice", n, i)
			}
			seen[n*ChunkHexes+i] = true
			counts[n]++
			if c0, j0 := ChunkCorner(n); c < c0 || j < j0 || c >= c0+ChunkColumns || j >= j0+ChunkRows {
				t.Fatalf("column %d row %d is not in chunk %d", c, j, n)
			}
		}
	}
	for n, k := range counts {
		if k != ChunkHexes {
			t.Errorf("chunk %d holds %d hexagons", n, k)
		}
	}
	for _, cell := range [][2]int32{{-1, 0}, {0, -1}, {HexColumns, 0}, {0, HexRows}} {
		if _, _, ok := ChunkOf(cell[0], cell[1]); ok {
			t.Errorf("column %d row %d is off the grid", cell[0], cell[1])
		}
	}
	// The grid covers the disk, 8,334 m across, with every hexagon of it.
	for k := range 3600 {
		a := float64(k) * 2 * math.Pi / 3600
		q, r := HexAt(8334*math.Sin(a), 8334*math.Cos(a))
		if _, _, ok := ChunkOf(HexCell(q, r)); !ok {
			t.Fatalf("the rim at %v rad is off the grid", a)
		}
	}
	if c, j := HexCell(0, 0); c != columnZero || j != rowZero {
		t.Errorf("the centre's hexagon is column %d row %d", c, j)
	}
}

// hexFile holds points on hexagons' edges and corners and the hexagon
// HexAt puts each in, for the module's test (client/src/predict/hex.test.ts):
// floats as their IEEE 754 bits in hexadecimal.
const hexFile = "testdata/hex.json"

func TestHexFile(t *testing.T) {
	type point struct {
		X, Y string
		Q, R int32
	}
	// The corners and the edges' midpoints, anticlockwise from east, as
	// constants: math.Cos and a multiply-add would give other points on a
	// machine that fuses them.
	const r, a = hexRadius, HexAcross
	offsets := [12][2]float64{
		{r, 0}, {r * 3 / 4, a / 4}, {r / 2, a / 2}, {0, a / 2}, {-r / 2, a / 2}, {-r * 3 / 4, a / 4},
		{-r, 0}, {-r * 3 / 4, -a / 4}, {-r / 2, -a / 2}, {0, -a / 2}, {r / 2, -a / 2}, {r * 3 / 4, -a / 4},
	}
	var points []point
	for _, h := range [][2]int32{{0, 0}, {1, 0}, {-1, 3}, {57, -200}, {-1200, 900}, {2431, -2000}, {-2432, 2111}} {
		cx, cy := HexCentre(h[0], h[1])
		for _, o := range offsets {
			x, y := cx+o[0], cy+o[1]
			q, rr := HexAt(x, y)
			points = append(points, point{toHex(x), toHex(y), q, rr})
		}
	}
	if *update {
		data, _ := json.MarshalIndent(points, "", " ")
		if err := os.WriteFile(hexFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	var want []point
	readJSON(t, hexFile, &want)
	if !reflect.DeepEqual(points, want) {
		t.Errorf("%s differs from this machine's: rewrite it with -update", hexFile)
	}
}
