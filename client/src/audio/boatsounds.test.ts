// SPDX-License-Identifier: AGPL-3.0-only

// The boat's own voices are what the server says they are: for every boat
// of internal/lookout/testdata/boatsounds.json the wind, the rigging, the
// flogging cloth, the water on the hull and its hiss, the sea and the rain
// as loud as the server has them, so its words for them are the phone's.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { newTargets, RECIPES, type SoundTargets, soundTargets } from './voices';

/** The levels the file holds, by the targets' names. */
const LEVELS = [
  'windLevel',
  'rigLevel',
  'flogLevel',
  'waterLevel',
  'hissLevel',
  'seaLevel',
  'rainLevel',
  'drumLevel',
] as const satisfies readonly (keyof SoundTargets)[];

interface BoatSoundsFile {
  cases: {
    name: string;
    input: {
      apparentWind: number;
      speed: number;
      throughWater: number;
      seaHeight: number;
      whitecaps: number;
      luffing: number;
      time: number;
      rain: number;
    };
    levels: Record<(typeof LEVELS)[number], number>;
    words: string;
  }[];
}

const file = JSON.parse(
  readFileSync(
    new URL('../../../internal/lookout/testdata/boatsounds.json', import.meta.url),
    'utf8',
  ),
) as BoatSoundsFile;

/** Whether two numbers agree within the last bits the two sides' logarithms differ by. */
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));

describe('the boat’s own voices', () => {
  test('are the server’s, as loud for the same boat', () => {
    expect(file.cases.length).toBeGreaterThan(10);
    for (const c of file.cases) {
      // Far from the lip: the falls are not the boat's.
      const t = soundTargets(
        RECIPES,
        { ...c.input, lip: Number.POSITIVE_INFINITY, lipPan: 0, falling: false },
        newTargets(),
      );
      for (const k of LEVELS) {
        expect(
          near(t[k], c.levels[k]),
          `${c.name}: ${k} ${t[k]}, the server's ${c.levels[k]}`,
        ).toBe(true);
      }
    }
  });
});
