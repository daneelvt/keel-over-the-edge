// SPDX-License-Identifier: AGPL-3.0-only

// Chat's words: why a line was not said, how chat stands, a mute or a
// block told, the report's reasons (a child at risk first), the owner
// reading, a statement of reasons; names kept apart as player text; and
// never who reported anyone, nor an age.

import { describe, expect, test } from 'vitest';
import * as words from './chatwords';
import {
  actionText,
  blockWords,
  leftText,
  lineWords,
  ownerReadsWords,
  REPORT_REASONS,
  refusedText,
  restingText,
  tiedWords,
  whenText,
} from './chatwords';
import { plain } from './deckwords';

const zone = 'Pacific/Auckland';
const now = Date.parse('2026-11-09T01:00:00Z'); // 14:00 in Auckland

describe('a line not said', () => {
  test('each refusal in plain words', () => {
    expect(refusedText('contact')).toBe('Links and contact details can’t be sent aboard');
    expect(refusedText('fast')).toBe('Too fast: wait a moment');
    expect(refusedText('nobody')).toBe('Nobody is aboard to hear you');
    expect(refusedText('silent')).toBe('You can’t chat just now');
    expect(refusedText('long')).toMatch(/200 characters/);
  });
});

describe('how chat stands', () => {
  test('resting: for now, a few minutes, until a time, until a day', () => {
    expect(restingText(0, now, zone)).toBe('Your chat is resting for now');
    expect(restingText(now + 10 * 60_000, now, zone)).toBe(
      'Your chat is resting for a few minutes',
    );
    expect(restingText(now + 2 * 3_600_000, now, zone)).toBe('Your chat is resting until 16:00');
    expect(restingText(now + 26 * 3_600_000, now, zone)).toBe(
      'Your chat is resting until 10 November, 16:00',
    );
    expect(whenText(now, now, zone)).toBe('14:00');
  });

  test('an owner reading their machine sailor’s chat', () => {
    const w = ownerReadsWords('Gull');
    expect(plain(w)).toBe('Watching Gull: you read its chat aboard');
    expect(w).toContainEqual({ player: 'Gull' });
  });
});

describe('mute, block and report', () => {
  test('a mute or a block told, by name; a full list', () => {
    expect(plain(tiedWords({ name: 'Iron Mary', muted: true, blocked: false, full: false }))).toBe(
      'Iron Mary is muted: you won’t see their lines.',
    );
    expect(plain(tiedWords({ name: 'Iron Mary', muted: true, blocked: true, full: false }))).toBe(
      'Iron Mary is blocked.',
    );
    expect(plain(tiedWords({ name: 'Iron Mary', muted: false, blocked: false, full: false }))).toBe(
      'Iron Mary is no longer muted or blocked.',
    );
    expect(
      plain(tiedWords({ name: 'Iron Mary', muted: true, blocked: false, full: true })),
    ).toMatch(/full \(1,000\)/);
  });

  test('the one question before a block names them as player text', () => {
    expect(blockWords('<b>Iron Mary</b>')).toEqual(['Block ', { player: '<b>Iron Mary</b>' }, '?']);
    expect(words.BLOCK_DETAIL).toBe(
      'You won’t see each other’s lines, and they can’t knock on your boat.',
    );
  });

  test('the reasons, a child at risk first, every one the server knows', () => {
    expect(REPORT_REASONS.map((r) => r.reason)).toEqual([
      'child',
      'sexual',
      'bullying',
      'hate',
      'threats',
      'scam',
      'cheating',
      'other',
    ]);
    expect(REPORT_REASONS[0]?.text).toBe('A child may be at risk');
    expect(words.REPORTED).toBe('Thanks: the owner will look');
  });

  test('a line for a screen reader keeps its sender and words as player text', () => {
    expect(lineWords('Iron Mary', 'Ahoy')).toEqual([
      { player: 'Iron Mary' },
      ': ',
      { player: 'Ahoy' },
    ]);
  });

  test('how many characters are left, only near the end', () => {
    expect(leftText(10, 200)).toBe('');
    expect(leftText(170, 200)).toBe('30 left');
    expect(leftText(205, 200)).toBe('0 left');
    expect(leftText(400, 500)).toBe('');
    expect(leftText(470, 500)).toBe('30 left');
  });
});

describe('a statement of reasons', () => {
  test('what the owner did', () => {
    expect(actionText('warn', 0, now, zone)).toMatch(/warning/);
    expect(actionText('mute-chat', now + 3_600_000, now, zone)).toBe(
      'Your chat rests until 15:00.',
    );
    expect(actionText('mute-chat', now - 1, now, zone)).toBe('Your chat was rested for a while.');
    expect(actionText('remove-line', 0, now, zone)).toBe('A line of yours was removed.');
    expect(actionText('stop', 0, now, zone)).toBe('Your account has been stopped.');
  });
});

describe('every word', () => {
  test('never markup, never who reported, never an age', () => {
    const all = Object.values(words)
      .flatMap((v) =>
        typeof v === 'string'
          ? [v]
          : Array.isArray(v)
            ? v.map((x) => (typeof x === 'string' ? x : (x as { text: string }).text))
            : [],
      )
      .join('\n');
    expect(all).not.toMatch(/<[a-z]/i);
    expect(all).not.toMatch(/reported by|who reported you/i);
    expect(all).not.toMatch(/\byears? old\b|\bage\b|\b1[3-7]\b/i);
  });
});
