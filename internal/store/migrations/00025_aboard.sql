-- SPDX-License-Identifier: AGPL-3.0-only
-- Sailing together: a player's month of birth and the Rules of the sea
-- accepted, a skipper's "sail with me" link, the owner's switches for
-- links and boarding and a link's lifetime, and the record's new actions.

-- +goose Up

-- born is the month of birth a player gave, year × 100 + month (200104),
-- NULL for an account made before it was asked and not yet answered. It is
-- never shown to anyone. A machine sailor has none, and accepts no rules:
-- its human does.
ALTER TABLE account
  ADD COLUMN born integer,
  ADD COLUMN rules_at timestamptz;
ALTER TABLE account ADD CONSTRAINT account_born CHECK (
  born IS NULL OR (born BETWEEN 190001 AND 210012 AND born % 100 BETWEEN 1 AND 12)) NOT VALID;
ALTER TABLE account VALIDATE CONSTRAINT account_born;
ALTER TABLE account ADD CONSTRAINT account_born_human CHECK (
  kind = 'human' OR (born IS NULL AND rules_at IS NULL)) NOT VALID;
ALTER TABLE account VALIDATE CONSTRAINT account_born_human;

-- A new sailor's month of birth, kept while its passkey is made.
ALTER TABLE webauthn_ceremony ADD COLUMN born integer;
ALTER TABLE webauthn_ceremony ADD CONSTRAINT webauthn_ceremony_born CHECK (
  born IS NULL OR (kind = 'create' AND born BETWEEN 190001 AND 210012 AND born % 100 BETWEEN 1 AND 12)) NOT VALID;
ALTER TABLE webauthn_ceremony VALIDATE CONSTRAINT webauthn_ceremony_born;

-- A skipper's link, kept by the SHA-256 of its token: it works from
-- made_at until expires_at, or until the owner's lifetime from made_at if
-- that is sooner, unless ended. A skipper has one live link at most: a new
-- one ends the old. Links are deleted a day after they stop working.
CREATE TABLE sail_link (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  skipper_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  hash       bytea NOT NULL UNIQUE CHECK (octet_length(hash) = 32),
  made_at    timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  ended_at   timestamptz,
  CONSTRAINT sail_link_expires CHECK (expires_at > made_at)
);
CREATE UNIQUE INDEX sail_link_live ON sail_link (skipper_id) WHERE ended_at IS NULL;
CREATE INDEX sail_link_skipper ON sail_link (skipper_id);
CREATE INDEX sail_link_stops ON sail_link (least(ended_at, expires_at));

-- The owner's switches, for everyone: how long a link lasts, whether
-- links work, and whether anyone may come aboard.
ALTER TABLE setting
  ADD COLUMN link_lifetime interval NOT NULL DEFAULT '24 hours'
    CONSTRAINT setting_link_lifetime CHECK (link_lifetime BETWEEN interval '5 minutes' AND interval '7 days'),
  ADD COLUMN links boolean NOT NULL DEFAULT true,
  ADD COLUMN boarding boolean NOT NULL DEFAULT true;

-- The record's new actions: the owner's three switches, on no account; and
-- an account stopped by the game itself, its player having said they are
-- under 13, for the owner to review.
ALTER TABLE account_action DROP CONSTRAINT account_action_action_check;
ALTER TABLE account_action ADD CONSTRAINT account_action_action_check CHECK (
  action IN ('stop', 'start', 'revoke', 'delete', 'flag', 'unflag', 'priority', 'unpriority', 'cap', 'lifetime',
             'link-lifetime', 'links', 'boarding', 'young')) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_action_check;
ALTER TABLE account_action DROP CONSTRAINT account_action_source_check;
ALTER TABLE account_action ADD CONSTRAINT account_action_source_check CHECK (source IN ('page', 'command', 'game')) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_source_check;
ALTER TABLE account_action DROP CONSTRAINT account_action_account;
ALTER TABLE account_action ADD CONSTRAINT account_action_account CHECK (
  (account_id IS NULL) = (action IN ('lifetime', 'link-lifetime', 'links', 'boarding'))) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_account;
