-- SPDX-License-Identifier: AGPL-3.0-only
-- A world's life: the next world made ahead, each world's beginning and
-- end, the worlds whose partitions are dropped; the jobs' runs; a boat
-- taken by the falls at a world's end; the notices of a world's end in the
-- news; and a session's last use found quickly.

-- +goose Up

-- A world is next from the day before it begins, while it is made and
-- checked; active while it is sailed; ended after; dropped once its
-- partitions are gone, its row kept. begins_at is when it became active,
-- ends_at when it ends, fixed as it begins: null for a world not yet
-- begun, and for one a build that knew nothing of ends began. The worlds
-- already ended end when the next began; the active world's end is set by
-- the schedule at keel's next start, which the migration cannot know.
ALTER TABLE world DROP CONSTRAINT world_state_check;
ALTER TABLE world ADD CONSTRAINT world_state_check CHECK (state IN ('next', 'active', 'ended', 'dropped'));
ALTER TABLE world
  ADD COLUMN begins_at timestamptz,
  ADD COLUMN ends_at timestamptz;
UPDATE world SET begins_at = created_at;
UPDATE world w SET ends_at = coalesce(
  (SELECT n.created_at FROM world n WHERE n.number > w.number ORDER BY n.number LIMIT 1),
  w.created_at)
WHERE w.state = 'ended';
CREATE UNIQUE INDEX world_one_next ON world ((true)) WHERE state = 'next';

-- A job's run: one row for each job and each time it was due, so a job
-- runs once for each, whichever process holds the simulation's lease and
-- however often it starts; a failed run is tried again in the same row,
-- counted in attempts. The lease's epoch of the process that ran it last.
-- outcome is null while it runs, and stays null if its process stopped
-- first: the next holder of the lease takes it over.
CREATE TABLE job_run (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  job         text NOT NULL,
  due         timestamptz NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome     text CHECK (outcome IN ('ok', 'failed', 'skipped')),
  detail      text NOT NULL DEFAULT '',
  attempts    integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  epoch       bigint NOT NULL,
  UNIQUE (job, due),
  CONSTRAINT job_run_finished CHECK ((outcome IS NULL) = (finished_at IS NULL))
);
CREATE INDEX job_run_started ON job_run (started_at);

-- A boat afloat when the falls took its world: where it was.
ALTER TABLE event DROP CONSTRAINT event_kind_check;
ALTER TABLE event ADD CONSTRAINT event_kind_check CHECK (kind IN ('launched', 'returned', 'expired', 'bump', 'over', 'approach', 'taken'));
ALTER TABLE event DROP CONSTRAINT event_edge_check;
ALTER TABLE event ADD CONSTRAINT event_edge_check CHECK (
  (kind = 'approach') = (distance IS NOT NULL)
  AND (kind NOT IN ('over', 'approach', 'taken') OR x IS NOT NULL AND y IS NOT NULL)
);

-- The news tells of a world's end: an item about the world itself, whose
-- end is ends_at, each reader showing it in their own time.
ALTER TABLE news_item DROP CONSTRAINT news_item_subject_check;
ALTER TABLE news_item ADD CONSTRAINT news_item_subject_check CHECK (subject IN ('island', 'place', 'feature', 'world'));
ALTER TABLE news_item ADD COLUMN ends_at timestamptz;

-- Sessions not used for longer than their cookie lives are deleted daily,
-- found by when they were last used.
CREATE INDEX session_last_seen ON session (last_seen_at);
