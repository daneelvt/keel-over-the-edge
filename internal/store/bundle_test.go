// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// testBundle is a bundle of made-up parts: 256 payloads of random bytes,
// some large, and two places.
func testBundle(t *testing.T) *store.Bundle {
	t.Helper()
	b := &store.Bundle{
		Seed: 1<<63 + 5, Format: 1, Generator: 3, Catalog: "abc", Made: 1<<64 - 1, Attempts: 2,
		Digest: bytes.Repeat([]byte{7}, 32), Records: []byte(`{"islands":[]}`), Report: []byte(`{"rules":[]}`),
		GenerationMs: 3400,
		Places: []store.Place{
			{Number: 0, Kind: store.PlaceIsland, Name: "Port Royal", Biome: "wooded", Size: "large", X: 1, Y: -2, Area: 2e5, Highest: 40},
			{Number: 1, Kind: store.PlaceGroup, Name: "The Brothers", Biome: "rocky", X: 3000, Y: 2},
		},
	}
	for i := range 256 {
		p := make([]byte, 20+i*(i%7)*40)
		if _, err := rand.Read(p); err != nil {
			t.Fatal(err)
		}
		b.Chunks = append(b.Chunks, p)
	}
	return b
}

func TestBundleRoundTrip(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	w, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadBundle(ctx, w.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a world with no bundle: %v", err)
	}
	if _, _, ok, err := s.WorldSeed(ctx, w.ID); ok || err != nil {
		t.Fatalf("a world with no terrain has a seed: %v %v", ok, err)
	}
	l := newLease(t, u, "test", store.LeaseOptions{})
	epoch := take(t, l)
	b := testBundle(t)
	// Fenced: another epoch's write stores nothing.
	if err := s.StoreBundle(ctx, w.ID, epoch+1, b); !errors.Is(err, store.ErrFenced) {
		t.Fatalf("a bundle stored by another epoch: %v", err)
	}
	if err := s.StoreBundle(ctx, w.ID, epoch, b); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadBundle(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Seed != b.Seed || got.Made != b.Made || got.Generator != b.Generator || got.Attempts != b.Attempts ||
		got.GenerationMs != b.GenerationMs || !bytes.Equal(got.Digest, b.Digest) || !bytes.Equal(got.Records, b.Records) {
		t.Errorf("the bundle reads back as %+v", got)
	}
	if len(got.Chunks) != 256 {
		t.Fatalf("%d chunks", len(got.Chunks))
	}
	for i := range got.Chunks {
		if !bytes.Equal(got.Chunks[i], b.Chunks[i]) {
			t.Fatalf("chunk %d differs", i)
		}
	}
	if len(got.Places) != 2 || got.Places[0] != b.Places[0] || got.Places[1] != b.Places[1] {
		t.Errorf("the places read back as %+v", got.Places)
	}
	seed, generator, ok, err := s.WorldSeed(ctx, w.ID)
	if err != nil || !ok || seed != b.Seed || generator != b.Generator {
		t.Errorf("the world's seed is %d (generator %d, %v, %v)", seed, generator, ok, err)
	}
	// A second bundle changes nothing: a world's terrain is made once.
	other := testBundle(t)
	other.Seed = 9
	if err := s.StoreBundle(ctx, w.ID, epoch, other); err != nil {
		t.Fatal(err)
	}
	again, err := s.LoadBundle(ctx, w.ID)
	if err != nil || again.Seed != b.Seed || !bytes.Equal(again.Chunks[100], b.Chunks[100]) {
		t.Errorf("a second bundle replaced the first: %v", err)
	}
	// A chunk's payload that no longer matches its digest is refused.
	pool := storetest.PoolOn(t, u)
	must(t, pool, "UPDATE world_chunk SET payload = '\\x00' WHERE chunk = 7")
	if _, err := s.LoadBundle(ctx, w.ID); err == nil {
		t.Error("a chunk not matching its digest was read")
	}
	// The payloads are stored as they are, out of line, not compressed
	// again.
	var storage string
	if err := pool.QueryRow(ctx, `SELECT a.attstorage FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
		WHERE c.relname = 'world_chunk_w1' AND a.attname = 'payload'`).Scan(&storage); err != nil || storage != "e" {
		t.Errorf("the partition's payload has storage %q (%v), not external", storage, err)
	}
}

func TestBundleMigration(t *testing.T) {
	ctx := context.Background()
	u := storetest.Empty(t)
	if _, err := store.Migrate(ctx, u, 4); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	w, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Migrate(ctx, u, 0); err != nil {
		t.Fatal(err)
	}
	pool := storetest.PoolOn(t, u)
	checkPartitioned(t, pool)
	// The existing world has its partitions, and no seed until it is made.
	for _, table := range []string{"world_bundle_w1", "world_chunk_w1", "place_w1"} {
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_class WHERE relname = $1", table).Scan(&n); err != nil || n != 1 {
			t.Errorf("no partition %s (%v)", table, err)
		}
	}
	if _, _, ok, err := s.WorldSeed(ctx, w.ID); ok || err != nil {
		t.Errorf("an existing world has a seed after the migration: %v %v", ok, err)
	}
	refused(t, exec(t, pool, "INSERT INTO place (world_id, number, kind, name, biome, x, y) VALUES ($1, 0, 'port', 'X', 'b', 0, 0)", w.ID), "23514")
	refused(t, exec(t, pool, "INSERT INTO world_chunk (world_id, chunk, payload, digest) VALUES ($1, 256, '\\x00', $2)", w.ID, bytes.Repeat([]byte{1}, 32)), "23514")
}

