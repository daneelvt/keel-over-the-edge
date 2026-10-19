-- SPDX-License-Identifier: AGPL-3.0-only
-- The shared chart: what has been charted in a world, and by whom; the
-- news its chartings make; and each account's notices switched off.

-- +goose Up

-- A subject charted: an island, a place or a feature, once a world, by its
-- number among the world's of its kind. The sailor who sighted it, their
-- name and their account's kind as they were then, copied so the credit
-- keeps what it showed; the boat, the tick and where the boat was; null for
-- a subject known from the world's start, or charted with another (an
-- island's features seen from no water), which with_subject and with_number
-- name. worth is what charting it was worth. A second write of one subject
-- fails on the key rather than charting it twice.
CREATE TABLE charting (
  world_id     uuid NOT NULL REFERENCES world (id),
  subject      text NOT NULL CHECK (subject IN ('island', 'place', 'feature')),
  number       integer NOT NULL CHECK (number >= 0),
  account_id   uuid,
  sailor       text,
  account_kind text CHECK (account_kind IN ('human', 'ai')),
  boat         bigint,
  tick         bigint NOT NULL,
  x            double precision,
  y            double precision,
  worth        double precision NOT NULL CHECK (worth >= 0),
  with_subject text CHECK (with_subject IN ('island', 'place', 'feature')),
  with_number  integer,
  charted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, subject, number),
  CONSTRAINT charting_credit CHECK ((account_id IS NULL) = (boat IS NULL))
) PARTITION BY LIST (world_id);

-- An item of the news, in its column, written with the chartings it tells
-- of: what it is about (its subject, its title and what it is, as they read
-- then: "KEYHOLE ROCK", "an island of the rim"), who charted it (copied, as
-- a charting's), its worth, where it is, and the subjects folded into it,
-- each with its title: a sailor's places and features about one island
-- within a few minutes of its item.
CREATE TABLE news_item (
  world_id      uuid NOT NULL REFERENCES world (id),
  id            uuid NOT NULL DEFAULT uuidv7(),
  news_column   text NOT NULL,
  account_id    uuid,
  sailor        text,
  account_kind  text CHECK (account_kind IN ('human', 'ai')),
  subject       text NOT NULL CHECK (subject IN ('island', 'place', 'feature')),
  number        integer NOT NULL CHECK (number >= 0),
  title         text NOT NULL,
  what          text NOT NULL,
  island_number integer,
  worth         double precision NOT NULL CHECK (worth >= 0),
  x             double precision NOT NULL,
  y             double precision NOT NULL,
  also          jsonb NOT NULL DEFAULT '[]',
  written_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, id)
) PARTITION BY LIST (world_id);

SELECT create_world_partitions(id) FROM world;

-- The kinds of notice an account's sailor has switched off, by the
-- catalog's ids: a constant default, so the column is added without
-- rewriting the table.
ALTER TABLE account ADD COLUMN notices_off text[] NOT NULL DEFAULT '{}';
