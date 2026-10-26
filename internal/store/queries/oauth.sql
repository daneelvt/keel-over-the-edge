-- SPDX-License-Identifier: AGPL-3.0-only
-- Sign-in for AI apps: the clients that registered, the requests waiting
-- for approval, the grants approved, their codes and tokens, and how long
-- a grant lasts.
;

-- name: InsertClient :exec
INSERT INTO oauth_client (client_id, name, redirect_uris, metadata)
VALUES (@client_id, @name, @redirect_uris, @metadata);

-- name: ClientByID :one
SELECT client_id, name, redirect_uris FROM oauth_client WHERE client_id = @client_id;

-- name: ClientUsed :exec
UPDATE oauth_client SET last_used_at = now() WHERE client_id = @client_id;

-- name: InsertRequest :exec
INSERT INTO oauth_request (handle_hash, client_id, client_name, registered, redirect_uri, state, code_challenge, expires_at)
VALUES (@handle_hash, @client_id, @client_name, @registered, @redirect_uri, @state, @code_challenge, @expires_at);

-- name: RequestByHash :one
SELECT client_id, client_name, registered, redirect_uri, state, code_challenge, account_id, passkey_id,
  coalesce(confirmed_until, 'epoch')::timestamptz AS confirmed_until, expires_at
FROM oauth_request WHERE handle_hash = @handle_hash;

-- name: ConfirmRequest :execrows
-- The request's approval begun by an account's passkey.
UPDATE oauth_request SET account_id = @account_id, passkey_id = @passkey_id, confirmed_until = @confirmed_until
WHERE handle_hash = @handle_hash AND expires_at > now();

-- name: TakeRequest :one
-- A request approved or denied: taken and gone, so it is used once.
DELETE FROM oauth_request WHERE handle_hash = @handle_hash
RETURNING client_id, client_name, registered, redirect_uri, state, code_challenge, account_id, passkey_id,
  coalesce(confirmed_until, 'epoch')::timestamptz AS confirmed_until, expires_at;

-- name: InsertGrant :one
INSERT INTO ai_grant (account_id, kind, client_id, client_name, redirect_uri, approved_by, passkey_id)
VALUES (@account_id, @kind, @client_id, @client_name, @redirect_uri, @approved_by, @passkey_id)
RETURNING id, approved_at;

-- name: GrantsOf :many
-- The grants of a human account's machine sailors, unrevoked or revoked
-- since the time given: what the account page lists.
SELECT g.id, g.account_id, g.kind, coalesce(g.client_id, '')::text AS client_id, coalesce(g.client_name, '')::text AS client_name,
  coalesce(g.redirect_uri, '')::text AS redirect_uri, g.approved_at,
  coalesce(g.last_used_at, 'epoch')::timestamptz AS last_used_at,
  coalesce(g.revoked_at, 'epoch')::timestamptz AS revoked_at, coalesce(g.revoked_why, '')::text AS revoked_why
FROM ai_grant g
JOIN account a ON a.id = g.account_id
WHERE a.owner_id = @owner_id AND (g.revoked_at IS NULL OR g.revoked_at > @since)
ORDER BY g.approved_at, g.id;

-- name: LiveGrantsOfMachine :many
-- A machine sailor's unrevoked grants of a kind, locked.
SELECT id, coalesce(client_id, '')::text AS client_id, approved_at FROM ai_grant
WHERE account_id = @account_id AND kind = @kind AND revoked_at IS NULL
ORDER BY approved_at
FOR UPDATE;

-- name: RevokeGrant :one
UPDATE ai_grant SET revoked_at = now(), revoked_why = @why
WHERE id = @id AND revoked_at IS NULL
RETURNING account_id;

-- name: OwnedGrant :one
-- A grant of one of a human account's machine sailors.
SELECT g.id, g.account_id, g.kind FROM ai_grant g JOIN account a ON a.id = g.account_id
WHERE g.id = @id AND a.owner_id = @owner_id;

-- name: GrantUsed :exec
UPDATE ai_grant SET last_used_at = @at WHERE id = @id;

-- name: InsertCode :exec
INSERT INTO oauth_code (hash, grant_id, client_id, redirect_uri, code_challenge, expires_at)
VALUES (@hash, @grant_id, @client_id, @redirect_uri, @code_challenge, @expires_at);

