-- SPDX-License-Identifier: AGPL-3.0-only
-- Machine sailors: the AI accounts a human account makes, and its fleet.
;

-- name: CreateMachineAccount :one
-- An AI account, saved from the start; it has no passkey, session or
-- recovery code, and makes no machine sailors of its own.
INSERT INTO account (kind, owner_id, saved_at, machine_cap)
VALUES ('ai', @owner_id, now(), 0)
RETURNING id;

-- name: CreateMachineSailor :exec
INSERT INTO sailor (account_id, name, name_key, look, version, finish, colour)
VALUES (@account_id, @name, @name_key, 'machine', @version, @finish, @colour);

-- name: LockOwner :one
-- A human account's row, locked for the rest of the transaction, so that
-- two machine sailors made at once are counted one after the other.
SELECT machine_cap FROM account WHERE id = @id AND kind = 'human' FOR UPDATE;

-- name: CountMachines :one
SELECT count(*) FROM account WHERE owner_id = @owner_id AND kind = 'ai';

-- name: CountBoats :one
SELECT count(*) FROM boat WHERE account_id = @account_id AND kind = @kind;

-- name: CreateBoat :exec
INSERT INTO boat (account_id, kind) VALUES (@account_id, @kind);

-- name: Fleet :many
-- A human account's boats, by kind: how many of each.
SELECT kind, count(*) AS boats FROM boat WHERE account_id = @account_id GROUP BY kind ORDER BY kind;

-- name: MachinesOf :many
-- A human account's machine sailors, the oldest first.
SELECT a.id, sl.name, coalesce(sl.version, '')::text AS version, coalesce(sl.finish, '')::text AS finish,
  coalesce(sl.colour, '')::text AS colour, a.created_at
FROM account a
JOIN sailor sl ON sl.account_id = a.id
WHERE a.owner_id = @owner_id AND a.kind = 'ai'
ORDER BY a.created_at, a.id;

-- name: MachineOf :one
-- One of a human account's machine sailors.
SELECT a.id, sl.name FROM account a JOIN sailor sl ON sl.account_id = a.id
WHERE a.id = @id AND a.owner_id = @owner_id AND a.kind = 'ai';

-- name: MachineIDsOf :many
SELECT id FROM account WHERE owner_id = @owner_id AND kind = 'ai';

-- name: DeleteMachine :execrows
-- A machine sailor deleted, with its grants and their tokens.
DELETE FROM account WHERE id = @id AND owner_id = @owner_id AND kind = 'ai';

-- name: DeleteMachinesOf :execrows
DELETE FROM account WHERE owner_id = @owner_id AND kind = 'ai';

-- name: SetMachineCap :execrows
-- How many machine sailors a human account may make.
UPDATE account SET machine_cap = @machine_cap WHERE id = @id AND kind = 'human';

-- name: MachineCap :one
SELECT machine_cap FROM account WHERE id = @id AND kind = 'human';

-- name: MachineCounts :one
-- The machine sailors: how many, and made in the last week.
SELECT count(*) AS total,
  count(*) FILTER (WHERE created_at > now() - interval '7 days') AS week
FROM account WHERE kind = 'ai';
