-- SPDX-License-Identifier: AGPL-3.0-only
-- A world's week of weather: made with the world, from its seed, for the
-- epoch and end it begins and ends at, and stored, so that a restart or a
-- new build never changes it.

-- +goose Up

-- A world's week, one row: the version of the generator that made it; the
-- world's epoch and end it was made for; its records as JSON, the exact
-- bytes its digest is of; how long it took to make, and when it was made.
-- A week made again for a world that begins at another time than planned
-- replaces the row before the world opens.
CREATE TABLE world_weather (
  world_id      uuid NOT NULL REFERENCES world (id),
  version       integer NOT NULL,
  epoch         timestamptz NOT NULL,
  ends          timestamptz NOT NULL,
  records       bytea NOT NULL,
  digest        bytea NOT NULL CHECK (length(digest) = 32),
  generation_ms integer NOT NULL CHECK (generation_ms >= 0),
  made          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id)
) PARTITION BY LIST (world_id);

SELECT create_world_partitions(id) FROM world;
