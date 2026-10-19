// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { breaksAt, closedIn, endStage, MIST_RANGE, NEAR_SEA, risen } from './taken';

const look = { sound: 60, mist: 60, tiles: 20, rise: 4 };

describe('the world’s end, staged', () => {
  test('nothing before a minute out', () => {
    expect(endStage(look, 61)).toEqual({
      sound: 0,
      mist: 0,
      cut: Number.POSITIVE_INFINITY,
      veil: 0,
    });
    expect(endStage(look, Number.POSITIVE_INFINITY).cut).toBe(Number.POSITIVE_INFINITY);
  });
  test('the falls heard and the mist closing in from a minute; the sea whole until twenty seconds', () => {
    const s = endStage(look, 50);
    expect(s.sound).toBeGreaterThan(0);
    expect(s.mist).toBeGreaterThan(0);
    expect(s.cut).toBe(Number.POSITIVE_INFINITY);
    expect(s.veil).toBe(0);
  });
  test('the near sea breaking away ring by ring, the far edge first', () => {
    expect(endStage(look, 15).cut).toBeCloseTo((NEAR_SEA * 15) / 20, 9);
    expect(endStage(look, 5).cut).toBeCloseTo((NEAR_SEA * 5) / 20, 9);
    expect(breaksAt(look, NEAR_SEA)).toBe(20);
    expect(breaksAt(look, 0)).toBe(0);
  });
  test('at the end: all of it gone, the screen the mist', () => {
    const s = endStage(look, 0);
    expect(s).toEqual({ sound: 1, mist: 1, cut: 0, veil: 1 });
    expect(endStage(look, -2).veil).toBe(1);
  });
  test('the same stage for the same time left: every page draws the same', () => {
    expect(endStage(look, 12.5)).toEqual(endStage(look, 12.5));
  });
  test('the mist closes the visual range to the lip’s, and the new world rises out of it', () => {
    expect(closedIn(20_000, 0)).toBe(20_000);
    expect(closedIn(20_000, 1)).toBeCloseTo(MIST_RANGE, 6);
    expect(closedIn(20_000, 0.5)).toBeCloseTo(Math.sqrt(20_000 * MIST_RANGE), 6);
    expect(risen(look, 0)).toBe(0);
    expect(risen(look, 4)).toBe(1);
  });
});
