-- SPDX-License-Identifier: AGPL-3.0-only
-- Accounts and their sailors.
;

-- name: CreateGuestAccount :one
INSERT INTO account (kind) VALUES ('human')
RETURNING id;

-- name: CreateSailor :exec
INSERT INTO sailor (account_id, name, name_key, look)
VALUES (@account_id, @name, @name_key, @look);