// TestChunkKey: a bundle stored with its chunk key reads it back; one
// stored without, as a world made before keys were, gets one once, and only
// from the lease's holder.
func TestChunkKey(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	w, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	key := func(b byte) []byte { return bytes.Repeat([]byte{b}, store.ChunkKeySize) }
	l := newLease(t, u, "test", store.LeaseOptions{})
	epoch := take(t, l)
	if _, err := s.SetChunkKey(ctx, w.ID, epoch, key(1)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a key for a world with no bundle: %v", err)
	}
	b := testBundle(t)
	if err := s.StoreBundle(ctx, w.ID, epoch, b); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadBundle(ctx, w.ID)
	if err != nil || got.ChunkKey != nil {
		t.Fatalf("a bundle stored without a key reads back with %x (%v)", got.ChunkKey, err)
	}
	// Fenced: another epoch sets nothing.
	if _, err := s.SetChunkKey(ctx, w.ID, epoch+1, key(2)); !errors.Is(err, store.ErrFenced) {
		t.Fatalf("a key set by another epoch: %v", err)
	}
	if k, err := s.SetChunkKey(ctx, w.ID, epoch, key(3)); err != nil || !bytes.Equal(k, key(3)) {
		t.Fatalf("the key set is %x (%v)", k, err)
	}
	// Once: a second key leaves the first, and is told it.
	if k, err := s.SetChunkKey(ctx, w.ID, epoch, key(4)); err != nil || !bytes.Equal(k, key(3)) {
		t.Fatalf("a second key: the bundle's is %x (%v)", k, err)
	}
	if got, err := s.LoadBundle(ctx, w.ID); err != nil || !bytes.Equal(got.ChunkKey, key(3)) {
		t.Fatalf("the bundle reads back with %x (%v)", got.ChunkKey, err)
	}
	if _, err := s.SetChunkKey(ctx, w.ID, epoch, key(5)[:16]); err == nil {
		t.Error("a key of 16 bytes was taken")
	}
	pool := storetest.PoolOn(t, u)
	refused(t, exec(t, pool, "UPDATE world_bundle SET chunk_key = '\\x0102'"), "23514")
}

// TestChunkKeyMigration: a bundle stored before the chunk key's migration
// keeps its rows and has no key until one is set.
func TestChunkKeyMigration(t *testing.T) {
	ctx := context.Background()
	u := storetest.Empty(t)
	if _, err := store.Migrate(ctx, u, 5); err != nil {
		t.Fatal(err)
	}
	pool := storetest.PoolOn(t, u)
	var w [16]byte
	if err := pool.QueryRow(ctx, `INSERT INTO world (number, epoch, state) VALUES (1, now(), 'active') RETURNING id`).Scan(&w); err != nil {
		t.Fatal(err)
	}
	must(t, pool, "SELECT create_world_partitions($1)", w)
	must(t, pool, `INSERT INTO world_bundle (world_id, format, generator, catalog, made, attempts, digest, records, report, generation_ms)
		VALUES ($1, 1, 1, 'c', 1, 1, $2, '\x7b7d', '{}', 5)`, w, bytes.Repeat([]byte{9}, 32))
	if _, err := store.Migrate(ctx, u, 0); err != nil {
		t.Fatal(err)
	}
	var have []byte
	var format int
	if err := pool.QueryRow(ctx, "SELECT format, chunk_key FROM world_bundle WHERE world_id = $1", w).Scan(&format, &have); err != nil || format != 1 || have != nil {
		t.Fatalf("the bundle after the migration: format %d, key %x (%v)", format, have, err)
	}
}
