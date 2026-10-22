-- SPDX-License-Identifier: AGPL-3.0-only
-- The shared chart: what is charted, the news, and the notices switched off.
;

-- name: InsertCharting :one
INSERT INTO charting (world_id, subject, number, account_id, sailor, account_kind, boat, tick, x, y, worth, with_subject, with_number)
VALUES (@world_id, @subject, @number, @account_id,
  (SELECT s.name FROM sailor s WHERE s.account_id = @account_id),
  (SELECT a.kind FROM account a WHERE a.id = @account_id),
  @boat, @tick, @x, @y, @worth, @with_subject, @with_number)
ON CONFLICT (world_id, subject, number) DO NOTHING
RETURNING sailor, account_kind, charted_at;

-- name: ChartRows :many
SELECT subject, number, account_id, sailor, account_kind, boat, tick, x, y, worth, with_subject, with_number, charted_at
FROM charting WHERE world_id = @world_id
ORDER BY charted_at, tick, subject, number;

-- name: FoldNews :execrows
UPDATE news_item SET also = news_item.also || @item::jsonb
WHERE news_item.world_id = @world_id AND news_item.id = (
  SELECT n.id FROM news_item n
  WHERE n.world_id = @world_id AND n.account_id = @account_id AND n.island_number = @island_number
    AND n.written_at > now() - make_interval(secs => @within::float8)
  ORDER BY n.written_at DESC LIMIT 1
);

-- name: InsertNews :exec
INSERT INTO news_item (world_id, news_column, account_id, sailor, account_kind, subject, number, title, what, island_number, worth, x, y)
VALUES (@world_id, @news_column, @account_id, @sailor, @account_kind, @subject, @number, @title, @what, @island_number, @worth, @x, @y);

-- name: News :many
SELECT id, news_column, sailor, account_kind, subject, number, title, what, worth, x, y, also, written_at, ends_at
FROM news_item
WHERE world_id = @world_id AND (sqlc.narg('before')::uuid IS NULL OR id < sqlc.narg('before')::uuid)
ORDER BY id DESC
LIMIT @lim;

-- name: SetNoticesOff :execrows
UPDATE account SET notices_off = @off::text[] WHERE id = @id;

-- name: InsertWorldNews :exec
INSERT INTO news_item (world_id, news_column, subject, number, title, what, worth, x, y, ends_at)
VALUES (@world_id, @news_column, 'world', @number, @title, @what, 0, @x, @y, @ends_at);

-- name: InsertGaleNews :execrows
INSERT INTO news_item (world_id, news_column, subject, number, title, what, worth, x, y)
VALUES (@world_id, @news_column, 'gale', @number, @title, @what, 0, @x, @y)
ON CONFLICT (world_id, number) WHERE subject = 'gale' DO NOTHING;
