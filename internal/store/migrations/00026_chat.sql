-- SPDX-License-Identifier: AGPL-3.0-only
-- Chat aboard: a player's own switch for chat, the owner's mute from chat,
-- the rest a player's chat is put to by reports, mutes and blocks between
-- players, reports and what the owner did about them, notices from
-- outside the game, statements of reasons, and the owner's switches for
-- chat.
--
-- No line of chat is ever written here but in a report: what players say
-- lives in keel's memory for half an hour and is gone.

-- +goose Up

-- chat is the player's own choice, NULL for their band's default: on for
-- an adult, off for 13 to 17 until they turn it on. chat_muted_until is
-- the owner's mute from chat. rested_at is when reports rested the
-- player's chat and knocks until the owner looks. A machine sailor has
-- none of them: its human's count for it.
ALTER TABLE account
  ADD COLUMN chat boolean,
  ADD COLUMN chat_muted_until timestamptz,
  ADD COLUMN rested_at timestamptz;
ALTER TABLE account ADD CONSTRAINT account_chat_human CHECK (
  kind = 'human' OR (chat IS NULL AND chat_muted_until IS NULL AND rested_at IS NULL)) NOT VALID;
ALTER TABLE account VALIDATE CONSTRAINT account_chat_human;

-- A mute hides the other's lines from the account, everywhere; a block
-- hides each one's lines from the other, refuses their knocks both ways
-- and their watch of the account's human sailor. Neither is ever told.
-- At most 1,000 of each an account, which the store checks.
CREATE TABLE mute (
  account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  other_id   uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  made_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, other_id),
  CHECK (account_id <> other_id)
);
CREATE INDEX mute_other ON mute (other_id);
CREATE TABLE block (
  account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  other_id   uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  made_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, other_id),
  CHECK (account_id <> other_id)
);
CREATE INDEX block_other ON block (other_id);

-- A report: by a player, from a line or a person; a notice from outside
-- the game; or the game's own, for an account whose player said they are
-- under 13. The accounts are kept by ID without a foreign key, with the
-- names as they were, so that a report held outlives a deletion; one not
-- held goes with the reported account (the trigger below). people is who
-- was aboard at the report: their names, bands and machine marks.
-- follow_until is when its lines stop being taken: a report takes what
-- the game's memory holds of the conversation and the next ten minutes.
CREATE TABLE report (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  made_at        timestamptz NOT NULL DEFAULT now(),
  source         text NOT NULL CHECK (source IN ('player', 'notice', 'game')),
  reason         text NOT NULL CHECK (reason IN ('child', 'sexual', 'bullying', 'hate', 'threats', 'scam', 'cheating',
                                                 'other', 'young')),
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  reporter_id    uuid,
  reporter_name  text NOT NULL DEFAULT '' CHECK (octet_length(reporter_name) <= 80),
  reported_id    uuid,
  reported_kind  text CHECK (reported_kind IN ('human', 'ai')),
  reported_name  text NOT NULL DEFAULT '' CHECK (octet_length(reported_name) <= 80),
  reported_owner uuid,
  place          text NOT NULL DEFAULT '' CHECK (octet_length(place) <= 400),
  people         jsonb NOT NULL DEFAULT '[]',
  follow_until   timestamptz,
  closed_at      timestamptz,
  outcome        text NOT NULL DEFAULT '' CHECK (octet_length(outcome) <= 40),
  held_until     timestamptz,
  referred       text NOT NULL DEFAULT '' CHECK (octet_length(referred) <= 400),
  CONSTRAINT report_who CHECK (source = 'notice' OR reported_id IS NOT NULL)
);
CREATE INDEX report_open ON report (made_at) WHERE closed_at IS NULL;
CREATE INDEX report_reported ON report (reported_id, made_at);
CREATE INDEX report_reported_owner ON report (reported_owner) WHERE reported_owner IS NOT NULL;
CREATE INDEX report_reporter ON report (reporter_id) WHERE reporter_id IS NOT NULL;
CREATE INDEX report_closed ON report (closed_at) WHERE closed_at IS NOT NULL;

-- A line a report holds: the only place a line of chat is ever written.
-- line is its number in the memory it was copied from, for the owner's
-- removal of it from every copy. reported marks the line the report was
-- made from.
CREATE TABLE report_line (
  report_id   uuid NOT NULL REFERENCES report (id) ON DELETE CASCADE,
  line        bigint NOT NULL,
  at          timestamptz NOT NULL,
  sender_id   uuid,
  sender_name text NOT NULL CHECK (octet_length(sender_name) <= 80),
  machine     boolean NOT NULL DEFAULT false,
  text        text NOT NULL CHECK (char_length(text) <= 200),
  reported    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (report_id, line, at)
);
CREATE INDEX report_line_line ON report_line (line, at);
CREATE INDEX report_line_sender ON report_line (sender_id) WHERE sender_id IS NOT NULL;

-- Notes on a report: the owner's, and a restricted player's answer to the
-- statement of reasons (once, 500 characters).
CREATE TABLE report_note (
  id        uuid PRIMARY KEY DEFAULT uuidv7(),
  report_id uuid NOT NULL REFERENCES report (id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  by        text NOT NULL CHECK (by IN ('owner', 'player')),
  text      text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500)
);
CREATE INDEX report_note_report ON report_note (report_id);

