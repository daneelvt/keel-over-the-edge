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

-- name: DueRaces :many
-- A world's races, not trials, open or closed, starting between two
-- times: those whose warning signal has come, for the committee.
SELECT id FROM race
WHERE world_id = @world_id AND kind = 'race' AND state IN ('open', 'closed') AND starts_at > @since AND starts_at <= @until
ORDER BY starts_at, id;

-- name: PendingRuns :many
-- A world's open trials' sailors who asked for a run: an entry in force,
-- with no run under way (one without its result), and the run they sail
-- next.
SELECT e.race_id, e.account_id, e.number, e.machine, e.with_crew,
  (SELECT coalesce(max(x.run), 0) + 1 FROM race_entry x
   WHERE x.world_id = e.world_id AND x.race_id = e.race_id AND x.account_id = e.account_id)::smallint AS next_run
FROM race_entry e
JOIN race r ON r.world_id = e.world_id AND r.id = e.race_id
WHERE e.world_id = @world_id AND r.kind = 'trial' AND r.state = 'open' AND e.run = 0 AND e.withdrawn_at IS NULL AND NOT e.removed
  AND NOT EXISTS (
    SELECT 1 FROM race_entry x
    WHERE x.world_id = e.world_id AND x.race_id = e.race_id AND x.account_id = e.account_id AND x.run > 0
      AND NOT EXISTS (SELECT 1 FROM race_result y
                      WHERE y.world_id = x.world_id AND y.race_id = x.race_id AND y.account_id = x.account_id AND y.run = x.run))
ORDER BY e.entered_at, e.account_id;

-- name: RacingState :exec
-- A race under way: racing, from open or closed.
UPDATE race SET state = 'racing' WHERE world_id = @world_id AND id = @id AND state IN ('open', 'closed');

-- name: StartEntries :exec
-- A race's boats placed on its line: started.
UPDATE race_entry SET started_at = @at
WHERE world_id = @world_id AND race_id = @race_id AND run = 0 AND account_id = ANY(@accounts::uuid[]) AND started_at IS NULL;

-- name: InsertRun :exec
-- A trial's run begun, as an entry of its own, started.
INSERT INTO race_entry (world_id, race_id, account_id, run, number, machine, with_crew, entered_at, started_at)
VALUES (@world_id, @race_id, @account_id, @run, @number, @machine, @with_crew, @at, @at)
ON CONFLICT DO NOTHING;

-- name: WithdrawRun :exec
-- A trial's sailor's run done or not begun: their entry no longer asks
-- for one until they enter again.
UPDATE race_entry SET withdrawn_at = @at
WHERE world_id = @world_id AND race_id = @race_id AND account_id = @account_id AND run = 0 AND withdrawn_at IS NULL;

-- name: PutRaceResult :exec
-- What a boat came to in a race, or a trial's run.
INSERT INTO race_result (world_id, race_id, account_id, run, place, elapsed, added, marks, to_go, how, medal, awards, crew)
VALUES (@world_id, @race_id, @account_id, @run, sqlc.narg(place), sqlc.narg(elapsed), @added, @marks, sqlc.narg(to_go), @how,
  sqlc.narg(medal), @awards, @crew)
ON CONFLICT (world_id, race_id, account_id, run) DO UPDATE
  SET place = excluded.place, elapsed = excluded.elapsed, added = excluded.added, marks = excluded.marks,
      to_go = excluded.to_go, how = excluded.how, medal = excluded.medal, awards = excluded.awards, crew = excluded.crew;

-- name: PutRaceRun :exec
-- A race's run as its committee laid it, once.
INSERT INTO race_run (world_id, race_id, run, warning, start, ended, course)
VALUES (@world_id, @race_id, @run, @warning, @start, @ended, @course)
ON CONFLICT DO NOTHING;

-- name: RaceRuns :many
-- A race's runs as their committee laid them, by run.
SELECT run, warning, start, ended, course
FROM race_run
WHERE world_id = @world_id AND race_id = @race_id
ORDER BY run;

