-- SPDX-License-Identifier: AGPL-3.0-only
-- Links to watch: every account's sailor has a short random code that
-- opens a watch of its boat, and every human account a second code for
-- its fleet of machine sailors. A code is never a name, so a name freed
-- by a deleted account never leads an old link to someone else. A code
-- lasts until its account is deleted or its owner makes a new one.

-- +goose Up

-- link_code is ten characters of lower-case base32 (50 random bits),
-- from ten bytes of a random UUID that carry no version or variant bits.
-- +goose StatementBegin
CREATE FUNCTION link_code() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT string_agg(substr('abcdefghijklmnopqrstuvwxyz234567', get_byte(b, i) % 32 + 1, 1), '' ORDER BY n)
  FROM (SELECT uuid_send(gen_random_uuid()) AS b) r,
       unnest(ARRAY[0, 1, 2, 3, 4, 5, 7, 9, 10, 11]) WITH ORDINALITY AS x(i, n)
$$;
-- +goose StatementEnd

ALTER TABLE account ADD COLUMN watch_code text NOT NULL DEFAULT link_code();
ALTER TABLE account ADD COLUMN fleet_code text;
UPDATE account SET fleet_code = link_code() WHERE kind = 'human';
ALTER TABLE account ADD CONSTRAINT account_fleet_code CHECK ((kind = 'human') = (fleet_code IS NOT NULL));

-- A human account is made with its fleet's code, however it is made.
-- +goose StatementBegin
CREATE FUNCTION account_fleet_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'human' AND NEW.fleet_code IS NULL THEN
    NEW.fleet_code := link_code();
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd
CREATE TRIGGER account_fleet_code BEFORE INSERT ON account
  FOR EACH ROW EXECUTE FUNCTION account_fleet_code();
CREATE UNIQUE INDEX account_watch_code_key ON account (watch_code);
CREATE UNIQUE INDEX account_fleet_code_key ON account (fleet_code) WHERE fleet_code IS NOT NULL;
