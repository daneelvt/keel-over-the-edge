// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// Bundle is a world's terrain as stored: what made it, its digest, its
// records and report as JSON, its chunks' payloads by number, and its
// places.
type Bundle struct {
	Seed         uint64 // the world's seed
	Format       int
	Generator    int
	Catalog      string
	Made         uint64 // the seed of the attempt that passed
	Attempts     int
	Digest       []byte
	Records      []byte
	Report       []byte
	GenerationMs int
	Chunks       [][]byte
	Places       []Place
	Lights       []Light
	// ChunkKey is the world's chunk key, 32 bytes, or nil if its bundle was
	// stored without one.
	ChunkKey []byte
	// Stored is when the bundle was stored: when the world's terrain was
	// made.
	Stored time.Time
}

// Place is an island, a group of rocks, or another place of the world (a
// port, a reef, a wreck …, by the catalog's kinds), by its number in the
// world.
type Place struct {
	Number  int
	Kind    string // PlaceIsland, PlaceGroup, or the catalog's kind
	Name    string
	Biome   string // "" for a place offshore
	Size    string // an island's size class; "" for any other place
	X, Y    float64
	Area    float64 // an island's land, m²; 0 for any other place
	Highest float64 // an island's highest point, m; 0 for any other place
	// Island is the island another place is on or by, -1 for none or for
	// an island or group; Details, what its kind measures, as JSON, or nil.
	Island  int
	Details []byte
}

// Light is a lighthouse's light, by its number in the world.
type Light struct {
	Number    int
	Place     int    // its lighthouse
	Role      string // main, port, edge or hazard
	Character string // as charts write it
	Phase     int64  // µs
	Range     float64
	Focal     float64
	Tower     float64
	Daymark   int
}

// The kinds of place.
const (
	PlaceIsland = "island"
	PlaceGroup  = "group"
)

