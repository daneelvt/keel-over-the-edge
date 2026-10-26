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
-- The account a passkey's user handle names, as a sign-in finds it, and
-- whether it is stopped.
SELECT a.id, a.kind, a.tools, a.priority, a.notices_off, a.user_handle, sl.name, sl.look,
  (a.stopped_at IS NOT NULL)::boolean AS stopped
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
-- A recovery code used: it is spent, and the next sign-in is told. A
-- stopped account's is not.
UPDATE account SET recovery_hash = NULL, recovered_at = now(), last_seen_at = now()
WHERE recovery_hash = @recovery_hash AND kind = 'human' AND stopped_at IS NULL
RETURNING id;

-- name: RecoveryCodeStopped :one
-- Whether a recovery code is a stopped account's.
SELECT EXISTS (SELECT 1 FROM account WHERE recovery_hash = @recovery_hash AND kind = 'human' AND stopped_at IS NOT NULL)::boolean;

-- name: AccountSeen :exec
-- An account seen now: signed in.
UPDATE account SET last_seen_at = now() WHERE id = @id;

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

-- name: AccountForAction :one
-- An account the operator acts on, locked for the rest of the transaction,
-- so that two actions on it run one after the other: its kind, its
-- sailor's name, its owner, its flag, and whether it, or its owner, is
-- stopped.
SELECT a.id, a.kind, a.owner_id, coalesce(sl.name, '')::text AS name, a.tools, (a.stopped_at IS NOT NULL)::boolean AS stopped,
  coalesce(o.tools, false)::boolean AS owner_tools, (o.stopped_at IS NOT NULL)::boolean AS owner_stopped
FROM account a
LEFT JOIN sailor sl ON sl.account_id = a.id
LEFT JOIN account o ON o.id = a.owner_id
WHERE a.id = @id
FOR UPDATE OF a;

-- name: StopAccount :execrows
UPDATE account SET stopped_at = now(), stop_reason = @reason WHERE id = @id AND stopped_at IS NULL;

-- name: StartAccount :execrows
UPDATE account SET stopped_at = NULL, stop_reason = NULL WHERE id = @id AND stopped_at IS NOT NULL;

-- name: StoppedAccounts :many
-- The accounts stopped: those stopped themselves, and the machine sailors
-- of a human stopped.
SELECT a.id, a.kind FROM account a
LEFT JOIN account o ON o.id = a.owner_id
WHERE a.stopped_at IS NOT NULL OR o.stopped_at IS NOT NULL;

-- name: CountSessions :one
SELECT count(*) FROM session WHERE account_id = @account_id;

-- name: SessionOf :one
-- The account a session's token names, stopped or not, as the operator's
-- search finds it.
SELECT account_id FROM session WHERE token_hash = @token_hash;

-- name: InsertAction :exec
-- An action recorded at the moment it is taken, under its account's lock,
-- not as its transaction began: two actions on one account are recorded
-- in the order they were taken.
INSERT INTO account_action (at, action, account_id, kind, name, detail, source, from_addr)
VALUES (clock_timestamp(), @action, @account_id, @kind, @name, @detail, @source, @from_addr);

-- name: ActionsOf :many
-- The record of an account, the newest first.
SELECT at, action, account_id, coalesce(kind, '')::text AS kind, name, detail, source, from_addr
FROM account_action WHERE account_id = @account_id
ORDER BY at DESC, id DESC LIMIT @lim;

-- name: LatestActions :many
SELECT at, action, account_id, coalesce(kind, '')::text AS kind, name, detail, source, from_addr
FROM account_action
ORDER BY at DESC, id DESC LIMIT @lim;

