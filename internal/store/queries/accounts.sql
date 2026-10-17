-- SPDX-License-Identifier: AGPL-3.0-only
-- Accounts and their sailors.
;

-- name: CreateGuestAccount :one
INSERT INTO account (kind) VALUES ('human')
RETURNING id;

-- name: CreateSailor :exec
INSERT INTO sailor (account_id, name, name_key, look)
VALUES (@account_id, @name, @name_key, @look);

-- name: SetAccountTools :execrows
-- The owner's flag of a human account; an AI's is never set.
UPDATE account SET tools = @tools WHERE id = @id AND kind = 'human';

-- name: AccountsByID :many
-- The accounts of ids, with their sailors' names: the world page's lists.
SELECT a.id, a.kind, (a.saved_at IS NOT NULL)::boolean AS saved, a.tools, coalesce(sl.name, '')::text AS name
FROM account a
LEFT JOIN sailor sl ON sl.account_id = a.id
WHERE a.id = ANY(@ids::uuid[]);
