// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The chunks as Go writes them, for the client's mesh worker to read
// (client/src/workers/mesh/chunk.test.ts): testdata/chunks.json holds a
// made chunk, the same chunk as formats 1 and 2 wrote it, the made chunk
// with roofs and parts, seed 1's chunk that holds the most of Port Royal's
// town and its chunk with the most roofs, as payloads of one world, and
// the SHA-256 of the elevations (int16s, little-endian), the surfaces and
// the shelter's whole table each should unpack to, with the town's and the
// features' counts and their first building, roof and part. After a
// deliberate change, rewrite it with
//
//	go test ./internal/worldgen -run ChunkFile -update

const chunkFile = "testdata/chunks.json"

// chunkFileWorld is the fixture's world's id.
var chunkFileWorld = [16]byte{0x01, 0x99, 0xc2, 0xa4, 0x5f, 0x7e, 0x7c, 0x3a, 0x9d, 0x0e, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc}

type chunkFileData struct {
	Comment string           `json:"comment"`
	Format  int              `json:"format"`
	World   string           `json:"world"`
	Chunks  []chunkFileChunk `json:"chunks"`
}

type chunkFileChunk struct {
	Name      string `json:"name"`
	Number    int32  `json:"number"`
	Payload   string `json:"payload"`
	Elevation string `json:"elevation"`
	Surface   string `json:"surface"`
	Shelter   string `json:"shelter"`
	// Format is the payload's format; Buildings and Discs what it holds of
	// the towns, and First its first building.
	Format    int           `json:"format"`
	Buildings int           `json:"buildings"`
	Discs     int           `json:"discs"`
	First     *fileBuilding `json:"first,omitempty"`
	// Roofs and Parts are what it holds of the features, with its first of
	// each.
	Roofs     int       `json:"roofs"`
	Parts     int       `json:"parts"`
	FirstRoof *fileRoof `json:"firstRoof,omitempty"`
	FirstPart *filePart `json:"firstPart,omitempty"`
}

// fileRoof is a roof as the page should read it: its hexagon's column and
// row on the grid, and its top and underside, m.
type fileRoof struct {
	Column int32   `json:"column"`
	Row    int32   `json:"row"`
	Top    float64 `json:"top"`
	Under  float64 `json:"under"`
}

// filePart is a feature's part as the page should read it.
type filePart struct {
	Kind    uint8   `json:"kind"`
	East    float64 `json:"east"`
	North   float64 `json:"north"`
	Level   float64 `json:"level"`
	Heading float64 `json:"heading"`
	Size    float64 `json:"size"`
	Count   uint16  `json:"count"`
	Seed    uint8   `json:"seed"`
}

// fileBuilding is a building as the page should read it.
type fileBuilding struct {
	Kind     uint8   `json:"kind"`
	Kit      uint8   `json:"kit"`
	East     float64 `json:"east"`
	North    float64 `json:"north"`
	Heading  float64 `json:"heading"`
	Level    float64 `json:"level"`
	Top      float64 `json:"top"`
	Storeys  uint8   `json:"storeys"`
	Seed     uint8   `json:"seed"`
	Frontage float64 `json:"frontage"`
	Depth    float64 `json:"depth"`
	Town     int32   `json:"town"`
}

// madeChunk is a chunk of a hill and its shallows, every surface, and a
// shelter table on some of its cells.
func madeChunk() (int32, *physics.GroundChunk, *physics.ShelterChunk) {
	n := int32(7*physics.ChunkSide + 8)
	g := new(physics.GroundChunk)
	c0, j0 := physics.ChunkCorner(n)
	for i := range int32(physics.ChunkHexes) {
		x, y := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
		d := math.Hypot(x-500, y+500)
		g.Elevation[i] = int16(max(physics.DeepWater, min(800, math.Round(10*(30-d/6)))))
		g.Surface[i] = uint8(int(d/20) % 8)
	}
	s := newShelterChunk()
	for i := int32(0); i < physics.ShelterCells; i += 3 {
		for k := range int32(physics.ShelterDirections) {
			v := s.Values[(i*physics.ShelterDirections+k)*2:]
			v[0], v[1] = uint8(100+(i+k)%96), uint8(int8((i*k)%41-20))
		}
	}
	return n, g, s
}

