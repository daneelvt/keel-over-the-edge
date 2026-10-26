-- SPDX-License-Identifier: AGPL-3.0-only
-- The operator's hand on accounts: an account stopped, with its reason;
-- the grants the operator revokes; the accounts listed by when they were
-- last active; and the record of what the operator did to each account,
-- kept apart from the accounts so that it outlives a deletion.

-- +goose Up

-- A stopped account cannot sign in or sail until it is started again. The
-- reason is the operator's note, never shown to its player. A machine
-- sailor is stopped too while its human is: that is read through its
-- owner, not copied here.
ALTER TABLE account
  ADD COLUMN stopped_at timestamptz,
  ADD COLUMN stop_reason text;
ALTER TABLE account ADD CONSTRAINT account_stopped CHECK (
  (stopped_at IS NULL) = (stop_reason IS NULL) AND char_length(stop_reason) BETWEEN 1 AND 500) NOT VALID;
ALTER TABLE account VALIDATE CONSTRAINT account_stopped;

-- The accounts by when they were last active.
CREATE INDEX account_last_seen ON account (last_seen_at);

-- A grant the operator revoked.
ALTER TABLE ai_grant DROP CONSTRAINT ai_grant_revoked_why_check;
ALTER TABLE ai_grant ADD CONSTRAINT ai_grant_revoked_why_check
  CHECK (revoked_why IN ('owner', 'replaced', 'reuse', 'app', 'operator')) NOT VALID;
ALTER TABLE ai_grant VALIDATE CONSTRAINT ai_grant_revoked_why_check;

-- What the operator did to an account, and why: written only by the
-- operator's tools. account_id has no foreign key, and name is the
-- sailor's as it was, so a deleted account's record stays. An action on
-- no account (the grant lifetime) has none. source says whether the world
-- page or the command did it, and from_addr the address it came from.
CREATE TABLE account_action (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  at         timestamptz NOT NULL DEFAULT now(),
  action     text NOT NULL CHECK (action IN ('stop', 'start', 'revoke', 'delete', 'flag', 'unflag', 'priority', 'unpriority',
                                             'cap', 'lifetime')),
  account_id uuid,
  kind       text CHECK (kind IN ('human', 'ai')),
  name       text NOT NULL DEFAULT '' CHECK (octet_length(name) <= 80),
  detail     text NOT NULL DEFAULT '' CHECK (octet_length(detail) <= 2000),
  source     text NOT NULL CHECK (source IN ('page', 'command')),
  from_addr  text NOT NULL DEFAULT '' CHECK (octet_length(from_addr) <= 100),
  CONSTRAINT account_action_account CHECK ((account_id IS NULL) = (action = 'lifetime'))
);
CREATE INDEX account_action_account ON account_action (account_id, at) WHERE account_id IS NOT NULL;
CREATE INDEX account_action_at ON account_action (at);
