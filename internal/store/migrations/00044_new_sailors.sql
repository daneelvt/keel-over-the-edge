-- SPDX-License-Identifier: AGPL-3.0-only
-- New sailors counted by the address they were made from, and the human
-- check. Each sailor made leaves a row of its address's keyed hash (an
-- HMAC under a key the database never holds: an IPv4 address, or an IPv6
-- address's /56) and when, and no account: a row says only that a sailor
-- was made from somewhere, then. Rows go once they are a day old.

-- +goose Up

CREATE TABLE new_sailor_from (
  key     bytea       NOT NULL CHECK (octet_length(key) = 32),
  made_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX new_sailor_from_key ON new_sailor_from (key, made_at);
CREATE INDEX new_sailor_from_made_at ON new_sailor_from (made_at);

-- The owner's two settings: how many new sailors one address may make in
-- 24 hours, and whether every new sailor passes the human check.
ALTER TABLE setting ADD COLUMN new_sailors_per_address smallint NOT NULL DEFAULT 20
  CONSTRAINT setting_new_sailors_per_address CHECK (new_sailors_per_address BETWEEN 1 AND 1000);
ALTER TABLE setting ADD COLUMN human_check boolean NOT NULL DEFAULT true;

-- The record's new actions: each setting changed, on no account.
ALTER TABLE account_action DROP CONSTRAINT account_action_action_check;
ALTER TABLE account_action ADD CONSTRAINT account_action_action_check CHECK (
  action IN ('stop', 'start', 'revoke', 'delete', 'flag', 'unflag', 'priority', 'unpriority', 'cap', 'lifetime',
             'link-lifetime', 'links', 'boarding', 'young',
             'chat', 'shipmate-messages', 'chat-countries', 'spectator-chat',
             'dismiss', 'warn', 'mute-chat', 'remove-line', 'purge', 'hold', 'release', 'under-13', 'referred',
             'rest', 'strike', 'unstrike', 'racing', 'every-boat', 'new-sailors', 'human-check')) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_action_check;
ALTER TABLE account_action DROP CONSTRAINT account_action_account;
ALTER TABLE account_action ADD CONSTRAINT account_action_account CHECK (
  CASE WHEN action IN ('lifetime', 'link-lifetime', 'links', 'boarding', 'chat', 'shipmate-messages', 'chat-countries',
                       'spectator-chat', 'racing', 'new-sailors', 'human-check')
         THEN account_id IS NULL
       WHEN action IN ('dismiss', 'remove-line', 'purge', 'hold', 'release', 'referred', 'strike', 'unstrike') THEN true
       ELSE account_id IS NOT NULL END) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_account;
