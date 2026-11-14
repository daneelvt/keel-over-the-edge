-- SPDX-License-Identifier: AGPL-3.0-only
-- Watching: the sailor a player asks to watch, the names of the boats a
-- player may watch, and the sailors a player follows.
;

-- name: WatchTarget :one
-- The account whose sailor has a name, by its key: its kind, its owner
-- (a machine sailor's human), whether it, or its owner, is stopped, and
-- its month of birth (0 for not known).
SELECT a.id, a.kind, coalesce(a.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id, sl.name,
  (a.stopped_at IS NOT NULL OR o.stopped_at IS NOT NULL)::boolean AS stopped, coalesce(a.born, 0)::integer AS born
FROM sailor sl
JOIN account a ON a.id = sl.account_id
LEFT JOIN account o ON o.id = a.owner_id
WHERE sl.name_key = @name_key;

-- name: WatchTargetByID :one
-- The account of an id, as WatchTarget has it.
SELECT a.id, a.kind, coalesce(a.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id, sl.name,
  (a.stopped_at IS NOT NULL OR o.stopped_at IS NOT NULL)::boolean AS stopped, coalesce(a.born, 0)::integer AS born
FROM account a
JOIN sailor sl ON sl.account_id = a.id
LEFT JOIN account o ON o.id = a.owner_id
WHERE a.id = @id;

-- name: SailorsByID :many
-- The sailors of the accounts of ids: their names, kinds, owners and
-- the codes of their links.
SELECT a.id, a.kind, coalesce(a.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id, sl.name, a.watch_code
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

-- name: LinkCodes :one
-- An account's codes for its links to watch: its sailor's, and, for a
-- human, its fleet's ('' for a machine sailor).
SELECT watch_code, coalesce(fleet_code, '')::text AS fleet_code FROM account WHERE id = @id;

-- name: LinkTarget :one
-- The sailor whose link has a code, as WatchTarget has it.
SELECT a.id, a.kind, coalesce(a.owner_id, '00000000-0000-0000-0000-000000000000')::uuid AS owner_id, sl.name,
  (a.stopped_at IS NOT NULL OR o.stopped_at IS NOT NULL)::boolean AS stopped, coalesce(a.born, 0)::integer AS born
FROM account a
JOIN sailor sl ON sl.account_id = a.id
LEFT JOIN account o ON o.id = a.owner_id
WHERE a.watch_code = @code;

-- name: FleetLinkOwner :one
-- The human account whose fleet's link has a code.
SELECT id FROM account WHERE fleet_code = @code AND kind = 'human';

-- name: NewWatchCode :one
-- A new code for the link to a sailor: a human account's own, or one of its
-- machine sailors'. The old code stops working.
UPDATE account SET watch_code = link_code()
WHERE id = @id AND ((id = @owner AND kind = 'human') OR (owner_id = @owner AND kind = 'ai'))
RETURNING watch_code;

-- name: NewFleetCode :one
-- A new code for the link to a human's fleet. The old code stops working.
UPDATE account SET fleet_code = link_code() WHERE id = @id AND kind = 'human'
RETURNING fleet_code;
