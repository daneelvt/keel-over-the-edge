-- SPDX-License-Identifier: AGPL-3.0-only
-- A world's terrain: the seed it is made from, and the bundle the generator
-- made of it, stored once and read back at every start.

-- +goose Up

-- The seed and the generator's version that made the world's terrain; null
-- until it is made. A seed is a whole number below 2⁶⁴, stored as the
-- bigint of the same bits.
ALTER TABLE world
  ADD COLUMN seed bigint,
  ADD COLUMN generator integer;

-- A world's bundle, one row: the format and generator it was made with, the
-- catalog's version, the seed of the attempt that passed and how many were
-- made, the digest of its records and chunks, its records (the islands,
-- groups, fetch table and start area) as JSON, the validator's report, and
-- how long it took to make.
CREATE TABLE world_bundle (
  world_id      uuid NOT NULL REFERENCES world (id),
  format        smallint NOT NULL,
  generator     integer NOT NULL,
  catalog       text NOT NULL,
  made          bigint NOT NULL,
  attempts      integer NOT NULL CHECK (attempts > 0),
  digest        bytea NOT NULL CHECK (length(digest) = 32),
  records       bytea NOT NULL,
  report        jsonb NOT NULL,
  generation_ms integer NOT NULL CHECK (generation_ms >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id)
) PARTITION BY LIST (world_id);

-- Each of its 256 chunks, as the gzip payload a reader decodes, with that
-- payload's SHA-256. The payload is compressed already: stored out of line
-- but not compressed again.
CREATE TABLE world_chunk (
  world_id uuid NOT NULL REFERENCES world (id),
  chunk    smallint NOT NULL CHECK (chunk >= 0 AND chunk < 256),
  payload  bytea STORAGE EXTERNAL NOT NULL,
  digest   bytea NOT NULL CHECK (length(digest) = 32),
  PRIMARY KEY (world_id, chunk)
) PARTITION BY LIST (world_id);

-- The world's places: each island and each group of rocks by its number in
-- the world, its name, its biome, its size class (a group has none), where
-- it is, metres east and north of the centre, its land's area in m² and its
-- highest point in m.
CREATE TABLE place (
  world_id uuid NOT NULL REFERENCES world (id),
  number   integer NOT NULL CHECK (number >= 0),
  kind     text NOT NULL CHECK (kind IN ('island', 'group')),
  name     text NOT NULL,
  biome    text NOT NULL,
  size     text,
  x        double precision NOT NULL,
  y        double precision NOT NULL,
  area     double precision,
  highest  double precision,
  PRIMARY KEY (world_id, number)
) PARTITION BY LIST (world_id);

SELECT create_world_partitions(id) FROM world;
