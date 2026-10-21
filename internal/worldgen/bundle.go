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
	"math"
	"slices"

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
// tables. From format 2, its towns: the buildings and props whose middles
// are in it, chunkBuilding bytes each, and the discs of harbour water whose
// centres are; so a town travels with the land it stands on. From format
// 3, its features: the roofs over its hexagons, chunkRoof bytes each, and
// the parts of features that stand in it, chunkPart bytes each. From format
// 4, a shelter's table holds three bytes a direction, the lee's fetch for
// the waves the third; before, two, and its lee is open water. Formats 1
// to 3 are still read.

// chunkMagic begins every chunk's payload.
var chunkMagic = [4]byte{'K', 'W', 'C', 'H'}

// chunkHeader is the payload's header's size.
const chunkHeader = 4 + 2 + 2 + 4 + 16 + 1

// What a payload holds, in the header's last byte.
const (
	holdsGround   = 1
	holdsShelter  = 2
	holdsTown     = 4
	holdsFeatures = 8
)

// chunkBuilding is a building's bytes in a payload: its kind and kit; its
// middle, dm east and north of the world's centre; its heading, in 256ths
// of a turn; its plot's level, dm; its storeys and a number of its own;
// its wall's and roof's colours; its shutters' and flag's; its frontage
// and depth, in fifths of a metre; its top above its plot, in quarters of
// a metre; and its town.
const chunkBuilding = 1 + 1 + 4 + 4 + 1 + 2 + 1 + 1 + 1 + 1 + 1 + 1 + 1

// chunkDisc is a disc of harbour water's bytes: its centre, dm, and its
// radius, dm.
const chunkDisc = 4 + 4 + 2

// chunkRoof is a roof's bytes: its hexagon's index in the chunk, and its
// top and underside, dm.
const chunkRoof = 4 + 2 + 2

// chunkPart is a feature's part's bytes: its feature's kind; its middle,
// dm east and north of the world's centre; its level, dm; its heading, in
// 256ths of a turn; its size, dm; its count; and a number of its own.
const chunkPart = 1 + 4 + 4 + 2 + 1 + 2 + 2 + 1

// ChunkTown is what a chunk holds on its land besides its ground: the
// towns' buildings and props whose middles are in it, the discs of harbour
// water whose centres are, the roofs over its hexagons and the features'
// parts that stand in it.
type ChunkTown struct {
	Buildings []Building
	Harbour   []Disc
	Roofs     []Roof
	Parts     []Part
}

// hasTown reports whether it holds anything of a town, and hasFeatures
// anything of a feature.
func (t *ChunkTown) hasTown() bool     { return t != nil && (len(t.Buildings) > 0 || len(t.Harbour) > 0) }
func (t *ChunkTown) hasFeatures() bool { return t != nil && (len(t.Roofs) > 0 || len(t.Parts) > 0) }

// chunkOfPoint is the chunk that holds (x, y).
func chunkOfPoint(x, y float64) int32 {
	n, _, _ := physics.ChunkOf(physics.HexCell(physics.HexAt(x, y)))
	return n
}

// Towns are what each chunk holds of the bundle's towns, by number; nil
// for a chunk that holds none.
func (b *Bundle) ChunkTowns() []*ChunkTown {
	out := make([]*ChunkTown, physics.ChunkCount)
	at := func(n int32) *ChunkTown {
		if out[n] == nil {
			out[n] = &ChunkTown{}
		}
		return out[n]
	}
	for _, bd := range b.Buildings {
		t := at(chunkOfPoint(bd.X, bd.Y))
		t.Buildings = append(t.Buildings, bd)
	}
	for _, tn := range b.Towns {
		for _, d := range tn.Harbour {
			t := at(chunkOfPoint(d.X, d.Y))
			t.Harbour = append(t.Harbour, d)
		}
	}
	for _, r := range b.Roofs {
		if n, _, ok := physics.ChunkOf(r.C, r.J); ok {
			t := at(n)
			t.Roofs = append(t.Roofs, r)
		}
	}
	for _, p := range b.Parts {
		t := at(chunkOfPoint(p.X, p.Y))
		t.Parts = append(t.Parts, p)
	}
	return out
}

