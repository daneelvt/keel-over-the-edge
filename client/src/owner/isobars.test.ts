// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type { PressureGrid } from './api';
import { centres, gridPoint, isobars } from './isobars';

/** A grid of side points step metres apart, the pressure of each point by where it is. */
function grid(
  side: number,
  step: number,
  hPa: (east: number, north: number) => number | null,
): PressureGrid {
  const g: PressureGrid = { step, side, values: [] };
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const [e, n] = gridPoint(g, i, j);
      g.values.push(hPa(e, n));
    }
  }
  return g;
}

describe('the isobars', () => {
  test('the grid runs from the north-west, its middle point at the centre', () => {
    const g = grid(5, 100, () => 1000);
    expect(gridPoint(g, 0, 0)).toEqual([-200, 200]);
    expect(gridPoint(g, 2, 2)).toEqual([0, 0]);
    expect(gridPoint(g, 4, 1)).toEqual([200, 100]);
  });

  test('a level field slopes in straight lines, every 2 hPa, and has no high or low', () => {
    // Rising 1 hPa a step eastward: each level's line straight, where it is.
    const g = grid(11, 100, (e) => 1010 + e / 100);
    const bars = isobars(g);
    expect(bars.map((b) => b.hPa)).toEqual([1006, 1008, 1010, 1012, 1014]);
    for (const b of bars) {
      expect(b.lines).toHaveLength(1);
      const line = b.lines[0] ?? [];
      expect(line).toHaveLength(11);
      for (const [e] of line) {
        expect(e).toBeCloseTo((b.hPa - 1010) * 100, 9);
      }
    }
    expect(centres(g)).toEqual([]);
  });

  test('a low is ringed by closed lines, and marked at its middle', () => {
    // Rising 1 hPa a step from 1000 at the centre.
    const step = 463;
    const g = grid(21, step, (e, n) => 1000 + Math.hypot(e, n) / step);
    const bars = isobars(g);
    const ring = bars.find((b) => b.hPa === 1004);
    expect(ring?.lines).toHaveLength(1);
    const line = ring?.lines[0] ?? [];
    expect(line.length).toBeGreaterThan(8);
    expect(line[0]).toEqual(line[line.length - 1]);
    for (const [e, n] of line) {
      expect(Math.abs(Math.hypot(e, n) - 4 * step)).toBeLessThan(0.15 * step);
    }
    expect(centres(g)).toEqual([{ east: 0, north: 0, hPa: 1000, high: false }]);
    // A high, the same turned over.
    const h = grid(21, step, (e, n) => 1020 - Math.hypot(e, n) / step);
    expect(centres(h)).toEqual([{ east: 0, north: 0, hPa: 1020, high: true }]);
  });

  test('a saddle is cut by the cell’s mean: the corners on the other side of it are cut off', () => {
    // High in the north-west and the south-east, low in the others; the
    // mean on the level, so the highs join and the lows are cut off.
    const g: PressureGrid = { step: 100, side: 2, values: [1012, 1010, 1010, 1012] };
    const bar = isobars(g, 1).find((b) => b.hPa === 1011);
    expect(bar?.lines).toHaveLength(2);
    for (const line of bar?.lines ?? []) {
      expect(line).toHaveLength(2);
      // About the north-east corner, or the south-west.
      const c = line.reduce((s, [e]) => s + e, 0) > 0 ? 50 : -50;
      for (const [e, n] of line) {
        expect(Math.hypot(e - c, n - c)).toBeCloseTo(50, 9);
      }
    }
  });

  test('a line ends where the grid does, beyond the lip', () => {
    // A level field with a hole in its middle: the line through it parts in two.
    const g = grid(11, 100, (e, n) => (Math.hypot(e, n) < 150 ? null : 1010 + e / 100));
    const bar = isobars(g).find((b) => b.hPa === 1010);
    expect(bar?.lines).toHaveLength(2);
    for (const line of bar?.lines ?? []) {
      for (const [e, n] of line) {
        expect(e).toBeCloseTo(0, 9);
        expect(Math.abs(n)).toBeGreaterThanOrEqual(200);
      }
    }
    // No high or low beside the hole, nor at the grid's edge.
    expect(centres(g)).toEqual([]);
  });
});
