// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// The bundle as it is stored: its records as JSON, its report as JSON, and
// each of its chunks as a payload, gzip at level 6. A payload begins with a
// header: the magic, the format, the chunk's number, the generator's
// version and the world's id, then what it holds, so that a reader never
// takes a chunk of another world, chunk or format for its own. Then the
// elevations, column by column, each as its difference from the one
// before, which compresses to about half of the values themselves; the
// surfaces; and the shelter: a bitmap of the cells with a table, and their
// tables.

// chunkMagic begins every chunk's payload.
var chunkMagic = [4]byte{'K', 'W', 'C', 'H'}

// chunkHeader is the payload's header's size.
const chunkHeader = 4 + 2 + 2 + 4 + 16 + 1

// What a payload holds, in the header's last byte.
const (
	holdsGround  = 1
	holdsShelter = 2
)

// shelterBitmap is the size of a payload's bitmap of cells with a table.
const shelterBitmap = (physics.ShelterCells + 7) / 8

// EncodeChunk is chunk n's payload, for the world with the id given.
func EncodeChunk(n int32, world [16]byte, g *physics.GroundChunk, s *physics.ShelterChunk) ([]byte, error) {
	var raw bytes.Buffer
	var head [chunkHeader]byte
	copy(head[:4], chunkMagic[:])
	binary.LittleEndian.PutUint16(head[4:], Format)
	binary.LittleEndian.PutUint16(head[6:], uint16(n))
	binary.LittleEndian.PutUint32(head[8:], Version)
	copy(head[12:28], world[:])
	if g != nil {
		head[28] |= holdsGround
	}
	if s != nil {
		head[28] |= holdsShelter
	}
	raw.Write(head[:])
	if g != nil {
		var prev int16
		var b [2]byte
		for _, e := range g.Elevation {
			binary.LittleEndian.PutUint16(b[:], uint16(e-prev))
			raw.Write(b[:])
			prev = e
		}
		raw.Write(g.Surface[:])
	}
	if s != nil {
		var bitmap [shelterBitmap]byte
		for i := range int32(physics.ShelterCells) {
			if shelterHas(s, i) {
				bitmap[i/8] |= 1 << (i % 8)
			}
		}
		raw.Write(bitmap[:])
		for i := range int32(physics.ShelterCells) {
			if bitmap[i/8]&(1<<(i%8)) != 0 {
				raw.Write(s.Values[i*physics.ShelterDirections*2 : (i+1)*physics.ShelterDirections*2])
			}
		}
	}
	var out bytes.Buffer
	zw, err := gzip.NewWriterLevel(&out, 6)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(raw.Bytes()); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// ErrChunk is a payload that is not the chunk asked for.
var ErrChunk = errors.New("worldgen: not the chunk asked for")

// DecodeChunk reads chunk n's payload for the world with the id given:
// its ground and shelter, each nil if it holds none. It refuses a payload of
// another chunk, world, format or generator.
func DecodeChunk(payload []byte, n int32, world [16]byte) (*physics.GroundChunk, *physics.ShelterChunk, error) {
	zr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, nil, fmt.Errorf("worldgen: chunk %d: %w", n, err)
	}
	raw, err := io.ReadAll(io.LimitReader(zr, 1<<22))
	if err != nil {
		return nil, nil, fmt.Errorf("worldgen: chunk %d: %w", n, err)
	}
	if len(raw) < chunkHeader || !bytes.Equal(raw[:4], chunkMagic[:]) {
		return nil, nil, fmt.Errorf("%w: chunk %d has no header", ErrChunk, n)
	}
	if f := binary.LittleEndian.Uint16(raw[4:]); f != Format {
		return nil, nil, fmt.Errorf("%w: chunk %d is of format %d, not %d", ErrChunk, n, f, Format)
	}
	if got := int32(binary.LittleEndian.Uint16(raw[6:])); got != n {
		return nil, nil, fmt.Errorf("%w: chunk %d holds chunk %d", ErrChunk, n, got)
	}
	if v := binary.LittleEndian.Uint32(raw[8:]); v != Version {
		return nil, nil, fmt.Errorf("%w: chunk %d is of generator %d, not %d", ErrChunk, n, v, Version)
	}
	if !bytes.Equal(raw[12:28], world[:]) {
		return nil, nil, fmt.Errorf("%w: chunk %d is another world's", ErrChunk, n)
	}
	holds := raw[28]
	body := raw[chunkHeader:]
	var g *physics.GroundChunk
	var s *physics.ShelterChunk
	if holds&holdsGround != 0 {
		if len(body) < 3*physics.ChunkHexes {
			return nil, nil, fmt.Errorf("worldgen: chunk %d is cut short", n)
		}
		g = new(physics.GroundChunk)
		var prev int16
		for i := range g.Elevation {
			prev += int16(binary.LittleEndian.Uint16(body[2*i:]))
			g.Elevation[i] = prev
		}
		body = body[2*physics.ChunkHexes:]
		copy(g.Surface[:], body[:physics.ChunkHexes])
		body = body[physics.ChunkHexes:]
	}
	if holds&holdsShelter != 0 {
		if len(body) < shelterBitmap {
			return nil, nil, fmt.Errorf("worldgen: chunk %d's shelter is cut short", n)
		}
		s = newShelterChunk()
		bitmap := body[:shelterBitmap]
		body = body[shelterBitmap:]
		for i := range int32(physics.ShelterCells) {
			if bitmap[i/8]&(1<<(i%8)) == 0 {
				continue
			}
			size := physics.ShelterDirections * 2
			if len(body) < size {
				return nil, nil, fmt.Errorf("worldgen: chunk %d's shelter is cut short", n)
			}
			copy(s.Values[i*int32(size):], body[:size])
			body = body[size:]
		}
	}
	if len(body) != 0 {
		return nil, nil, fmt.Errorf("worldgen: chunk %d has %d bytes too many", n, len(body))
	}
	return g, s, nil
}

