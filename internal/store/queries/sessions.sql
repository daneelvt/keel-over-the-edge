-- SPDX-License-Identifier: AGPL-3.0-only
-- Sessions: a token's hash names an account.
;

-- name: CreateSession :exec
INSERT INTO session (account_id, token_hash, held)
VALUES (@account_id, @token_hash, @held);

-- name: SessionAccount :one
-- The account a session names; none for a stopped account's.
SELECT a.id, a.kind, a.tools, a.priority, a.notices_off, sl.name, sl.look, s.last_seen_at,
  s.held, coalesce(s.confirmed_until, 'epoch')::timestamptz AS confirmed_until
FROM session s
JOIN account a ON a.id = s.account_id
JOIN sailor sl ON sl.account_id = a.id
WHERE s.token_hash = @token_hash AND a.stopped_at IS NULL;

-- name: TouchSession :exec
WITH s AS (
  UPDATE session SET last_seen_at = now()
  WHERE token_hash = @token_hash
  RETURNING account_id
)
UPDATE account SET last_seen_at = now()
WHERE id IN (SELECT account_id FROM s);

-- name: DeleteSession :execrows
DELETE FROM session WHERE token_hash = @token_hash;

-- name: DeleteOtherSessions :execrows
DELETE FROM session WHERE account_id = @account_id AND token_hash <> @keep;

-- name: DeleteAccountSessions :execrows
DELETE FROM session WHERE account_id = @account_id;

-- name: ConfirmSession :execrows
UPDATE session SET confirmed_until = @until WHERE token_hash = @token_hash AND account_id = @account_id;

-- name: ReleaseSession :execrows
-- A session held to adding a passkey, let go once one is added.
UPDATE session SET held = false WHERE token_hash = @token_hash AND account_id = @account_id;

-- name: AccountHeld :one
-- Whether an account has a session held to adding a passkey: its
-- recovery code used, and no passkey added since.
SELECT EXISTS (SELECT 1 FROM session WHERE account_id = @account_id AND held)::boolean;
