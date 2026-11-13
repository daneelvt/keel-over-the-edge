-- SPDX-License-Identifier: AGPL-3.0-only
-- The sailor's log: voyages, entries and the collection, written with the
-- world's writes and read by sailors.
;

-- name: InsertLogVoyage :execrows
-- A voyage or a time aboard, once by its source, and only while its
-- account is: a voyage of an account deleted meanwhile is dropped.
INSERT INTO log_voyage (account_id, source, world, aboard, boat, boat_kind, boat_name, began_at, ended_at, how, run, place, least,
  bumps_at, bumps_not, met, gale_place, fog_place, skipper_id, skipper_name, skipper_machine, crew)
SELECT @account_id, @source, @world, @aboard, @boat, @boat_kind, @boat_name, @began_at, @ended_at, @how, @run, @place, @least,
  @bumps_at, @bumps_not, @met, @gale_place, @fog_place, @skipper_id, @skipper_name, @skipper_machine, @crew
WHERE EXISTS (SELECT 1 FROM account a WHERE a.id = @account_id)
ON CONFLICT (account_id, source) DO NOTHING;

-- name: InsertLogEntry :execrows
-- An entry, once by its source, while its account is.
INSERT INTO log_entry (account_id, source, world, at, kind, title, what, worth, grp, find, x, y, place,
  other_id, other_name, other_machine, other_boat, article, fault)
SELECT @account_id, @source, @world, @at, @kind, @title, @what, @worth, @grp, @find, @x, @y, @place,
  @other_id, @other_name, @other_machine, @other_boat, @article, @fault
WHERE EXISTS (SELECT 1 FROM account a WHERE a.id = @account_id)
ON CONFLICT (account_id, source) DO NOTHING;

-- name: UpsertLogFind :one
-- A kind found: counted once more, or found for the first time, while its
-- account is; first is true for the first time.
INSERT INTO log_find (account_id, grp, find, first_world, first_at, first_place, last_world)
SELECT @account_id, @grp, @find, @world, @at, @place, @world
WHERE EXISTS (SELECT 1 FROM account a WHERE a.id = @account_id)
ON CONFLICT (account_id, grp, find) DO UPDATE
  SET count = log_find.count + 1, last_world = greatest(log_find.last_world, excluded.last_world)
RETURNING (xmax = 0)::boolean AS first;

-- name: LogFrom :one
-- When the log began to be kept as the game keeps it now.
SELECT log_from FROM setting;