-- name: SearchAccounts :many
-- The human accounts whose sailor, or one of whose machine sailors, has a
-- name whose key is the key given or, with part, holds the pattern; every
-- human account with every. A page of them, those with the key itself
-- first, sorted as asked: by last active, oldest or newest first; the
-- newest made; or their machine sailors' latest call; with how many
-- there are in all.
WITH hit AS (
  SELECT coalesce(a.owner_id, a.id) AS id, bool_or(sl.name_key = sqlc.arg(key)::text) AS exact
  FROM account a JOIN sailor sl ON sl.account_id = a.id
  WHERE sqlc.arg(every)::boolean OR sl.name_key = sqlc.arg(key)::text
     OR (sqlc.arg(part)::boolean AND sl.name_key LIKE sqlc.arg(pattern)::text)
  GROUP BY 1
), found AS (
  SELECT h.id, sl.name, h.created_at, h.last_seen_at, h.tools, h.priority, (h.stopped_at IS NOT NULL)::boolean AS stopped, hit.exact,
    (SELECT max(m.last_seen_at) FROM account m WHERE m.owner_id = h.id AND m.kind = 'ai' AND m.last_seen_at > m.created_at) AS machines_seen
  FROM hit
  JOIN account h ON h.id = hit.id AND h.kind = 'human'
  JOIN sailor sl ON sl.account_id = h.id
)
SELECT id, name, created_at, last_seen_at, tools, priority, stopped, exact,
  coalesce(machines_seen, 'epoch')::timestamptz AS machines_seen, count(*) OVER () AS total
FROM found
ORDER BY exact DESC,
  CASE WHEN sqlc.arg(sort)::text = 'active-old' THEN last_seen_at END ASC,
  CASE WHEN sqlc.arg(sort)::text = 'active-new' THEN last_seen_at END DESC,
  CASE WHEN sqlc.arg(sort)::text = 'made' THEN created_at END DESC,
  CASE WHEN sqlc.arg(sort)::text = 'machines' THEN machines_seen END DESC NULLS LAST,
  id
LIMIT sqlc.arg(lim) OFFSET sqlc.arg(off);

-- name: HumansByActiveOldest :many
-- A page of every human account, the least lately active first, by the
-- index of last active.
SELECT h.id, sl.name, h.created_at, h.last_seen_at, h.tools, h.priority, (h.stopped_at IS NOT NULL)::boolean AS stopped
FROM account h JOIN sailor sl ON sl.account_id = h.id
WHERE h.kind = 'human'
ORDER BY h.last_seen_at, h.id
LIMIT @lim OFFSET @off;

-- name: HumansByActiveNewest :many
-- A page of every human account, the most lately active first.
SELECT h.id, sl.name, h.created_at, h.last_seen_at, h.tools, h.priority, (h.stopped_at IS NOT NULL)::boolean AS stopped
FROM account h JOIN sailor sl ON sl.account_id = h.id
WHERE h.kind = 'human'
ORDER BY h.last_seen_at DESC, h.id DESC
LIMIT @lim OFFSET @off;

-- name: MachinesOfMany :many
-- The machine sailors of human accounts, the oldest first.
SELECT a.id, a.owner_id, sl.name, sl.name_key, a.created_at, a.last_seen_at, a.priority, (a.stopped_at IS NOT NULL)::boolean AS stopped
FROM account a JOIN sailor sl ON sl.account_id = a.id
WHERE a.owner_id = ANY(@owners::uuid[]) AND a.kind = 'ai'
ORDER BY a.created_at, a.id;

-- name: AccountCard :one
-- What the world page's card shows of an account, and of its owner.
SELECT a.id, a.kind, a.owner_id, sl.name, sl.look, coalesce(sl.version, '')::text AS version, coalesce(sl.finish, '')::text AS finish,
  coalesce(sl.colour, '')::text AS colour, a.created_at, a.last_seen_at, a.tools, a.priority, a.machine_cap,
  coalesce(a.stopped_at, 'epoch')::timestamptz AS stopped_at, coalesce(a.stop_reason, '')::text AS stop_reason,
  coalesce(a.recovery_made_at, 'epoch')::timestamptz AS recovery_made_at, (a.recovery_hash IS NOT NULL)::boolean AS has_recovery,
  coalesce(osl.name, '')::text AS owner_name, coalesce(o.tools, false)::boolean AS owner_tools,
  coalesce(o.stopped_at, 'epoch')::timestamptz AS owner_stopped_at
FROM account a
JOIN sailor sl ON sl.account_id = a.id
LEFT JOIN account o ON o.id = a.owner_id
LEFT JOIN sailor osl ON osl.account_id = o.id
WHERE a.id = @id;

-- name: SessionsSeen :one
-- How many sessions an account has, and when the latest was last seen.
SELECT count(*) AS sessions, coalesce(max(last_seen_at), 'epoch')::timestamptz AS latest FROM session WHERE account_id = @account_id;
