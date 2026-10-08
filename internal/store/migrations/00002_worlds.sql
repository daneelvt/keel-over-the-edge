-- SPDX-License-Identifier: AGPL-3.0-only
-- Worlds, and the rule every table of a world's data follows.

-- +goose Up

-- At most one world is active at a time.
CREATE TABLE world (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  number     integer NOT NULL UNIQUE CHECK (number > 0),
  epoch      timestamptz NOT NULL,
  state      text NOT NULL CHECK (state IN ('active', 'ended')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX world_one_active ON world ((true)) WHERE state = 'active';

-- Every table of a world's data has a world_id column and is partitioned by
-- it, PARTITION BY LIST (world_id), one partition per world named
-- <table>_w<number>, so a world's data is dropped with its partitions.
--
-- create_world_partitions makes the partitions of one world for every such
-- table, found in the catalog rather than listed here, so a new table cannot
-- be forgotten. It is idempotent: a migration that adds a table calls it for
-- every existing world.
-- +goose StatementBegin
CREATE FUNCTION create_world_partitions(world uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  n integer;
  t text;
BEGIN
  SELECT w.number INTO STRICT n FROM world w WHERE w.id = create_world_partitions.world;
  FOR t IN
    SELECT c.relname
    FROM pg_partitioned_table p
    JOIN pg_class c ON c.oid = p.partrelid
    JOIN pg_attribute a ON a.attrelid = p.partrelid AND a.attnum = p.partattrs[0]
    WHERE c.relnamespace = current_schema()::regnamespace
      AND NOT c.relispartition
      AND p.partstrat = 'l' AND p.partnatts = 1 AND a.attname = 'world_id'
    ORDER BY c.relname
  LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES IN (%L)',
                   t || '_w' || n, t, create_world_partitions.world);
  END LOOP;
END $$;
-- +goose StatementEnd
