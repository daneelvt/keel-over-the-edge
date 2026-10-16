-- SPDX-License-Identifier: AGPL-3.0-only
-- Worlds.
;

-- name: ActiveWorld :one
SELECT id, number, epoch FROM world WHERE state = 'active';

-- name: InsertWorld :one
INSERT INTO world (number, epoch, state)
VALUES ((SELECT coalesce(max(number), 0) + 1 FROM world), @epoch, 'active')
RETURNING id, number, epoch;

-- name: CreateWorldPartitions :exec
SELECT create_world_partitions(@world_id);

-- name: WorldSeed :one
SELECT seed, generator FROM world WHERE id = @world_id;

-- name: SetWorldSeed :exec
UPDATE world SET seed = @seed, generator = @generator WHERE id = @world_id;

-- name: InsertBundle :execrows
INSERT INTO world_bundle (world_id, format, generator, catalog, made, attempts, digest, records, report, generation_ms)
VALUES (@world_id, @format, @generator, @catalog, @made, @attempts, @digest, @records, @report, @generation_ms)
ON CONFLICT (world_id) DO NOTHING;

-- name: InsertChunks :copyfrom
INSERT INTO world_chunk (world_id, chunk, payload, digest) VALUES (@world_id, @chunk, @payload, @digest);

-- name: InsertPlaces :copyfrom
INSERT INTO place (world_id, number, kind, name, biome, size, x, y, area, highest)
VALUES (@world_id, @number, @kind, @name, @biome, @size, @x, @y, @area, @highest);

-- name: WorldBundle :one
SELECT format, generator, catalog, made, attempts, digest, records, report, generation_ms
FROM world_bundle WHERE world_id = @world_id;

-- name: WorldChunks :many
SELECT chunk, payload, digest FROM world_chunk WHERE world_id = @world_id ORDER BY chunk;

-- name: WorldPlaces :many
SELECT number, kind, name, biome, size, x, y, area, highest FROM place WHERE world_id = @world_id ORDER BY number;
