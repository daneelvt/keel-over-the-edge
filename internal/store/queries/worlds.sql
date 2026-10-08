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
