// SPDX-License-Identifier: AGPL-3.0-only

// Shipmates' words: what came of an offer, ending's one question, why a
// message was not sent, the notices, where a shipmate is; names kept
// apart as player text; and never markup, nor anything of an age.

import { describe, expect, test } from 'vitest';
import { plain } from './deckwords';
import * as words from './shipmatewords';
import {
  emptyThreadWords,
  endWords,
  messageRefusedWords,
  offerWords,
  presenceText,
  wouldLikeWords,
  wroteWords,
} from './shipmatewords';

describe('an offer', () => {
  test('each answer in plain words, the name as player text', () => {
    expect(offerWords('offered', 'Iron Mary')).toEqual([
      'Offered: if ',
      { player: 'Iron Mary' },
      ' accepts, you’ll be shipmates',
    ]);
    expect(plain(offerWords('made', 'Iron Mary'))).toBe('You and Iron Mary are shipmates');
    expect(plain(offerWords('not-yet', 'Iron Mary'))).toBe(
      'You can offer once you’ve sailed together a while',
    );
    expect(plain(offerWords('full', 'Iron Mary'))).toBe(
      'You have as many shipmates as you can keep',
    );
    expect(plain(offerWords('offers', 'Iron Mary'))).toBe(
      'You have offers waiting; try again later',
    );
    expect(plain(offerWords('already', 'Iron Mary'))).toBe('Iron Mary is already your shipmate');
    expect(plain(offerWords('gone', 'Iron Mary'))).toBe('That offer has lapsed');
    expect(plain(offerWords('unavailable', 'Iron Mary'))).toMatch(/Try again/);
  });

  test('ending asks once, by name', () => {
    expect(endWords('Iron Mary')).toEqual([
      'No longer shipmates with ',
      { player: 'Iron Mary' },
      '?',
    ]);
  });
});

describe('a thread', () => {
  test('why a message was not sent, the shipmate named', () => {
    expect(plain(messageRefusedWords('away', 'Iron Mary'))).toBe(
      'Iron Mary isn’t in the game; messages aren’t kept for later',
    );
    expect(plain(messageRefusedWords('resting', 'Iron Mary'))).toBe(
      'Messages between shipmates are resting',
    );
    expect(plain(messageRefusedWords('contact', 'Iron Mary'))).toBe(
      'Links and contact details can’t be sent',
    );
    for (const why of ['long', 'fast', 'silent', 'nobody'] as const) {
      expect(plain(messageRefusedWords(why, 'Iron Mary'))).not.toBe('');
    }
    expect(plain(emptyThreadWords('Iron Mary'))).toMatch(/only while they’re in the game/);
  });

  test('where a shipmate is: in the game, at sea, or nothing', () => {
    expect(presenceText('game')).toBe('in the game');
    expect(presenceText('sea')).toBe('at sea');
    expect(presenceText('')).toBe('');
  });

  test('the notices', () => {
    expect(wroteWords('Iron Mary')).toEqual([{ player: 'Iron Mary' }, ' wrote']);
    expect(plain(wouldLikeWords('Iron Mary'))).toBe('Iron Mary would like to be shipmates');
  });
});

describe('every word', () => {
  test('never markup, never an age', () => {
    const name = 'Iron Mary';
    const all = [
      ...Object.values(words).flatMap((v: unknown) => (typeof v === 'string' ? [v] : [])),
      ...['offered', 'made', 'not-yet', 'full', 'offers', 'already', 'gone', 'x'].map((r) =>
        plain(offerWords(r, name)),
      ),
      ...(['away', 'resting', 'contact', 'long', 'fast', 'silent', 'nobody'] as const).map((w) =>
        plain(messageRefusedWords(w, name)),
      ),
      plain(endWords(name)),
      plain(emptyThreadWords(name)),
    ].join('\n');
    expect(all).not.toMatch(/<[a-z]/i);
    expect(all).not.toMatch(/\byears?\b|\bage\b|\badult|\bteen|\bchild|\b1[3-8]\b/i);
  });
});
