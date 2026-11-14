-- SPDX-License-Identifier: AGPL-3.0-only
-- A race's replay. Each run of a race, as its committee laid it: its
-- warning signal, its gun and its end, world ticks, and its course as the
-- chart draws it (the lines, the marks, the way and the legs), kept with
-- the world beside its boats' tracks. And in the lasting record, each
-- boat's race number, its time from the start (s, none if not home) and
-- the seconds added to it, so a race's link shows its results after its
-- world has gone.

-- +goose Up

CREATE TABLE race_run (
  world_id   uuid NOT NULL REFERENCES world (id),
  race_id    uuid NOT NULL,
  run        smallint NOT NULL DEFAULT 0 CHECK (run >= 0),
  warning    bigint NOT NULL,
  start      bigint NOT NULL,
  ended      bigint NOT NULL,
  course     jsonb NOT NULL CHECK (jsonb_typeof(course) = 'object'),
  PRIMARY KEY (world_id, race_id, run),
  FOREIGN KEY (world_id, race_id) REFERENCES race (world_id, id)
) PARTITION BY LIST (world_id);

SELECT create_world_partitions(id) FROM world;

ALTER TABLE race_record ADD COLUMN number smallint CHECK (number > 0);
ALTER TABLE race_record ADD COLUMN elapsed real CHECK (elapsed >= 0);
ALTER TABLE race_record ADD COLUMN added real NOT NULL DEFAULT 0 CHECK (added >= 0);
CREATE INDEX race_record_code ON race_record (code);
