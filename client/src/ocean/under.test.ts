// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { SEA, SEA_SPEED_STEP } from '../predict/layout.gen';
import { KNOT } from './look';
import { type AreaInputs, SeaUnder } from './under';

const HALF = SEA.areas >> 1;

/** A window centred on the world's centre: `west` knots in its western columns, `east` from column `split` on. */
function window(west: number, east: number, split: number, from = 0): AreaInputs {
  const n = SEA.window * SEA.window;
  const speed = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    speed[i] = Math.round(((i % SEA.window >= split ? east : west) * KNOT) / SEA_SPEED_STEP);
  }
  return {
    col: HALF - 2,
    row: HALF - 2,
    size: SEA.window,
    speed,
    from: new Uint32Array(n).fill(from),
    fetch: new Uint32Array(n).fill(11000),
  };
}

describe('the sea under the boat', () => {
  it('is the area’s own at its centre, and there at once the first time', () => {
    const u = new SeaUnder();
    u.lay(window(20, 20, 9, SEA.fromSteps / 4));
    u.update(0, 0, 1 / 60);
    expect(u.speed).toBeCloseTo(20 * KNOT, 2);
    expect(u.fetch).toBe(11000);
    // A wind from the east raises waves that travel west.
    expect(u.east).toBeCloseTo(-1, 6);
    expect(u.north).toBeCloseTo(0, 6);
    expect(u.foam.whitecaps).toBeGreaterThan(0.6);
    expect(u.foam.streaks).toBe(0);
  });

  it('is blended between areas as the boat band is', () => {
    const u = new SeaUnder();
    // 6 knots here and 34 from the next column east.
    u.lay(window(6, 34, 3));
    u.update(0, 0, 1);
    expect(u.speed).toBeCloseTo(6 * KNOT, 2);
    u.update(SEA.areaSize / 2, 0, 1);
    expect(u.speed).toBeCloseTo(20 * KNOT, 2);
    u.update(SEA.areaSize, 0, 1);
    expect(u.speed).toBeCloseTo(34 * KNOT, 2);
    // A quarter of the way: the weight is smoothed, 0.25² (3 − 0.5) = 0.156.
    u.update(SEA.areaSize / 4, 0, 1);
    expect(u.speed / KNOT).toBeCloseTo(6 + 28 * 0.15625, 1);
  });

  it('eases to a new sea over two seconds', () => {
    const u = new SeaUnder();
    u.lay(window(6, 6, 9));
    u.update(0, 0, 1 / 60);
    u.lay(window(34, 34, 9));
    u.update(0, 0, 1 / 60);
    expect(u.speed / KNOT).toBeLessThan(7);
    expect(u.target.speed).toBeCloseTo(34 * KNOT, 2);
    for (let i = 0; i < 120; i++) {
      u.update(0, 0, 1 / 60);
    }
    expect(u.speed / KNOT).toBeGreaterThan(32);
    expect(u.speed / KNOT).toBeLessThan(34);
    // After a pause what eases simply arrives.
    u.lay(window(12, 12, 9));
    u.update(0, 0, 1);
    expect(u.speed).toBeCloseTo(12 * KNOT, 2);
  });

  it('gives each area the foam of its own wind', () => {
    const u = new SeaUnder();
    u.lay(window(6, 34, 3));
    expect(u.areas[0]?.toArray()).toEqual([0, 0, 0, 0]);
    // The wind is held in steps of a hundredth of a metre a second: a hair under 34 knots.
    expect(u.areas[4]?.x).toBeCloseTo(1, 3);
    expect(u.areas[4]?.y).toBeCloseTo(0.75, 3);
    expect(u.areas[4]?.z).toBe(1);
    u.lay(null);
    expect(u.areas.every((a) => a.x === 0 && a.y === 0 && a.z === 0)).toBe(true);
    u.update(0, 0, 1);
    expect(u.speed).toBe(0);
  });

  it('turns with the wind, the short way', () => {
    const u = new SeaUnder();
    u.lay(window(12, 12, 9, 0));
    u.update(0, 0, 1);
    expect(u.north).toBeCloseTo(-1, 6);
    u.lay(window(12, 12, 9, SEA.fromSteps / 4));
    for (let i = 0; i < 30; i++) {
      u.update(0, 0, 1 / 60);
      expect(Math.hypot(u.east, u.north)).toBeCloseTo(1, 9);
    }
    // Half a second on, part of the way from south to west.
    expect(u.east).toBeLessThan(-0.3);
    expect(u.north).toBeLessThan(-0.3);
  });
});