-- A notice from outside the game, from anyone: who they are and how to
-- reach them, what and where, and why. Its report holds the rest.
CREATE TABLE notice_report (
  report_id uuid PRIMARY KEY REFERENCES report (id) ON DELETE CASCADE,
  who       text NOT NULL CHECK (char_length(who) BETWEEN 1 AND 200),
  contact   text NOT NULL CHECK (char_length(contact) BETWEEN 1 AND 200),
  sailor    text NOT NULL DEFAULT '' CHECK (char_length(sailor) <= 80),
  happened  text NOT NULL DEFAULT '' CHECK (char_length(happened) <= 200),
  what      text NOT NULL CHECK (char_length(what) BETWEEN 1 AND 2000)
);

-- A statement of reasons: what a player restricted is told on their next
-- entry (the rule, what was seen, the action and how to ask again), and
-- their one answer, which puts the report back in the queue.
CREATE TABLE statement (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id  uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  report_id   uuid REFERENCES report (id) ON DELETE SET NULL,
  made_at     timestamptz NOT NULL DEFAULT now(),
  action      text NOT NULL CHECK (action IN ('warn', 'mute-chat', 'stop', 'remove-line')),
  rule        text NOT NULL CHECK (octet_length(rule) <= 40),
  seen        text NOT NULL DEFAULT '' CHECK (char_length(seen) <= 500),
  until       timestamptz,
  read_at     timestamptz,
  answer      text CHECK (char_length(answer) BETWEEN 1 AND 500),
  answered_at timestamptz
);
CREATE INDEX statement_account ON statement (account_id, made_at);

-- An account deleted takes the reports about it with it, but those held;
-- reports it made, and lines it said in others' reports, keep no name of
-- it.
-- +goose StatementBegin
CREATE FUNCTION report_forget_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM report
  WHERE (reported_id = OLD.id OR reported_owner = OLD.id) AND (held_until IS NULL OR held_until < now());
  UPDATE report SET reporter_id = NULL, reporter_name = 'a former sailor' WHERE reporter_id = OLD.id;
  UPDATE report_line l SET sender_id = NULL, sender_name = 'a former sailor'
  WHERE l.sender_id = OLD.id
    AND NOT EXISTS (SELECT 1 FROM report r WHERE r.id = l.report_id AND r.held_until >= now());
  RETURN OLD;
END $$;
-- +goose StatementEnd

CREATE TRIGGER report_forget_account AFTER DELETE ON account
  FOR EACH ROW EXECUTE FUNCTION report_forget_account();

-- The owner's switches for chat, for everyone: chat itself, shipmates'
-- messages, and chat off where a player's country is one of these (ISO
-- 3166 codes, as the edge's country header gives them).
ALTER TABLE setting
  ADD COLUMN chat boolean NOT NULL DEFAULT true,
  ADD COLUMN shipmate_messages boolean NOT NULL DEFAULT true,
  ADD COLUMN chat_countries text[] NOT NULL DEFAULT '{}'
    CONSTRAINT setting_chat_countries CHECK (cardinality(chat_countries) <= 300);

-- The record's new actions: the owner's switches for chat, on no account;
-- the owner's actions on a report and on its accounts; the game's rest of
-- a reported player's chat. report_id names the report an action was on.
ALTER TABLE account_action ADD COLUMN report_id uuid;
ALTER TABLE account_action DROP CONSTRAINT account_action_action_check;
ALTER TABLE account_action ADD CONSTRAINT account_action_action_check CHECK (
  action IN ('stop', 'start', 'revoke', 'delete', 'flag', 'unflag', 'priority', 'unpriority', 'cap', 'lifetime',
             'link-lifetime', 'links', 'boarding', 'young',
             'chat', 'shipmate-messages', 'chat-countries',
             'dismiss', 'warn', 'mute-chat', 'remove-line', 'purge', 'hold', 'release', 'under-13', 'referred',
             'rest')) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_action_check;
ALTER TABLE account_action DROP CONSTRAINT account_action_account;
ALTER TABLE account_action ADD CONSTRAINT account_action_account CHECK (
  CASE WHEN action IN ('lifetime', 'link-lifetime', 'links', 'boarding', 'chat', 'shipmate-messages', 'chat-countries')
         THEN account_id IS NULL
       WHEN action IN ('dismiss', 'remove-line', 'purge', 'hold', 'release', 'referred') THEN true
       ELSE account_id IS NOT NULL END) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_account;

-- Accounts the game stopped before reports existed, their player having
-- said they are under 13, go into the queue for the owner.
INSERT INTO report (made_at, source, reason, reported_id, reported_kind, reported_name)
SELECT DISTINCT ON (a.id) x.at, 'game', 'young', a.id, 'human', x.name
FROM account_action x JOIN account a ON a.id = x.account_id
WHERE x.action = 'young' AND a.stopped_at IS NOT NULL
ORDER BY a.id, x.at DESC;
