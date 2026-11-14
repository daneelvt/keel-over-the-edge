-- SPDX-License-Identifier: AGPL-3.0-only
-- Races: the racing limits and the harbour races' timetable; races made,
-- found by their codes, entered and withdrawn from; the rows the limits
-- are counted from; the harbour races and their newcomers' hours.
;

-- name: RaceSettings :one
-- The racing limits and the harbour races' timetable.
SELECT race_ahead, race_daily, race_made, race_owned, extract(epoch FROM race_cutoff)::bigint AS cutoff_seconds,
  harbour_every, harbour_boats, greenhorn_us
FROM setting;

-- name: SetRaceSettings :exec
-- The racing limits and the harbour races' timetable, all at once.
UPDATE setting SET race_ahead = @race_ahead, race_daily = @race_daily, race_made = @race_made, race_owned = @race_owned,
  race_cutoff = sqlc.arg(cutoff_seconds)::bigint * interval '1 second', harbour_every = @harbour_every,
  harbour_boats = @harbour_boats, greenhorn_us = @greenhorn_us;

-- name: LockRacing :exec
-- Holds, to the end of the transaction, the lock of one key: an account's
-- racing, or a world's racing areas.
SELECT pg_advisory_xact_lock(hashtextextended(@key::text, 7));

-- name: InsertRace :one
-- A race made: its code comes from link_code().
INSERT INTO race (world_id, owner_id, kind, course_kind, course, shape, long, boat, who, name, starts_at, harbour, again_of, made_at)
VALUES (@world_id, sqlc.narg(owner_id), @kind, @course_kind, @course, sqlc.narg(shape), @long, @boat, @who, @name, @starts_at,
  sqlc.narg(harbour), sqlc.narg(again_of), @made_at)
RETURNING code;

-- name: InsertHarbourRace :execrows
-- A harbour race made, once for its start.
INSERT INTO race (world_id, kind, course_kind, course, shape, long, boat, who, name, starts_at, harbour, made_at)
VALUES (@world_id, 'race', 'buoy', @course, @shape, false, @boat, @who, @name, @starts_at, @harbour, @made_at)
ON CONFLICT (world_id, starts_at) WHERE harbour IS NOT NULL DO NOTHING;

