// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type { SeaPoint } from './api';
import { areaCentre, foamOf, foamOver, SEA_FULL, seaWords } from './sea';

describe('the sea on the map', () => {
  test('the areas run row by row from the south-west, the middle one at the centre', () => {
    const page = { side: 37, size: 463 };
    expect(areaCentre(page, 0)).toEqual([-18 * 463, -18 * 463]);
    expect(areaCentre(page, 36)).toEqual([18 * 463, -18 * 463]);
    expect(areaCentre(page, 37)).toEqual([-18 * 463, -17 * 463]);
    expect(areaCentre(page, 18 * 37 + 18)).toEqual([0, 0]);
    expect(areaCentre(page, 37 * 37 - 1)).toEqual([18 * 463, 18 * 463]);
  });

  test('the foam grows with the waves, to its palest at full', () => {
    expect(foamOf(0)).toBe(0);
    expect(foamOf(-1)).toBe(0);
    expect(foamOf(SEA_FULL / 2)).toBeCloseTo(foamOf(SEA_FULL) / 2, 9);
    expect(foamOf(3 * SEA_FULL)).toBe(foamOf(SEA_FULL));
    expect(foamOver('#14365e', 0)).toBe('#14365e');
    expect(foamOver('#000000', SEA_FULL)).toMatch(/^#([0-9a-f]{2})\1\1$/);
  });
});

describe('the sea at a point in words', () => {
  const point: SeaPoint = {
    east: 100,
    north: -200,
    windHs: 0.42,
    windPeriod: 2.9,
    swellHs: 0.8,
    swellPeriod: 9.5,
    swellFrom: 45,
    current: 1.12,
    lee: 0.45,
    hs: 0.41,
  };

  test('its partitions and factors', () => {
    expect(seaWords(point)).toBe(
      'wind sea 0.42 m, 2.9 s; swell 0.80 m, 9.5 s from 045°; current ×1.12, lee ×0.45; Hs 0.41 m',
    );
  });

  test('no swell', () => {
    expect(seaWords({ ...point, swellHs: 0, swellPeriod: 0, swellFrom: 0 })).toContain(
      '; no swell;',
    );
  });
});
