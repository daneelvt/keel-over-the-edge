// SPDX-License-Identifier: AGPL-3.0-only

// The news's words: a story's slots set by each name's kind, a player's
// own words kept apart, a name opening a sentence with its capital, a
// named sailor's boat before them; an edition's date and its headwords.

import { describe, expect, test } from 'vitest';
import {
  editionDate,
  editionDay,
  headWords,
  type NewsStory,
  storyParts,
  storyText,
  zonePlace,
} from './newswords';

const story = (text: string, names: NewsStory['names']): NewsStory => ({
  id: '01',
  kind: 'record',
  at: 0,
  head: 'OFF THE SKERRIES',
  text,
  names,
  number: 0,
});

describe('a story', () => {
  test('names set by their kinds', () => {
    const text = '{0} passed 8 m from the lip. {1} met {2}, with {3} and {4}.';
    expect(
      storyText(
        story(text, [
          { kind: 'boat', name: 'Gull' },
          { kind: 'boat', type: 'Jolly boat' },
          { kind: 'machine', name: 'Gus' },
          { kind: 'sailor' },
          { kind: 'former' },
        ]),
      ),
    ).toBe(
      'The Gull passed 8 m from the lip. A Jolly boat met Gus ⚙, with a sailor and a former sailor.',
    );
    expect(storyText(story('First sighted by {0}.', [{ kind: 'human', name: 'Mira' }]))).toBe(
      'First sighted by Mira.',
    );
  });
  test("a player's words are a part of their own", () => {
    const parts = storyParts('Charted by {0}.', [{ kind: 'human', name: '{1}', logged: true }]);
    expect(parts).toEqual([
      { words: 'Charted by ' },
      { name: { kind: 'human', name: '{1}', logged: true }, opens: false },
      { words: '.' },
    ]);
  });
});

describe('a named sailor’s boat', () => {
  test('stands before them, its comma left to the words when they open with one', () => {
    const mira = { kind: 'human' as const, name: 'Mira', boat: 'Iron Mary' };
    expect(storyText(story('{0} passed 8 m from the lip.', [mira]))).toBe(
      'The Iron Mary, Mira, passed 8 m from the lip.',
    );
    expect(storyText(story('Spoke {0}, 8 m from the lip.', [mira]))).toBe(
      'Spoke the Iron Mary, Mira, 8 m from the lip.',
    );
    expect(
      storyText(story('First sighted by {0}.', [{ kind: 'machine', name: 'Gus', boat: 'Gull' }])),
    ).toBe('First sighted by the Gull, Gus ⚙.');
  });
});

describe('an edition’s date', () => {
  test('a calendar date, with the place whose clock keeps the days when the reader’s differs', () => {
    expect(editionDate('2026-11-12', 'America/New_York', 'America/New_York')).toBe(
      'Thursday 12 November',
    );
    // Toronto keeps New York's clock: one day, no place said.
    expect(editionDate('2026-11-12', 'America/New_York', 'America/Toronto')).toBe(
      'Thursday 12 November',
    );
    expect(editionDate('2026-11-12', 'America/New_York', 'Pacific/Auckland')).toBe(
      'Thursday 12 November (New York)',
    );
    expect(editionDate('2026-11-12', '', 'Pacific/Auckland')).toBe('Thursday 12 November');
    expect(editionDay('2026-11-11')).toBe('Wednesday 11');
    expect(zonePlace('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
  });
  test('a headword set in small capitals: its first letter a capital', () => {
    expect(headWords('KEYHOLE ROCK')).toBe('Keyhole rock');
    expect(headWords('LA DÉSIRÉE')).toBe('La désirée');
  });
});
