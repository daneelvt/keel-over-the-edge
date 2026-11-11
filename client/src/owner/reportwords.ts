// SPDX-License-Identifier: AGPL-3.0-only

// The reports in words, as the world page's Reports tab tells them: the
// queue, a report whole, and the owner's actions on one. Each action is
// first checked, the server's words of what it would do shown, and done
// only once those are confirmed; a confirmation open closes as soon as
// what it was asked with changes. What players wrote is only ever shown as
// text.

import { momentWords, reasonProblem } from './accountwords';
import type { QueueRow, ReportSource } from './api';
import { plural } from './machines';

/** A report's reasons, as the owner reads them. */
export const REASONS: Record<string, string> = {
  child: 'A child may be at risk',
  sexual: 'Sexual content',
  bullying: 'Bullying or harassment',
  hate: 'Hate',
  threats: 'Threats or self-harm',
  scam: 'A scam or spam',
  cheating: 'Cheating',
  other: 'Something else',
  young: 'Said they are under 13',
};

/** A reason in words, or as keel gave it. */
export function reasonWords(reason: string): string {
  return REASONS[reason] ?? reason;
}

/** Where a report came from. */
export function sourceWords(source: ReportSource): string {
  switch (source) {
    case 'player':
      return 'a player';
    case 'notice':
      return 'a notice from outside the game';
    case 'game':
      return 'the game';
  }
}

/** Someone's band, as a report keeps it. */
export function bandWords(band: string): string {
  switch (band) {
    case '13-17':
      return '13–17';
    case 'adult':
    case 'under 13':
      return band;
    default:
      return 'band unknown';
  }
}

