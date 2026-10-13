// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { Turned } from './turn';

/** The distance between two places in a pattern, the short way round each coordinate. */
function apart(a: [number, number], b: [number, number]): number {
  const d = (x: number, y: number): number => Math.abs(((x - y + 1.5) % 1) - 0.5);
  return Math.max(d(a[0], b[0]), d(a[1], b[1]));
}

describe('a pattern turned to the wind', () => {
  it('is fixed in the world while the wind holds: the floating origin does not move it', () => {
    const t = new Turned(1 / 41, 1 / 41);
    t.update(0.6, 0.8, 0, 0, 10, 10);
    const a = t.at(1234.5, -987.25, 0, 0);
    // The origin jumps half a kilometre; the same point of the world is the same place in the pattern.
    t.update(0.6, 0.8, 520, -480, 10, 10);
    expect(apart(t.at(1234.5, -987.25, 520, -480), a)).toBeLessThan(1e-9);
    // And far out, late in a long sail.
    t.update(0.6, 0.8, 8300, 100, 8310, 90);
    expect(apart(t.at(1234.5, -987.25, 8300, 100), a)).toBeLessThan(1e-9);
  });

  it('runs down the wind and across it at its own scales', () => {
    const t = new Turned(0.1, 0.5);
    t.update(1, 0, 0, 0, 0, 0);
    expect(t.at(1, 0, 0, 0)[0]).toBeCloseTo(0.1, 12);
    expect(t.at(1, 0, 0, 0)[1]).toBeCloseTo(0, 12);
    expect(t.at(0, 1, 0, 0)[1]).toBeCloseTo(0.5, 12);
  });

  it('turns about the boat when the wind turns: the water there stays put', () => {
    const t = new Turned(1 / 41, 1 / 41);
    const boat: [number, number] = [8000, -3000];
    t.update(0, -1, 7900, -2900, ...boat);
    const here = t.at(...boat, 7900, -2900);
    const off = t.at(boat[0] + 30, boat[1], 7900, -2900);
    // The wind veers by a degree.
    const a = (181 * Math.PI) / 180;
    t.update(Math.sin(a), Math.cos(a), 7900, -2900, ...boat);
    expect(apart(t.at(...boat, 7900, -2900), here)).toBeLessThan(1e-9);
    // Thirty metres off it moves by thirty metres' worth of a degree, not eight kilometres'.
    const moved = apart(t.at(boat[0] + 30, boat[1], 7900, -2900), off) * 41;
    expect(moved).toBeGreaterThan(0.3);
    expect(moved).toBeLessThan(0.7);
  });
});
