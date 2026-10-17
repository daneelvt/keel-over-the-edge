-- SPDX-License-Identifier: AGPL-3.0-only
-- A world's places besides its islands and groups of rocks: its ports,
-- fishing villages, lighthouses, anchorages, coves, lagoons, reefs,
-- sandbars and wrecks; and its lighthouses' lights.

-- +goose Up

-- The kinds a place may be: an island, a group of rocks, or one of the
-- catalog's kinds of place. A place offshore has no biome. Each place
-- other than an island or a group names the island it is on or by (null
-- offshore) and keeps what its kind measures as JSON: a cove's width, an
-- anchorage's shelter, a wreck's ship. The constraint is added not valid,
-- then validated, so the table is scanned under a lock that lets reads and
-- writes go on.
ALTER TABLE place DROP CONSTRAINT place_kind_check;
ALTER TABLE place ADD CONSTRAINT place_kind_check CHECK (kind IN (
  'island', 'group', 'port', 'fishing-village', 'lighthouse', 'anchorage', 'cove', 'lagoon', 'reef', 'sandbar', 'wreck'
)) NOT VALID;
ALTER TABLE place VALIDATE CONSTRAINT place_kind_check;
ALTER TABLE place ALTER COLUMN biome DROP NOT NULL;
ALTER TABLE place
  ADD COLUMN island integer CHECK (island >= 0),
  ADD COLUMN details jsonb;

-- Each lighthouse's light: its number in the world, its lighthouse (a
-- place), its role (Port Royal's, a port's, an edge light, a hazard's),
-- its character as charts write it, its phase in microseconds, its nominal
-- range in m, the light's height above the sea and its tower's in m, and
-- its tower's daymark by the catalog's index.
CREATE TABLE light (
  world_id  uuid NOT NULL REFERENCES world (id),
  number    integer NOT NULL CHECK (number >= 0),
  place     integer NOT NULL,
  role      text NOT NULL CHECK (role IN ('main', 'port', 'edge', 'hazard')),
  character text NOT NULL,
  phase     bigint NOT NULL CHECK (phase >= 0),
  reach     double precision NOT NULL CHECK (reach > 0),
  focal     double precision NOT NULL,
  tower     double precision NOT NULL CHECK (tower > 0),
  daymark   smallint NOT NULL CHECK (daymark >= 0),
  PRIMARY KEY (world_id, number),
  FOREIGN KEY (world_id, place) REFERENCES place (world_id, number)
) PARTITION BY LIST (world_id);

SELECT create_world_partitions(id) FROM world;