-- name: RaceByCode :one
-- The race of a code, in the newest world that has one, with its world's
-- number and how many are entered.
SELECT r.world_id, r.id, r.code, coalesce(r.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id,
  r.kind, r.course_kind, r.course, coalesce(r.shape, '')::text AS shape, r.long, r.boat, r.who, r.name, r.starts_at,
  r.moved, r.state, coalesce(r.harbour, -1)::smallint AS harbour, r.made_at, w.number AS world,
  (SELECT count(*) FROM race_entry e WHERE e.world_id = r.world_id AND e.race_id = r.id
     AND e.withdrawn_at IS NULL AND NOT e.removed)::integer AS entered
FROM race r
JOIN world w ON w.id = r.world_id
WHERE r.code = @code
ORDER BY w.number DESC
LIMIT 1;

-- name: RaceForUpdate :one
-- A race's state and start, its row locked to the end of the
-- transaction.
SELECT state, starts_at, moved, kind FROM race WHERE world_id = @world_id AND id = @id FOR UPDATE;

-- name: SetRaceState :execrows
-- A race's state changed, if it is in one of those given.
UPDATE race SET state = @state, ended_at = CASE WHEN @state IN ('cancelled', 'finished') THEN @at::timestamptz END
WHERE world_id = @world_id AND id = @id AND state = ANY(@was::text[]);

-- name: MoveRace :execrows
-- A race's start moved, once.
UPDATE race SET starts_at = @starts_at, moved = true
WHERE world_id = @world_id AND id = @id AND NOT moved AND state IN ('open', 'closed');

-- name: RacesBy :many
-- The races an owner made in any world since a time, or has not finished
-- in the world sailed (a race of a world ended is over).
SELECT r.made_at, (CASE WHEN w.state = 'active' THEN r.state ELSE 'finished' END)::text AS state, r.kind
FROM race r
JOIN world w ON w.id = r.world_id
WHERE r.owner_id = @owner_id AND (r.made_at > @since OR (r.state IN ('open', 'closed', 'racing') AND w.state = 'active'));

-- name: BuoyRacesNear :many
-- A world's buoy races, not cancelled, starting between two times: the
-- racing areas they take.
SELECT course, starts_at FROM race
WHERE world_id = @world_id AND course_kind = 'buoy' AND kind = 'race' AND state <> 'cancelled'
  AND starts_at BETWEEN @since AND @until;

-- name: RaceEntrants :many
-- A race's entries in force, by race number, each with the name of its
-- skipper's boat of the race's kind, "" for none.
SELECT e.account_id, e.number, e.machine, e.with_crew, e.entered_at,
  coalesce((SELECT b.name FROM boat b WHERE b.sailor = e.account_id AND b.kind = @boat AND b.name IS NOT NULL
            ORDER BY b.made_at LIMIT 1), '')::text AS boat_name
FROM race_entry e
WHERE e.world_id = @world_id AND e.race_id = @race_id AND e.run = 0 AND e.withdrawn_at IS NULL AND NOT e.removed
ORDER BY e.number;

-- name: RaceEntryOf :one
-- An account's entry in a race, in force or not.
SELECT number, with_crew, (withdrawn_at IS NOT NULL)::boolean AS withdrawn, removed FROM race_entry
WHERE world_id = @world_id AND race_id = @race_id AND account_id = @account_id AND run = 0;

-- name: NextRaceNumber :one
-- The race number the next boat entered takes.
SELECT (coalesce(max(number), 0) + 1)::smallint FROM race_entry WHERE world_id = @world_id AND race_id = @race_id;

-- name: EnterRace :exec
-- An account's boat entered in a race, or entered again with its number
-- after withdrawing.
INSERT INTO race_entry (world_id, race_id, account_id, number, machine, with_crew, entered_at)
VALUES (@world_id, @race_id, @account_id, @number, @machine, @with_crew, @at)
ON CONFLICT (world_id, race_id, account_id, run) DO UPDATE
  SET with_crew = excluded.with_crew, entered_at = excluded.entered_at, withdrawn_at = NULL;

-- name: WithdrawEntry :execrows
-- An account's boat withdrawn from a race.
UPDATE race_entry SET withdrawn_at = @at
WHERE world_id = @world_id AND race_id = @race_id AND account_id = @account_id AND run = 0
  AND withdrawn_at IS NULL AND NOT removed;

-- name: RemoveEntry :one
-- A race's boat of a number removed by the race's owner: its skipper.
UPDATE race_entry SET removed = true
WHERE world_id = @world_id AND race_id = @race_id AND number = @number AND run = 0
  AND withdrawn_at IS NULL AND NOT removed
RETURNING account_id;

-- name: EntriesOf :many
-- An account's races entered in force in any world that start after a
-- time: each race's start, state and kind, and whether it was entered.
SELECT r.world_id, r.id, r.starts_at, r.state, r.kind, (e.started_at IS NOT NULL)::boolean AS started
FROM race_entry e
JOIN race r ON r.world_id = e.world_id AND r.id = e.race_id
WHERE e.account_id = @account_id AND e.run = 0 AND e.withdrawn_at IS NULL AND NOT e.removed
  AND r.starts_at > @since AND r.state <> 'cancelled';

-- name: RacesSailed :one
-- How many races an account has sailed over every world, skipper or crew.
SELECT count(*)::integer FROM race_record
WHERE account_id = @account_id AND kind = 'race' AND role IN ('skipper', 'crew') AND how IS DISTINCT FROM 'dns';

-- name: RaceList :many
-- A world's races of the ids given, with how many are entered.
SELECT r.id, r.code, coalesce(r.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id, r.kind,
  r.course_kind, r.course, coalesce(r.shape, '')::text AS shape, r.long, r.boat, r.who, r.name, r.starts_at,
  r.moved, r.state, coalesce(r.harbour, -1)::smallint AS harbour, r.made_at,
  (SELECT count(*) FROM race_entry e WHERE e.world_id = r.world_id AND e.race_id = r.id
     AND e.withdrawn_at IS NULL AND NOT e.removed)::integer AS entered
FROM race r
WHERE r.world_id = @world_id AND r.id = ANY(@ids::uuid[])
ORDER BY r.starts_at, r.id;

-- name: HarbourRaceIDs :many
-- A world's next harbour races, open or closed, starting after a time.
SELECT id FROM race
WHERE world_id = @world_id AND harbour IS NOT NULL AND state IN ('open', 'closed') AND starts_at > @after
ORDER BY starts_at
LIMIT @most;

-- name: RaceIDsOf :many
-- The races of a world an account owns or is entered in, not over.
SELECT r.id FROM race r
WHERE r.world_id = @world_id AND r.state IN ('open', 'closed', 'racing')
  AND (r.owner_id = @account_id OR EXISTS (
    SELECT 1 FROM race_entry e WHERE e.world_id = r.world_id AND e.race_id = r.id AND e.account_id = @account_id
      AND e.run = 0 AND e.withdrawn_at IS NULL AND NOT e.removed))
ORDER BY r.starts_at
LIMIT 20;

-- name: HarbourDays :many
-- A world's days and their newcomers' harbour races' hours.
SELECT day, hour FROM harbour_day WHERE world_id = @world_id ORDER BY day;

-- name: InsertHarbourDay :exec
-- A day's newcomers' harbour race's hour, set once.
INSERT INTO harbour_day (world_id, day, hour) VALUES (@world_id, @day, @hour) ON CONFLICT DO NOTHING;
