-- SPDX-License-Identifier: AGPL-3.0-only
-- Accounts and their sailors.
;

-- name: CreateAccount :one
-- A human's account, made with its first passkey: saved from the start.
INSERT INTO account (kind, saved_at, user_handle, recovery_hash, recovery_made_at)
VALUES ('human', now(), @user_handle, @recovery_hash, now())
RETURNING id;

-- name: CreateSailor :exec
INSERT INTO sailor (account_id, name, name_key, look)
VALUES (@account_id, @name, @name_key, @look);

-- name: NameTaken :one
SELECT EXISTS (SELECT 1 FROM sailor WHERE name_key = @name_key)::boolean;

-- name: SetAccountTools :execrows
-- The owner's flag of a human account; an AI's is never set.
UPDATE account SET tools = @tools WHERE id = @id AND kind = 'human';

-- name: SetAccountPriority :execrows
-- A priority account, human or AI, never waits for a boat.
UPDATE account SET priority = @priority WHERE id = @id;

-- name: AccountsByID :many
-- The accounts of ids, with their sailors' names: the world page's lists.
SELECT a.id, a.kind, a.tools, a.priority, coalesce(sl.name, '')::text AS name
FROM account a
LEFT JOIN sailor sl ON sl.account_id = a.id
WHERE a.id = ANY(@ids::uuid[]);

-- name: AccountByUserHandle :one
-- The account a passkey's user handle names, as a sign-in finds it.
SELECT a.id, a.kind, a.tools, a.priority, a.notices_off, a.user_handle, sl.name, sl.look
FROM account a
JOIN sailor sl ON sl.account_id = a.id
WHERE a.user_handle = @user_handle AND a.kind = 'human';

-- name: AccountByID :one
SELECT a.id, a.kind, a.tools, a.priority, a.notices_off, coalesce(a.user_handle, '')::bytea AS user_handle, sl.name, sl.look,
  a.created_at, a.recovery_made_at, (a.recovery_hash IS NOT NULL)::boolean AS has_recovery
FROM account a
JOIN sailor sl ON sl.account_id = a.id
WHERE a.id = @id;

-- name: SpendRecoveryCode :one
-- A recovery code used: it is spent, and the next sign-in is told.
UPDATE account SET recovery_hash = NULL, recovered_at = now()
WHERE recovery_hash = @recovery_hash AND kind = 'human'
RETURNING id;

-- name: SetRecoveryCode :execrows
UPDATE account SET recovery_hash = @recovery_hash, recovery_made_at = now()
WHERE id = @id AND kind = 'human';

-- name: TakeRecoveryNotice :one
-- When the recovery code was last used, if no sign-in has been told yet;
-- telling this one clears it.
UPDATE account a SET recovered_at = NULL
FROM (SELECT o.id, o.recovered_at FROM account o WHERE o.id = @id FOR UPDATE) old
WHERE a.id = old.id
RETURNING old.recovered_at;

-- name: ForgetCredits :exec
-- A deleted account's credits keep their places, under no name.
WITH c AS (UPDATE charting SET sailor = NULL WHERE charting.account_id = @id)
UPDATE news_item SET sailor = NULL WHERE news_item.account_id = @id;

-- name: DeleteAccount :execrows
-- An account deleted, with its sailor, passkeys, sessions and ceremonies.
DELETE FROM account WHERE id = @id AND kind = 'human';

-- name: LockAccount :one
SELECT id FROM account WHERE id = @id FOR UPDATE;

-- name: AccountCounts :one
-- The human accounts: how many, made in the last week, seen in the last day.
SELECT count(*) AS total,
  count(*) FILTER (WHERE created_at > now() - interval '7 days') AS week,
  count(*) FILTER (WHERE last_seen_at > now() - interval '1 day') AS today
FROM account WHERE kind = 'human';