-- name: UseCode :one
-- A code exchanged: marked used, so a second use is known.
UPDATE oauth_code c SET used_at = now()
FROM ai_grant g
WHERE c.hash = @hash AND c.used_at IS NULL AND g.id = c.grant_id
RETURNING c.grant_id, c.client_id, c.redirect_uri, c.code_challenge, c.expires_at,
  g.account_id, g.approved_at, coalesce(g.revoked_at, 'epoch')::timestamptz AS revoked_at;

-- name: UsedCode :one
-- A code that was exchanged already: its grant.
SELECT grant_id FROM oauth_code WHERE hash = @hash AND used_at IS NOT NULL;

-- name: InsertToken :exec
INSERT INTO oauth_token (hash, grant_id, kind, pair, expires_at)
VALUES (@hash, @grant_id, @kind, @pair, @expires_at);

-- name: TokenForRefresh :one
-- A refresh token presented, its grant and the pair issued in its place,
-- locked, so that two refreshes of one token run one after the other.
SELECT t.hash, t.grant_id, t.pair, coalesce(t.used_at, 'epoch')::timestamptz AS used_at, t.next_pair,
  g.account_id, g.kind AS grant_kind, coalesce(g.client_id, '')::text AS client_id, g.approved_at,
  coalesce(g.revoked_at, 'epoch')::timestamptz AS revoked_at, coalesce(g.revoked_why, '')::text AS revoked_why
FROM oauth_token t
JOIN ai_grant g ON g.id = t.grant_id
WHERE t.hash = @hash AND t.kind = 'refresh'
FOR UPDATE OF t, g;

-- name: PairUsed :one
-- Whether the refresh token of a pair has been used.
SELECT (used_at IS NOT NULL)::boolean FROM oauth_token WHERE pair = @pair AND kind = 'refresh';

-- name: DeletePair :execrows
DELETE FROM oauth_token WHERE pair = @pair;

-- name: RotateToken :exec
UPDATE oauth_token SET used_at = coalesce(used_at, now()), next_pair = @next_pair WHERE hash = @hash;

-- name: TokenByHash :one
-- A token as the door checks it: its grant, its machine sailor and its
-- owner's sailor.
SELECT t.kind, t.grant_id, coalesce(t.expires_at, 'epoch')::timestamptz AS expires_at,
  g.kind AS grant_kind, g.approved_at, coalesce(g.revoked_at, 'epoch')::timestamptz AS revoked_at,
  coalesce(g.revoked_why, '')::text AS revoked_why, coalesce(g.client_name, '')::text AS client_name,
  g.account_id, sl.name, coalesce(osl.name, '')::text AS owner_name
FROM oauth_token t
JOIN ai_grant g ON g.id = t.grant_id
JOIN account a ON a.id = g.account_id
JOIN sailor sl ON sl.account_id = a.id
LEFT JOIN sailor osl ON osl.account_id = a.owner_id
WHERE t.hash = @hash;

-- name: TokenKind :one
SELECT t.kind, t.grant_id, g.account_id, coalesce(g.client_id, '')::text AS client_id
FROM oauth_token t JOIN ai_grant g ON g.id = t.grant_id WHERE t.hash = @hash;

-- name: DeleteToken :execrows
DELETE FROM oauth_token WHERE hash = @hash;

-- name: GrantLifetime :one
SELECT (extract(epoch FROM grant_lifetime) * 1000000)::bigint AS micros FROM setting;

-- name: SetGrantLifetime :execrows
UPDATE setting SET grant_lifetime = sqlc.arg(micros)::bigint * interval '1 microsecond';

-- name: GrantsEndedBy :one
-- How many grants live under the lifetime now a new one would end at once.
SELECT count(*) FROM ai_grant
WHERE revoked_at IS NULL AND approved_at + sqlc.arg(now_micros)::bigint * interval '1 microsecond' > now()
  AND approved_at + sqlc.arg(micros)::bigint * interval '1 microsecond' <= now();

-- name: LiveGrants :many
-- The unrevoked grants within a lifetime, by kind.
SELECT kind, count(*) AS grants FROM ai_grant
WHERE revoked_at IS NULL AND approved_at + sqlc.arg(micros)::bigint * interval '1 microsecond' > now()
GROUP BY kind ORDER BY kind;