-- name: PutRaceTrack :exec
-- A boat's track in a race, once.
INSERT INTO race_track (world_id, race_id, account_id, run, samples)
VALUES (@world_id, @race_id, @account_id, @run, @samples)
ON CONFLICT DO NOTHING;

-- name: PutRaceRecord :exec
-- A race in a sailor's lasting record, once for its source, while the
-- account is kept.
INSERT INTO race_record (account_id, source, world, at, code, race_name, kind, course_name, boat, boat_name, fleet, harbour,
  newcomers, role, place, how, medal, awards, skipper_id, skipper_name, skipper_machine, number, elapsed)
SELECT @account_id, @source, @world, @at, @code, @race_name, @kind, @course_name, @boat, sqlc.narg(boat_name), @fleet, @harbour,
  @newcomers, @role, sqlc.narg(place), sqlc.narg(how), sqlc.narg(medal), @awards, sqlc.narg(skipper_id), sqlc.narg(skipper_name),
  @skipper_machine, sqlc.narg(number), sqlc.narg(elapsed)
WHERE EXISTS (SELECT 1 FROM account WHERE id = @account_id)
ON CONFLICT (account_id, source) DO NOTHING;

-- name: FinishRace :exec
-- A race over, its results kept.
UPDATE race SET state = 'finished', ended_at = @at
WHERE world_id = @world_id AND id = @id AND state IN ('open', 'closed', 'racing');

