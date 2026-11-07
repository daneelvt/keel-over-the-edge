-- SPDX-License-Identifier: AGPL-3.0-only
-- The fleet: an account's boats, their looks, and whose each is.
;

-- name: FleetBoats :many
-- A human account's boats, the oldest first, each with its sailor's name
-- and kind, if it has one.
SELECT b.id, b.kind, b.number, coalesce(b.name, '')::text AS name, b.paint, b.cloth, b.sailor,
  coalesce(sl.name, '')::text AS sailor_name, coalesce(a.kind = 'ai', false)::boolean AS machine, b.made_at
FROM boat b
LEFT JOIN account a ON a.id = b.sailor
LEFT JOIN sailor sl ON sl.account_id = b.sailor
WHERE b.account_id = @account_id
ORDER BY b.made_at, b.id;

-- name: FleetOwner :one
-- The human account whose fleet a sailor sails from: its own, or its
-- owner's for a machine sailor.
SELECT coalesce(owner_id, id)::uuid AS owner FROM account WHERE id = @id;

-- name: LetBoatGo :exec
-- A sailor's boat, but the one given, is no longer theirs.
UPDATE boat SET sailor = NULL WHERE sailor = @sailor AND id <> @id;

-- name: GiveBoat :execrows
-- One of an account's boats becomes a sailor's.
UPDATE boat SET sailor = @sailor WHERE id = @id AND account_id = @account_id;

-- name: SetBoatLook :execrows
UPDATE boat SET paint = @paint, cloth = @cloth, number = @number, name = sqlc.narg(name)
WHERE id = @id AND account_id = @account_id;

-- name: BoatNumberTaken :one
-- Whether another boat of a kind has a sail number.
SELECT EXISTS (SELECT 1 FROM boat WHERE kind = @kind AND number = @number AND id <> @id)::boolean;

-- name: LockBoatNumbers :exec
-- Numbers of a kind are given one at a time, to the end of the
-- transaction.
SELECT pg_advisory_xact_lock(hashtext('boat number ' || @kind::text));

-- name: FreeBoatNumber :one
-- The lowest sail number of a kind no boat has.
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM boat o WHERE o.kind = sqlc.arg(kind)::text AND o.number = 1) THEN 1
  ELSE (SELECT min(b.number) + 1 FROM boat b WHERE b.kind = sqlc.arg(kind)::text
    AND NOT EXISTS (SELECT 1 FROM boat c WHERE c.kind = sqlc.arg(kind)::text AND c.number = b.number + 1)) END::integer AS number;
