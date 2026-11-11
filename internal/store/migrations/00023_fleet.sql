-- SPDX-License-Identifier: AGPL-3.0-only
-- The fleet: each boat's look and who has it. A boat has a hull paint and a
-- sail cloth, places in the catalog's lists (0, the first, for a boat made
-- before), a sail number, unique within its kind and given by the game,
-- and a name, none until given. sailor is the sailor whose boat it is: the
-- one who sails it, or sailed it last and takes it again, a sailor of the
-- account (the account's own, or one of its machine sailors'), one boat to
-- a sailor; null for none. Whether the sailor is in the water is the
-- world's, never stored.
--
-- Every human account's fleet gains a keelboat, one for the account, its
-- sailors' to share. The numbers are given in the order the boats were
-- made.

-- +goose Up

ALTER TABLE boat
  ADD COLUMN sailor uuid REFERENCES account (id) ON DELETE SET NULL,
  ADD COLUMN paint smallint NOT NULL DEFAULT 0 CHECK (paint BETWEEN 0 AND 15),
  ADD COLUMN cloth smallint NOT NULL DEFAULT 0 CHECK (cloth BETWEEN 0 AND 15),
  ADD COLUMN number integer,
  ADD COLUMN name text CHECK (octet_length(name) BETWEEN 1 AND 80);

UPDATE boat SET number = n.number
FROM (SELECT id, row_number() OVER (PARTITION BY kind ORDER BY made_at, id) AS number FROM boat) n
WHERE boat.id = n.id;

INSERT INTO boat (account_id, kind, number)
SELECT id, 'keelboat', row_number() OVER (ORDER BY created_at, id) FROM account WHERE kind = 'human';

ALTER TABLE boat ALTER COLUMN number SET NOT NULL;
ALTER TABLE boat ADD CONSTRAINT boat_number CHECK (number BETWEEN 1 AND 16383);
CREATE UNIQUE INDEX boat_kind_number ON boat (kind, number);
CREATE UNIQUE INDEX boat_sailor ON boat (sailor);
