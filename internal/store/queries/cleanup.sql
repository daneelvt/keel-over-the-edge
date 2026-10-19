-- SPDX-License-Identifier: AGPL-3.0-only
-- Cleanup: what can no longer be used.
;

-- name: DeleteStaleSessions :execrows
DELETE FROM session WHERE id IN (
  SELECT s.id FROM session s WHERE s.last_seen_at < @before ORDER BY s.last_seen_at LIMIT @lim
);
