-- SPDX-License-Identifier: AGPL-3.0-only
-- Chat aboard: a player's switch, mutes and blocks, reports and the
-- owner's review of them, notices from outside, statements of reasons and
-- the owner's switches. No line of chat is written but in a report.
;

-- name: TalkerOf :one
-- An account as chat needs it: its kind, its human's (itself for a
-- human), and its human's month of birth, Rules of the sea, chat switch,
-- mute from chat and rest.
SELECT a.kind, coalesce(a.owner_id, a.id)::uuid AS human, coalesce(h.born, 0)::integer AS born,
  (h.rules_at IS NOT NULL)::boolean AS rules, h.chat, h.chat_muted_until, h.rested_at, sl.name
FROM account a
JOIN account h ON h.id = coalesce(a.owner_id, a.id)
JOIN sailor sl ON sl.account_id = a.id
WHERE a.id = @id;

-- name: SetChat :execrows
-- A human's own switch for chat.
UPDATE account SET chat = @chat WHERE id = @id AND kind = 'human';

-- name: AllMutes :many
SELECT account_id, other_id FROM mute;

-- name: AllBlocks :many
SELECT account_id, other_id FROM block;

-- name: InsertMute :execrows
-- A mute, if the account has fewer than the limit.
INSERT INTO mute (account_id, other_id)
SELECT @account_id, @other_id
WHERE (SELECT count(*) FROM mute WHERE account_id = @account_id) < sqlc.arg(lim)::bigint
ON CONFLICT DO NOTHING;

-- name: DeleteMute :execrows
DELETE FROM mute WHERE account_id = @account_id AND other_id = @other_id;

-- name: InsertBlock :execrows
-- A block, if the account has fewer than the limit.
INSERT INTO block (account_id, other_id)
SELECT @account_id, @other_id
WHERE (SELECT count(*) FROM block WHERE account_id = @account_id) < sqlc.arg(lim)::bigint
ON CONFLICT DO NOTHING;

-- name: DeleteBlock :execrows
DELETE FROM block WHERE account_id = @account_id AND other_id = @other_id;

-- name: TiesOf :many
-- An account's mutes and blocks, with the sailors' names, the newest
-- first.
SELECT t.kind, t.other_id, t.made_at, sl.name FROM (
  SELECT 'mute'::text AS kind, other_id, made_at FROM mute WHERE mute.account_id = @account_id
  UNION ALL
  SELECT 'block'::text AS kind, other_id, made_at FROM block WHERE block.account_id = @account_id
) t JOIN sailor sl ON sl.account_id = t.other_id
ORDER BY t.made_at DESC;

-- name: InsertReport :one
INSERT INTO report (source, reason, note, reporter_id, reporter_name, reported_id, reported_kind, reported_name,
                    reported_owner, place, people, follow_until)
VALUES (@source, @reason, @note, sqlc.narg(reporter_id), @reporter_name, sqlc.narg(reported_id), sqlc.narg(reported_kind),
        @reported_name, sqlc.narg(reported_owner), @place, @people, sqlc.narg(follow_until))
RETURNING id, made_at;

-- name: InsertYoungReport :execrows
-- The game's report of an account it stopped, its player having said
-- they are under 13.
INSERT INTO report (source, reason, reported_id, reported_kind, reported_name)
SELECT 'game', 'young', a.id, 'human', sl.name FROM account a JOIN sailor sl ON sl.account_id = a.id
WHERE a.id = @id AND a.kind = 'human';

-- name: InsertReportLine :exec
INSERT INTO report_line (report_id, line, at, sender_id, sender_name, machine, text, reported)
VALUES (@report_id, @line, @at, sqlc.narg(sender_id), @sender_name, @machine, @text, @reported)
ON CONFLICT DO NOTHING;

-- name: ReportersOfInDay :one
-- How many players reported the account (or its machine sailors) in the
-- last day, and whether any said a child may be at risk, of the reports
-- still open.
SELECT count(DISTINCT reporter_id)::bigint AS reporters, bool_or(reason = 'child')::boolean AS child
FROM report
WHERE (reported_id = @account_id OR reported_owner = @account_id) AND source = 'player' AND closed_at IS NULL
  AND made_at > now() - interval '1 day';

-- name: SetRested :execrows
-- A human's chat and knocks rested until the owner looks, once.
UPDATE account SET rested_at = coalesce(rested_at, now()) WHERE id = @id AND kind = 'human';

-- name: ClearRested :execrows
UPDATE account SET rested_at = NULL WHERE id = @id AND kind = 'human';

-- name: MuteChat :execrows
UPDATE account SET chat_muted_until = @until WHERE id = @id AND kind = 'human';

-- name: InsertNotice :exec
INSERT INTO notice_report (report_id, who, contact, sailor, happened, what)
VALUES (@report_id, @who, @contact, @sailor, @happened, @what);

-- name: ReportQueue :many
-- The open reports, a child's safety first, then the reported with the
-- most reports open, then the oldest.
WITH open AS (
  SELECT r.*, coalesce(r.reported_owner, r.reported_id) AS subject FROM report r WHERE r.closed_at IS NULL
), counts AS (
  SELECT subject, count(*) AS n, bool_or(reason = 'child') AS child FROM open GROUP BY subject
)
SELECT o.id, o.made_at, o.source, o.reason, o.reporter_name, o.reported_name, coalesce(o.reported_kind, '')::text AS reported_kind,
  o.place, coalesce(c.n, 1)::bigint AS reports, (o.reason = 'child' OR o.reason = 'young')::boolean AS urgent,
  (SELECT count(*) FROM report_line l WHERE l.report_id = o.id)::bigint AS lines,
  (SELECT count(*) FROM report_note n WHERE n.report_id = o.id AND n.by = 'player')::bigint AS answers
