-- SPDX-License-Identifier: AGPL-3.0-only
-- Cleanup: what can no longer be used.
;

-- name: DeleteStaleSessions :execrows
DELETE FROM session WHERE id IN (
  SELECT s.id FROM session s WHERE s.last_seen_at < @before ORDER BY s.last_seen_at LIMIT @lim
);

-- name: DeleteExpiredCeremonies :execrows
DELETE FROM webauthn_ceremony WHERE handle_hash IN (
  SELECT c.handle_hash FROM webauthn_ceremony c WHERE c.expires_at < @before ORDER BY c.expires_at LIMIT @lim
);

-- name: DeleteExpiredRequests :execrows
DELETE FROM oauth_request WHERE handle_hash IN (
  SELECT r.handle_hash FROM oauth_request r WHERE r.expires_at < @before ORDER BY r.expires_at LIMIT @lim
);

-- name: DeleteExpiredCodes :execrows
DELETE FROM oauth_code WHERE hash IN (
  SELECT c.hash FROM oauth_code c WHERE c.expires_at < @before ORDER BY c.expires_at LIMIT @lim
);

-- name: DeleteExpiredAccessTokens :execrows
DELETE FROM oauth_token WHERE hash IN (
  SELECT t.hash FROM oauth_token t WHERE t.kind = 'access' AND t.expires_at < @before ORDER BY t.expires_at LIMIT @lim
);

-- name: DeleteEndedRefreshTokens :execrows
-- The used refresh tokens of grants revoked, or ended by the lifetime.
DELETE FROM oauth_token WHERE hash IN (
  SELECT t.hash FROM oauth_token t JOIN ai_grant g ON g.id = t.grant_id
  WHERE t.kind = 'refresh' AND t.used_at IS NOT NULL
    AND (g.revoked_at IS NOT NULL OR g.approved_at + sqlc.arg(micros)::bigint * interval '1 microsecond' <= now())
  LIMIT @lim
);

-- name: DeleteEndedGrants :execrows
-- The grants revoked, or ended by the lifetime, before the time given,
-- with their tokens and codes.
DELETE FROM ai_grant WHERE id IN (
  SELECT g.id FROM ai_grant g
  WHERE coalesce(g.revoked_at, g.approved_at + sqlc.arg(micros)::bigint * interval '1 microsecond') < @before
  LIMIT @lim
);

-- name: DeleteUnusedClients :execrows
-- The clients that registered and have no grant left, unused since the
-- time given.
DELETE FROM oauth_client WHERE client_id IN (
  SELECT c.client_id FROM oauth_client c
  WHERE c.last_used_at < @before AND NOT EXISTS (SELECT 1 FROM ai_grant g WHERE g.client_id = c.client_id)
  LIMIT @lim
);
