// SPDX-License-Identifier: AGPL-3.0-only

// The wind readout is the server's: for every run of
// internal/lookout/testdata/wind.json the same mean over three seconds and
// the same words, and every wind and heading written alike.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { beaufortForce, headingText, knots, windText } from './format';
import { WindWindow } from './model';

interface WindFile {
  sequences: {
    name: string;
    start: number;
    every: number;
    count: number;
    back: number;
    backBy: number;
    speeds: number[];
    froms: number[];
    mean: number;
    at: number[];
    shown: { speed: number; from: number; text: string }[];
  }[];
  words: {
    speed: number;
    from: number;
    mean: number;
    text: string;
    force: number;
    knots: string;
  }[];
  headings: { heading: number; text: string }[];
}

const file = JSON.parse(
  readFileSync(new URL('../../../internal/lookout/testdata/wind.json', import.meta.url), 'utf8'),
) as WindFile;

/** The difference of two directions, rad, either way round. */
const turn = (a: number, b: number): number =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe('the wind readout', () => {
  test('averages the wind over three seconds as the server does', () => {
    expect(file.sequences.length).toBeGreaterThan(5);
    for (const s of file.sequences) {
      const w = new WindWindow();
      let k = 0;
      for (let i = 0; i < s.count; i++) {
        const now = s.start + i * s.every - (s.back > 0 && i >= s.back ? s.backBy : 0);
        w.add(now, s.speeds[i % s.speeds.length] ?? 0, s.froms[i % s.froms.length] ?? 0);
        if (s.at[k] === i) {
          const want = s.shown[k];
          const label = `${s.name} at ${i}`;
          expect(Math.abs(w.speed - (want?.speed ?? Number.NaN)), label).toBeLessThan(1e-12);
          expect(turn(w.from, want?.from ?? Number.NaN), label).toBeLessThan(1e-12);
          expect(windText(w.speed, w.from, s.mean), label).toBe(want?.text);
          k++;
        }
      }
      expect(k, s.name).toBe(s.shown.length);
    }
  });

  test('writes every wind and heading in the server’s words', () => {
    for (const c of file.words) {
      expect(windText(c.speed, c.from, c.mean), `${c.speed} from ${c.from}`).toBe(c.text);
      expect(beaufortForce(c.mean)).toBe(c.force);
      expect(knots(c.speed)).toBe(c.knots);
    }
    for (const c of file.headings) {
      expect(headingText(c.heading), String(c.heading)).toBe(c.text);
    }
  });
});
