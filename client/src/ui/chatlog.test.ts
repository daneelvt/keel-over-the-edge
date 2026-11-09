// SPDX-License-Identifier: AGPL-3.0-only

// Chat aboard as the page keeps it: the last 50 lines and no more; an own
// line shown at once and matched to its echo, said, refused for a word
// (which looks said), refused and taken back, or lost; a muted or blocked
// person's lines hidden at once and shown again; the open strip's fit;
// and nothing of it in the browser's storage.

import { describe, expect, test, vi } from 'vitest';
import type { ChatTold, PersonTold } from '../net/messages';
import {
  ChatLog,
  ECHO_WAIT,
  fitStrip,
  KEPT_LINES,
  lineLength,
  lineOf,
  MAX_LINE,
  NOTE_STAYS,
} from './chatlog';

function line(id: number, name: string, text: string, more: Partial<ChatTold> = {}): ChatTold {
  return {
    id,
    seat: 1,
    name,
    machine: false,
    at: 1_000 + id,
    text,
    you: false,
    echo: 0,
    refused: '',
    ...more,
  };
}

function person(seat: number, name: string, more: Partial<PersonTold> = {}): PersonTold {
  return { seat, look: 0, name, machine: false, you: false, muted: false, blocked: false, ...more };
}

describe('the lines kept', () => {
  test('the newest 50, the oldest first', () => {
    const log = new ChatLog();
    for (let i = 1; i <= KEPT_LINES + 7; i++) {
      log.receive(line(i, 'Iron Mary', `line ${i}`), 0);
    }
    const ids = log.lines.value.map((l) => l.id);
    expect(ids).toHaveLength(KEPT_LINES);
    expect(ids[0]).toBe(8);
    expect(ids[ids.length - 1]).toBe(KEPT_LINES + 7);
  });

  test('a new voyage forgets them all, and the note', () => {
    const log = new ChatLog();
    log.receive(line(1, 'Iron Mary', 'Ahoy'), 0);
    log.reported(true, 0);
    log.clear();
    expect(log.lines.value).toEqual([]);
    expect(log.note.value).toBeNull();
  });

  test('nothing of chat goes in the browser’s storage', () => {
    const set = vi.fn();
    vi.stubGlobal('localStorage', { setItem: set, getItem: () => null });
    vi.stubGlobal('sessionStorage', { setItem: set, getItem: () => null });
    try {
      const log = new ChatLog();
      log.receive(line(1, 'Iron Mary', 'Ahoy'), 0);
      log.say('Fair winds', 'Saltpeter Sue', 0);
      log.tie('Iron Mary', 'mute', true);
      expect(set).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('an own line and its echo', () => {
  test('shown at once, waiting; said, it takes the server’s number, text and time', () => {
    const log = new ChatLog();
    const s = log.say('  Fair   winds\n', 'Saltpeter Sue', 5_000);
    expect(s).toEqual({ id: 1, text: 'Fair   winds' });
    expect(log.lines.value).toMatchObject([
      { you: true, pending: true, name: 'Saltpeter Sue', text: 'Fair   winds' },
    ]);
    expect(log.waiting).toBe(true);
    log.receive(
      line(42, 'Saltpeter Sue', 'Fair winds', { you: true, echo: s?.id ?? 0, at: 6_000 }),
      6_100,
    );
    expect(log.lines.value).toMatchObject([
      { id: 42, you: true, pending: false, text: 'Fair winds', at: 6_000 },
    ]);
    expect(log.waiting).toBe(false);
  });

  test('a line refused for a word comes back as said, and looks just like one', () => {
    const log = new ChatLog();
    const s = log.say('You barnacle', 'Saltpeter Sue', 0);
    // The server sends it back with no number and, so far, no name.
    log.receive(line(0, '', 'You barnacle', { you: true, echo: s?.id ?? 0 }), 10);
    expect(log.lines.value).toMatchObject([
      { id: 0, you: true, pending: false, name: 'Saltpeter Sue', text: 'You barnacle' },
    ]);
    expect(log.note.value).toBeNull();
  });

  test('refused: taken back, why told, its words kept for the field', () => {
    for (const why of ['contact', 'fast', 'nobody', 'silent', 'long'] as const) {
      const log = new ChatLog();
      log.receive(line(1, 'Iron Mary', 'Ahoy'), 0);
      const s = log.say('find me at example dot com', 'Saltpeter Sue', 0);
      log.receive(line(0, '', '', { you: true, echo: s?.id ?? 0, refused: why }), 10);
      expect(log.lines.value.map((l) => l.text)).toEqual(['Ahoy']);
      expect(log.note.value).toEqual({
        kind: 'refused',
        why,
        text: 'find me at example dot com',
        at: 10,
      });
    }
  });

  test('echoes match their own lines, whatever order they come in', () => {
    const log = new ChatLog();
    const a = log.say('one', 'Saltpeter Sue', 0);
    const b = log.say('two', 'Saltpeter Sue', 0);
    log.receive(line(0, '', '', { you: true, echo: b?.id ?? 0, refused: 'fast' }), 1);
    log.receive(line(5, 'Saltpeter Sue', 'one', { you: true, echo: a?.id ?? 0 }), 2);
    expect(log.lines.value.map((l) => [l.text, l.id, l.pending])).toEqual([['one', 5, false]]);
  });

  test('an echo with no line waiting is kept as the player’s own', () => {
    const log = new ChatLog();
    log.receive(line(3, 'Saltpeter Sue', 'from before', { you: true, echo: 99 }), 0);
    expect(log.lines.value).toMatchObject([{ you: true, pending: false, text: 'from before' }]);
  });

  test('no echo in time: lost, taken back, and its words kept', () => {
    const log = new ChatLog();
    log.say('hello?', 'Saltpeter Sue', 0);
    log.expire(ECHO_WAIT);
    expect(log.lines.value).toHaveLength(1);
    log.expire(ECHO_WAIT + 1);
    expect(log.lines.value).toEqual([]);
    expect(log.note.value).toEqual({ kind: 'lost', text: 'hello?', at: ECHO_WAIT + 1 });
    log.expire(ECHO_WAIT + 1 + NOTE_STAYS + 1);
    expect(log.note.value).toBeNull();
  });

  test('nothing to send, or too long, is not sent; a line is one line', () => {
    const log = new ChatLog();
    expect(log.say('   ', 'Saltpeter Sue', 0)).toBeNull();
    expect(log.say('a'.repeat(MAX_LINE + 1), 'Saltpeter Sue', 0)).toBeNull();
    expect(lineOf('a'.repeat(MAX_LINE))).toHaveLength(MAX_LINE);
    expect(lineOf('one\ntwo\r\nthree')).toBe('one two three');
    // Characters as the server counts them: an emoji is one.
    expect(lineLength('⛵⛵')).toBe(2);
    expect(lineOf('🐋'.repeat(MAX_LINE))).not.toBeNull();
    expect(log.lines.value).toEqual([]);
  });

  test('the Say’s ids count up from 1 and never give 0', () => {
    const log = new ChatLog();
    const ids = [1, 2, 3].map(() => log.say('x', 'S', 0)?.id);
    expect(ids).toEqual([1, 2, 3]);
  });
});

describe('mutes and blocks', () => {
  test('a muted sender’s lines hidden at once, and shown again when the mute ends', () => {
    const log = new ChatLog();
    log.receive(line(1, 'Iron Mary', 'Ahoy'), 0);
    log.receive(line(2, 'Bosun Bly', 'Fair winds'), 0);
    log.tie('Iron Mary', 'mute', true);
    expect(log.lines.value.map((l) => l.name)).toEqual(['Bosun Bly']);
    expect(log.hidden.value.has('Iron Mary')).toBe(true);
    log.tie('Iron Mary', 'mute', false);
    expect(log.lines.value.map((l) => l.name)).toEqual(['Iron Mary', 'Bosun Bly']);
  });

  test('the server’s word stands: Tied, and who is aboard', () => {
    const log = new ChatLog();
    log.receive(line(1, 'Iron Mary', 'Ahoy'), 0);
    log.receive(line(2, 'Gull', 'Beep'), 0);
    log.tied({ name: 'Iron Mary', muted: false, blocked: true, full: false }, 5);
    expect(log.tieOf('Iron Mary')).toEqual({ muted: false, blocked: true });
    expect(log.note.value).toMatchObject({ kind: 'tied', name: 'Iron Mary', blocked: true });
    log.crew([person(0, 'Iron Mary'), person(1, 'Gull', { muted: true })]);
    expect(log.lines.value.map((l) => l.name)).toEqual(['Iron Mary']);
  });

  test('a full list changes nothing', () => {
    const log = new ChatLog();
    log.receive(line(1, 'Iron Mary', 'Ahoy'), 0);
    log.tied({ name: 'Iron Mary', muted: true, blocked: false, full: true }, 0);
    expect(log.lines.value).toHaveLength(1);
    expect(log.note.value).toMatchObject({ kind: 'tied', full: true });
  });

  test('the player’s own lines are never hidden', () => {
    const log = new ChatLog();
    log.say('mine', 'Saltpeter Sue', 0);
    log.tie('Saltpeter Sue', 'mute', true);
    expect(log.lines.value).toHaveLength(1);
  });
});

describe('the open strip’s fit', () => {
  test('its lines as tall as there is room, between the least and the most', () => {
    expect(fitStrip(160, 100, 500, 40, 140)).toEqual({ lines: 140, lift: 0 });
    expect(fitStrip(160, 100, 340, 40, 140)).toEqual({ lines: 80, lift: 0 });
  });

  test('with no room even for the least, it lifts', () => {
    expect(fitStrip(160, 100, 260, 40, 140)).toEqual({ lines: 40, lift: 40 });
  });
});
