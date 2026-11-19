// SPDX-License-Identifier: AGPL-3.0-only

// The noises: the same on every page, as loud as each other, coloured as
// named, and looped without a seam.

import { describe, expect, test } from 'vitest';
import { shareAbove } from './loudness';
import { noiseSamples } from './noise';

const RATE = 16000;

const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe('the noises', () => {
  test('are the same every time, and as loud as each other', () => {
    for (const c of ['white', 'pink', 'brown'] as const) {
      const a = noiseSamples(c, 2, RATE);
      expect(noiseSamples(c, 2, RATE)).toEqual(a);
      expect(rms(a)).toBeCloseTo(0.7 / Math.sqrt(3), 3);
    }
  });

  test('are coloured: pink and brown have ever less of their energy high', () => {
    const above = (c: 'white' | 'pink' | 'brown'): number =>
      shareAbove([noiseSamples(c, 4, RATE)], RATE, 1000);
    // White's share above 1 kHz is the band's share of the spectrum.
    expect(above('white')).toBeCloseTo(7 / 8, 1);
    expect(above('pink')).toBeLessThan(0.5);
    expect(above('brown')).toBeLessThan(0.05);
  });

  test('loop without a seam: the end runs into the start as from one sample to the next', () => {
    for (const c of ['pink', 'brown'] as const) {
      const x = noiseSamples(c, 2, RATE);
      let step = 0;
      for (let i = 1; i < x.length; i++) {
        step += ((x[i] ?? 0) - (x[i - 1] ?? 0)) ** 2;
      }
      step = Math.sqrt(step / (x.length - 1));
      expect(Math.abs((x[0] ?? 0) - (x[x.length - 1] ?? 0))).toBeLessThan(4 * step);
    }
  });
});
