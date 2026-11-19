// SPDX-License-Identifier: AGPL-3.0-only

// The bed's layers: their shares crossfade at equal power as the physics
// moves between them, a recording takes over at equal power, and the
// synthesis plays what the recordings leave of its family, so the family's
// power is the same throughout.

import { describe, expect, test } from 'vitest';
import { shares, synthShare, takeOf } from './layers';

const power = (s: readonly number[]): number => s.reduce((a, v) => a + v * v, 0);

describe('the layers', () => {
  const at = [3, 7, 12, 18];

  test('each is all of its family at its centre, and the first and last hold beyond', () => {
    expect(shares(0, at)).toEqual([1, 0, 0, 0]);
    expect(shares(3, at)).toEqual([1, 0, 0, 0]);
    expect(shares(7, at)[1]).toBeCloseTo(1, 12);
    expect(shares(12, at)[2]).toBeCloseTo(1, 12);
    expect(shares(30, at)).toEqual([0, 0, 0, 1]);
  });

  test('between two, they crossfade at equal power, and only those two play', () => {
    for (let x = 0; x <= 25; x += 0.25) {
      const s = shares(x, at);
      expect(power(s), String(x)).toBeCloseTo(1, 12);
      expect(s.filter((v) => v > 1e-9).length).toBeLessThanOrEqual(2);
    }
    const mid = shares(9.5, at);
    expect(mid[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(mid[2]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  test('a recording takes over at equal power over its crossfade', () => {
    expect(takeOf(-1, 3)).toBe(0);
    expect(takeOf(0, 3)).toBe(0);
    expect(takeOf(1.5, 3)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(takeOf(3, 3)).toBe(1);
    expect(takeOf(100, 3)).toBe(1);
    for (let t = 0; t <= 3; t += 0.1) {
      const take = takeOf(t, 3);
      // The synthesis of a family of one layer, as it is taken over.
      expect(take ** 2 + synthShare([1], [take]) ** 2).toBeCloseTo(1, 12);
    }
  });

  test('the synthesis plays the share the loaded layers leave, so the family is as loud', () => {
    const s = shares(9.5, at);
    // Nothing loaded: the synthesis is all of it.
    expect(synthShare(s, [0, 0, 0, 0])).toBe(1);
    // The moderate loaded and taken over; the strong not: the synthesis
    // plays the strong's share.
    const synth = synthShare(s, [0, 1, 0, 0]);
    expect(synth).toBeCloseTo(s[2] ?? 0, 12);
    expect(synth ** 2 + (s[1] ?? 0) ** 2).toBeCloseTo(1, 12);
    // Both: none of it.
    expect(synthShare(s, [1, 1, 1, 1])).toBeCloseTo(0, 6);
  });
});