-- name: RaceIn :one
-- A world's race of an ID, with how many are entered.
SELECT r.code, coalesce(r.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id,
  r.kind, r.course_kind, r.course, coalesce(r.shape, '')::text AS shape, r.long, r.boat, r.who, r.name, r.starts_at,
  r.moved, r.state, coalesce(r.harbour, -1)::smallint AS harbour, r.made_at,
  (SELECT count(*) FROM race_entry e WHERE e.world_id = r.world_id AND e.race_id = r.id
     AND e.withdrawn_at IS NULL AND NOT e.removed)::integer AS entered
FROM race r
WHERE r.world_id = @world_id AND r.id = @id;

-- name: RaceResults :many
-- What a race's boats came to, or a trial's runs, with their tracks: by
-- run, then place, those unplaced last.
SELECT r.account_id, r.run, coalesce(r.place, 0)::smallint AS place, coalesce(r.elapsed, -1)::real AS elapsed, r.added, r.marks,
  coalesce(r.to_go, -1)::real AS to_go, r.how, coalesce(r.medal, '')::text AS medal, r.awards, r.crew,
  coalesce(t.samples, ''::bytea)::bytea AS samples, coalesce(e.number, 0)::smallint AS number, coalesce(e.machine, false)::boolean AS machine
FROM race_result r
LEFT JOIN race_track t USING (world_id, race_id, account_id, run)
LEFT JOIN race_entry e USING (world_id, race_id, account_id, run)
WHERE r.world_id = @world_id AND r.race_id = @race_id
ORDER BY r.run, r.place NULLS LAST, r.account_id;

-- name: RaceRecordsOf :many
-- A sailor's lasting race records, the newest first.
SELECT source, world, at, code, race_name, kind, course_name, boat, coalesce(boat_name, '')::text AS boat_name, fleet, harbour,
  newcomers, role, coalesce(place, 0)::smallint AS place, coalesce(how, '')::text AS how, coalesce(medal, '')::text AS medal,
  awards, coalesce(skipper_id, '00000000-0000-0000-0000-000000000000')::uuid AS skipper_id,
  coalesce(skipper_name, '')::text AS skipper_name, skipper_machine, hung
FROM race_record
WHERE account_id = @account_id
ORDER BY at DESC, id DESC
LIMIT @most;

-- name: RaceRibbonsOf :many
-- A sailor's lasting records of races sailed, skipper or crew, the newest
-- first: a page of most after the first skip.
SELECT source, world, at, code, race_name, kind, course_name, boat, coalesce(boat_name, '')::text AS boat_name, fleet, harbour,
  newcomers, role, coalesce(place, 0)::smallint AS place, coalesce(how, '')::text AS how, coalesce(medal, '')::text AS medal,
  awards, coalesce(skipper_id, '00000000-0000-0000-0000-000000000000')::uuid AS skipper_id,
  coalesce(skipper_name, '')::text AS skipper_name, skipper_machine, hung
FROM race_record
WHERE account_id = @account_id AND role IN ('skipper', 'crew')
ORDER BY at DESC, id DESC
OFFSET @skip
LIMIT @most;

-- name: RaceRecordsByCode :many
-- The lasting records of a race's boats and their crews by its link's
-- code, of the newest world that raced one, by run then place.
SELECT r.account_id, r.source, r.world, r.at, r.code, r.race_name, r.kind, r.course_name, r.boat,
  coalesce(r.boat_name, '')::text AS boat_name, r.fleet, r.harbour, r.newcomers, r.role, coalesce(r.place, 0)::smallint AS place,
  coalesce(r.how, '')::text AS how, coalesce(r.medal, '')::text AS medal, r.awards,
  coalesce(r.skipper_id, '00000000-0000-0000-0000-000000000000')::uuid AS skipper_id,
  coalesce(r.skipper_name, '')::text AS skipper_name, r.skipper_machine, coalesce(r.number, 0)::smallint AS number,
  coalesce(r.elapsed, -1)::real AS elapsed
FROM race_record r
WHERE r.code = @code AND r.role IN ('skipper', 'crew') AND r.source LIKE 'race:%'
  AND r.world = (SELECT max(n.world) FROM race_record n WHERE n.code = @code AND n.role IN ('skipper', 'crew'))
ORDER BY r.source, r.place NULLS LAST, r.number, r.account_id;

-- name: HangSpoon :execrows
-- Hangs the wooden spoon a sailor was given in a world's race from their
-- boats' sterns, or takes it down: only on a record of theirs that has it.
UPDATE race_record SET hung = @hung
WHERE account_id = @account_id AND world = @world AND code = @code AND role IN ('skipper', 'crew')
  AND 'spoon' = ANY (awards);

-- name: SpoonsHung :one
-- How many wooden spoons a sailor hangs in a world.
SELECT count(*)::integer FROM race_record WHERE account_id = @account_id AND world = @world AND hung;

-- name: RaceCountsOf :one
-- A sailor's races counted over every world: those sailed, skipper or
-- crew; their top three places and wins in races; the awards and medals
-- given; the races run as their owner.
SELECT
  count(*) FILTER (WHERE role IN ('skipper', 'crew'))::integer AS sailed,
  count(*) FILTER (WHERE role IN ('skipper', 'crew') AND kind = 'race' AND place BETWEEN 1 AND 3)::integer AS top3,
  count(*) FILTER (WHERE role IN ('skipper', 'crew') AND kind = 'race' AND place = 1)::integer AS wins,
  count(*) FILTER (WHERE 'best-start' = ANY (awards))::integer AS best_starts,
  count(*) FILTER (WHERE 'comeback' = ANY (awards))::integer AS comebacks,
  count(*) FILTER (WHERE 'photo-finish' = ANY (awards))::integer AS photo_finishes,
  count(*) FILTER (WHERE 'crowd' = ANY (awards))::integer AS crowds,
  count(*) FILTER (WHERE 'spoon' = ANY (awards))::integer AS spoons,
  count(*) FILTER (WHERE medal = 'harbourmaster')::integer AS harbourmasters,
  count(*) FILTER (WHERE medal = 'gold')::integer AS golds,
  count(*) FILTER (WHERE medal = 'silver')::integer AS silvers,
  count(*) FILTER (WHERE medal = 'bronze')::integer AS bronzes,
  count(*) FILTER (WHERE role = 'owner')::integer AS ran
FROM race_record
WHERE account_id = @account_id;
