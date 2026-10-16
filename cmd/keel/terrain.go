// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/config"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// generator makes the world of a seed: worldgen.Generate unless a test
// sets another.
type generator func(seed uint64) (*worldgen.Bundle, error)

// catalogGenerator makes worlds from the catalog's world values.
func catalogGenerator(cat *catalog.Catalog) generator {
	return func(seed uint64) (*worldgen.Bundle, error) { return worldgen.Generate(seed, cat) }
}

// terrainBeat is how often the heartbeat beats while a world is made.
const terrainBeat = time.Second

// terrain is the world's terrain as the server holds it: its bundle, its
// chunks' payloads as stored, which the page fetches, and its chunk key,
// which signs their addresses.
type terrain struct {
	bundle   *worldgen.Bundle
	payloads [][]byte
	key      []byte
}

// worldTerrain is the world's terrain: its bundle read back from the
// database, as every start reads it. A world without one gets one first:
// made from its seed, or KEEL_WORLD_SEED, or a seed drawn from crypto/rand,
// on one goroutine while this one beats the heartbeat, then stored, fenced
// by the lease's epoch, with a chunk key of its own. A world's terrain is
// never made again; one stored without a chunk key gets one now, once.
func worldTerrain(ctx context.Context, db database, sailed store.World, epoch int64, cfg config.Config,
	gen generator, health *obs.Health, log *slog.Logger) (*terrain, error) {
	stored, err := db.LoadBundle(ctx, sailed.ID)
	if errors.Is(err, store.ErrNotFound) {
		if err := makeTerrain(ctx, db, sailed, epoch, cfg, gen, health, log); err != nil {
			return nil, err
		}
		stored, err = db.LoadBundle(ctx, sailed.ID)
	}
	if err != nil {
		return nil, err
	}
	if stored.ChunkKey == nil {
		key, err := chunkKey()
		if err != nil {
			return nil, err
		}
		if stored.ChunkKey, err = db.SetChunkKey(ctx, sailed.ID, epoch, key); err != nil {
			return nil, fmt.Errorf("the world's chunk key: %w", err)
		}
		log.Info("the world's terrain had no chunk key: it has one now")
	}
	start := time.Now()
	b, err := worldgen.Load(stored.Records, stored.Report, stored.Chunks, sailed.ID, stored.Digest)
	if err != nil {
		return nil, err
	}
	b.Seed = stored.Seed
	log.Info("the world's terrain is loaded", "seed", b.Seed, "generator", b.Generator, "islands", len(b.Islands),
		"digest", b.DigestHex(), "took", time.Since(start).Round(time.Millisecond).String())
	if b.Generator != worldgen.Version {
		log.Warn("the world's terrain was made by another generator: it is sailed as it was made",
			"generator", b.Generator, "this_generator", worldgen.Version)
	}
	return &terrain{bundle: b, payloads: stored.Chunks, key: stored.ChunkKey}, nil
}

// chunkKey is a new chunk key: random bytes from crypto/rand.
func chunkKey() ([]byte, error) {
	key := make([]byte, store.ChunkKeySize)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	return key, nil
}

// makeTerrain makes and stores the world's terrain.
func makeTerrain(ctx context.Context, db database, sailed store.World, epoch int64, cfg config.Config,
	gen generator, health *obs.Health, log *slog.Logger) error {
	seed, _, ok, err := db.WorldSeed(ctx, sailed.ID)
	if err != nil {
		return err
	}
	switch {
	case ok:
	case cfg.HasWorldSeed:
		seed = cfg.WorldSeed
	default:
		var b [8]byte
		if _, err := rand.Read(b[:]); err != nil {
			return err
		}
		seed = binary.LittleEndian.Uint64(b[:])
	}
	health.Waiting("the world's terrain")
	log.Info("the world has no terrain: making it", "world", sailed.Number, "seed", seed, "generator", worldgen.Version)
	type made struct {
		b   *worldgen.Bundle
		err error
	}
	done := make(chan made, 1)
	start := time.Now()
	go func() {
		b, err := gen(seed)
		done <- made{b, err}
	}()
	t := time.NewTicker(terrainBeat)
	defer t.Stop()
	var m made
wait:
	for {
		select {
		case m = <-done:
			break wait
		case <-t.C:
			health.Beat()
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	took := time.Since(start)
	switch {
	case errors.Is(m.err, worldgen.ErrInvalid):
		log.Error("no attempt passed the world's rules: it is sailed as the last was made", "seed", seed, "attempts", m.b.Attempts)
	case m.err != nil:
		return fmt.Errorf("making the world's terrain: %w", m.err)
	}
	b := m.b
	log.Info("the world's terrain is made", "seed", seed, "made_from", b.Made, "attempts", b.Attempts,
		"islands", len(b.Islands), "land_share", fmt.Sprintf("%.2f%%", b.Report.LandShare),
		"digest", b.DigestHex(), "took", took.Round(time.Millisecond).String())
	health.Beat()
	sb, err := storedBundle(b, sailed.ID, took)
	if err != nil {
		return err
	}
	if err := db.StoreBundle(ctx, sailed.ID, epoch, sb); err != nil {
		return fmt.Errorf("storing the world's terrain: %w", err)
	}
	return nil
}

// storedBundle is a bundle as the database stores it, for the world with
// the id given.
func storedBundle(b *worldgen.Bundle, world [16]byte, took time.Duration) (*store.Bundle, error) {
	records, err := json.Marshal(b.Records)
	if err != nil {
		return nil, err
	}
	report, err := json.Marshal(b.Report)
	if err != nil {
		return nil, err
	}
	chunks, err := b.Chunks(world)
	if err != nil {
		return nil, err
	}
	key, err := chunkKey()
	if err != nil {
		return nil, err
	}
	sb := &store.Bundle{
		Seed: b.Seed, Format: b.Format, Generator: b.Generator, Catalog: catalog.Version, Made: b.Made,
		Attempts: b.Attempts, Digest: b.Digest[:], Records: records, Report: report,
		GenerationMs: int(took.Milliseconds()), Chunks: chunks, ChunkKey: key,
	}
	for _, is := range b.Islands {
		sb.Places = append(sb.Places, store.Place{
			Number: int(is.Number), Kind: store.PlaceIsland, Name: is.Name, Biome: is.Biome, Size: is.Size,
			X: is.X, Y: is.Y, Area: is.Area, Highest: is.Highest,
		})
	}
	for _, g := range b.Groups {
		sb.Places = append(sb.Places, store.Place{
			Number: len(b.Islands) + int(g.Number), Kind: store.PlaceGroup, Name: g.Name, Biome: g.Biome, X: g.X, Y: g.Y,
		})
	}
	return sb, nil
}
