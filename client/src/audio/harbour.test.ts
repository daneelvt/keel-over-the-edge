// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  bellPartials,
  bellStrokes,
  HARBOUR_RECIPES,
  type HarbourInput,
  harbourEvents,
  lappingNow,
  panOf,
  pointLevel,
  strokeTimes,
} from './harbour';

const R = HARBOUR_RECIPES;

const input = (change: Partial<HarbourInput> = {}): HarbourInput => ({
  seconds: 1000,
  hour: 10.5,
  day: true,
  listener: { east: 0, north: 0 },
  look: 0,
  inPort: true,
  nearTown: 50,
  bell: { east: 100, north: 0 },
  yard: { east: -60, north: 0 },
  quay: { east: 0, north: 10 },
  seaHeight: 0.5,
  period: 4,
  ...change,
});

describe('the harbour bell', () => {
  test('strikes the watches: one bell to eight bells, eight at a watch’s end', () => {
    expect(bellStrokes(0.5)).toBe(1);
    expect(bellStrokes(1)).toBe(2);
    expect(bellStrokes(3.5)).toBe(7);
    expect(bellStrokes(4)).toBe(8);
    expect(bellStrokes(0)).toBe(8);
    expect(bellStrokes(12.25)).toBe(8);
    expect(bellStrokes(23.5)).toBe(7);
  });

  test('in pairs, the odd one last', () => {
    const t = strokeTimes(5, R.bell);
    expect(t).toHaveLength(5);
    expect((t[1] ?? 0) - (t[0] ?? 0)).toBeCloseTo(R.bell.stroke, 12);
    expect((t[2] ?? 0) - (t[1] ?? 0)).toBeCloseTo(R.bell.pair, 12);
  });

  test('sounds its partials as a bell is tuned: 0.5, 1, 1.2, 1.5 and 2 of its prime', () => {
    expect(bellPartials(R.bell).map((f) => f / R.bell.prime)).toEqual([0.5, 1, 1.2, 1.5, 2]);
  });

  test('is struck when a half hour of the world’s day begins, and not between', () => {
    const per = 300; // s an hour
    const at = input({ hour: 10.5, seconds: 1000 });
    const struck = harbourEvents(R, at, 999, 1000, per).filter((e) => e.kind === 'bell');
    expect(struck).toHaveLength(bellStrokes(10.5));
    const between = harbourEvents(R, input({ hour: 10.6 }), 999, 1000, per).filter(
      (e) => e.kind === 'bell',
    );
    expect(between).toHaveLength(0);
  });
});

describe('the harbour’s voices', () => {
  test('are heard only in port or near a town', () => {
    const far = input({ inPort: false, nearTown: 1000, hour: 10.5 });
    expect(harbourEvents(R, far, 900, 1000, 300)).toEqual([]);
    expect(lappingNow(R.lapping, far).level).toBe(0);
    expect(harbourEvents(R, input(), 900, 1000, 300).length).toBeGreaterThan(0);
  });

  test('call gulls and knock mallets by day only', () => {
    const night = harbourEvents(R, input({ day: false, hour: 22.1 }), 900, 1000, 300);
    expect(night.filter((e) => e.kind !== 'bell')).toEqual([]);
    const day = harbourEvents(R, input({ hour: 10.1 }), 900, 1000, 300);
    expect(day.some((e) => e.kind === 'gull')).toBe(true);
    expect(day.some((e) => e.kind === 'mallet')).toBe(true);
  });

  test('are the same on every phone at the same world time', () => {
    const a = harbourEvents(R, input(), 900, 1000, 300);
    const b = harbourEvents(R, input(), 900, 1000, 300);
    expect(a).toEqual(b);
  });

  test('are placed: panned by bearing, fainter with distance', () => {
    expect(panOf({ east: 0, north: 0 }, { east: 10, north: 0 }, 0)).toBeCloseTo(1, 12);
    expect(panOf({ east: 0, north: 0 }, { east: -10, north: 0 }, 0)).toBeCloseTo(-1, 12);
    expect(panOf({ east: 0, north: 0 }, { east: 0, north: 10 }, 0)).toBeCloseTo(0, 12);
    // 6 dB each time the distance doubles: half the amplitude.
    expect(pointLevel(80, 20, 1000) / pointLevel(40, 20, 1000)).toBeCloseTo(0.5, 12);
    expect(pointLevel(5, 20, 1000)).toBe(1);
    expect(pointLevel(1200, 20, 1000)).toBe(0);
  });

  test('lap louder in a higher sea, swelling at the waves’ period', () => {
    const calm = lappingNow(R.lapping, input({ seaHeight: 0, seconds: 1 }));
    const rough = lappingNow(R.lapping, input({ seaHeight: 2, seconds: 1 }));
    expect(rough.level).toBeGreaterThan(calm.level);
    const a = lappingNow(R.lapping, input({ seconds: 0 })).level;
    const b = lappingNow(R.lapping, input({ seconds: 4 })).level;
    expect(a).toBeCloseTo(b, 9);
  });
});
