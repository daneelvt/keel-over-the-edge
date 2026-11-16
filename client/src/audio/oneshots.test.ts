// SPDX-License-Identifier: AGPL-3.0-only

// The sounds played once: the take a seed picks, never the last again and
// the same for two pages that heard the same; the variation within its
// bounds; and the voice limits letting the quietest go.

import { describe, expect, test } from 'vitest';
import { loudnessAt, type Playing, pickTake, Voices, vary } from './oneshots';

describe('the takes', () => {
  test('never the same take twice in a row, however the seeds fall', () => {
    for (const n of [2, 3, 4, 6]) {
      let last = -1;
      const seen = new Set<number>();
      for (let seed = 0; seed < 2000; seed++) {
        const k = pickTake(seed % 7 === 0 ? 5 : seed, n, last);
        expect(k).not.toBe(last);
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThan(n);
        seen.add(k);
        last = k;
      }
      // Every take is heard.
      expect(seen.size).toBe(n);
    }
    expect(pickTake(12, 1, 0)).toBe(0);
  });

  test('the seed picks the take: two pages hear the same, whatever each heard before', () => {
    let a = -1;
    let b = 2;
    let same = 0;
    for (let seed = 100; seed < 400; seed++) {
      const ka = pickTake(seed, 4, a);
      const kb = pickTake(seed, 4, b);
      if (ka === kb) {
        same++;
      }
      a = ka;
      b = kb;
    }
    // Two pages that came in at different times agree but where one's
    // last take was the seed's own.
    expect(same / 300).toBeGreaterThan(0.6);
    // Two pages that heard the same agree always.
    let c = -1;
    let d = -1;
    for (let seed = 0; seed < 300; seed++) {
      c = pickTake(seed * 17, 5, c);
      d = pickTake(seed * 17, 5, d);
      expect(c).toBe(d);
    }
  });

  test('varied within a semitone or two and 2 dB, the same for a seed, never for a signal', () => {
    let low = 1;
    let high = 1;
    for (let seed = 0; seed < 500; seed++) {
      const v = vary(seed, 2, 2);
      low = Math.min(low, v.rate);
      high = Math.max(high, v.rate);
      expect(Math.abs(20 * Math.log10(v.gain))).toBeLessThanOrEqual(2 + 1e-9);
      expect(vary(seed, 2, 2)).toEqual(v);
    }
    expect(12 * Math.log2(high)).toBeGreaterThan(1.8);
    expect(12 * Math.log2(low)).toBeLessThan(-1.8);
    expect(12 * Math.log2(high)).toBeLessThanOrEqual(2 + 1e-9);
    expect(vary(42, 0, 0)).toEqual({ rate: 1, gain: 1 });
  });
});

describe('the voice limits', () => {
  /** A sound playing from 0 for 2 s at level, noting when it is let go. */
  const sound = (family: string | null, level: number, gone: number[]): Playing => ({
    family,
    level,
    start: 0,
    end: 2,
    letGo: () => gone.push(level),
  });

  test('a family full lets its quietest go, or refuses one quieter still', () => {
    const v = new Voices({ most: 24, families: { thunder: 2 } });
    const gone: number[] = [];
    expect(v.admit(sound('thunder', 0.5, gone), 0)).toBe(true);
    expect(v.admit(sound('thunder', 0.3, gone), 0)).toBe(true);
    expect(v.admit(sound('thunder', 0.8, gone), 0)).toBe(true);
    expect(gone).toEqual([0.3]);
    expect(v.admit(sound('thunder', 0.1, gone), 0)).toBe(false);
    expect(v.count(0, 'thunder')).toBe(2);
    // Others are not held by it.
    expect(v.admit(sound('gulls', 0.01, gone), 0)).toBe(true);
    expect(v.letGo).toBe(2);
  });

  test('at most so many at once in all, and the ended make room', () => {
    const v = new Voices({ most: 3, families: {} });
    const gone: number[] = [];
    for (const l of [0.4, 0.2, 0.6]) {
      expect(v.admit(sound(null, l, gone), 0)).toBe(true);
    }
    expect(v.admit(sound(null, 0.5, gone), 0)).toBe(true);
    expect(gone).toEqual([0.2]);
    expect(v.count(0)).toBe(3);
    expect(v.count(2)).toBe(0);
    expect(v.admit(sound(null, 0.05, gone), 2)).toBe(true);
  });

  test('a sound fades from its level to nothing by its end', () => {
    const p = { level: 0.8, start: 1, end: 3 };
    expect(loudnessAt(p, 0)).toBe(0.8);
    expect(loudnessAt(p, 2)).toBeCloseTo(0.4, 9);
    expect(loudnessAt(p, 3)).toBe(0);
  });
});