// appendFeatures appends a chunk's features' bytes: its roofs, then its
// parts.
func appendFeatures(out []byte, n int32, t *ChunkTown) []byte {
	c0, j0 := physics.ChunkCorner(n)
	out = binary.LittleEndian.AppendUint16(out, uint16(len(t.Roofs)))
	for _, r := range t.Roofs {
		out = binary.LittleEndian.AppendUint32(out, uint32((r.C-c0)*physics.ChunkRows+(r.J-j0)))
		out = binary.LittleEndian.AppendUint16(out, uint16(r.Top))
		out = binary.LittleEndian.AppendUint16(out, uint16(r.Under))
	}
	out = binary.LittleEndian.AppendUint16(out, uint16(len(t.Parts)))
	for _, p := range t.Parts {
		turn := float64(2 * math.Pi)
		out = append(out, p.Kind)
		out = binary.LittleEndian.AppendUint32(out, uint32(dm(p.X)))
		out = binary.LittleEndian.AppendUint32(out, uint32(dm(p.Y)))
		out = binary.LittleEndian.AppendUint16(out, uint16(int16(dm(p.Level))))
		out = append(out, uint8(round(float64(p.Heading/turn)*256)&255))
		out = binary.LittleEndian.AppendUint16(out, uint16(min(max(dm(p.Size), 0), 65535)))
		out = binary.LittleEndian.AppendUint16(out, p.Count)
		out = append(out, p.Seed)
	}
	return out
}

// readFeatures reads a chunk's features' bytes into t, and returns what is
// left.
func readFeatures(body []byte, n int32, t *ChunkTown) ([]byte, error) {
	c0, j0 := physics.ChunkCorner(n)
	if len(body) < 2 {
		return nil, errors.New("its roofs are cut short")
	}
	k := int(binary.LittleEndian.Uint16(body))
	body = body[2:]
	if len(body) < k*chunkRoof {
		return nil, errors.New("its roofs are cut short")
	}
	for range k {
		p := body[:chunkRoof]
		body = body[chunkRoof:]
		i := int32(binary.LittleEndian.Uint32(p))
		if i < 0 || i >= physics.ChunkHexes {
			return nil, errors.New("a roof off the chunk")
		}
		t.Roofs = append(t.Roofs, Roof{C: c0 + i/physics.ChunkRows, J: j0 + i%physics.ChunkRows,
			Top: int16(binary.LittleEndian.Uint16(p[4:])), Under: int16(binary.LittleEndian.Uint16(p[6:]))})
	}
	if len(body) < 2 {
		return nil, errors.New("its parts are cut short")
	}
	k = int(binary.LittleEndian.Uint16(body))
	body = body[2:]
	if len(body) < k*chunkPart {
		return nil, errors.New("its parts are cut short")
	}
	for range k {
		p := body[:chunkPart]
		body = body[chunkPart:]
		t.Parts = append(t.Parts, Part{
			Kind:    p[0],
			X:       float64(int32(binary.LittleEndian.Uint32(p[1:]))) / 10,
			Y:       float64(int32(binary.LittleEndian.Uint32(p[5:]))) / 10,
			Level:   float64(int16(binary.LittleEndian.Uint16(p[9:]))) / 10,
			Heading: float64(float64(p[11]) * (2 * math.Pi / 256)),
			Size:    float64(binary.LittleEndian.Uint16(p[12:])) / 10,
			Count:   binary.LittleEndian.Uint16(p[14:]),
			Seed:    p[16],
		})
	}
	return body, nil
}

// dm is a length, m, in whole decimetres.
func dm(v float64) int32 { return round(float64(v * 10)) }

// appendTown appends a chunk's towns' bytes.
func appendTown(out []byte, t *ChunkTown) []byte {
	out = binary.LittleEndian.AppendUint16(out, uint16(len(t.Buildings)))
	for _, b := range t.Buildings {
		turn := float64(2 * math.Pi)
		out = append(out, b.Kind, b.Kit)
		out = binary.LittleEndian.AppendUint32(out, uint32(dm(b.X)))
		out = binary.LittleEndian.AppendUint32(out, uint32(dm(b.Y)))
		out = append(out, uint8(round(float64(b.Heading/turn)*256)&255))
		out = binary.LittleEndian.AppendUint16(out, uint16(b.Level))
		out = append(out, b.Storeys&3|b.Seed<<2, b.Wall&15|b.Roof<<4, b.Shutter&15|b.Flag<<4,
			byteOf(float64(b.Frontage*5)), byteOf(float64(b.Depth*5)), byteOf(float64((b.Top-float64(float64(b.Level)*0.1))*4)), uint8(b.Town))
	}
	out = binary.LittleEndian.AppendUint16(out, uint16(len(t.Harbour)))
	for _, d := range t.Harbour {
		out = binary.LittleEndian.AppendUint32(out, uint32(dm(d.X)))
		out = binary.LittleEndian.AppendUint32(out, uint32(dm(d.Y)))
		out = binary.LittleEndian.AppendUint16(out, uint16(dm(d.R)))
	}
	return out
}

