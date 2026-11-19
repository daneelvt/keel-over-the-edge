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

-- name: SetNoticesOff :execrows
UPDATE account SET notices_off = @off::text[] WHERE id = @id;

-- name: InsertWorldNews :exec
INSERT INTO news_item (world_id, news_column, subject, number, title, what, worth, x, y, ends_at)
VALUES (@world_id, @news_column, 'world', @number, @title, @what, 0, @x, @y, @ends_at);