// WorldSeed is the seed and generator of the world's terrain; ok is false
// while it has none.
func (s *Store) WorldSeed(ctx context.Context, world [16]byte) (seed uint64, generator int, ok bool, err error) {
	row, err := s.q.WorldSeed(ctx, pgtype.UUID{Bytes: world, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, 0, false, ErrNotFound
	}
	if err != nil || !row.Seed.Valid {
		return 0, 0, false, err
	}
	return uint64(row.Seed.Int64), int(row.Generator.Int32), true, nil
}

// LoadBundle reads the world's bundle, every chunk checked against its
// digest; ErrNotFound if it has none.
func (s *Store) LoadBundle(ctx context.Context, world [16]byte) (*Bundle, error) {
	id := pgtype.UUID{Bytes: world, Valid: true}
	row, err := s.q.WorldBundle(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	seed, _, _, err := s.WorldSeed(ctx, world)
	if err != nil {
		return nil, err
	}
	b := &Bundle{
		Seed: seed, Format: int(row.Format), Generator: int(row.Generator), Catalog: row.Catalog,
		Made: uint64(row.Made), Attempts: int(row.Attempts), Digest: row.Digest, Records: row.Records,
		Report: row.Report, GenerationMs: int(row.GenerationMs), ChunkKey: row.ChunkKey,
		Stored: row.CreatedAt,
	}
	chunks, err := s.q.WorldChunks(ctx, id)
	if err != nil {
		return nil, err
	}
	for i, c := range chunks {
		if int(c.Chunk) != i {
			return nil, fmt.Errorf("store: the world's chunk %d is missing", i)
		}
		if sum := sha256.Sum256(c.Payload); string(sum[:]) != string(c.Digest) {
			return nil, fmt.Errorf("store: the world's chunk %d does not match its digest", i)
		}
		b.Chunks = append(b.Chunks, c.Payload)
	}
	places, err := s.q.WorldPlaces(ctx, id)
	if err != nil {
		return nil, err
	}
	for _, p := range places {
		island := -1
		if p.Island.Valid {
			island = int(p.Island.Int32)
		}
		b.Places = append(b.Places, Place{
			Number: int(p.Number), Kind: p.Kind, Name: p.Name, Biome: p.Biome.String, Size: p.Size.String,
			X: p.X, Y: p.Y, Area: p.Area.Float64, Highest: p.Highest.Float64, Island: island, Details: p.Details,
		})
	}
	lights, err := s.q.WorldLights(ctx, id)
	if err != nil {
		return nil, err
	}
	for _, l := range lights {
		b.Lights = append(b.Lights, Light{
			Number: int(l.Number), Place: int(l.Place), Role: l.Role, Character: l.Character, Phase: l.Phase,
			Range: l.Reach, Focal: l.Focal, Tower: l.Tower, Daymark: int(l.Daymark),
		})
	}
	return b, nil
}

// StoreBundle stores the world's bundle, its seed and generator, its chunks
// and its places, in one transaction fenced by the lease's epoch as the
// world's writes are. If the world has a bundle already it changes nothing:
// a world's terrain is made once.
func (s *Store) StoreBundle(ctx context.Context, world [16]byte, epoch int64, b *Bundle) error {
	id := pgtype.UUID{Bytes: world, Valid: true}
	return s.inTx(ctx, func(q *db.Queries) error {
		e, err := q.LeaseEpochForShare(ctx)
		if err != nil {
			return err
		}
		if e != epoch {
			return fmt.Errorf("%w: the epoch is %d, the writer's %d", ErrFenced, e, epoch)
		}
		n, err := q.InsertBundle(ctx, db.InsertBundleParams{
			WorldID: id, Format: int16(b.Format), Generator: int32(b.Generator), Catalog: b.Catalog,
			Made: int64(b.Made), Attempts: int32(b.Attempts), Digest: b.Digest, Records: b.Records,
			Report: b.Report, GenerationMs: int32(b.GenerationMs), ChunkKey: b.ChunkKey,
		})
		if err != nil || n == 0 {
			return err
		}
		if err := q.SetWorldSeed(ctx, db.SetWorldSeedParams{
			WorldID: id, Seed: pgtype.Int8{Int64: int64(b.Seed), Valid: true}, Generator: pgtype.Int4{Int32: int32(b.Generator), Valid: true},
		}); err != nil {
			return err
		}
		rows := make([]db.InsertChunksParams, len(b.Chunks))
		for i, c := range b.Chunks {
			sum := sha256.Sum256(c)
			rows[i] = db.InsertChunksParams{WorldID: id, Chunk: int16(i), Payload: c, Digest: sum[:]}
		}
		if _, err := q.InsertChunks(ctx, rows); err != nil {
			return err
		}
		places := make([]db.InsertPlacesParams, len(b.Places))
		for i, p := range b.Places {
			r := db.InsertPlacesParams{WorldID: id, Number: int32(p.Number), Kind: p.Kind, Name: p.Name,
				Biome: pgtype.Text{String: p.Biome, Valid: p.Biome != ""}, X: p.X, Y: p.Y, Details: p.Details}
			if p.Kind == PlaceIsland {
				r.Size = pgtype.Text{String: p.Size, Valid: true}
				r.Area = pgtype.Float8{Float64: p.Area, Valid: true}
				r.Highest = pgtype.Float8{Float64: p.Highest, Valid: true}
			}
			if p.Island >= 0 {
				r.Island = pgtype.Int4{Int32: int32(p.Island), Valid: true}
			}
			places[i] = r
		}
		if _, err := q.InsertPlaces(ctx, places); err != nil {
			return err
		}
		lights := make([]db.InsertLightsParams, len(b.Lights))
		for i, l := range b.Lights {
			lights[i] = db.InsertLightsParams{WorldID: id, Number: int32(l.Number), Place: int32(l.Place), Role: l.Role,
				Character: l.Character, Phase: l.Phase, Reach: l.Range, Focal: l.Focal, Tower: l.Tower, Daymark: int16(l.Daymark)}
		}
		_, err = q.InsertLights(ctx, lights)
		return err
	})
}

// ChunkKeySize is a world's chunk key's length, in bytes.
const ChunkKeySize = 32

// SetChunkKey gives the world's bundle the chunk key, if it has none, in
// one statement fenced by the lease's epoch, and returns the key the bundle
// then has: this one, or the one it had. A write by another epoch is
// refused with ErrFenced; a world with no bundle is ErrNotFound.
func (s *Store) SetChunkKey(ctx context.Context, world [16]byte, epoch int64, key []byte) ([]byte, error) {
	if len(key) != ChunkKeySize {
		return nil, fmt.Errorf("store: a chunk key of %d bytes", len(key))
	}
	id := pgtype.UUID{Bytes: world, Valid: true}
	if _, err := s.q.SetChunkKey(ctx, db.SetChunkKeyParams{ChunkKey: key, WorldID: id, Epoch: epoch}); err != nil {
		return nil, err
	}
	have, err := s.q.ChunkKey(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if have == nil {
		return nil, fmt.Errorf("%w: the world's chunk key was not set by epoch %d", ErrFenced, epoch)
	}
	return have, nil
}
