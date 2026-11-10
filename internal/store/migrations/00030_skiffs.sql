-- SPDX-License-Identifier: AGPL-3.0-only
-- The skiff: every human account's fleet gains one, the account's, its
-- sailors' to share, as it has a keelboat and a tall ship. Each takes the
-- lowest sail number of its kind no boat has, in the order the accounts
-- were made; an account that has one already keeps it.

-- +goose Up

WITH needing AS (
  SELECT a.id, row_number() OVER (ORDER BY a.created_at, a.id) AS n
  FROM account a
  WHERE a.kind = 'human' AND NOT EXISTS (SELECT 1 FROM boat b WHERE b.account_id = a.id AND b.kind = 'skiff')
), free AS (
  SELECT g AS number, row_number() OVER (ORDER BY g) AS n
  FROM generate_series(1, (SELECT count(*) FROM needing) + (SELECT count(*) FROM boat WHERE kind = 'skiff')) g
  WHERE NOT EXISTS (SELECT 1 FROM boat b WHERE b.kind = 'skiff' AND b.number = g)
)
INSERT INTO boat (account_id, kind, number)
SELECT needing.id, 'skiff', free.number FROM needing JOIN free USING (n);