// Chunks are a bundle's chunks' payloads, for the world with the id given.
func (b *Bundle) Chunks(world [16]byte) ([][]byte, error) {
	out := make([][]byte, physics.ChunkCount)
	for n := range int32(physics.ChunkCount) {
		p, err := EncodeChunk(n, world, b.Ground.Chunks[n], b.Shelter.Chunks[n])
		if err != nil {
			return nil, err
		}
		out[n] = p
	}
	return out, nil
}

// Load makes a bundle from its stored parts: its records, its report and
// its chunks' payloads, for the world with the id given. It checks the
// digest, if one is given.
func Load(records, report []byte, chunks [][]byte, world [16]byte, digest []byte) (*Bundle, error) {
	b := &Bundle{Ground: new(physics.Ground), Shelter: new(physics.Shelter)}
	if err := json.Unmarshal(records, &b.Records); err != nil {
		return nil, fmt.Errorf("worldgen: the records: %w", err)
	}
	if b.Format != Format {
		return nil, fmt.Errorf("worldgen: the bundle is of format %d, not %d", b.Format, Format)
	}
	if b.Circulation == 0 {
		b.Circulation = circulationOf(b.Made)
	}
	if len(report) > 0 {
		if err := json.Unmarshal(report, &b.Report); err != nil {
			return nil, fmt.Errorf("worldgen: the report: %w", err)
		}
	}
	if len(chunks) != physics.ChunkCount {
		return nil, fmt.Errorf("worldgen: %d chunks, not %d", len(chunks), physics.ChunkCount)
	}
	for n := range int32(physics.ChunkCount) {
		g, s, err := DecodeChunk(chunks[n], n, world)
		if err != nil {
			return nil, err
		}
		b.Ground.Chunks[n], b.Shelter.Chunks[n] = g, s
	}
	b.Digest = b.digest()
	if len(digest) > 0 && !bytes.Equal(digest, b.Digest[:]) {
		return nil, fmt.Errorf("worldgen: the bundle's digest is %x, not the %x it was stored with", b.Digest, digest)
	}
	return b, nil
}

// fileMagic begins a bundle written to a file.
var fileMagic = [8]byte{'K', 'E', 'E', 'L', 'W', 'R', 'L', 'D'}

// WriteFile writes the bundle as one file: the magic, then its records,
// report and digest, and each chunk's payload, each a length and its bytes.
// The chunks are of the zero world's id.
func (b *Bundle) WriteFile(w io.Writer) error {
	records, err := json.Marshal(b.Records)
	if err != nil {
		return err
	}
	report, err := json.Marshal(b.Report)
	if err != nil {
		return err
	}
	chunks, err := b.Chunks([16]byte{})
	if err != nil {
		return err
	}
	var out bytes.Buffer
	out.Write(fileMagic[:])
	part := func(p []byte) {
		var n [4]byte
		binary.LittleEndian.PutUint32(n[:], uint32(len(p)))
		out.Write(n[:])
		out.Write(p)
	}
	part(records)
	part(report)
	part(b.Digest[:])
	for _, c := range chunks {
		part(c)
	}
	_, err = w.Write(out.Bytes())
	return err
}

// ReadFile reads a bundle WriteFile wrote.
func ReadFile(data []byte) (*Bundle, error) {
	if len(data) < len(fileMagic) || !bytes.Equal(data[:len(fileMagic)], fileMagic[:]) {
		return nil, errors.New("worldgen: not a world bundle")
	}
	data = data[len(fileMagic):]
	next := func() ([]byte, error) {
		if len(data) < 4 {
			return nil, errors.New("worldgen: the bundle is cut short")
		}
		n := binary.LittleEndian.Uint32(data)
		if uint64(len(data)-4) < uint64(n) {
			return nil, errors.New("worldgen: the bundle is cut short")
		}
		p := data[4 : 4+n]
		data = data[4+n:]
		return p, nil
	}
	records, err := next()
	if err != nil {
		return nil, err
	}
	report, err := next()
	if err != nil {
		return nil, err
	}
	digest, err := next()
	if err != nil {
		return nil, err
	}
	chunks := make([][]byte, physics.ChunkCount)
	for i := range chunks {
		if chunks[i], err = next(); err != nil {
			return nil, err
		}
	}
	return Load(records, report, chunks, [16]byte{}, digest)
}

// Terrain is the bundle as the simulation sails it: its ground, read with
// the catalog's grounding, its shelter and fetch, its start area's places,
// each a boat at rest facing the start's heading, and its circulation.
func (b *Bundle) Terrain(ground *physics.GroundPrepared) *sim.Terrain {
	g := *b.Ground
	g.Prepared = ground
	start := make([]physics.State, len(b.Start.Places))
	for i, p := range b.Start.Places {
		start[i] = physics.State{X: p[0], Y: p[1], Heading: b.Start.Heading}
	}
	return &sim.Terrain{Ground: &g, Shelter: b.Shelter, Fetch: b.Fetch, Start: start, Circulation: float64(b.Circulation)}
}
