-- SPDX-License-Identifier: AGPL-3.0-only
-- The simulation's lease, the world's checkpoint and what it decides that
-- lasts.

-- +goose Up

-- The lease on the simulation: one row. Whoever holds the advisory lock
-- keel's lease names runs the world, and raised epoch by one when it took
-- it: a fencing token (Kleppmann, "How to do distributed locking", 2016).
-- Every transaction that writes world state first reads epoch FOR SHARE and
-- gives up if it is not its own, so a simulation that lost the lease
-- without knowing changes nothing lasting; and the next holder's raise
-- waits for any such transaction still open.
CREATE TABLE sim_lease (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch     bigint NOT NULL CHECK (epoch >= 0),
  holder    text NOT NULL,
  since     timestamptz
);
INSERT INTO sim_lease (epoch, holder) VALUES (0, '');

-- A world's last checkpoint: its whole state, as the simulation's snapshot
-- of the format given, replaced each time. A build restores it only if it
-- reads the format and has the same catalog and physics layout.
CREATE TABLE checkpoint (
  world_id   uuid NOT NULL REFERENCES world (id),
  tick       bigint NOT NULL,
  format     smallint NOT NULL,
  build      text NOT NULL,
  catalog    text NOT NULL,
  layout     integer NOT NULL,
  epoch      bigint NOT NULL,
  boats      integer NOT NULL CHECK (boats >= 0),
  data       bytea NOT NULL,
  written_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id)
) PARTITION BY LIST (world_id);

-- What the simulation decided that lasts: a boat launched into the world
-- (joined, or given a boat from the queue), returned (left) or expired (its
-- grace ended). The account is copied, not referenced: scripted sailors
-- have no account row, and what is shown of an event keeps what it showed.
CREATE TABLE event (
  world_id   uuid NOT NULL REFERENCES world (id),
  id         uuid NOT NULL DEFAULT uuidv7(),
  tick       bigint NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('launched', 'returned', 'expired')),
  account_id uuid NOT NULL,
  boat       bigint NOT NULL,
  written_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id)
) PARTITION BY LIST (world_id);

SELECT create_world_partitions(id) FROM world;
