// SPDX-License-Identifier: AGPL-3.0-only

// The races' words are a newcomer's: no racing jargon reaches a player.
// Every file that holds what a player reads of races, its comments taken
// out, is read for the words a newcomer would have to decode: the shape's
// old name, the start's signals' names, and the racers' shorthand for
// retired, did not start and did not finish. The Articles' own teaching
// lines ("Windward keeps clear of leeward") are the log's words and stay.
// The one literal let through is the buoy course's shape as the server
// names it, 'windward-leeward': a key, never shown.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/** The files of races' words, and the parts that put them on the screen. */
const FILES = [
  'racewords.ts',
  'racelinewords.ts',
  'racewatchwords.ts',
  'racecourse.ts',
  'racenotices.ts',
  'racerow.tsx',
  'races.tsx',
  'raceline.tsx',
  'racebar.tsx',
  'board.tsx',
  'menu.tsx',
  'replayparts.tsx',
  'certtasks.ts',
];

/** The words that may not appear, as patterns. */
const BANNED: [string, RegExp][] = [
  ['windward–leeward', /windward\s*[-–—‐]\s*leeward/i],
  ['warning signal', /warning signal/i],
  ['preparatory', /preparatory/i],
  ['RET', /\bRET\b/],
  ['DNS', /\bDNS\b/],
  ['DNF', /\bDNF\b/],
];

/** A source file without its comments, and without the shape's key. */
function words(file: string): string {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  return (
    src
      // Block comments, then line comments not inside a URL.
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
      .replace(/(['"`])windward-leeward\1/g, "''")
  );
}

describe('the races’ words are plain', () => {
  for (const file of FILES) {
    test(file, () => {
      const text = words(file);
      for (const [name, re] of BANNED) {
        expect(re.test(text), `${file} says “${name}”`).toBe(false);
      }
    });
  }

  test('the shapes are said plainly', async () => {
    const { shapeText } = await import('./racecourse');
    const said = (['triangle', 'windward-leeward', 'reach', 'dash'] as const).flatMap((shape) =>
      [false, true].map((long) => shapeText({ id: '', kind: 'buoy', shape, long, name: '' })),
    );
    for (const w of said) {
      for (const [name, re] of BANNED) {
        expect(re.test(w), `${w} says “${name}”`).toBe(false);
      }
    }
    expect(said).toContain('Upwind and back, short');
  });
});
