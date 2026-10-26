// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  actionBody,
  appWords,
  checked,
  countsWords,
  dayWords,
  doneWords,
  type Flow,
  type FlowEvent,
  fleetWords,
  kindWords,
  momentWords,
  nextFlow,
  reasonProblem,
  startWords,
  stoppedWords,
  typedProblem,
  VERBS,
} from './accountwords';

/** Midday, UTC, on 26 October 2026: the same day in any zone the tests run in but the farthest. */
const DAY = Date.UTC(2026, 9, 26, 12);

describe('the Accounts tab’s head', () => {
  test('counts the humans, the machine sailors and the grants live, and those stopped', () => {
    expect(
      countsWords({
        total: 12,
        week: 3,
        today: 5,
        stopped: { human: 1, ai: 2 },
        machines: { total: 4, week: 1, grants: { app: 2 }, lifetime: 60 },
      }),
    ).toBe(
      '12 humans: 3 made this week, 5 seen today; ' +
        '4 machine sailors, 1 made this week; grants live: 2 apps, 0 connection tokens; ' +
        'stopped: 1 human, 2 machine sailors',
    );
  });

  test('leaves out what keel does not count', () => {
    expect(countsWords({ total: 1, week: 0, today: 1 })).toBe(
      '1 human: 0 made this week, 1 seen today',
    );
  });
});

describe('an account’s card', () => {
  test('tells days and moments, and never for none', () => {
    expect(dayWords(DAY)).toMatch(/^2[67] Oct 2026$/);
    expect(momentWords(DAY)).toMatch(/^2[67] Oct 2026, \d\d:\d\d$/);
    expect(dayWords(0)).toBe('never');
    expect(momentWords(0)).toBe('never');
  });

  test('names the kinds as the players do', () => {
    expect(kindWords('human')).toBe('human');
    expect(kindWords('ai')).toBe('machine sailor');
  });

  test('says when and why an account was stopped, and when only for its human', () => {
    expect(stoppedWords({ at: DAY, reason: ' spam ', byOwner: false })).toMatch(
      /^stopped on 2[67] Oct 2026, \d\d:\d\d: spam$/,
    );
    expect(stoppedWords({ at: DAY, reason: '', byOwner: true })).toMatch(
      /, because its human is stopped$/,
    );
  });

  test('lists the fleet by the boats’ ids, none for none', () => {
    expect(fleetWords({ 'jolly-boat': 2, cutter: 0 })).toBe('2 jolly-boat');
    expect(fleetWords({})).toBe('none');
  });

  test('tells an app’s grant: where it goes back to, and how it ended', () => {
    const app = {
      id: 'g',
      name: 'Claude',
      returnHost: 'claude.ai',
      loopback: false,
      approved: DAY,
      lastUsed: 0,
      ends: DAY,
      ended: false,
    };
    expect(appWords(app)).toMatch(
      /^claude\.ai; approved 2[67] Oct 2026, last used never, ends 2[67] Oct 2026$/,
    );
    expect(appWords({ ...app, loopback: true, ended: true, endedHow: 'revoked' })).toMatch(
      /^an app on its owner’s computer; .*, ended, revoked$/,
    );
  });
});

