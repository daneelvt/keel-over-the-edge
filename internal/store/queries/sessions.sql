-- SPDX-License-Identifier: AGPL-3.0-only
-- Sessions: a token's hash names an account.
;

-- name: CreateSession :exec
INSERT INTO session (account_id, token_hash)
VALUES (@account_id, @token_hash);

-- name: SessionAccount :one
SELECT a.id, a.kind, (a.saved_at IS NOT NULL)::boolean AS saved, sl.name, sl.look, s.last_seen_at
FROM session s
JOIN account a ON a.id = s.account_id
JOIN sailor sl ON sl.account_id = a.id
WHERE s.token_hash = @token_hash;

-- name: TouchSession :exec
WITH s AS (
  UPDATE session SET last_seen_at = now()
  WHERE token_hash = @token_hash
  RETURNING account_id
)
UPDATE account SET last_seen_at = now()
WHERE id IN (SELECT account_id FROM s);
