-- SPDX-License-Identifier: AGPL-3.0-only
-- Watching: the sailor a player asks to watch, the accounts that let
-- anyone watch them, and the names of the boats a player may watch.
;

-- name: WatchTarget :one
-- The account whose sailor has a name, by its key: its kind, its owner
-- (a machine sailor's human), whether it lets anyone watch always, and
-- whether it, or its owner, is stopped.
SELECT a.id, a.kind, coalesce(a.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id, sl.name, a.spectators,
  (a.stopped_at IS NOT NULL OR o.stopped_at IS NOT NULL)::boolean AS stopped
FROM sailor sl
JOIN account a ON a.id = sl.account_id
LEFT JOIN account o ON o.id = a.owner_id
WHERE sl.name_key = @name_key;

-- name: SetSpectators :execrows
-- Whether a human account lets anyone watch it always; an AI's is never
-- set.
UPDATE account SET spectators = @spectators WHERE id = @id AND kind = 'human';

-- name: SpectatorsAllowed :many
-- The accounts that let anyone watch them always.
SELECT id FROM account WHERE spectators;

-- name: SailorsByID :many
-- The sailors of the accounts of ids: their names, kinds and owners.
SELECT a.id, a.kind, coalesce(a.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id, sl.name
FROM account a
JOIN sailor sl ON sl.account_id = a.id
WHERE a.id = ANY(@ids::uuid[]);