FROM open o LEFT JOIN counts c ON c.subject IS NOT DISTINCT FROM o.subject
ORDER BY (o.reason = 'child') DESC, coalesce(c.child, false) DESC, (o.reason = 'young') DESC, coalesce(c.n, 1) DESC, o.made_at
LIMIT @lim;

-- name: ReportCounts :one
-- How many reports are open, how many of them say a child may be at
-- risk, and when the oldest was made.
SELECT count(*)::bigint AS open, count(*) FILTER (WHERE reason = 'child')::bigint AS child,
  coalesce(min(made_at), 'epoch')::timestamptz AS oldest
FROM report WHERE closed_at IS NULL;

-- name: ReportByID :one
SELECT r.id, r.made_at, r.source, r.reason, r.note, r.reporter_id, r.reporter_name, r.reported_id,
  coalesce(r.reported_kind, '')::text AS reported_kind, r.reported_name, r.reported_owner, r.place, r.people,
  r.follow_until, r.closed_at, r.outcome, r.held_until, r.referred,
  coalesce(n.who, '')::text AS notice_who, coalesce(n.contact, '')::text AS notice_contact,
  coalesce(n.sailor, '')::text AS notice_sailor, coalesce(n.happened, '')::text AS notice_happened,
  coalesce(n.what, '')::text AS notice_what
FROM report r LEFT JOIN notice_report n ON n.report_id = r.id
WHERE r.id = @id;

-- name: ReportLines :many
SELECT line, at, sender_id, sender_name, machine, text, reported FROM report_line
WHERE report_id = @report_id ORDER BY at, line;

-- name: ReportNotes :many
SELECT at, by, text FROM report_note WHERE report_id = @report_id ORDER BY at;

-- name: InsertReportNote :exec
INSERT INTO report_note (report_id, by, text) VALUES (@report_id, @by, @text);

-- name: CloseReport :execrows
UPDATE report SET closed_at = now(), outcome = @outcome WHERE id = @id;

-- name: CloseReportsOf :execrows
-- Every open report on the same account, closed with the one acted on.
UPDATE report o SET closed_at = now(), outcome = @outcome
FROM report r
WHERE r.id = sqlc.arg(id)::uuid AND o.closed_at IS NULL AND o.id <> r.id
  AND coalesce(o.reported_owner, o.reported_id) = coalesce(r.reported_owner, r.reported_id);

-- name: ReopenReport :execrows
UPDATE report SET closed_at = NULL, outcome = '' WHERE id = @id;

-- name: HoldReport :execrows
UPDATE report SET held_until = sqlc.narg(until) WHERE id = @id;

-- name: ReferReport :execrows
UPDATE report SET referred = @referred WHERE id = @id;

-- name: RemoveReportLine :execrows
-- A line taken out of every report that holds it.
DELETE FROM report_line WHERE line = @line AND at = @at;

-- name: PurgeReport :execrows
-- Every line the report holds taken out of every report that holds it,
-- and its note.
WITH gone AS (SELECT g.line, g.at FROM report_line g WHERE g.report_id = sqlc.arg(id)::uuid)
DELETE FROM report_line l USING gone WHERE l.line = gone.line AND l.at = gone.at;

-- name: BlankReportNote :exec
UPDATE report SET note = '' WHERE id = @id;

-- name: EndFollows :exec
UPDATE report SET follow_until = now() WHERE follow_until > now();

-- name: DeleteOldReports :execrows
-- Reports closed before the time given and not held, or held until
-- before it: at most lim.
DELETE FROM report WHERE id IN (
  SELECT id FROM report
  WHERE closed_at < sqlc.arg(before)::timestamptz AND (held_until IS NULL OR held_until < now())
  LIMIT @lim
);

-- name: InsertStatement :one
INSERT INTO statement (account_id, report_id, action, rule, seen, until)
VALUES (@account_id, sqlc.narg(report_id), @action, @rule, @seen, sqlc.narg(until))
RETURNING id;

-- name: StatementsOf :many
-- An account's statements of reasons, the newest first.
SELECT id, made_at, action, rule, seen, until, read_at, answer, answered_at FROM statement
WHERE account_id = @account_id ORDER BY made_at DESC LIMIT 20;

-- name: ReadStatement :execrows
UPDATE statement SET read_at = coalesce(read_at, now()) WHERE id = @id AND account_id = @account_id;

-- name: AnswerStatement :one
-- The player's one answer: the report it was about back in the queue.
UPDATE statement SET answer = @answer, answered_at = now(), read_at = coalesce(read_at, now())
WHERE id = @id AND account_id = @account_id AND answer IS NULL
RETURNING report_id;

-- name: ChatSettings :one
SELECT chat, shipmate_messages, chat_countries FROM setting;

-- name: SetChatSwitch :execrows
UPDATE setting SET chat = @chat;

-- name: SetShipmateMessages :execrows
UPDATE setting SET shipmate_messages = @shipmate_messages;

-- name: SetChatCountries :execrows
UPDATE setting SET chat_countries = @chat_countries;