-- name: LogSailor :one
-- The account whose sailor has a name, by its key, as its log is read:
-- its kind and owner, its sailor's name and look, when it was made, its
-- month of birth (its owner's for a machine sailor), who may read its
-- log, and whether it, or its owner, is stopped.
SELECT a.id, a.kind, coalesce(a.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id, sl.name, sl.look,
  coalesce(sl.version, '')::text AS version, coalesce(sl.skin, '')::text AS skin, coalesce(sl.hair, '')::text AS hair,
  coalesce(sl.colour, '')::text AS colour, coalesce(sl.finish, '')::text AS finish, sl.look_chosen, a.created_at,
  coalesce(coalesce(a.born, o.born), 0)::integer AS born, coalesce(a.log_shown, '')::text AS log_shown,
  (a.stopped_at IS NOT NULL OR o.stopped_at IS NOT NULL)::boolean AS stopped
FROM sailor sl
JOIN account a ON a.id = sl.account_id
LEFT JOIN account o ON o.id = a.owner_id
WHERE (sqlc.narg('name_key')::text IS NOT NULL AND sl.name_key = sqlc.narg('name_key')::text)
   OR (sqlc.narg('id')::uuid IS NOT NULL AND a.id = sqlc.narg('id')::uuid);

-- name: LogPeople :many
-- The accounts of ids as the log names them: their kinds, their months of
-- birth (a machine sailor's owner's), who may read their logs, and their
-- owners.
SELECT a.id, a.kind, coalesce(a.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id,
  coalesce(coalesce(a.born, o.born), 0)::integer AS born, coalesce(a.log_shown, '')::text AS log_shown
FROM account a
LEFT JOIN account o ON o.id = a.owner_id
WHERE a.id = ANY(@ids::uuid[]);

-- name: SetLogShown :execrows
-- Who may read a human account's log.
UPDATE account SET log_shown = @log_shown WHERE id = @id AND kind = 'human';

-- name: LogTotals :one
-- An account's voyages over every world, counted: those skippered and
-- those aboard, the distance logged, the worlds, the falls, the closest
-- approach to the lip survived, the bumps, the weather ridden out and
-- met, and when the distance was first logged.
SELECT count(*) FILTER (WHERE NOT aboard) AS voyages, count(*) FILTER (WHERE aboard) AS aboard,
  coalesce(sum(run::float8), 0)::float8 AS run, count(DISTINCT world) AS worlds,
  count(*) FILTER (WHERE how = 'over' AND NOT aboard) AS falls,
  coalesce(min(least), -1)::float8 AS least,
  coalesce(sum(bumps_at), 0)::bigint AS bumps_at, coalesce(sum(bumps_not), 0)::bigint AS bumps_not,
  count(*) FILTER (WHERE met & 4 <> 0) AS gales, count(*) FILTER (WHERE met & 8 <> 0) AS storms,
  count(*) FILTER (WHERE met & 16 <> 0) AS fogs, count(*) FILTER (WHERE met & 32 <> 0) AS nights,
  count(*) FILTER (WHERE NOT aboard AND jsonb_array_length(crew) > 0) AS crewed,
  coalesce(min(began_at) FILTER (WHERE run IS NOT NULL), 'epoch')::timestamptz AS logged_from
FROM log_voyage WHERE account_id = @account_id;

-- name: LogEntryTotals :one
-- An account's entries over every world, counted by kind, and its worlds.
SELECT count(*) FILTER (WHERE kind = 'charted') AS charted, count(*) FILTER (WHERE kind = 'sighted') AS sighted,
  count(*) FILTER (WHERE kind = 'met') AS met, count(DISTINCT world) AS worlds
FROM log_entry WHERE account_id = @account_id;

-- name: LogWorlds :many
-- The worlds an account's log has anything of, the newest first, with the
-- first and last time of each.
SELECT world, min(t0)::timestamptz AS first_at, max(t1)::timestamptz AS last_at FROM (
  SELECT v.world, v.began_at AS t0, v.ended_at AS t1 FROM log_voyage v WHERE v.account_id = @account_id
  UNION ALL
  SELECT e.world, e.at, e.at FROM log_entry e WHERE e.account_id = @account_id
) w GROUP BY world ORDER BY world DESC;

-- name: LogVoyagesOf :many
-- An account's voyages and times aboard in a world, in the order they
-- ended.
SELECT id, aboard, boat, boat_kind, coalesce(boat_name, '')::text AS boat_name, began_at, ended_at, how,
  coalesce(run, -1)::float8 AS run, coalesce(place, '')::text AS place, coalesce(least, -1)::float8 AS least,
  bumps_at, bumps_not, met, coalesce(gale_place, '')::text AS gale_place, coalesce(fog_place, '')::text AS fog_place,
  skipper_id, coalesce(skipper_name, '')::text AS skipper_name, skipper_machine, crew
FROM log_voyage WHERE account_id = @account_id AND world = @world
ORDER BY ended_at, id;

-- name: LogEntriesOf :many
-- An account's entries in a world, in their order.
SELECT id, at, kind, title, what, worth, coalesce(grp, '')::text AS grp, coalesce(find, '')::text AS find,
  coalesce(x, 0)::float8 AS x, coalesce(y, 0)::float8 AS y, coalesce(place, '')::text AS place,
  other_id, coalesce(other_name, '')::text AS other_name, other_machine, coalesce(other_boat, '')::text AS other_boat,
  coalesce(article, '')::text AS article, coalesce(fault, '')::text AS fault
FROM log_entry WHERE account_id = @account_id AND world = @world
ORDER BY at, id;

-- name: LogFinds :many
-- An account's collection: every kind found.
SELECT grp, find, count, first_world, first_at, coalesce(first_place, '')::text AS first_place, last_world
FROM log_find WHERE account_id = @account_id
ORDER BY grp, find;

-- name: LogFigures :many
-- The accounts of ids' logs in a few figures: distance logged and voyages
-- skippered, for the world page's list of accounts.
SELECT account_id, coalesce(sum(run::float8), 0)::float8 AS run, count(*) FILTER (WHERE NOT aboard) AS voyages
FROM log_voyage WHERE account_id = ANY(@ids::uuid[])
GROUP BY account_id;

-- name: KeptWorlds :many
-- The worlds whose records are still kept, with their numbers and epochs.
SELECT id, number, epoch FROM world WHERE state IN ('active', 'ended') ORDER BY number;

-- name: BackfillChartings :many
-- A world's credited chartings written before a time, the oldest first.
SELECT subject, number, account_id, tick, x, y, worth, coalesce(with_subject, '')::text AS with_subject,
  coalesce(with_number, 0)::integer AS with_number, charted_at
FROM charting
WHERE world_id = @world_id AND account_id IS NOT NULL AND charted_at < @before
ORDER BY charted_at, subject, number;

-- name: BackfillEvents :many
-- A world's events of the kinds a log is made of, written before a time,
-- in their order.
SELECT id, tick, kind, account_id, boat, other_account_id, coalesce(other_boat, 0)::bigint AS other_boat,
  coalesce(article, '')::text AS article, coalesce(fault, '')::text AS fault,
  coalesce(x, 0)::float8 AS x, coalesce(y, 0)::float8 AS y, coalesce(distance, 0)::float8 AS distance, written_at
FROM event
WHERE world_id = @world_id AND written_at < @before
  AND kind IN ('launched', 'returned', 'expired', 'over', 'approach', 'taken', 'bump')
ORDER BY tick, id;