// readTown reads a chunk's towns' bytes, and returns what is left.
func readTown(body []byte) (*ChunkTown, []byte, error) {
	t := &ChunkTown{}
	if len(body) < 2 {
		return nil, nil, errors.New("its town is cut short")
	}
	n := int(binary.LittleEndian.Uint16(body))
	body = body[2:]
	if len(body) < n*chunkBuilding {
		return nil, nil, errors.New("its buildings are cut short")
	}
	for range n {
		p := body[:chunkBuilding]
		body = body[chunkBuilding:]
		b := Building{
			Kind: p[0], Kit: p[1],
			X:       float64(int32(binary.LittleEndian.Uint32(p[2:]))) / 10,
			Y:       float64(int32(binary.LittleEndian.Uint32(p[6:]))) / 10,
			Heading: float64(float64(p[10]) * (2 * math.Pi / 256)),
			Level:   int16(binary.LittleEndian.Uint16(p[11:])),
			Storeys: p[13] & 3, Seed: p[13] >> 2,
			Wall: p[14] & 15, Roof: p[14] >> 4,
			Shutter: p[15] & 15, Flag: p[15] >> 4,
			Frontage: float64(p[16]) / 5, Depth: float64(p[17]) / 5,
			Town: int32(p[19]),
		}
		b.Top = float64(float64(b.Level)*0.1) + float64(float64(p[18])/4)
		t.Buildings = append(t.Buildings, b)
	}
	if len(body) < 2 {
		return nil, nil, errors.New("its harbour is cut short")
	}
	n = int(binary.LittleEndian.Uint16(body))
	body = body[2:]
	if len(body) < n*chunkDisc {
		return nil, nil, errors.New("its harbour is cut short")
	}
	for range n {
		p := body[:chunkDisc]
		body = body[chunkDisc:]
		t.Harbour = append(t.Harbour, Disc{
			X: float64(int32(binary.LittleEndian.Uint32(p))) / 10,
			Y: float64(int32(binary.LittleEndian.Uint32(p[4:]))) / 10,
			R: float64(binary.LittleEndian.Uint16(p[8:])) / 10,
		})
	}
	return t, body, nil
}

// shelterBitmap is the size of a payload's bitmap of cells with a table.
const shelterBitmap = (physics.ShelterCells + 7) / 8

// EncodeChunk is chunk n's payload, for the world with the id given, with
// no town.
func EncodeChunk(n int32, world [16]byte, g *physics.GroundChunk, s *physics.ShelterChunk) ([]byte, error) {
	return EncodeChunkTown(n, world, g, s, nil)
}

// EncodeChunkTown is chunk n's payload, for the world with the id given,
// with what it holds of the towns, if any.
func EncodeChunkTown(n int32, world [16]byte, g *physics.GroundChunk, s *physics.ShelterChunk, t *ChunkTown) ([]byte, error) {
	return encodeChunk(n, world, g, s, t, Format, Version)
}

