-- SPDX-License-Identifier: AGPL-3.0-only
-- Watching: the sailor a player asks to watch, the names of the boats a
-- player may watch, and the sailors a player follows.
;

-- name: WatchTarget :one
-- The account whose sailor has a name, by its key: its kind, its owner
-- (a machine sailor's human), and whether it, or its owner, is stopped.
SELECT a.id, a.kind, coalesce(a.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id, sl.name,
  (a.stopped_at IS NOT NULL OR o.stopped_at IS NOT NULL)::boolean AS stopped
FROM sailor sl
JOIN account a ON a.id = sl.account_id
LEFT JOIN account o ON o.id = a.owner_id
WHERE sl.name_key = @name_key;

-- name: SailorsByID :many
-- The sailors of the accounts of ids: their names, kinds and owners.
SELECT a.id, a.kind, coalesce(a.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id, sl.name
FROM account a
JOIN sailor sl ON sl.account_id = a.id
WHERE a.id = ANY(@ids::uuid[]);

-- name: Follows :many
-- The sailors an account follows: their accounts, names, kinds and
-- owners.
SELECT a.id, a.kind, coalesce(a.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id, sl.name
FROM follow f
JOIN account a ON a.id = f.followed_id
JOIN sailor sl ON sl.account_id = a.id
WHERE f.follower_id = @follower_id;

-- name: Follow :exec
-- An account follows another's sailor; following it again changes nothing.
INSERT INTO follow (follower_id, followed_id) VALUES (@follower_id, @followed_id)
ON CONFLICT DO NOTHING;

-- name: Unfollow :exec
-- An account stops following another's sailor.
DELETE FROM follow WHERE follower_id = @follower_id AND followed_id = @followed_id;
