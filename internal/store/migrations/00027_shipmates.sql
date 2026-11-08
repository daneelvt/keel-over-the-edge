-- SPDX-License-Identifier: AGPL-3.0-only
-- Shipmates: who sailed with whom, the offers to be shipmates and the
-- shipmates made, and a player's choice to appear offline to them.
--
-- No message between shipmates is ever written here: what they say lives
-- in keel's memory for half an hour, as chat aboard does, and is gone.

-- +goose Up

-- appear_offline hides from the player's shipmates that they are in the
-- game.
ALTER TABLE account ADD COLUMN appear_offline boolean NOT NULL DEFAULT false;

-- Two people aboard the same boat together, a pair once, the lesser ID
-- first: seen_at the last time they were aboard together, sailed_at the
-- last time they had been aboard together for five minutes or more (NULL
-- for never, and again once they are no longer shipmates), and boat the
-- boat they were last aboard, for a report from the list of recent crew.
-- Kept 30 days from seen_at.
CREATE TABLE sailed_with (
  a_id      uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  b_id      uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  seen_at   timestamptz NOT NULL,
  sailed_at timestamptz,
  boat      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);
CREATE INDEX sailed_with_b ON sailed_with (b_id);
CREATE INDEX sailed_with_seen ON sailed_with (seen_at);

-- Two shipmates, the lesser ID first. Ending it deletes the row, and
-- nothing else records it.
CREATE TABLE shipmate (
  a_id    uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  b_id    uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  made_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);
CREATE INDEX shipmate_b ON shipmate (b_id);

-- An offer to be shipmates, waiting for its answer: it lapses after seven
-- days. silent is an offer that never reaches its receiver (between the
-- age bands, or declined), which its sender sees waiting as any other.
CREATE TABLE shipmate_offer (
  from_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  to_id   uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  made_at timestamptz NOT NULL DEFAULT now(),
  silent  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (from_id, to_id),
  CHECK (from_id <> to_id)
);
CREATE INDEX shipmate_offer_to ON shipmate_offer (to_id);
CREATE INDEX shipmate_offer_made ON shipmate_offer (made_at);
