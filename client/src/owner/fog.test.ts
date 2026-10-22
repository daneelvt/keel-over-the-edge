// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type { CloudGrid, LightNow, SkyPoint } from './api';
import {
  FLASH_FOR,
  flashAge,
  flashAlpha,
  lightWords,
  MET_WORDS,
  outlinesUnder,
  visibilityRanges,
  visibilityWordOf,
  visibilityWords,
} from './fog';

describe('the visibility', () => {
  test("its words are the Met Office's on the game's stage", () => {
    expect(visibilityWordOf(0, MET_WORDS)).toBe(3);
    expect(visibilityWordOf(399, MET_WORDS)).toBe(3);
    expect(visibilityWordOf(400, MET_WORDS)).toBe(2);
    expect(visibilityWordOf(1851, MET_WORDS)).toBe(2);
    expect(visibilityWordOf(1852, MET_WORDS)).toBe(1);
    expect(visibilityWordOf(3703, MET_WORDS)).toBe(1);
    expect(visibilityWordOf(3704, MET_WORDS)).toBe(0);
    expect(visibilityWordOf(99999, MET_WORDS)).toBe(0);
    expect(visibilityRanges(MET_WORDS)).toEqual(['under 400', '400 to 1852', '1852 to 3704']);
  });
});

/** A grid of side points a side, 100 m apart about the centre, every value far unless given. */
function grid(side: number, values: Record<number, number>): CloudGrid {
  const half = ((side - 1) / 2) * 100;
  return {
    west: -half,
    north: half,
    step: 100,
    side,
    values: Array.from({ length: side * side }, (_, i) => values[i] ?? 5000),
  };
}

/** Every segment's ends, each counted: a closed outline has each end twice. */
function ends(segs: [number, number, number, number][]): Map<string, number> {
  const m = new Map<string, number>();
  for (const [e0, n0, e1, n1] of segs) {
    for (const k of [`${e0.toFixed(3)},${n0.toFixed(3)}`, `${e1.toFixed(3)},${n1.toFixed(3)}`]) {
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return m;
}

describe('the very poor areas outlined', () => {
  test('a point of fog is closed about by the crossings of its threshold', () => {
    const segs = outlinesUnder(grid(5, { 12: 100 }), 400, 10_000);
    expect(segs).toHaveLength(4);
    for (const n of ends(segs).values()) {
      expect(n).toBe(2);
    }
    // The threshold crosses (400 − 100) / (5000 − 100) of the way out.
    const out = (100 * 300) / 4900;
    for (const [e0, n0, e1, n1] of segs) {
      expect(Math.hypot(e0, n0)).toBeCloseTo(out, 6);
      expect(Math.hypot(e1, n1)).toBeCloseTo(out, 6);
    }
  });

  test('a band of fog across the grid is outlined along both its sides', () => {
    // The middle row very poor: outlined 50 m north and south of it, the
    // band's ends open at the grid's edge.
    const segs = outlinesUnder(grid(5, { 10: 0, 11: 0, 12: 0, 13: 0, 14: 0 }), 2500, 10_000);
    expect(segs).toHaveLength(8);
    for (const [, n0, , n1] of segs) {
      expect(Math.abs(n0)).toBeCloseTo(50, 6);
      expect(n1).toBeCloseTo(n0, 6);
    }
  });

  test('the points beyond the lip are not fog, and no fog outlines nothing', () => {
    const all = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [i, 100]));
    const segs = outlinesUnder(grid(5, all), 400, 50);
    expect(segs).toHaveLength(4);
    for (const [e0, n0] of segs) {
      expect(Math.hypot(e0, n0)).toBeCloseTo(50, 6);
    }
    expect(outlinesUnder(grid(5, {}), 400, 10_000)).toEqual([]);
  });
});

describe('the lightning', () => {
  test('a flash fades with its age, never wholly within the minute', () => {
    const f = { slot: 16, tick: 3000, east: 0, north: 0, sea: true, strokes: 3 };
    expect(flashAge(f, 3000 + 30 * 20)).toBe(20);
    expect(flashAlpha(0)).toBe(1);
    expect(flashAlpha(FLASH_FOR / 2)).toBeCloseTo(0.575, 9);
    expect(flashAlpha(FLASH_FOR)).toBeCloseTo(0.15, 9);
    expect(flashAlpha(2 * FLASH_FOR)).toBeCloseTo(0.15, 9);
    expect(flashAlpha(-1)).toBe(1);
  });
});

describe('the lights and the point in words', () => {
  const l: LightNow = {
    number: 3,
    east: 0,
    north: 0,
    signal: 'Dia(1) 20s',
    sounding: true,
    lit: true,
    byDay: true,
  };

  test('a light sounding its fog signal, lit by day', () => {
    expect(lightWords(l)).toBe('sounding Dia(1) 20s, lit by day');
    expect(lightWords({ ...l, sounding: false })).toBe('lit by day');
    expect(lightWords({ ...l, sounding: false, lit: true, byDay: false })).toBe('');
  });

  const sky: SkyPoint = {
    rain: 0,
    rainWord: 'none',
    sheets: { cirrus: 0, middle: 0, low: 0 },
    cloud: null,
    visibility: 119,
    visibilityWord: 'very poor',
    air: { clear: 0.02, fog: 0.98, rain: 0, mist: 0 },
  };

  test('the visibility at a point, its word and what makes it, the most first', () => {
    expect(visibilityWords(sky)).toBe('119 m, very poor: fog 98%, clear air 2%');
    expect(
      visibilityWords({
        ...sky,
        visibility: 2400,
        visibilityWord: 'moderate',
        air: { clear: 0.3, fog: 0, rain: 0.6, mist: 0.1 },
      }),
    ).toBe('2400 m, moderate: rain 60%, clear air 30%, mist 10%');
    expect(
      visibilityWords({
        ...sky,
        visibility: 99999,
        visibilityWord: 'good',
        air: { clear: 0, fog: 0, rain: 0, mist: 0 },
      }),
    ).toBe('unlimited, good');
  });
});
