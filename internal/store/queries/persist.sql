-- SPDX-License-Identifier: AGPL-3.0-only
-- The simulation's lease, checkpoints and events.
;

-- name: TryLease :one
SELECT pg_try_advisory_lock(@key::bigint);

-- name: ReleaseLease :one
SELECT pg_advisory_unlock(@key::bigint);

-- name: RaiseLeaseEpoch :one
UPDATE sim_lease SET epoch = epoch + 1, holder = @holder, since = now()
RETURNING epoch;

-- name: LeaseHolder :one
SELECT epoch, holder, since FROM sim_lease;

-- name: LeaseEpochForShare :one
SELECT epoch FROM sim_lease FOR SHARE;

-- name: InsertEvents :copyfrom
INSERT INTO event (world_id, tick, kind, account_id, boat) VALUES (@world_id, @tick, @kind, @account_id, @boat);

-- name: UpsertCheckpoint :exec
INSERT INTO checkpoint (world_id, tick, format, build, catalog, layout, epoch, boats, data, written_at)
VALUES (@world_id, @tick, @format, @build, @catalog, @layout, @epoch, @boats, @data, now())
ON CONFLICT (world_id) DO UPDATE SET
  tick = excluded.tick, format = excluded.format, build = excluded.build, catalog = excluded.catalog,
  layout = excluded.layout, epoch = excluded.epoch, boats = excluded.boats, data = excluded.data,
  written_at = excluded.written_at;

-- name: LatestCheckpoint :one
SELECT tick, format, build, catalog, layout, epoch, boats, data, written_at
FROM checkpoint WHERE world_id = @world_id;