func digestOf(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func fileChunk(name string, n int32, g *physics.GroundChunk, s *physics.ShelterChunk, t *ChunkTown, format uint16, generator uint32) (chunkFileChunk, error) {
	payload, err := encodeChunk(n, chunkFileWorld, g, s, t, format, generator)
	if err != nil {
		return chunkFileChunk{}, err
	}
	e := make([]byte, 0, 2*physics.ChunkHexes)
	for _, v := range g.Elevation {
		e = binary.LittleEndian.AppendUint16(e, uint16(v))
	}
	c := chunkFileChunk{Name: name, Number: n, Payload: base64.StdEncoding.EncodeToString(payload),
		Elevation: digestOf(e), Surface: digestOf(g.Surface[:]), Format: int(format)}
	if s != nil {
		c.Shelter = digestOf(s.Values[:])
	}
	if t != nil && format >= 2 {
		// As the page reads it back.
		_, _, read, err := DecodeChunkOf(payload, n, chunkFileWorld, int(generator))
		if err != nil {
			return chunkFileChunk{}, err
		}
		if read != nil {
			c.Buildings, c.Discs, c.Roofs, c.Parts = len(read.Buildings), len(read.Harbour), len(read.Roofs), len(read.Parts)
			if len(read.Buildings) > 0 {
				b := read.Buildings[0]
				c.First = &fileBuilding{Kind: b.Kind, Kit: b.Kit, East: b.X, North: b.Y, Heading: b.Heading,
					Level: float64(b.Level) / 10, Top: b.Top, Storeys: b.Storeys, Seed: b.Seed, Frontage: b.Frontage, Depth: b.Depth, Town: b.Town}
			}
			if len(read.Roofs) > 0 {
				r := read.Roofs[0]
				c.FirstRoof = &fileRoof{Column: r.C, Row: r.J, Top: float64(r.Top) / 10, Under: float64(r.Under) / 10}
			}
			if len(read.Parts) > 0 {
				p := read.Parts[0]
				c.FirstPart = &filePart{Kind: p.Kind, East: p.X, North: p.Y, Level: p.Level, Heading: p.Heading, Size: p.Size, Count: p.Count, Seed: p.Seed}
			}
		}
	}
	return c, nil
}

// madeFeatures are roofs over a few of the made chunk's hexagons, and a
// part of each kind of feature in it.
func madeFeatures(n int32) *ChunkTown {
	c0, j0 := physics.ChunkCorner(n)
	t := &ChunkTown{}
	for k := range int32(5) {
		t.Roofs = append(t.Roofs, Roof{C: c0 + 40 + k, J: j0 + 60, Top: int16(120 + 10*k), Under: int16(50 + 5*k)})
	}
	x, y := physics.CellCentre(c0+100, j0+100)
	for k := range uint8(4) {
		t.Parts = append(t.Parts, Part{Kind: 2 * k, X: x + float64(k)*3.5, Y: y - float64(k)*1.5, Level: 8.5 + float64(k),
			Heading: float64(k) * 1.25, Size: 2.5 + float64(k), Count: uint16(20 + 7*k), Seed: 31 * k})
	}
	return t
}

func TestChunkFile(t *testing.T) {
	var want chunkFileData
	if !*update {
		data, err := os.ReadFile(chunkFile)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &want); err != nil {
			t.Fatal(err)
		}
	}
	got := chunkFileData{
		Comment: "Written by go test ./internal/worldgen -run ChunkFile -update: payloads, and the SHA-256 of the elevations (int16, little-endian), surfaces and shelter table each unpacks to.",
		Format:  Format,
		World:   "0199c2a4-5f7e-7c3a-9d0e-123456789abc",
	}
	n, g, s := madeChunk()
	made, err := fileChunk("made", n, g, s, nil, Format, Version)
	if err != nil {
		t.Fatal(err)
	}
	old, err := fileChunk("made, format 1", n, g, s, nil, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	two, err := fileChunk("made, format 2", n, g, s, &ChunkTown{}, 2, 3)
	if err != nil {
		t.Fatal(err)
	}
	featured, err := fileChunk("made, with features", n, g, s, madeFeatures(n), Format, Version)
	if err != nil {
		t.Fatal(err)
	}
	got.Chunks = append(got.Chunks, made, old, two, featured)
	if testing.Short() && !*update {
		if len(want.Chunks) < 4 || want.Format != Format {
			t.Fatal("the made chunks differ from chunks.json: rewrite it with -update")
		}
		for i := range 4 {
			if want.Chunks[i].Payload != got.Chunks[i].Payload {
				t.Fatalf("%s differs from chunks.json: rewrite it with -update", got.Chunks[i].Name)
			}
		}
		return
	}
	_, w := wholeWorld(t)
	// The chunk that holds the most of Port Royal's town.
	towns := w.ChunkTowns()
	at, most := int32(0), -1
	for n, t := range towns {
		if t != nil && len(t.Buildings) > most {
			at, most = int32(n), len(t.Buildings)
		}
	}
	port, err := fileChunk("seed 1, Port Royal's", at, w.Ground.Chunks[at], w.Shelter.Chunks[at], towns[at], Format, Version)
	if err != nil {
		t.Fatal(err)
	}
	// The chunk with the most roofs.
	at, most = 0, -1
	for n, t := range towns {
		if t != nil && len(t.Roofs) > most {
			at, most = int32(n), len(t.Roofs)
		}
	}
	arches, err := fileChunk("seed 1, its arches'", at, w.Ground.Chunks[at], w.Shelter.Chunks[at], towns[at], Format, Version)
	if err != nil {
		t.Fatal(err)
	}
	got.Chunks = append(got.Chunks, port, arches)
	if *update {
		data, err := json.MarshalIndent(got, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(chunkFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	if len(want.Chunks) != len(got.Chunks) || want.Format != got.Format || want.World != got.World {
		t.Fatal("chunks.json differs: rewrite it with -update")
	}
	for i := range got.Chunks {
		g, w := got.Chunks[i], want.Chunks[i]
		if g.Payload != w.Payload || g.Buildings != w.Buildings || g.Discs != w.Discs || g.Roofs != w.Roofs || g.Parts != w.Parts {
			t.Errorf("%s differs from chunks.json: rewrite it with -update", got.Chunks[i].Name)
		}
	}
}
