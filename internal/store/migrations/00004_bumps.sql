-- SPDX-License-Identifier: AGPL-3.0-only
-- Bumps: two boats touching after being apart, judged by the Articles.

-- +goose Up

-- A bump is one row: the account and boat at fault in account_id and boat
-- (with no fault, the first boat's: the lower slot's), the other in
-- other_account_id and other_boat; the Article, numbered as the Racing
-- Rules of Sailing number the rule ('10', '16.1'); whether an account was at
-- fault or no one was; and where they touched, metres east and north of the
-- world's centre. Copies, not references, as for every event. The new
-- columns are null for the other kinds, which builds that know nothing of
-- bumps go on writing.
ALTER TABLE event DROP CONSTRAINT event_kind_check;
ALTER TABLE event ADD CONSTRAINT event_kind_check CHECK (kind IN ('launched', 'returned', 'expired', 'bump'));
ALTER TABLE event
  ADD COLUMN other_account_id uuid,
  ADD COLUMN other_boat bigint,
  ADD COLUMN article text,
  ADD COLUMN fault text CHECK (fault IN ('account', 'none')),
  ADD COLUMN x double precision,
  ADD COLUMN y double precision;
ALTER TABLE event ADD CONSTRAINT event_bump_check CHECK (
  (kind = 'bump') = (other_account_id IS NOT NULL AND other_boat IS NOT NULL AND article IS NOT NULL
    AND fault IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL)
);