// encodeChunk is chunk n's payload in the format given, of the generator
// given; a format 1 payload holds no town, and one of format 2 no feature.
func encodeChunk(n int32, world [16]byte, g *physics.GroundChunk, s *physics.ShelterChunk, t *ChunkTown, format uint16, generator uint32) ([]byte, error) {
	if format < 2 {
		t = nil
	}
	town := t != nil && (format < 3 || t.hasTown())
	features := format >= 3 && t.hasFeatures()
	var raw bytes.Buffer
	var head [chunkHeader]byte
	copy(head[:4], chunkMagic[:])
	binary.LittleEndian.PutUint16(head[4:], format)
	binary.LittleEndian.PutUint16(head[6:], uint16(n))
	binary.LittleEndian.PutUint32(head[8:], generator)
	copy(head[12:28], world[:])
	if g != nil {
		head[28] |= holdsGround
	}
	if s != nil {
		head[28] |= holdsShelter
	}
	if town {
		head[28] |= holdsTown
	}
	if features {
		head[28] |= holdsFeatures
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
			if bitmap[i/8]&(1<<(i%8)) == 0 {
				continue
			}
			v := s.Values[i*physics.ShelterDirections*physics.ShelterStride : (i+1)*physics.ShelterDirections*physics.ShelterStride]
			if format >= 4 {
				raw.Write(v)
				continue
			}
			for k := 0; k < len(v); k += physics.ShelterStride {
				raw.Write(v[k : k+2])
			}
		}
	}
	if town {
		raw.Write(appendTown(nil, t))
	}
	if features {
		raw.Write(appendFeatures(nil, n, t))
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

// DecodeChunk reads chunk n's payload for the world with the id given, of
// this generator: its ground and shelter, each nil if it holds none. It
// refuses a payload of another chunk, world, format or generator.
func DecodeChunk(payload []byte, n int32, world [16]byte) (*physics.GroundChunk, *physics.ShelterChunk, error) {
	g, s, _, err := DecodeChunkOf(payload, n, world, Version)
	return g, s, err
}

// DecodeChunkOf reads chunk n's payload for the world with the id given,
// made by the generator given: its ground, its shelter and its towns, each
// nil if it holds none. It refuses a payload of another chunk, world or
// generator, or of a format it does not know.
func DecodeChunkOf(payload []byte, n int32, world [16]byte, generator int) (*physics.GroundChunk, *physics.ShelterChunk, *ChunkTown, error) {
	zr, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("worldgen: chunk %d: %w", n, err)
	}
	raw, err := io.ReadAll(io.LimitReader(zr, 1<<22))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("worldgen: chunk %d: %w", n, err)
	}
	if len(raw) < chunkHeader || !bytes.Equal(raw[:4], chunkMagic[:]) {
		return nil, nil, nil, fmt.Errorf("%w: chunk %d has no header", ErrChunk, n)
	}
	format := binary.LittleEndian.Uint16(raw[4:])
	if format < 1 || format > Format {
		return nil, nil, nil, fmt.Errorf("%w: chunk %d is of format %d, not 1 to %d", ErrChunk, n, format, Format)
	}
	if got := int32(binary.LittleEndian.Uint16(raw[6:])); got != n {
		return nil, nil, nil, fmt.Errorf("%w: chunk %d holds chunk %d", ErrChunk, n, got)
	}
	if v := binary.LittleEndian.Uint32(raw[8:]); v != uint32(generator) {
		return nil, nil, nil, fmt.Errorf("%w: chunk %d is of generator %d, not %d", ErrChunk, n, v, generator)
	}
	if !bytes.Equal(raw[12:28], world[:]) {
		return nil, nil, nil, fmt.Errorf("%w: chunk %d is another world's", ErrChunk, n)
	}
	holds := raw[28]
	body := raw[chunkHeader:]
	var g *physics.GroundChunk
	var s *physics.ShelterChunk
	var t *ChunkTown
	if holds&holdsGround != 0 {
		if len(body) < 3*physics.ChunkHexes {
			return nil, nil, nil, fmt.Errorf("worldgen: chunk %d is cut short", n)
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
			return nil, nil, nil, fmt.Errorf("worldgen: chunk %d's shelter is cut short", n)
		}
		s = newShelterChunk()
		bitmap := body[:shelterBitmap]
		body = body[shelterBitmap:]
		for i := range int32(physics.ShelterCells) {
			if bitmap[i/8]&(1<<(i%8)) == 0 {
				continue
			}
			width := 2
			if format >= 4 {
				width = physics.ShelterStride
			}
			size := physics.ShelterDirections * width
			if len(body) < size {
				return nil, nil, nil, fmt.Errorf("worldgen: chunk %d's shelter is cut short", n)
			}
			v := s.Values[i*physics.ShelterDirections*physics.ShelterStride:]
			for k := range physics.ShelterDirections {
				copy(v[k*physics.ShelterStride:k*physics.ShelterStride+width], body[k*width:(k+1)*width])
			}
			body = body[size:]
		}
	}
	if holds&holdsTown != 0 && format >= 2 {
		if t, body, err = readTown(body); err != nil {
			return nil, nil, nil, fmt.Errorf("worldgen: chunk %d: %w", n, err)
		}
	}
	if holds&holdsFeatures != 0 && format >= 3 {
		if t == nil {
			t = &ChunkTown{}
		}
		if body, err = readFeatures(body, n, t); err != nil {
			return nil, nil, nil, fmt.Errorf("worldgen: chunk %d: %w", n, err)
		}
	}
	if len(body) != 0 {
		return nil, nil, nil, fmt.Errorf("worldgen: chunk %d has %d bytes too many", n, len(body))
	}
	return g, s, t, nil
}