/** An RFC 3339 time as ms, 0 for none or one that is not. */
export function msOf(iso: string | undefined): number {
  const ms = iso === undefined || iso === '' ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** An RFC 3339 time in the owner's zone, "9 Nov 2026, 18:05"; never for none. */
export function isoWords(iso: string | undefined): string {
  return momentWords(msOf(iso));
}

const seconds = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** A line's time, to the second in the owner's zone: "18:05:09". */
export function lineTime(iso: string): string {
  const ms = msOf(iso);
  return ms > 0 ? seconds.format(ms) : iso;
}

/** How long a report has waited: "under a minute", "12 minutes", "3 hours", "2 days". */
export function waitedWords(made: string, now: number): string {
  const ms = Math.max(0, now - msOf(made));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return 'under a minute';
  }
  if (minutes < 60) {
    return plural(minutes, 'minute');
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? plural(hours, 'hour') : plural(Math.floor(hours / 24), 'day');
}

/** A queue row's counts: the reports open on the player, the lines it holds, an answer waiting. */
export function queueCountsWords(r: QueueRow): string {
  const words = [`${plural(r.reports, 'report')} open on them`, `${plural(r.lines, 'line')} held`];
  if (r.answered === true) {
    words.push('an answer from the player waiting');
  }
  return words.join('; ');
}

/** The queue's head: how many are open, and how many say a child may be at risk. */
export function queueWords(rows: QueueRow[]): string {
  if (rows.length === 0) {
    return 'No report is open.';
  }
  const child = rows.filter((r) => r.urgent === true).length;
  const open = `${plural(rows.length, 'report')} open`;
  return child === 0 ? `${open}.` : `${open}, ${child} saying a child may be at risk.`;
}

/** The rows matching what is typed, by the reporter's or the reported's name, any case. */
export function filterQueue(rows: QueueRow[], filter: string): QueueRow[] {
  const f = filter.trim().toLocaleLowerCase();
  if (f === '') {
    return rows;
  }
  return rows.filter((r) =>
    [r.reporter, r.reported].some((n) => n?.toLocaleLowerCase().includes(f) === true),
  );
}

/** How many reports are open on each of names, those with none left out. */
export function reportsOn(rows: QueueRow[], names: string[]): { name: string; open: number }[] {
  return names
    .map((name) => ({ name, open: rows.filter((r) => r.reported === name).length }))
    .filter((n) => n.open > 0);
}

/** "still taking the next 10 minutes, until 18:15", or "" once it no longer is. */
export function takingWords(until: string | undefined, now: number): string {
  const ms = msOf(until);
  if (ms <= now) {
    return '';
  }
  return `Still taking the next 10 minutes, until ${seconds.format(ms).slice(0, 5)}.`;
}

/** The owner's actions on a report, as keel names them. */
export type ReportAction =
  | 'dismiss'
  | 'warn'
  | 'mute-chat'
  | 'stop'
  | 'delete'
  | 'remove-line'
  | 'purge'
  | 'hold'
  | 'release'
  | 'under-13'
  | 'referred';

/** Each action's button. */
export const ACTIONS: Record<ReportAction, string> = {
  dismiss: 'Dismiss',
  warn: 'Warn',
  'mute-chat': 'Mute from chat',
  stop: 'Stop',
  delete: 'Delete',
  'remove-line': 'Remove',
  purge: 'Purge its lines',
  hold: 'Hold',
  release: 'Release',
  'under-13': 'Under 13',
  referred: 'Referred',
};

/** The actions that cannot be taken back, shown as such. */
export function dangerous(a: ReportAction): boolean {
  return a === 'stop' || a === 'delete' || a === 'purge' || a === 'under-13';
}

/**
 * The actions the hand offers, in keel's order: those keel lists but a
 * line's removal, which is on each line's row; hold or release, as the
 * report is held or not.
 */
export function handActions(actions: string[], held: boolean): ReportAction[] {
  return actions.filter(
    (a): a is ReportAction =>
      a in ACTIONS && a !== 'remove-line' && a !== (held ? 'hold' : 'release'),
  );
}

/**
 * What the owner typed for an action: the reason, kept with the record;
 * what was seen, the statement's; the days of a mute; to whom it was
 * referred; and the reported sailor's name again, to delete them.
 */
export interface ReportTyped {
  reason: string;
  note: string;
  days: number;
  referred: string;
  name: string;
}

/** Nothing typed yet, a mute of 7 days chosen. */
export const NOTHING_TYPED: ReportTyped = { reason: '', note: '', days: 7, referred: '', name: '' };

/** What was seen, at most, in characters, as keel keeps it. */
export const MAX_NOTE = 500;

/** To whom a report was referred, at most, in bytes of UTF-8, as keel keeps it. */
export const MAX_REFERRED = 400;

/** Why an action cannot be asked yet, or "". */
export function actProblem(
  a: ReportAction,
  t: ReportTyped,
  reported: string,
  days: number[],
): string {
  const r = reasonProblem(t.reason, a === 'stop' || a === 'delete');
  if (r !== '') {
    return r;
  }
  const n = [...t.note.trim()].length;
  if (n > MAX_NOTE) {
    return `What was seen is at most ${MAX_NOTE} characters: this is ${n}.`;
  }
  if (a === 'mute-chat' && !days.includes(t.days)) {
    return `A mute from chat lasts ${days.join(', ')} days.`;
  }
  if (a === 'delete' && t.name.trim() !== reported.trim()) {
    return 'Type the reported sailor’s name again, as the report has it, to delete them.';
  }
  if (a === 'referred' && t.referred.trim() === '') {
    return 'Say to whom it was referred, and its reference.';
  }
  if (a === 'referred' && new TextEncoder().encode(t.referred.trim()).length > MAX_REFERRED) {
    return 'To whom it was referred is too long: shorten it.';
  }
  return '';
}

/** A line to remove: its number and when it was said, as report.json gives them. */
export interface LineAt {
  line: number;
  at: string;
}

/** An action's body, as keel takes it: what was typed, trimmed, and only what the action reads. */
export function actBody(
  a: ReportAction,
  report: string,
  t: ReportTyped,
  line?: LineAt,
): Record<string, string | number> {
  const body: Record<string, string | number> = { report, action: a };
  const reason = t.reason.trim();
  const note = t.note.trim();
  if (reason !== '') {
    body.reason = reason;
  }
  if (note !== '') {
    body.note = note;
  }
  if (a === 'mute-chat') {
    body.days = t.days;
  }
  if (a === 'referred') {
    body.referred = t.referred.trim();
  }
  if (a === 'remove-line' && line !== undefined) {
    body.line = line.line;
    body.at = line.at;
  }
  return body;
}

/** An action done, as the page's message says it. */
export function actDoneWords(a: ReportAction, reported: string, days: number): string {
  const who = reported === '' ? 'the player' : reported;
  switch (a) {
    case 'dismiss':
      return 'the report dismissed';
    case 'warn':
      return `${who} warned`;
    case 'mute-chat':
      return `${who} muted from chat for ${plural(days, 'day')}`;
    case 'stop':
      return `${who} stopped`;
    case 'delete':
      return `${who} deleted`;
    case 'remove-line':
      return 'the line removed';
    case 'purge':
      return 'the report’s lines purged';
    case 'hold':
      return 'the report held';
    case 'release':
      return 'the report’s hold released';
    case 'under-13':
      return `${who} deleted as under 13`;
    case 'referred':
      return 'the report recorded as referred';
  }
}

/** What an action on its way is about: the action, and for a line's removal, which. */
export function actKey(a: ReportAction, line?: LineAt): string {
  return line === undefined ? a : `${a} ${line.line} ${line.at}`;
}

/**
 * An action on its way: being checked, asked of the owner with keel's
 * words of what it does and the body checked, or being sent.
 */
export type ReportFlow =
  | { step: 'idle' }
  | { step: 'checking'; key: string }
  | {
      step: 'asked';
      key: string;
      body: Record<string, string | number>;
      words: string;
      what: string;
    }
  | {
      step: 'sending';
      key: string;
      body: Record<string, string | number>;
      words: string;
      what: string;
    };

export type ReportFlowEvent =
  | { kind: 'check'; key: string }
  | { kind: 'ask'; key: string; body: Record<string, string | number>; words: string; what: string }
  | { kind: 'refused' }
  | { kind: 'edit' }
  | { kind: 'cancel' }
  | { kind: 'confirm' }
  | { kind: 'done' };

/**
 * The next step. A check is asked only from rest or over another
 * confirmation; its answer is shown only for what is being checked, and
 * not once what was typed changed since; confirming sends only what is
 * asked; nothing closes what is on its way.
 */
export function nextReportFlow(f: ReportFlow, e: ReportFlowEvent): ReportFlow {
  switch (e.kind) {
    case 'check':
      return f.step === 'idle' || f.step === 'asked' ? { step: 'checking', key: e.key } : f;
    case 'ask':
      return f.step === 'checking' && f.key === e.key
        ? { step: 'asked', key: e.key, body: e.body, words: e.words, what: e.what }
        : f;
    case 'refused':
      return f.step === 'checking' ? { step: 'idle' } : f;
    case 'edit':
      return f.step === 'asked' || f.step === 'checking' ? { step: 'idle' } : f;
    case 'cancel':
      return f.step === 'asked' ? { step: 'idle' } : f;
    case 'confirm':
      return f.step === 'asked' ? { ...f, step: 'sending' } : f;
    case 'done':
      return f.step === 'sending' ? { step: 'idle' } : f;
  }
}

/**
 * The countries typed, as keel takes them: two letters each, comma
 * separated, upper case, sorted, each once; ok false when one is not two
 * letters. Nothing typed is no country.
 */
export function countriesOf(text: string): { codes: string[]; ok: boolean } {
  let ok = true;
  const codes = new Set<string>();
  for (const part of text.split(',')) {
    const c = part.trim();
    if (c === '') {
      continue;
    }
    if (/^[A-Za-z]{2}$/.test(c)) {
      codes.add(c.toUpperCase());
    } else {
      ok = false;
    }
  }
  return { codes: [...codes].sort(), ok };
}

/** The countries where chat is off, in words. */
export function countriesWords(codes: string[]): string {
  return codes.length === 0 ? 'none' : codes.join(', ');
}
