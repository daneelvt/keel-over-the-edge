// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type { QueueRow } from './api';
import {
  ACTIONS,
  actBody,
  actDoneWords,
  actKey,
  actProblem,
  bandWords,
  countriesOf,
  countriesWords,
  dangerous,
  filterQueue,
  handActions,
  lineTime,
  MAX_NOTE,
  msOf,
  NOTHING_TYPED,
  nextReportFlow,
  queueCountsWords,
  queueWords,
  type ReportFlow,
  type ReportFlowEvent,
  reasonWords,
  reportsOn,
  sourceWords,
  takingWords,
  waitedWords,
} from './reportwords';

const MADE = '2026-11-09T08:30:00Z';
const AT = Date.parse(MADE);

function row(over: Partial<QueueRow>): QueueRow {
  return {
    id: 'r1',
    made: MADE,
    source: 'player',
    reason: 'bullying',
    reports: 1,
    lines: 0,
    ...over,
  };
}

describe('the queue', () => {
  test('tells reasons and sources in words, and what keel adds as it is', () => {
    expect(reasonWords('child')).toBe('A child may be at risk');
    expect(reasonWords('young')).toBe('Said they are under 13');
    expect(reasonWords('weather')).toBe('weather');
    expect(sourceWords('player')).toBe('a player');
    expect(sourceWords('notice')).toBe('a notice from outside the game');
    expect(sourceWords('game')).toBe('the game');
  });

  test('tells how long a report has waited', () => {
    expect(waitedWords(MADE, AT + 20_000)).toBe('under a minute');
    expect(waitedWords(MADE, AT + 12 * 60_000)).toBe('12 minutes');
    expect(waitedWords(MADE, AT + 3 * 3_600_000 + 59 * 60_000)).toBe('3 hours');
    expect(waitedWords(MADE, AT + 47 * 3_600_000)).toBe('47 hours');
    expect(waitedWords(MADE, AT + 50 * 3_600_000)).toBe('2 days');
    // A clock behind keel's never waits less than nothing.
    expect(waitedWords(MADE, AT - 60_000)).toBe('under a minute');
  });

  test('counts the reports open on the player, the lines held, and an answer waiting', () => {
    expect(queueCountsWords(row({ reports: 1, lines: 1 }))).toBe(
      '1 report open on them; 1 line held',
    );
    expect(queueCountsWords(row({ reports: 3, lines: 12, answered: true }))).toBe(
      '3 reports open on them; 12 lines held; an answer from the player waiting',
    );
  });

  test('heads the queue with how many are open, and those for a child', () => {
    expect(queueWords([])).toBe('No report is open.');
    expect(queueWords([row({})])).toBe('1 report open.');
    expect(queueWords([row({ urgent: true }), row({ id: 'r2' })])).toBe(
      '2 reports open, 1 saying a child may be at risk.',
    );
  });

  test('narrows to a name, by the reporter or the reported, any case', () => {
    const rows = [
      row({ id: 'a', reporter: 'Ann Bonny', reported: 'Iron Mary', machine: true }),
      row({ id: 'b', source: 'notice', reported: 'Calico Jack' }),
      row({ id: 'c', source: 'notice' }),
    ];
    expect(filterQueue(rows, '').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(filterQueue(rows, '  mary ').map((r) => r.id)).toEqual(['a']);
    expect(filterQueue(rows, 'BONNY').map((r) => r.id)).toEqual(['a']);
    expect(filterQueue(rows, 'jack').map((r) => r.id)).toEqual(['b']);
    expect(filterQueue(rows, 'nobody')).toEqual([]);
  });

  test('counts the reports on an account and its machine sailors, by their names exactly', () => {
    const rows = [
      row({ id: 'a', reported: 'Iron Mary' }),
      row({ id: 'b', reported: 'Iron Mary' }),
      row({ id: 'c', reported: 'Ann Bonny' }),
      row({ id: 'd', reporter: 'Ann Bonny', reported: 'Calico Jack' }),
    ];
    expect(reportsOn(rows, ['Ann Bonny', 'Iron Mary', 'Brass Jill'])).toEqual([
      { name: 'Ann Bonny', open: 1 },
      { name: 'Iron Mary', open: 2 },
    ]);
    expect(reportsOn(rows, ['Iron'])).toEqual([]);
  });
});

describe('a report', () => {
  test('tells bands, times and the conversation it still takes', () => {
    expect(bandWords('13-17')).toBe('13–17');
    expect(bandWords('adult')).toBe('adult');
    expect(bandWords('under 13')).toBe('under 13');
    expect(bandWords('unknown')).toBe('band unknown');
    expect(msOf(MADE)).toBe(AT);
    expect(msOf(undefined)).toBe(0);
    expect(msOf('soon')).toBe(0);
    expect(lineTime('2026-11-09T08:29:09.123456Z')).toMatch(/^\d\d:29:09$/);
    expect(lineTime('soon')).toBe('soon');
    expect(takingWords(undefined, AT)).toBe('');
    expect(takingWords(MADE, AT)).toBe('');
    expect(takingWords('2026-11-09T08:40:00Z', AT)).toMatch(
      /^Still taking the next 10 minutes, until \d\d:\d0\.$/,
    );
  });
});

describe('the owner’s hand on a report', () => {
  const days = [1, 7, 30];

  test('offers keel’s actions but a line’s removal, and hold or release as it is held', () => {
    const all = Object.keys(ACTIONS);
    expect(handActions(all, false)).toEqual([
      'dismiss',
      'warn',
      'mute-chat',
      'stop',
      'delete',
      'purge',
      'hold',
      'under-13',
      'referred',
    ]);
    expect(handActions(all, true)).toContain('release');
    expect(handActions(all, true)).not.toContain('hold');
    expect(handActions(['dismiss', 'keelhaul'], false)).toEqual(['dismiss']);
    expect(dangerous('delete')).toBe(true);
    expect(dangerous('under-13')).toBe(true);
    expect(dangerous('warn')).toBe(false);
  });

  test('asks a reason for a stop and a delete, the name again for a delete, whom for a referral', () => {
    const t = { ...NOTHING_TYPED };
    expect(actProblem('dismiss', t, 'Iron Mary', days)).toBe('');
    expect(actProblem('warn', t, 'Iron Mary', days)).toBe('');
    expect(actProblem('stop', t, 'Iron Mary', days)).toMatch(/^A reason is needed/);
    expect(actProblem('stop', { ...t, reason: 'threats' }, 'Iron Mary', days)).toBe('');
    expect(actProblem('delete', { ...t, reason: 'threats' }, 'Iron Mary', days)).toMatch(
      /name again/,
    );
    expect(
      actProblem('delete', { ...t, reason: 'threats', name: 'iron mary' }, 'Iron Mary', days),
    ).toMatch(/name again/);
    expect(
      actProblem('delete', { ...t, reason: 'threats', name: ' Iron Mary ' }, 'Iron Mary', days),
    ).toBe('');
    expect(actProblem('referred', t, 'Iron Mary', days)).toMatch(/^Say to whom/);
    expect(actProblem('referred', { ...t, referred: 'x'.repeat(401) }, 'Iron Mary', days)).toMatch(
      /too long/,
    );
    expect(actProblem('referred', { ...t, referred: 'the police, 123' }, 'Iron Mary', days)).toBe(
      '',
    );
    expect(actProblem('mute-chat', { ...t, days: 3 }, 'Iron Mary', days)).toBe(
      'A mute from chat lasts 1, 7, 30 days.',
    );
    expect(actProblem('mute-chat', t, 'Iron Mary', days)).toBe('');
    expect(actProblem('warn', { ...t, note: 'x'.repeat(MAX_NOTE + 1) }, 'Iron Mary', days)).toMatch(
      /^What was seen is at most 500/,
    );
    expect(actProblem('warn', { ...t, reason: 'x'.repeat(501) }, 'Iron Mary', days)).toMatch(
      /^A reason is at most 500/,
    );
  });

  test('sends only what each action reads, trimmed', () => {
    const t = {
      reason: ' rude ',
      note: ' the words ',
      days: 30,
      referred: ' the police ',
      name: 'Iron Mary',
    };
    expect(actBody('dismiss', 'r1', NOTHING_TYPED)).toEqual({ report: 'r1', action: 'dismiss' });
    expect(actBody('warn', 'r1', t)).toEqual({
      report: 'r1',
      action: 'warn',
      reason: 'rude',
      note: 'the words',
    });
    expect(actBody('mute-chat', 'r1', t)).toEqual({
      report: 'r1',
      action: 'mute-chat',
      reason: 'rude',
      note: 'the words',
      days: 30,
    });
    expect(actBody('referred', 'r1', { ...NOTHING_TYPED, referred: ' the police, 123 ' })).toEqual({
      report: 'r1',
      action: 'referred',
      referred: 'the police, 123',
    });
    expect(
      actBody('remove-line', 'r1', NOTHING_TYPED, { line: 7, at: '2026-11-09T08:29:09.123456Z' }),
    ).toEqual({ report: 'r1', action: 'remove-line', line: 7, at: '2026-11-09T08:29:09.123456Z' });
    // The name typed again is the page's check, never sent.
    expect(actBody('delete', 'r1', t)).not.toHaveProperty('name');
  });

  test('says what was done', () => {
    expect(actDoneWords('mute-chat', 'Iron Mary', 7)).toBe('Iron Mary muted from chat for 7 days');
    expect(actDoneWords('mute-chat', 'Iron Mary', 1)).toBe('Iron Mary muted from chat for 1 day');
    expect(actDoneWords('warn', '', 7)).toBe('the player warned');
    expect(actDoneWords('dismiss', 'Iron Mary', 7)).toBe('the report dismissed');
    expect(actDoneWords('under-13', 'Ann Bonny', 7)).toBe('Ann Bonny deleted as under 13');
  });
});

describe('an action on a report on its way', () => {
  const body = { report: 'r1', action: 'warn' };
  const asked: ReportFlow = { step: 'asked', key: 'warn', body, words: 'W', what: 'w' };
  const step = (f: ReportFlow, ...es: ReportFlowEvent[]): ReportFlow =>
    es.reduce(nextReportFlow, f);

  test('is checked, asked with keel’s words, sent, and done', () => {
    let f = step({ step: 'idle' }, { kind: 'check', key: 'warn' });
    expect(f).toEqual({ step: 'checking', key: 'warn' });
    f = step(f, { kind: 'ask', key: 'warn', body, words: 'W', what: 'w' });
    expect(f).toEqual(asked);
    f = step(f, { kind: 'confirm' });
    expect(f.step).toBe('sending');
    // Nothing closes what is on its way.
    expect(step(f, { kind: 'edit' }, { kind: 'cancel' }, { kind: 'check', key: 'stop' }).step).toBe(
      'sending',
    );
    expect(step(f, { kind: 'done' })).toEqual({ step: 'idle' });
  });

  test('shows an answer only for what is being checked, and not once typing changed it', () => {
    const late = { kind: 'ask', key: 'stop', body, words: 'S', what: 's' } as const;
    expect(step({ step: 'checking', key: 'warn' }, late)).toEqual({
      step: 'checking',
      key: 'warn',
    });
    expect(step({ step: 'checking', key: 'warn' }, { kind: 'edit' }, late)).toEqual({
      step: 'idle',
    });
    expect(step({ step: 'idle' }, late)).toEqual({ step: 'idle' });
    expect(step(asked, { kind: 'edit' })).toEqual({ step: 'idle' });
    expect(step(asked, { kind: 'cancel' })).toEqual({ step: 'idle' });
    expect(step({ step: 'checking', key: 'warn' }, { kind: 'refused' })).toEqual({ step: 'idle' });
    // Confirming sends only what is asked.
    expect(step({ step: 'idle' }, { kind: 'confirm' })).toEqual({ step: 'idle' });
  });

  test('tells one line’s removal from another’s', () => {
    expect(actKey('warn')).toBe('warn');
    const a = actKey('remove-line', { line: 7, at: 'T1' });
    const b = actKey('remove-line', { line: 7, at: 'T2' });
    expect(a).not.toBe(b);
    expect(
      step({ step: 'checking', key: a }, { kind: 'ask', key: b, body, words: '', what: '' }).step,
    ).toBe('checking');
  });
});

describe('chat’s countries', () => {
  test('are two letters each, upper case, sorted and each once; nothing is no country', () => {
    expect(countriesOf('')).toEqual({ codes: [], ok: true });
    expect(countriesOf(' , ')).toEqual({ codes: [], ok: true });
    expect(countriesOf('br, au,AU ')).toEqual({ codes: ['AU', 'BR'], ok: true });
    expect(countriesOf('BRA').ok).toBe(false);
    expect(countriesOf('B1').ok).toBe(false);
    expect(countriesOf('ÉS').ok).toBe(false);
    expect(countriesOf('ß').ok).toBe(false);
    expect(countriesOf('BR AU').ok).toBe(false);
    expect(countriesWords([])).toBe('none');
    expect(countriesWords(['AU', 'BR'])).toBe('AU, BR');
  });
});