describe('the owner’s hand on an account', () => {
  test('its buttons in the players’ words', () => {
    expect(Object.values(VERBS)).toEqual(['Stop', 'Start again', 'Revoke tokens', 'Delete']);
  });

  test('a reason is needed, of 1 to 500 characters, but for starting again', () => {
    expect(reasonProblem('', true)).toBe('A reason is needed, up to 500 characters.');
    expect(reasonProblem('   ', true)).not.toBe('');
    expect(reasonProblem('', false)).toBe('');
    expect(reasonProblem('spam', true)).toBe('');
    expect(reasonProblem('é'.repeat(500), true)).toBe('');
    // Counted in characters, as the server counts: 500 emoji are 1000 UTF-16 units.
    expect(reasonProblem('🐟'.repeat(500), true)).toBe('');
    expect(reasonProblem('x'.repeat(501), false)).toBe(
      'A reason is at most 500 characters: this is 501.',
    );
    expect(typedProblem('stop', { reason: '', name: '' })).not.toBe('');
    expect(typedProblem('start', { reason: '', name: '' })).toBe('');
    expect(typedProblem('delete', { reason: 'asked', name: ' ' })).toBe(
      'Type the sailor’s name again to delete it.',
    );
    expect(typedProblem('delete', { reason: 'asked', name: 'Ann Bonny' })).toBe('');
  });

  test('each action’s body as keel takes it', () => {
    const t = { reason: ' spam ', name: ' Ann Bonny ' };
    expect(actionBody('stop', 'id', t)).toEqual({ account: 'id', reason: 'spam' });
    expect(actionBody('revoke', 'id', t)).toEqual({ account: 'id', reason: 'spam' });
    expect(actionBody('delete', 'id', t)).toEqual({
      account: 'id',
      reason: 'spam',
      name: 'Ann Bonny',
    });
    expect(actionBody('start', 'id', t)).toEqual({ account: 'id', reason: 'spam' });
    expect(actionBody('start', 'id', { reason: '', name: '' })).toEqual({ account: 'id' });
  });

  test('all but starting again are checked first; starting again is asked in the page’s words', () => {
    expect(checked('stop')).toBe(true);
    expect(checked('revoke')).toBe(true);
    expect(checked('delete')).toBe(true);
    expect(checked('start')).toBe(false);
    expect(startWords('Ann Bonny', '')).toBe(
      'Start Ann Bonny again? It may sign in and sail once more.',
    );
    expect(startWords('Ann Bonny', ' a mistake ')).toBe(
      'Start Ann Bonny again? It may sign in and sail once more. The reason kept: a mistake',
    );
    expect(doneWords('stop', 'Ann Bonny')).toBe('Ann Bonny stopped');
    expect(doneWords('start', 'Ann Bonny')).toBe('Ann Bonny started again');
    expect(doneWords('revoke', 'Ann Bonny')).toBe("Ann Bonny's tokens revoked");
    expect(doneWords('delete', 'Ann Bonny')).toBe('Ann Bonny deleted');
  });
});

describe('a confirmation', () => {
  const body = { account: 'id', reason: 'spam' };
  const run = (...events: FlowEvent[]): Flow =>
    events.reduce<Flow>((f, e) => nextFlow(f, e), { step: 'idle' });
  const asked: FlowEvent = { kind: 'ask', verb: 'stop', body, words: 'Ann Bonny stops.' };

  test('opens with keel’s words once checked, and sends what was checked once confirmed', () => {
    expect(run({ kind: 'check', verb: 'stop' })).toEqual({ step: 'checking', verb: 'stop' });
    const open = run({ kind: 'check', verb: 'stop' }, asked);
    expect(open).toEqual({ step: 'asked', verb: 'stop', body, words: 'Ann Bonny stops.' });
    expect(nextFlow(open, { kind: 'confirm' })).toEqual({ ...open, step: 'sending' });
    expect(
      run({ kind: 'check', verb: 'stop' }, asked, { kind: 'confirm' }, { kind: 'done' }),
    ).toEqual({ step: 'idle' });
  });

  test('a stray click sends nothing: confirming needs a confirmation open', () => {
    expect(run({ kind: 'confirm' })).toEqual({ step: 'idle' });
    expect(run({ kind: 'check', verb: 'stop' }, { kind: 'confirm' })).toEqual({
      step: 'checking',
      verb: 'stop',
    });
    // An answer unasked for opens nothing, nor one for another action.
    expect(run(asked)).toEqual({ step: 'idle' });
    expect(run({ kind: 'check', verb: 'delete' }, asked)).toEqual({
      step: 'checking',
      verb: 'delete',
    });
  });

  test('closes when cancelled, when what was typed changes, or when refused', () => {
    expect(run({ kind: 'check', verb: 'stop' }, asked, { kind: 'cancel' })).toEqual({
      step: 'idle',
    });
    expect(run({ kind: 'check', verb: 'stop' }, asked, { kind: 'edit' })).toEqual({
      step: 'idle',
    });
    // Typed again while it was checked: its answer is of what is no longer typed.
    expect(run({ kind: 'check', verb: 'stop' }, { kind: 'edit' }, asked)).toEqual({
      step: 'idle',
    });
    expect(run({ kind: 'check', verb: 'stop' }, { kind: 'refused' })).toEqual({ step: 'idle' });
  });

  test('what is on its way is not closed, nor asked again', () => {
    const sending = run({ kind: 'check', verb: 'stop' }, asked, { kind: 'confirm' });
    expect(nextFlow(sending, { kind: 'cancel' })).toBe(sending);
    expect(nextFlow(sending, { kind: 'edit' })).toBe(sending);
    expect(nextFlow(sending, { kind: 'confirm' })).toBe(sending);
    expect(nextFlow(sending, { kind: 'check', verb: 'revoke' })).toBe(sending);
  });

  test('starting again is asked without a check', () => {
    const start: FlowEvent = { kind: 'ask', verb: 'start', body: { account: 'id' }, words: 'w' };
    expect(run(start)).toEqual({
      step: 'asked',
      verb: 'start',
      body: { account: 'id' },
      words: 'w',
    });
  });
});
