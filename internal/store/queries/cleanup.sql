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
