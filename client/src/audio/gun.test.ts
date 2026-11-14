// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { GUN, gunReport } from './gun';

const muzzle = { east: 0, north: 0 };
const at = (d: number) => ({ east: 0, north: -d });

describe('the signal gun’s report', () => {
  test('a racer or a spectator hears every gun at full level, wherever they are, soon after the smoke', () => {
    const near = gunReport(GUN, muzzle, at(20), 0, 1, true);
    const far = gunReport(GUN, muzzle, at(3000), 0, 1, true);
    expect(near?.level).toBeCloseTo(GUN.level, 9);
    expect(far?.level).toBeCloseTo(GUN.level, 9);
    expect(far?.delay).toBeCloseTo(GUN.near / GUN.speed, 9);
    expect(near?.delay ?? 0).toBeLessThan(far?.delay ?? 0);
  });

  test('anyone else hears it fainter and duller with distance, and not at all past its reach', () => {
    const near = gunReport(GUN, muzzle, at(30), 0, 1, false);
    const mid = gunReport(GUN, muzzle, at(600), 0, 1, false);
    expect(near?.level ?? 0).toBeGreaterThan(mid?.level ?? 1);
    expect(near?.cutoff ?? 0).toBeGreaterThan(mid?.cutoff ?? 1e9);
    expect(mid?.delay).toBeCloseTo(600 / GUN.speed, 9);
    expect(gunReport(GUN, muzzle, at(GUN.reach + 1), 0, 1, false)).toBeNull();
  });

  test('the start’s gun is louder than a signal’s, its echoes longer', () => {
    const signal = gunReport(GUN, muzzle, at(100), 0, 1, true);
    const start = gunReport(GUN, muzzle, at(100), 0, 1.6, true);
    expect(start?.level ?? 0).toBeGreaterThan(signal?.level ?? 1);
    const last = (r: typeof signal) => r?.echoes.at(-1)?.delay ?? 0;
    expect(last(start)).toBeGreaterThan(last(signal));
  });

  test('it is placed to the side it is heard from, and its echoes are fainter and duller in turn', () => {
    const r = gunReport(GUN, { east: 100, north: 0 }, { east: 0, north: 0 }, 0, 1, true);
    expect(r?.pan).toBeCloseTo(1, 6);
    const e = r?.echoes ?? [];
    for (let i = 1; i < e.length; i++) {
      expect(e[i]?.level ?? 1).toBeLessThan(e[i - 1]?.level ?? 0);
      expect(e[i]?.cutoff ?? 1e9).toBeLessThanOrEqual(e[i - 1]?.cutoff ?? 0);
      expect(e[i]?.delay ?? 0).toBeGreaterThan(e[i - 1]?.delay ?? 1e9);
    }
  });
});
