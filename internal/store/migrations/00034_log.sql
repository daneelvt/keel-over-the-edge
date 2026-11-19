-- SPDX-License-Identifier: AGPL-3.0-only
-- The sailor's log: what each sailor did at sea, kept from world to world.
-- Its tables are never partitioned by world and have no world_id: a
-- world's partitions are dropped weeks after it ends, and the log outlives
-- them, keeping the world's number and its own copies of every name and
-- place it shows. An account deleted takes its rows with it; its name in
-- others' rows is forgotten, read as a former sailor's.

-- +goose Up

-- log_shown is who may read the account's log: 'sailors', every sailor
-- signed in to the game; 'me', its sailor alone. NULL is the default of
-- its sailor's age band, read each time: a teen's and an unknown band's
-- 'me', an adult's 'sailors'. A machine sailor's is always read by
-- sailors.
ALTER TABLE account ADD COLUMN log_shown text;
ALTER TABLE account ADD CONSTRAINT account_log_shown
  CHECK (log_shown IN ('sailors', 'me') AND (kind = 'human' OR log_shown = 'sailors')) NOT VALID;
ALTER TABLE account VALIDATE CONSTRAINT account_log_shown;

-- log_from is when the log began to be kept as the game keeps it now:
-- distance and weather are logged from it, and what the worlds still kept
-- recorded before it is copied into the log once.
ALTER TABLE setting ADD COLUMN log_from timestamptz NOT NULL DEFAULT now();

-- A voyage, or a time aboard another's boat (aboard), in the world of
-- number world: the boat, its kind and its name as they were; when it
-- began and ended and how; the distance run over the ground (NULL where it
-- was not logged); the place named nearest where it ended; the closest
-- approach to the lip survived; its bumps; the weather met (flags: 1 a
-- gale, 2 a storm, 4 a gale ridden out, 8 a storm ridden out, 16 a
-- landfall in fog, 32 a night at sea) and where; a time aboard's skipper;
-- and the others aboard, each {"id", "name", "machine", "s"} (s the
-- seconds aboard), copies. source makes a row once, however often it is
-- written.
CREATE TABLE log_voyage (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id      uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (octet_length(source) BETWEEN 1 AND 200),
  world           integer NOT NULL CHECK (world > 0),
  aboard          boolean NOT NULL DEFAULT false,
  boat            bigint NOT NULL,
  boat_kind       text NOT NULL,
  boat_name       text,
  began_at        timestamptz NOT NULL,
  ended_at        timestamptz NOT NULL,
  how             text NOT NULL CHECK (how IN ('returned', 'expired', 'over', 'taken', 'aboard', 'ashore', 'landed')),
  run             real CHECK (run >= 0),
  place           text,
  least           real CHECK (least >= 0),
  bumps_at        smallint NOT NULL DEFAULT 0 CHECK (bumps_at >= 0),
  bumps_not       smallint NOT NULL DEFAULT 0 CHECK (bumps_not >= 0),
  met             smallint NOT NULL DEFAULT 0 CHECK (met BETWEEN 0 AND 63),
  gale_place      text,
  fog_place       text,
  skipper_id      uuid,
  skipper_name    text,
  skipper_machine boolean NOT NULL DEFAULT false,
  crew            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(crew) = 'array'),
  CONSTRAINT log_voyage_source UNIQUE (account_id, source),
  CHECK (ended_at >= began_at)
);
CREATE INDEX log_voyage_ended ON log_voyage (account_id, world, ended_at);
CREATE INDEX log_voyage_skipper ON log_voyage (skipper_id) WHERE skipper_id IS NOT NULL;
CREATE INDEX log_voyage_crew ON log_voyage USING gin (crew jsonb_path_ops);

-- A notable thing in a sailor's log: a place charted, credited to them
-- (charted) or sighted from another's boat (sighted, other its skipper);
-- the first of a kind found for the collection (found, grp and find its
-- group and kind); a kind of the sea's life met (met); a bump (bump, other
-- the other boat's sailor, other_boat its name, the Article and whose
-- fault: the sailor's, the other's or no one's). Its title and what it is,
-- its worth, where, and the place named nearest are copies.
CREATE TABLE log_entry (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id    uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  source        text NOT NULL CHECK (octet_length(source) BETWEEN 1 AND 200),
  world         integer NOT NULL CHECK (world > 0),
  at            timestamptz NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('charted', 'sighted', 'found', 'met', 'bump')),
  title         text NOT NULL DEFAULT '',
  what          text NOT NULL DEFAULT '',
  worth         real NOT NULL DEFAULT 0,
  grp           text,
  find          text,
  x             real,
  y             real,
  place         text,
  other_id      uuid,
  other_name    text,
  other_machine boolean NOT NULL DEFAULT false,
  other_boat    text,
  article       text,
  fault         text CHECK (fault IN ('mine', 'theirs', 'none')),
  CONSTRAINT log_entry_source UNIQUE (account_id, source),
  CHECK ((kind = 'bump') = (fault IS NOT NULL)),
  CHECK ((kind IN ('found', 'met')) = (find IS NOT NULL))
);
CREATE INDEX log_entry_at ON log_entry (account_id, world, at);
CREATE INDEX log_entry_other ON log_entry (other_id) WHERE other_id IS NOT NULL;

-- The collection: each kind of a group a sailor has found, how many times
-- over every world, and where and when first; last_world the latest world
-- it was found in.
CREATE TABLE log_find (
  account_id  uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  grp         text NOT NULL CHECK (octet_length(grp) BETWEEN 1 AND 40),
  find        text NOT NULL CHECK (octet_length(find) BETWEEN 1 AND 80),
  count       integer NOT NULL DEFAULT 1 CHECK (count > 0),
  first_world integer NOT NULL CHECK (first_world > 0),
  first_at    timestamptz NOT NULL,
  first_place text,
  last_world  integer NOT NULL CHECK (last_world >= first_world),
  PRIMARY KEY (account_id, grp, find)
);
