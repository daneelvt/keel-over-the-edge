// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type { HeapedCloud, SkyPoint } from './api';
import {
  gridPoint,
  outlineOf,
  rainRanges,
  rainWordOf,
  SHEET_ALPHA,
  shadeOver,
  sheetShade,
  skyWords,
  WMO_WORDS,
} from './clouds';

describe('the clouds on the map', () => {
  test('the grids run row by row from the north-west', () => {
    const g = { west: -9000, north: 9000, step: 500, side: 37 };
    expect(gridPoint(g, 0)).toEqual([-9000, 9000]);
    expect(gridPoint(g, 36)).toEqual([9000, 9000]);
    expect(gridPoint(g, 37)).toEqual([-9000, 8500]);
    expect(gridPoint(g, 18 * 37 + 18)).toEqual([0, 0]);
    expect(gridPoint(g, 37 * 37 - 1)).toEqual([9000, -9000]);
  });

  test("a heaped cloud's outline reaches from behind its centre to ahead of it", () => {
    const c: HeapedCloud = {
      form: 'cumulonimbus',
      slot: 16,
      east: 1000,
      north: 0,
      heading: 90,
      size: 800,
      cloud: 1,
      base: 350,
      top: 2500,
      behind: 300,
      ahead: 800,
      deck: 400,
      deckTop: 600,
      rain: 70,
      rainReach: 700,
    };
    const o = outlineOf(c);
    expect(o.radius).toBe(550);
    // Heading east, it reaches 300 m west of its centre and 800 m east.
    expect(o.east - o.radius).toBeCloseTo(700, 9);
    expect(o.east + o.radius).toBeCloseTo(1800, 9);
    expect(o.north).toBeCloseTo(0, 9);
  });

  test('the sheets laid one over another, the low cloud darkest', () => {
    expect(sheetShade(0, 0, 0)[3]).toBe(0);
    expect(sheetShade(1, 0, 0)[3]).toBeCloseTo(SHEET_ALPHA.cirrus, 9);
    expect(sheetShade(0, 0, 1)[3]).toBeCloseTo(SHEET_ALPHA.low, 9);
    const all = sheetShade(1, 1, 1);
    expect(all[3]).toBeGreaterThan(SHEET_ALPHA.low);
    expect(all[3]).toBeLessThan(1);
    const sea = '#14365e';
    const lum = (hex: string): number => Number.parseInt(hex.slice(1, 3), 16);
    expect(shadeOver(sea, sheetShade(0, 0, 0))).toBe(sea);
    // Over the dark sea the cirrus is faint and the low cloud a dark grey.
    expect(lum(shadeOver(sea, sheetShade(1, 0, 0)))).toBeGreaterThan(lum(sea));
    expect(shadeOver(sea, sheetShade(0, 0, 1))).not.toBe(sea);
  });
});

describe('the rain', () => {
  test("its words are WMO's", () => {
    expect(rainWordOf(0, WMO_WORDS)).toBe(0);
    expect(rainWordOf(0.04, WMO_WORDS)).toBe(0);
    expect(rainWordOf(0.1, WMO_WORDS)).toBe(1);
    expect(rainWordOf(2.4, WMO_WORDS)).toBe(1);
    expect(rainWordOf(2.5, WMO_WORDS)).toBe(2);
    expect(rainWordOf(9.9, WMO_WORDS)).toBe(2);
    expect(rainWordOf(10, WMO_WORDS)).toBe(3);
    expect(rainWordOf(50, WMO_WORDS)).toBe(4);
    expect(rainWordOf(Number.NaN, WMO_WORDS)).toBe(0);
    expect(rainRanges(WMO_WORDS)).toEqual(['under 2.5', '2.5 to 10', '10 to 50', '50 and over']);
  });
});

describe('the sky at a point in words', () => {
  const sky: SkyPoint = {
    rain: 12.3,
    rainWord: 'heavy',
    sheets: { cirrus: 0.4, middle: 0.125, low: 0 },
    cloud: { form: 'cumulonimbus', slot: 16, top: 2500 },
  };

  test('its rain, its sheets and the cloud over it', () => {
    expect(skyWords(sky)).toBe(
      'rain 12.3 mm/h, heavy; cirrus 40%, middle 13%, low 0%; under a cumulonimbus, its top 2500 m',
    );
  });

  test('no rain and no heaped cloud', () => {
    expect(skyWords({ ...sky, rain: 0, rainWord: 'none', cloud: null })).toBe(
      'no rain; cirrus 40%, middle 13%, low 0%; no heaped cloud overhead',
    );
  });
});
