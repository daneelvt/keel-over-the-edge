-- SPDX-License-Identifier: AGPL-3.0-only
-- Certificates: what a sailor holds, and what its log and races hold of
-- its sailing alone since its last was earned, counted each time.
;

-- name: CertificatesOf :many
-- The certificates a sailor holds, the first earned first.
SELECT certificate, by_hand, earned_at, world, tasks FROM certificate WHERE account_id = @account_id ORDER BY earned_at, id;

-- name: InsertCertificate :execrows
-- A certificate earned, once, while the account is kept.
INSERT INTO certificate (account_id, certificate, by_hand, earned_at, world, tasks, source)
SELECT @account_id, @certificate, @by_hand, @earned_at, @world, @tasks, @source
WHERE EXISTS (SELECT 1 FROM account WHERE id = @account_id)
ON CONFLICT DO NOTHING;

-- name: SoloRuns :many
-- A sailor's time trials' runs finished since a time, sailed as skipper
-- with nobody else aboard, on a course a record keeps: the oldest first.
SELECT course::text AS course, course_name, coalesce(medal, '')::text AS medal, piloted, at
FROM race_record
WHERE account_id = @account_id AND kind = 'trial' AND role = 'skipper' AND alone AND course IS NOT NULL
  AND how = 'finished' AND at > @since
ORDER BY at, id;

-- name: SoloVoyages :one
-- What a sailor's voyages sailed alone since a time come to: the distance
-- logged, m; nights at sea, gales ridden out, storms ridden out or
-- landfalls in fog, falls; the closest approach to the lip survived (−1
-- for none); the worlds sailed in; and every weather met, the log's flags.
SELECT coalesce(sum(run), 0)::float8 AS distance,
  (count(*) FILTER (WHERE met & 32 <> 0))::integer AS nights,
  (count(*) FILTER (WHERE met & 4 <> 0))::integer AS gales,
  (count(*) FILTER (WHERE met & 24 <> 0))::integer AS storms_or_fogs,
  (count(*) FILTER (WHERE how = 'over'))::integer AS falls,
  coalesce(min(least), -1)::float8 AS least,
  (count(DISTINCT world))::integer AS worlds,
  coalesce(bit_or(met), 0)::integer AS weather
FROM log_voyage
WHERE account_id = @account_id AND ended_at > @since AND NOT aboard AND crew = '[]'::jsonb;

-- name: SoloEntries :one
-- What a sailor's log's entries made alone since a time come to: the
-- kinds of the sea's life met, the places charted, and the places seen:
-- those it charted, and those named nearest where it met life, charted
-- something or ended a voyage alone.
SELECT
  (SELECT count(DISTINCT find) FROM log_entry e
   WHERE e.account_id = @account_id AND e.at > @since AND e.alone AND e.kind = 'met')::integer AS life_kinds,
  (SELECT count(*) FROM log_entry e
   WHERE e.account_id = @account_id AND e.at > @since AND e.alone AND e.kind = 'charted')::integer AS charted,
  (SELECT count(DISTINCT p) FROM (
     SELECT e.title AS p FROM log_entry e
     WHERE e.account_id = @account_id AND e.at > @since AND e.alone AND e.kind = 'charted' AND e.title <> ''
     UNION
     SELECT e.place FROM log_entry e
     WHERE e.account_id = @account_id AND e.at > @since AND e.alone AND e.kind IN ('charted', 'met') AND e.place IS NOT NULL
     UNION
     SELECT v.place FROM log_voyage v
     WHERE v.account_id = @account_id AND v.ended_at > @since AND NOT v.aboard AND v.crew = '[]'::jsonb AND v.place IS NOT NULL
   ) seen)::integer AS places;

-- name: SailRights :one
-- What opens boats to a sailor: the owner's every boat, the certificates
-- it holds, and the kinds it keeps.
SELECT a.every_boat,
  coalesce((SELECT array_agg(c.certificate ORDER BY c.earned_at) FROM certificate c WHERE c.account_id = a.id), '{}')::text[] AS held,
  coalesce((SELECT array_agg(k.boat_kind ORDER BY k.boat_kind) FROM boat_kept k WHERE k.account_id = a.id), '{}')::text[] AS kept
FROM account a WHERE a.id = @id;

-- name: SetEveryBoat :execrows
-- Every kind of boat opened to a sailor by the owner, or closed again.
UPDATE account SET every_boat = @every_boat WHERE id = @id;

-- name: CertificatesHeld :many
-- The certificates some sailors hold, by the catalog's ids, the first
-- earned first; a sailor with none is left out.
SELECT account_id, array_agg(certificate ORDER BY earned_at, id)::text[] AS held
FROM certificate
WHERE account_id = ANY (@ids::uuid[])
GROUP BY account_id;