// Chunks are a bundle's chunks' payloads, for the world with the id given.
func (b *Bundle) Chunks(world [16]byte) ([][]byte, error) {
	out := make([][]byte, physics.ChunkCount)
	towns := b.ChunkTowns()
	for n := range int32(physics.ChunkCount) {
		if b.Format < 2 {
			towns[n] = nil
		}
		p, err := b.encodeChunk(n, world, b.Ground.Chunks[n], b.Shelter.Chunks[n], towns[n])
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
	if b.Format < 1 || b.Format > Format {
		return nil, fmt.Errorf("worldgen: the bundle is of format %d, not 1 to %d", b.Format, Format)
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
		g, s, t, err := DecodeChunkOf(chunks[n], n, world, b.Generator)
		if err != nil {
			return nil, err
		}
		b.Ground.Chunks[n], b.Shelter.Chunks[n] = g, s
		if t != nil {
			b.Buildings = append(b.Buildings, t.Buildings...)
			b.Roofs = append(b.Roofs, t.Roofs...)
			b.Parts = append(b.Parts, t.Parts...)
		}
	}
	slices.SortStableFunc(b.Buildings, func(p, q Building) int { return int(p.Town) - int(q.Town) })
	rec, err := withoutCirculation(records)
	if err != nil {
		return nil, err
	}
	b.Digest = b.digestOf(rec)
	if len(digest) > 0 && !bytes.Equal(digest, b.Digest[:]) {
		return nil, fmt.Errorf("worldgen: the bundle's digest is %x, not the %x it was stored with", b.Digest, digest)
	}
	return b, nil
}

// withoutCirculation is the records' bytes as stored without their
// circulation member, which the digest leaves out: the bytes the digest was
// taken of when the bundle was made. They are as json.Marshal wrote them,
// with no space between members.
func withoutCirculation(records []byte) ([]byte, error) {
	d := json.NewDecoder(bytes.NewReader(records))
	if t, err := d.Token(); err != nil || t != json.Delim('{') {
		return nil, errors.New("worldgen: the records are not an object")
	}
	for first := true; d.More(); first = false {
		start := d.InputOffset()
		key, err := d.Token()
		if err != nil {
			return nil, fmt.Errorf("worldgen: the records: %w", err)
		}
		var value json.RawMessage
		if err := d.Decode(&value); err != nil {
			return nil, fmt.Errorf("worldgen: the records: %w", err)
		}
		if key != "circulation" {
			continue
		}
		// The comma before it goes with it, or the one after it if it is
		// the first.
		end := d.InputOffset()
		if first && end < int64(len(records)) && records[end] == ',' {
			end++
		}
		return slices.Concat(records[:start], records[end:]), nil
	}
	return records, nil
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
		start[i] = physics.State{X: p[0], Y: p[1], Heading: b.Start.HeadingOf(i)}
	}
	return &sim.Terrain{Ground: &g, Shelter: b.Shelter, Fetch: b.Fetch, Start: start, Circulation: float64(b.Circulation)}
}

// encodeChunk is chunk n's payload as the bundle's format writes it: of the
// generator that made it.
func (b *Bundle) encodeChunk(n int32, world [16]byte, g *physics.GroundChunk, s *physics.ShelterChunk, t *ChunkTown) ([]byte, error) {
	return encodeChunk(n, world, g, s, t, uint16(b.Format), uint32(b.Generator))
}

// byteOf is v rounded to the nearest whole number, within a byte's range.
func byteOf(v float64) uint8 { return uint8(min(max(round(v), 0), 255)) }
