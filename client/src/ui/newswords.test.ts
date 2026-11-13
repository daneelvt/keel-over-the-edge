// SPDX-License-Identifier: AGPL-3.0-only

// The news's words: a story's slots set by each name's kind, a player's
// own words kept apart, a name opening a sentence with its capital.

import { describe, expect, test } from 'vitest';
import { type NewsStory, storyParts, storyText } from './newswords';

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
    ).toBe('The Gull passed 8 m from the lip. A Jolly boat met Gus ⚙, with a sailor and a former sailor.');
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
