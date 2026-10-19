-- SPDX-License-Identifier: AGPL-3.0-only
-- Worlds.
;

-- name: ActiveWorld :one
SELECT id, number, epoch FROM world WHERE state = 'active';

-- name: InsertWorld :one
INSERT INTO world (number, epoch, state, begins_at)
VALUES ((SELECT coalesce(max(number), 0) + 1 FROM world), @epoch, 'active', now())
RETURNING id, number, epoch;

-- name: CreateWorldPartitions :exec
SELECT create_world_partitions(@world_id);

-- name: WorldSeed :one
SELECT seed, generator FROM world WHERE id = @world_id;

-- name: SetWorldSeed :exec
UPDATE world SET seed = @seed, generator = @generator WHERE id = @world_id;

-- name: InsertBundle :execrows
INSERT INTO world_bundle (world_id, format, generator, catalog, made, attempts, digest, records, report, generation_ms, chunk_key)
VALUES (@world_id, @format, @generator, @catalog, @made, @attempts, @digest, @records, @report, @generation_ms, @chunk_key)
ON CONFLICT (world_id) DO NOTHING;

-- name: SetChunkKey :execrows
-- The world's chunk key, if its bundle has none, in one statement fenced by
-- the simulation's lease.
UPDATE world_bundle SET chunk_key = @chunk_key
WHERE world_id = @world_id AND chunk_key IS NULL
  AND (SELECT epoch FROM sim_lease FOR SHARE) = @epoch::bigint;

-- name: ChunkKey :one
SELECT chunk_key FROM world_bundle WHERE world_id = @world_id;

-- name: InsertChunks :copyfrom
INSERT INTO world_chunk (world_id, chunk, payload, digest) VALUES (@world_id, @chunk, @payload, @digest);

-- name: InsertPlaces :copyfrom
INSERT INTO place (world_id, number, kind, name, biome, size, x, y, area, highest, island, details)
VALUES (@world_id, @number, @kind, @name, @biome, @size, @x, @y, @area, @highest, @island, @details);

-- name: InsertLights :copyfrom
INSERT INTO light (world_id, number, place, role, character, phase, reach, focal, tower, daymark)
VALUES (@world_id, @number, @place, @role, @character, @phase, @reach, @focal, @tower, @daymark);

-- name: WorldBundle :one
SELECT format, generator, catalog, made, attempts, digest, records, report, generation_ms, chunk_key, created_at
FROM world_bundle WHERE world_id = @world_id;

-- name: WorldChunks :many
SELECT chunk, payload, digest FROM world_chunk WHERE world_id = @world_id ORDER BY chunk;

-- name: WorldPlaces :many
SELECT number, kind, name, biome, size, x, y, area, highest, island, details FROM place WHERE world_id = @world_id ORDER BY number;

-- name: WorldLights :many
SELECT number, place, role, character, phase, reach, focal, tower, daymark FROM light WHERE world_id = @world_id ORDER BY number;

-- name: WorldTimes :one
SELECT id, number, epoch, begins_at, ends_at FROM world WHERE state = 'active';

-- name: SetWorldEnd :execrows
UPDATE world SET ends_at = @ends_at WHERE id = @id AND state = 'active';

-- name: InsertNextWorld :one
INSERT INTO world (number, epoch, state, seed, generator)
VALUES ((SELECT coalesce(max(number), 0) + 1 FROM world), @epoch, 'next', @seed, @generator)
RETURNING id, number, epoch;

-- name: NextWorld :one
SELECT w.id, w.number, w.seed, w.created_at,
  (b.world_id IS NOT NULL)::boolean AS stored, b.attempts, b.generation_ms, b.made, b.created_at AS stored_at
FROM world w LEFT JOIN world_bundle b ON b.world_id = w.id
WHERE w.state = 'next';

-- name: EndActiveWorld :execrows
UPDATE world SET state = 'ended', ends_at = @ends_at WHERE state = 'active' AND number = @number;

-- name: ActivateNextWorld :one
UPDATE world SET state = 'active', epoch = @begins_at, begins_at = @begins_at, ends_at = @ends_at
WHERE id = @id AND state = 'next'
RETURNING id, number, epoch;

-- name: DeleteNextWorld :execrows
DELETE FROM world WHERE id = @id AND state = 'next';

-- name: WorldsToDrop :many
SELECT id, number FROM world WHERE state = 'ended' AND ends_at < @before ORDER BY number;

-- name: MarkWorldDropped :execrows
UPDATE world SET state = 'dropped' WHERE id = @id AND state = 'ended';

-- name: RecentWorlds :many
SELECT number, state, seed, begins_at, ends_at, created_at FROM world ORDER BY number DESC LIMIT @lim;
