-- SPDX-License-Identifier: AGPL-3.0-only
-- The owner's switch for spectators reading machine sailors' chat: while
-- everyone aboard a boat is a machine sailor, anyone watching it reads its
-- chat, unless the owner has this off for everyone.

-- +goose Up

ALTER TABLE setting ADD COLUMN spectator_chat boolean NOT NULL DEFAULT true;

-- The record's new action: the switch, on no account.
ALTER TABLE account_action DROP CONSTRAINT account_action_action_check;
ALTER TABLE account_action ADD CONSTRAINT account_action_action_check CHECK (
  action IN ('stop', 'start', 'revoke', 'delete', 'flag', 'unflag', 'priority', 'unpriority', 'cap', 'lifetime',
             'link-lifetime', 'links', 'boarding', 'young',
             'chat', 'shipmate-messages', 'chat-countries', 'spectator-chat',
             'dismiss', 'warn', 'mute-chat', 'remove-line', 'purge', 'hold', 'release', 'under-13', 'referred',
             'rest')) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_action_check;
ALTER TABLE account_action DROP CONSTRAINT account_action_account;
ALTER TABLE account_action ADD CONSTRAINT account_action_account CHECK (
  CASE WHEN action IN ('lifetime', 'link-lifetime', 'links', 'boarding', 'chat', 'shipmate-messages', 'chat-countries',
                       'spectator-chat')
         THEN account_id IS NULL
       WHEN action IN ('dismiss', 'remove-line', 'purge', 'hold', 'release', 'referred') THEN true
       ELSE account_id IS NOT NULL END) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_account;
