-- SPDX-License-Identifier: AGPL-3.0-only
-- The news as a daily edition. Whatever could be news is written to the
-- world's news_item as a candidate story: its kind (story) and score, the
-- day it belongs to by the world's schedule, the sailor it is about
-- (account_id) and the others it names (named, in order), a number it
-- turns on (amount: a distance, a run), and the facts its words need, as
-- copies (facts). A day's edition, once set, is a row of its own (story
-- 'edition', its figures in facts), and each story chosen for it keeps
-- its place (rank); struck is the owner's hand, hiding a story for
-- everyone. source writes a row once, however often it is asked. A story
-- about a sailor alone, not a place, has subject 'sailor'. A world's
-- first edition opens with its arrival and the last world in review, rows
-- of their own about the world.

-- +goose Up

ALTER TABLE news_item
  ADD COLUMN story  text,
  ADD COLUMN score  smallint NOT NULL DEFAULT 0,
  ADD COLUMN day    date,
  ADD COLUMN rank   smallint,
  ADD COLUMN struck boolean NOT NULL DEFAULT false,
  ADD COLUMN named  uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN amount double precision,
  ADD COLUMN facts  jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN source text;

ALTER TABLE news_item ADD CONSTRAINT news_item_story CHECK (
  story IN ('great', 'record', 'life', 'crew', 'first', 'run', 'milestone', 'charting', 'arrival', 'review', 'edition'));
ALTER TABLE news_item ADD CONSTRAINT news_item_score CHECK (score BETWEEN 0 AND 100);
ALTER TABLE news_item ADD CONSTRAINT news_item_rank CHECK (rank BETWEEN 1 AND 100);
ALTER TABLE news_item ADD CONSTRAINT news_item_facts CHECK (jsonb_typeof(facts) = 'object');
ALTER TABLE news_item ADD CONSTRAINT news_item_source CHECK (octet_length(source) BETWEEN 1 AND 200);
ALTER TABLE news_item ADD CONSTRAINT news_item_day CHECK (story IS NULL OR day IS NOT NULL);
ALTER TABLE news_item DROP CONSTRAINT news_item_subject_check;
ALTER TABLE news_item ADD CONSTRAINT news_item_subject_check CHECK (subject IN ('island', 'place', 'feature', 'world', 'gale', 'sailor'));

CREATE UNIQUE INDEX news_item_once ON news_item (world_id, source) WHERE source IS NOT NULL;
CREATE INDEX news_item_day ON news_item (world_id, day) WHERE day IS NOT NULL;

-- A day's figures are counted from the log's voyages by the world's
-- number and when they ended.
CREATE INDEX log_voyage_world ON log_voyage (world, ended_at);

-- The record's new action: a story struck from the news, or put back.
ALTER TABLE account_action DROP CONSTRAINT account_action_action_check;
ALTER TABLE account_action ADD CONSTRAINT account_action_action_check CHECK (
  action IN ('stop', 'start', 'revoke', 'delete', 'flag', 'unflag', 'priority', 'unpriority', 'cap', 'lifetime',
             'link-lifetime', 'links', 'boarding', 'young',
             'chat', 'shipmate-messages', 'chat-countries', 'spectator-chat',
             'dismiss', 'warn', 'mute-chat', 'remove-line', 'purge', 'hold', 'release', 'under-13', 'referred',
             'rest', 'strike', 'unstrike')) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_action_check;
ALTER TABLE account_action DROP CONSTRAINT account_action_account;
ALTER TABLE account_action ADD CONSTRAINT account_action_account CHECK (
  CASE WHEN action IN ('lifetime', 'link-lifetime', 'links', 'boarding', 'chat', 'shipmate-messages', 'chat-countries',
                       'spectator-chat')
         THEN account_id IS NULL
       WHEN action IN ('dismiss', 'remove-line', 'purge', 'hold', 'release', 'referred', 'strike', 'unstrike') THEN true
       ELSE account_id IS NOT NULL END) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_account;
