-- SPDX-License-Identifier: AGPL-3.0-only
-- The news: candidate stories, a day's edition, its figures, the world's
-- notices, and the owner's strike.
;

-- name: InsertStory :execrows
-- A candidate story, its day the day of at in zone; its sailor's name and
-- account's kind copied as they are. With nearer, it is written only if no
-- story of its kind this world has an amount as small: a record.
INSERT INTO news_item (world_id, news_column, account_id, sailor, account_kind, subject, number, title, what,
  island_number, worth, x, y, written_at, story, score, day, named, amount, facts, source)
SELECT @world_id, @news_column, sqlc.narg('account_id')::uuid,
  (SELECT s.name FROM sailor s WHERE s.account_id = sqlc.narg('account_id')::uuid),
  (SELECT a.kind FROM account a WHERE a.id = sqlc.narg('account_id')::uuid),
  @subject, @number, @title, @what, sqlc.narg('island_number')::integer, @worth, @x, @y, @at::timestamptz,
  @story::text, @score, timezone(@zone::text, @at::timestamptz)::date, @named::uuid[], sqlc.narg('amount')::float8,
  @facts, sqlc.narg('source')::text
WHERE sqlc.narg('nearer')::float8 IS NULL OR NOT EXISTS (
  SELECT 1 FROM news_item n
  WHERE n.world_id = @world_id AND n.story = @story::text AND n.amount <= sqlc.narg('nearer')::float8)
ON CONFLICT (world_id, source) WHERE source IS NOT NULL DO NOTHING;

-- name: ChartedBefore :one
-- Whether an account's log has a place charted.
SELECT EXISTS (SELECT 1 FROM log_entry WHERE account_id = @account_id AND kind = 'charted');

-- name: LogRunOf :one
-- The distance an account's log has, m.
SELECT coalesce(sum(run::float8), 0)::float8 FROM log_voyage WHERE account_id = @account_id;

-- name: LogWorldsOf :one
-- The worlds an account's log has, and its voyages in one of them.
SELECT count(DISTINCT world)::integer AS worlds, (count(*) FILTER (WHERE world = @world))::integer AS here
FROM log_voyage WHERE account_id = @account_id;

-- name: LogChartedOf :one
-- The places an account has charted.
SELECT count(*)::integer FROM log_entry WHERE account_id = @account_id AND kind = 'charted';

-- name: DayStories :many
-- A day's stories, the oldest first: its candidates, and the world's
-- arrival and the last world's review if it is the world's first.
SELECT id, story::text AS story, score, account_id, sailor, account_kind, named, subject, number, title, what, worth, x, y,
  amount, facts, rank, struck, written_at
FROM news_item
WHERE world_id = @world_id AND day = @day AND story IS NOT NULL AND story <> 'edition'
ORDER BY written_at, id;

-- name: RankedStories :many
-- The stories chosen for the editions of days, set, by day and place.
SELECT id, story::text AS story, score, account_id, sailor, account_kind, named, subject, number, title, what, worth, x, y,
  amount, facts, rank, struck, written_at, day
FROM news_item
WHERE world_id = @world_id AND day = ANY(@days::date[]) AND rank IS NOT NULL AND story <> 'edition'
ORDER BY day, rank;

-- name: StoriesAbout :many
-- The stories chosen for set editions naming an account, the newest
-- first.
SELECT id, story::text AS story, score, account_id, sailor, account_kind, named, subject, number, title, what, worth, x, y,
  amount, facts, rank, struck, written_at, day
FROM news_item
WHERE world_id = @world_id AND rank IS NOT NULL AND NOT struck AND story <> 'edition'
  AND (account_id = @account_id OR @account_id::uuid = ANY(named))
ORDER BY day DESC, rank
LIMIT @lim;

-- name: Editions :many
-- The editions set of a world, the oldest first: each day, its number and
-- its figures.
SELECT day, number, facts FROM news_item WHERE world_id = @world_id AND story = 'edition' ORDER BY day;

-- name: InsertEdition :execrows
INSERT INTO news_item (world_id, news_column, subject, number, title, what, worth, x, y, story, score, day, facts, source)
VALUES (@world_id, @news_column, 'world', @number, '', '', 0, 0, 0, 'edition', 0, @day, @facts, @source)
ON CONFLICT (world_id, source) WHERE source IS NOT NULL DO NOTHING;

-- name: RankStory :execrows
UPDATE news_item SET rank = @rank WHERE world_id = @world_id AND id = @id AND rank IS NULL;

-- name: WorldNotices :many
-- The world's own notices, the oldest first: its end.
SELECT id, news_column, title, what, x, y, written_at, ends_at
FROM news_item WHERE world_id = @world_id AND subject = 'world' AND story IS NULL
ORDER BY id;

-- name: DayVoyageFigures :one
-- A day's voyages in a world, of its number, as its figures count them:
-- the boats sailed (each sailor once), the machine sailors among them,
-- the distance run and the falls.
SELECT count(DISTINCT v.account_id)::integer AS boats,
  (count(DISTINCT v.account_id) FILTER (WHERE a.kind = 'ai'))::integer AS machines,
  coalesce(sum(v.run::float8), 0)::float8 AS run,
  (count(*) FILTER (WHERE v.how = 'over'))::integer AS over
FROM log_voyage v JOIN account a ON a.id = v.account_id
WHERE v.world = @world AND NOT v.aboard AND v.ended_at >= @since AND v.ended_at < @until;

-- name: DayCharted :one
-- The places sailors charted in a world in a time.
SELECT count(*)::integer FROM charting
WHERE world_id = @world_id AND account_id IS NOT NULL AND charted_at >= @since AND charted_at < @until;

-- name: WorldVoyageFigures :one
-- A whole world's voyages, of its number: the sailors and the distance
-- run.
SELECT count(DISTINCT account_id)::integer AS sailors, coalesce(sum(run::float8) FILTER (WHERE NOT aboard), 0)::float8 AS run
FROM log_voyage WHERE world = @world;

-- name: NearestTheFalls :many
-- The voyage of a world, of its number, that came nearest the lip and
-- lived.
SELECT account_id, least::float8 AS least, coalesce(boat_name, '')::text AS boat_name, boat_kind
FROM log_voyage WHERE world = @world AND NOT aboard AND least IS NOT NULL
ORDER BY least, ended_at LIMIT 1;

-- name: ChartedIslands :one
SELECT count(*)::integer FROM charting WHERE world_id = @world_id AND subject = 'island';

-- name: GreatestFinds :many
-- A world's greatest finds by sailors, the greatest first.
SELECT account_id, sailor, account_kind, subject, number, title, what, worth
FROM news_item WHERE world_id = @world_id AND story IN ('great', 'first', 'charting')
ORDER BY worth DESC, written_at, id LIMIT @lim;

-- name: ArrivalFacts :many
SELECT facts FROM news_item WHERE world_id = @world_id AND story = 'arrival';

-- name: StrikeStory :one
-- A story struck from the news, or put back.
UPDATE news_item SET struck = @struck
WHERE world_id = @world_id AND id = @id AND story IS NOT NULL AND story <> 'edition'
RETURNING account_id, sailor, title, story::text AS story;

-- name: DayRaces :one
-- The races run in a world in a time: finished, with a boat that
-- started.
SELECT count(*)::integer FROM race r
WHERE r.world_id = @world_id AND r.kind = 'race' AND r.state = 'finished' AND r.ended_at >= @since AND r.ended_at < @until
  AND EXISTS (SELECT 1 FROM race_entry e WHERE e.world_id = r.world_id AND e.race_id = r.id AND e.started_at IS NOT NULL);
