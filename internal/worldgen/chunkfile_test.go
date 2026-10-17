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
// made chunk, the same chunk as format 1 wrote it, and seed 1's chunk 205,
// Port Royal's with its town, as payloads of one world, and the SHA-256 of
// the elevations (int16s, little-endian), the surfaces and the shelter's
// whole table each should unpack to, with the town's counts and its first
// building. After a deliberate change, rewrite it with
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
		c.Buildings, c.Discs = len(read.Buildings), len(read.Harbour)
		if len(read.Buildings) > 0 {
			b := read.Buildings[0]
			c.First = &fileBuilding{Kind: b.Kind, Kit: b.Kit, East: b.X, North: b.Y, Heading: b.Heading,
				Level: float64(b.Level) / 10, Top: b.Top, Storeys: b.Storeys, Seed: b.Seed, Frontage: b.Frontage, Depth: b.Depth, Town: b.Town}
		}
	}
	return c, nil
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
	got.Chunks = append(got.Chunks, made, old)
	if testing.Short() && !*update {
		if len(want.Chunks) < 2 || want.Chunks[0].Payload != made.Payload ||
			want.Chunks[1].Payload != old.Payload || want.Format != Format {
			t.Fatal("the made chunk differs from chunks.json: rewrite it with -update")
		}
		return
	}
	_, w := wholeWorld(t)
	port, err := fileChunk("seed 1, Port Royal's", 205, w.Ground.Chunks[205], w.Shelter.Chunks[205], w.ChunkTowns()[205], Format, Version)
	if err != nil {
		t.Fatal(err)
	}
	got.Chunks = append(got.Chunks, port)
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
		if g.Payload != w.Payload || g.Buildings != w.Buildings || g.Discs != w.Discs {
			t.Errorf("%s differs from chunks.json: rewrite it with -update", got.Chunks[i].Name)
		}
	}
}
