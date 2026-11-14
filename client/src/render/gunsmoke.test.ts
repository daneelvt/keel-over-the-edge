// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { type Burst, burstPuff, puffsOf } from './gunsmoke';

const G = catalog.world.committee.gun;
/** A report from a muzzle pointing east, 1.6 m up. */
const burst: Burst = {
  east: 0,
  north: 0,
  up: 1.6,
  wayEast: 1,
  wayNorth: 0,
  at: 0,
  loud: 1,
  seed: 3,
};
/** A breeze of 5 m/s from the north. */
const SPEED = 5;
const FROM = 0;

function cloud(
  age: number,
  b: Burst = burst,
): { up: number; north: number; east: number; n: number } {
  let up = 0;
  let north = 0;
  let east = 0;
  let n = 0;
  for (let i = 0; i < puffsOf(G, b.loud); i++) {
    const p = burstPuff(G, b, i, age, SPEED, FROM);
    if (p !== null) {
      up += p.up;
      north += p.north;
      east += p.east;
      n++;
    }
  }
  return { up: up / n, north: north / n, east: east / n, n };
}

describe('the signal gun’s smoke', () => {
  test('leaves the muzzle the way it points, then rises and drifts down the wind', () => {
    const early = cloud(0.5);
    expect(early.east).toBeGreaterThan(1);
    const later = cloud(10);
    expect(later.up).toBeGreaterThan(early.up + 15);
    // Down a north wind: south, at the wind's speed.
    expect(later.north).toBeCloseTo(-SPEED * 10, -1);
  });

  test('stands high enough to be seen over the horizon 600 m off within twenty seconds', () => {
    // The dome's horizon: sqrt(2 R h); from an eye 2 m up, the cloud's top
    // shows from where sqrt(2 R 2) + sqrt(2 R top) reaches 600 m.
    let top = 0;
    for (let i = 0; i < puffsOf(G, 1); i++) {
      const p = burstPuff(G, burst, i, 20, SPEED, FROM);
      top = Math.max(top, (p?.up ?? 0) + (p?.width ?? 0) / 2);
    }
    expect(Math.sqrt(2 * 2500 * 2) + Math.sqrt(2 * 2500 * (burst.up + top))).toBeGreaterThan(600);
  });

  test('thins as it ages and is gone after its life', () => {
    const a = burstPuff(G, burst, 0, 1, SPEED, FROM);
    const b = burstPuff(G, burst, 0, G.life * 0.8, SPEED, FROM);
    expect(a?.thick ?? 0).toBeGreaterThan(b?.thick ?? 1);
    expect((b?.width ?? 0) > (a?.width ?? 0)).toBe(true);
    expect(burstPuff(G, burst, 0, G.life + 0.1, SPEED, FROM)).toBeNull();
    expect(burstPuff(G, burst, 0, -0.1, SPEED, FROM)).toBeNull();
  });

  test('a louder report throws more and bigger puffs, the same on every phone', () => {
    expect(puffsOf(G, 1.6)).toBeGreaterThan(puffsOf(G, 1));
    const loud = { ...burst, loud: 1.6 };
    const p = burstPuff(G, loud, 0, 5, SPEED, FROM);
    const q = burstPuff(G, burst, 0, 5, SPEED, FROM);
    expect(p?.width ?? 0).toBeGreaterThan(q?.width ?? 0);
    expect(burstPuff(G, burst, 4, 7, SPEED, FROM)).toEqual(burstPuff(G, burst, 4, 7, SPEED, FROM));
  });
});
