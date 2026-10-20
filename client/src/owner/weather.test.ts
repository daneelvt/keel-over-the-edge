// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type { Front } from './api';
import { fromNow, frontLine, regimeColour, whereFrom } from './weather';

/** Ticks a second. */
const TPS = 30;

describe('the weather in words', () => {
  test('a span from now, ahead or behind', () => {
    expect(fromNow(20 * TPS, TPS)).toBe('now');
    expect(fromNow(-59 * TPS, TPS)).toBe('now');
    expect(fromNow(12 * 60 * TPS, TPS)).toBe('in 12 min');
    expect(fromNow(-12 * 60 * TPS, TPS)).toBe('12 min ago');
    expect(fromNow(65 * 60 * TPS, TPS)).toBe('in 1 h 05 min');
    expect(fromNow((3 * 24 + 5) * 3600 * TPS, TPS)).toBe('in 3 d 5 h');
  });

  test('where a point is from the centre', () => {
    expect(whereFrom(0, 20)).toBe('at the centre');
    expect(whereFrom(0, 3200)).toBe('3.2 km at 000°');
    expect(whereFrom(1000, 1000)).toBe('1.4 km at 045°');
    expect(whereFrom(-2000, 0)).toBe('2.0 km at 270°');
  });

  test('each regime its colour, any number of them', () => {
    expect(regimeColour(0)).not.toBe(regimeColour(1));
    expect(regimeColour(7)).toMatch(/^#/);
  });
});

describe("a front's line", () => {
  const front = (toward: number, line: number): Front => ({
    toward,
    line,
    knots: 10,
    depth: 3,
    enters: 0,
    leaves: 0,
    portRoyal: 0,
  });

  test('lies square to the way it moves, line metres along it, its ends on the lip', () => {
    // Moving east, 3 km past the centre: a line north and south through 3 km east.
    const ends = frontLine(front(90, 3000), 5000);
    expect(ends).not.toBeNull();
    for (const [e, n] of ends ?? []) {
      expect(e).toBeCloseTo(3000, 6);
      expect(Math.abs(n)).toBeCloseTo(4000, 6);
      expect(Math.hypot(e, n)).toBeCloseTo(5000, 6);
    }
    // Moving north-west, short of the centre: south-east of it.
    for (const [e, n] of frontLine(front(315, -1000), 5000) ?? []) {
      expect(e * Math.sin((315 * Math.PI) / 180) + n * Math.cos((315 * Math.PI) / 180)).toBeCloseTo(
        -1000,
        6,
      );
    }
  });

  test('is gone beyond the lip', () => {
    expect(frontLine(front(0, 5000), 5000)).toBeNull();
    expect(frontLine(front(0, -6000), 5000)).toBeNull();
  });
});
