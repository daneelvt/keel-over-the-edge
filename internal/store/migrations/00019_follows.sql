-- SPDX-License-Identifier: AGPL-3.0-only
-- Follows: the sailors a player follows, a bookmark on the list of sailors
-- to watch. A follow is the follower's alone: the sailor followed is never
-- told. It goes with either account.

-- +goose Up

CREATE TABLE follow (
  follower_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  followed_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
CREATE INDEX follow_followed ON follow (followed_id);
