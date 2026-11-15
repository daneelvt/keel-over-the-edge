-- SPDX-License-Identifier: AGPL-3.0-only
-- Certificates: each opens bigger boats to the sailor who holds it. A
-- certificate is earned from the rows the log and the races keep, counted
-- each time inside the transaction that writes them; nothing of a sailor's
-- progress is stored but the certificates earned, kept for good like the
-- log, through every world. The owner may open every boat to any sailor
-- for their testing, and every sailor keeps the kinds of boat it had
-- sailed before certificates came.

-- +goose Up

-- A certificate earned: by the catalog's id, by hand or not, when and in
-- which world's number, the tasks that counted and the way each did (each
-- {"task", "way"}: hand, pilot, or log for a task of the log), copies.
-- source makes a row once, however often it is written.
CREATE TABLE certificate (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id  uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  certificate text NOT NULL CHECK (octet_length(certificate) BETWEEN 1 AND 40),
  by_hand     boolean NOT NULL DEFAULT false,
  earned_at   timestamptz NOT NULL,
  world       integer NOT NULL CHECK (world > 0),
  tasks       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tasks) = 'array'),
  source      text NOT NULL CHECK (octet_length(source) BETWEEN 1 AND 200),
  CONSTRAINT certificate_source UNIQUE (account_id, source),
  CONSTRAINT certificate_once UNIQUE (account_id, certificate)
);
CREATE INDEX certificate_earned ON certificate (account_id, earned_at);

-- Every boat: the owner opens every kind of boat to the sailor, whatever
-- its certificates, for their testing. It gives no certificate.
ALTER TABLE account ADD COLUMN every_boat boolean NOT NULL DEFAULT false;

-- The kinds of boat a sailor keeps whatever its certificates: each kind it
-- had skippered, and each it held in its fleet, as certificates came.
CREATE TABLE boat_kept (
  account_id uuid NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  boat_kind  text NOT NULL CHECK (octet_length(boat_kind) BETWEEN 1 AND 40),
  PRIMARY KEY (account_id, boat_kind)
);
INSERT INTO boat_kept (account_id, boat_kind)
SELECT account_id, boat_kind FROM log_voyage WHERE NOT aboard
UNION
SELECT sailor, kind FROM boat WHERE sailor IS NOT NULL
ON CONFLICT DO NOTHING;

-- A race in a sailor's record: whether the autopilot steered its boat at
-- any moment of its run, whether nobody else was aboard from the line to
-- the finish, and its course: a buoy course's shape and length (short,
-- long, triangle, long-triangle) or an island course. Records written
-- before have none of these, and count toward no certificate.
ALTER TABLE race_record
  ADD COLUMN piloted boolean NOT NULL DEFAULT false,
  ADD COLUMN alone   boolean NOT NULL DEFAULT false,
  ADD COLUMN course  text CONSTRAINT race_record_course CHECK (course IN ('short', 'long', 'triangle', 'long-triangle', 'island'));
CREATE INDEX race_record_trials ON race_record (account_id, at) WHERE kind = 'trial' AND role = 'skipper' AND alone;

-- The world's standing trials, the Harbourmaster's, owner none: one of a
-- course for a kind of boat, however often the job that makes them runs.
CREATE UNIQUE INDEX race_standing ON race (world_id, course_kind, course, shape, long, boat) NULLS NOT DISTINCT
  WHERE owner_id IS NULL AND kind = 'trial';

-- The log's entries gain a certificate earned (its title the certificate's
-- name), and whether the sailor was alone in its own boat as it was
-- written: what was met or charted with others aboard, or aboard another's
-- boat, counts toward no certificate. Entries written before are counted.
ALTER TABLE log_entry ADD COLUMN alone boolean NOT NULL DEFAULT true;
ALTER TABLE log_entry DROP CONSTRAINT log_entry_kind_check;
ALTER TABLE log_entry ADD CONSTRAINT log_entry_kind_check CHECK (
  kind IN ('charted', 'sighted', 'found', 'met', 'bump', 'certificate')) NOT VALID;
ALTER TABLE log_entry VALIDATE CONSTRAINT log_entry_kind_check;

-- The record's new action: every boat opened to a sailor, or closed again
-- (its detail on or off).
ALTER TABLE account_action DROP CONSTRAINT account_action_action_check;
ALTER TABLE account_action ADD CONSTRAINT account_action_action_check CHECK (
  action IN ('stop', 'start', 'revoke', 'delete', 'flag', 'unflag', 'priority', 'unpriority', 'cap', 'lifetime',
             'link-lifetime', 'links', 'boarding', 'young',
             'chat', 'shipmate-messages', 'chat-countries', 'spectator-chat',
             'dismiss', 'warn', 'mute-chat', 'remove-line', 'purge', 'hold', 'release', 'under-13', 'referred',
             'rest', 'strike', 'unstrike', 'racing', 'every-boat')) NOT VALID;
ALTER TABLE account_action VALIDATE CONSTRAINT account_action_action_check;
