// SPDX-License-Identifier: AGPL-3.0-only

// Messages between shipmates as the page keeps them: a thread each, the
// newest 50; an own message shown at once and matched to its echo, said
// or refused with its words kept for the field, or lost; a shipmate's
// message heard; the threads of anyone no longer a shipmate forgotten;
// and which echoes are a message's rather than a line aboard's.

import { describe, expect, test } from 'vitest';
import type { ChatTold } from '../net/messages';
import { ChatLog, ECHO_WAIT, KEPT_LINES, NOTE_STAYS } from './chatlog';
import { FIRST_MESSAGE_ID, ShipmateThreads } from './shipmatelog';

function heard(thread: string, id: number, text: string, more: Partial<ChatTold> = {}): ChatTold {
  return {
    id,
    seat: 0,
    name: 'Iron Mary',
    machine: false,
    at: 1_000 + id,
    text,
    you: false,
    echo: 0,
    refused: '',
    thread,
    ...more,
  };
}

function echo(thread: string, echo: number, more: Partial<ChatTold> = {}): ChatTold {
  return heard(thread, 0, '', { you: true, echo, name: 'Saltpeter Sue', ...more });
}

describe('a thread each', () => {
  test('a shipmate’s messages kept by thread, the newest 50, and heard', () => {
    const t = new ShipmateThreads();
    for (let i = 1; i <= KEPT_LINES + 3; i++) {
      t.receive(heard('mary', i, `message ${i}`), 0);
    }
    t.receive(heard('bly', 99, 'Ahoy', { name: 'Bosun Bly' }), 0);
    const mary = t.lines('mary');
    expect(mary).toHaveLength(KEPT_LINES);
    expect(mary[0]?.text).toBe('message 4');
    expect(mary.at(-1)?.text).toBe(`message ${KEPT_LINES + 3}`);
    expect(t.lines('bly').map((l) => l.text)).toEqual(['Ahoy']);
    expect(t.heard.value).toMatchObject({ thread: 'bly', name: 'Bosun Bly' });
    expect(t.threads).toEqual(['mary', 'bly']);
    expect(t.lines('nobody')).toEqual([]);
  });

  test('a line aboard has no thread, and is none of a thread’s', () => {
    const t = new ShipmateThreads();
    t.receive(heard('', 1, 'aboard'), 0);
    expect(t.threads).toEqual([]);
    expect(t.heard.value).toBeNull();
  });
});

describe('an own message', () => {
  test('shown at once, waiting, then said by its echo', () => {
    const t = new ShipmateThreads();
    const s = t.say('mary', '  Fair winds  ', 'Saltpeter Sue', 5_000);
    expect(s).toEqual({ id: FIRST_MESSAGE_ID, text: 'Fair winds' });
    expect(t.lines('mary')).toMatchObject([{ text: 'Fair winds', you: true, pending: true }]);
    expect(t.waiting.value).toBe(true);
    t.receive(echo('mary', s?.id ?? 0, { id: 41, text: 'Fair winds', at: 5_100 }), 5_200);
    expect(t.lines('mary')).toMatchObject([
      { id: 41, text: 'Fair winds', you: true, pending: false },
    ]);
    expect(t.waiting.value).toBe(false);
    // Its own echo is not a shipmate's message heard.
    expect(t.heard.value).toBeNull();
  });

  test('nothing to send, or to nobody: nothing shown', () => {
    const t = new ShipmateThreads();
    expect(t.say('mary', '   ', 'Sue', 0)).toBeNull();
    expect(t.say('', 'Ahoy', 'Sue', 0)).toBeNull();
    expect(t.say('mary', 'x'.repeat(201), 'Sue', 0)).toBeNull();
    expect(t.threads).toEqual([]);
  });

  test('refused for its shipmate away: taken back, why told, its words kept', () => {
    const t = new ShipmateThreads();
    const s = t.say('meg', 'See you at the light', 'Sue', 0);
    // The refusal names no thread: its echo finds it.
    t.receive(echo('', s?.id ?? 0, { refused: 'away' }), 10);
    expect(t.lines('meg')).toEqual([]);
    expect(t.note('meg')).toEqual({
      kind: 'refused',
      why: 'away',
      text: 'See you at the light',
      at: 10,
    });
    // A new message puts the note away.
    t.say('meg', 'Again', 'Sue', 20);
    expect(t.note('meg')).toBeNull();
  });

  test('with no echo in time it is lost, its words kept; the note goes in time', () => {
    const t = new ShipmateThreads();
    t.say('mary', 'Anyone there?', 'Sue', 0);
    t.expire(ECHO_WAIT);
    expect(t.lines('mary')).toHaveLength(1);
    t.expire(ECHO_WAIT + 1);
    expect(t.lines('mary')).toEqual([]);
    expect(t.note('mary')).toMatchObject({ kind: 'lost', text: 'Anyone there?' });
    t.expire(ECHO_WAIT + 1 + NOTE_STAYS);
    expect(t.note('mary')).not.toBeNull();
    t.expire(ECHO_WAIT + 2 + NOTE_STAYS);
    expect(t.note('mary')).toBeNull();
  });

  test('the echoes of messages are told from those of lines aboard', () => {
    const t = new ShipmateThreads();
    const log = new ChatLog();
    const aboard = log.say('Ahoy all', 'Sue', 0);
    const message = t.say('mary', 'Ahoy Mary', 'Sue', 0);
    expect(aboard?.id).toBeLessThan(FIRST_MESSAGE_ID);
    expect(message?.id).toBeGreaterThanOrEqual(FIRST_MESSAGE_ID);
    expect(t.answers({ you: true, echo: aboard?.id ?? 0, thread: '' })).toBe(false);
    expect(t.answers({ you: true, echo: message?.id ?? 0, thread: '' })).toBe(true);
    expect(t.answers({ you: false, echo: 0, thread: 'mary' })).toBe(true);
    expect(t.answers({ you: false, echo: 0, thread: '' })).toBe(false);
  });
});

describe('no longer shipmates', () => {
  test('every thread but the shipmates’ forgotten, its notes with it', () => {
    const t = new ShipmateThreads();
    t.receive(heard('mary', 1, 'Ahoy'), 0);
    const s = t.say('bly', 'Hello', 'Sue', 0);
    t.receive(echo('bly', s?.id ?? 0, { refused: 'away' }), 0);
    t.keep(new Set(['mary']));
    expect(t.threads).toEqual(['mary']);
    expect(t.note('bly')).toBeNull();
    t.keep(new Set());
    expect(t.threads).toEqual([]);
    expect(t.heard.value).toBeNull();
  });
});
