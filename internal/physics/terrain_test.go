// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
)

// The golden scenarios' terrains: made here from functions of a hexagon's
// centre, and written to testdata/ground/<name>.terrain by
// go test ./internal/physics -run Golden -update, so that the module's
// runner (client/src/predict/golden.ts) loads the same chunks. A file is
// gzip of records one after another: the chunk's number as a little-endian
// uint16, what follows as a byte (1 its ground: its elevations as int16s,
// then its surfaces; 2 its shelter's table), and that.

const terrainDir = "testdata/ground"

// The record kinds of a terrain file.
const (
	terrainGround  = 1
	terrainShelter = 2
)

// terrainChunks are the chunks a test terrain holds: the four about the
// world's centre.
var terrainChunks = []int32{7*ChunkSide + 7, 7*ChunkSide + 8, 8*ChunkSide + 7, 8*ChunkSide + 8}

// testTerrain is a terrain of the golden scenarios: an elevation in m and
// a surface for each hexagon's centre, and whether the land shelters the
// wind.
type testTerrain struct {
	elevation func(x, y float64) float64
	surface   func(x, y float64) uint8
	shelter   bool
}

// The surfaces' indices, as the catalog lists them.
const (
	testSand = 0
	testRock = 4
	testReef = 7
)

var testTerrains = map[string]testTerrain{
	"beach": {elevation: beach, surface: func(x, y float64) uint8 { return testSand }},
	// A fringing reef: 4 m of water, the crest awash from x = 90 to 110,
	// the lagoon 1.5 m deep behind it, the beach from x = 170.
	"reef": {elevation: func(x, y float64) float64 {
		switch {
		case x < 90:
			return -4
		case x < 110:
			return -0.4
		case x < 170:
			return -1.5
		}
		return 1
	}, surface: func(x, y float64) uint8 {
		if x >= 90 && x < 110 {
			return testReef
		}
		return testSand
	}},
	"cliff": {elevation: cliff, surface: func(x, y float64) uint8 { return testRock }},
	// A harbour's works: a pier 8 m wide from y = −30 to 30 at x = 60 to
	// 68, and a quay from x = 120, each 1.6 m above 5 m of water.
	"pier": {elevation: pier, surface: func(x, y float64) uint8 { return testRock }},
	// A headland 12 m thick from x = 120 to 132 and 15 m high, through which
	// an arch's span runs at |y| < 6: under it the rock awash, at the sea's
	// level; 5 m of water before it.
	"arch": {elevation: arch, surface: func(x, y float64) uint8 { return testRock }},
	// A round hill 30 m high and 40 m across at (200, 0), in deep water.
	"lee": {elevation: func(x, y float64) float64 {
		if math.Hypot(x-200, y) < 40 {
			return 30
		}
		return -20
	}, surface: func(x, y float64) uint8 { return testRock }, shelter: true},
}

// make builds a terrain's ground and shelter.
func (tt testTerrain) make() (*Ground, *Shelter) {
	g := &Ground{Prepared: new(GroundPrepared)}
	PrepareGround(&testGroundParams, g.Prepared)
	for _, n := range terrainChunks {
		ch := new(GroundChunk)
		c0, j0 := ChunkCorner(n)
		for i := range int32(ChunkHexes) {
			x, y := CellCentre(c0+i/ChunkRows, j0+i%ChunkRows)
			ch.Elevation[i] = int16(max(min(math.Round(tt.elevation(x, y)*10), 800), DeepWater))
			ch.Surface[i] = tt.surface(x, y)
		}
		g.Chunks[n] = ch
	}
	if !tt.shelter {
		return g, nil
	}
	heights := make(ShelterHeights, ShelterFieldSize)
	for _, n := range terrainChunks {
		c0, j0 := ChunkCorner(n)
		for i := range int32(ChunkHexes) {
			if e := g.Chunks[n].Elevation[i]; e > 0 {
				c, j := c0+i/ChunkRows, j0+i%ChunkRows
				k := ShelterIndex(c/ShelterCell, j/ShelterCell)
				heights[k] = max(heights[k], float32(float64(e)*0.1))
			}
		}
	}
	var sp ShelterPrepared
	PrepareShelter(&testShelterParams, &sp)
	sh := new(Shelter)
	for _, n := range terrainChunks {
		ch := new(ShelterChunk)
		for v := 0; v < len(ch.Values); v += 2 {
			ch.Values[v] = ShelterFactorOne
		}
		sh.Chunks[n] = ch
	}
	f := newShelterField()
	cols, rows := ShelterGrid()
	for k := range int32(ShelterDirections) {
		for i := range f.Lee {
			f.Lee[i], f.Right[i], f.Left[i] = 1, 0, 0
		}
		ShelterDirection(heights, k, &sp, &f)
		for a := range cols {
			for b := range rows {
				n, i, _ := ShelterCellOf(a, b)
				if sh.Chunks[n] == nil {
					continue
				}
				fb, tb := ShelterBytes(ShelterAt(&f, ShelterIndex(a, b), &sp))
				v := sh.Chunks[n].Values[(i*ShelterDirections+k)*2:]
				v[0], v[1] = fb, tb
			}
		}
	}
	return g, sh
}

// writeTerrain writes a terrain's file.
func writeTerrain(name string, g *Ground, sh *Shelter) error {
	var raw bytes.Buffer
	for _, n := range terrainChunks {
		raw.Write(binary.LittleEndian.AppendUint16(nil, uint16(n)))
		raw.WriteByte(terrainGround)
		for _, e := range g.Chunks[n].Elevation {
			raw.Write(binary.LittleEndian.AppendUint16(nil, uint16(e)))
		}
		raw.Write(g.Chunks[n].Surface[:])
		if sh != nil && sh.Chunks[n] != nil {
			raw.Write(binary.LittleEndian.AppendUint16(nil, uint16(n)))
			raw.WriteByte(terrainShelter)
			raw.Write(sh.Chunks[n].Values[:])
		}
	}
	var out bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&out, gzip.BestCompression)
	zw.Write(raw.Bytes())
	zw.Close()
	if err := os.MkdirAll(terrainDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(terrainDir, name+".terrain"), out.Bytes(), 0o644)
}

// readTerrain reads a terrain's file: its ground, and its shelter or nil.
func readTerrain(name string, gp *GroundPrepared) (*Ground, *Shelter, error) {
	data, err := os.ReadFile(filepath.Join(terrainDir, name+".terrain"))
	if err != nil {
		return nil, nil, err
	}
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, nil, err
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return nil, nil, err
	}
	g := &Ground{Prepared: gp}
	var sh *Shelter
	for len(raw) > 0 {
		if len(raw) < 3 {
			return nil, nil, fmt.Errorf("%s: cut short", name)
		}
		n, kind := binary.LittleEndian.Uint16(raw), raw[2]
		raw = raw[3:]
		switch kind {
		case terrainGround:
			ch := new(GroundChunk)
			for i := range ch.Elevation {
				ch.Elevation[i] = int16(binary.LittleEndian.Uint16(raw[2*i:]))
			}
			raw = raw[2*ChunkHexes:]
			copy(ch.Surface[:], raw[:ChunkHexes])
			raw = raw[ChunkHexes:]
			g.Chunks[n] = ch
		case terrainShelter:
			if sh == nil {
				sh = new(Shelter)
			}
			ch := new(ShelterChunk)
			copy(ch.Values[:], raw[:len(ch.Values)])
			raw = raw[len(ch.Values):]
			sh.Chunks[n] = ch
		default:
			return nil, nil, fmt.Errorf("%s: a record of kind %d", name, kind)
		}
	}
	return g, sh, nil
}
