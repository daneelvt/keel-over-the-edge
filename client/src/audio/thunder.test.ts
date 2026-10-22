// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  channelReach,
  THUNDER_RECIPE,
  THUNDER_RULE,
  type ThunderFlash,
  type ThunderInput,
  thunderEvents,
} from './thunder';

const R = THUNDER_RECIPE;
const C = THUNDER_RULE;

const flash = (change: Partial<ThunderFlash> = {}): ThunderFlash => ({
  tick: 300,
  east: 0,
  north: 2000,
  sea: true,
  base: 600,
  seed: 7,
  ...change,
});

const input = (flashes: ThunderFlash[], change: Partial<ThunderInput> = {}): ThunderInput => ({
  seconds: 0,
  listener: { east: 0, north: 0 },
  look: 0,
  flashes,
  ...change,
});

/** Every thunder of the flashes, heard in the minute after the first strikes. */
const all = (flashes: ThunderFlash[], change: Partial<ThunderInput> = {}) =>
  thunderEvents(R, C, input(flashes, change), 0, 70);

describe('thunder', () => {
  test('is heard the distance over the speed of sound after its flash, rolling as its channel spreads', () => {
    const [e] = all([flash()]);
    expect(e).toBeDefined();
    expect(e?.at).toBeCloseTo(10 + 2000 / 343, 6);
    expect(e?.distance).toBeCloseTo(2000, 6);
    expect(e?.length).toBeCloseTo((Math.hypot(2000, 600) - 2000) / 343, 6);
    expect(e?.seed).toBe(7);
    // Ahead of a listener looking north; to the right looking west.
    expect(e?.pan).toBeCloseTo(0, 6);
    expect(all([flash()], { look: -Math.PI / 2 })[0]?.pan).toBeGreaterThan(0.99);
  });

  test('is played once, in the interval it is first heard in', () => {
    const at = 10 + 2000 / 343;
    expect(thunderEvents(R, C, input([flash()]), 0, at - 0.01)).toEqual([]);
    expect(thunderEvents(R, C, input([flash()]), at - 0.01, at + 0.01)).toHaveLength(1);
    expect(thunderEvents(R, C, input([flash()]), at + 0.01, 70)).toEqual([]);
  });

  test('nothing beyond 3 nautical miles', () => {
    expect(all([flash({ north: 3 * 1852 - 1 })])).toHaveLength(1);
    expect(all([flash({ north: 3 * 1852 + 1 })])).toEqual([]);
  });

  test('a crack only within a kilometre of the channel', () => {
    expect(all([flash({ north: 900 })])[0]?.crack).toBe(true);
    expect(all([flash({ north: 1100 })])[0]?.crack).toBe(false);
    // A flash in its cloud 900 m above: its channel's nearest point is the base.
    expect(all([flash({ north: 0, sea: false, base: 900 })])[0]?.crack).toBe(true);
    expect(all([flash({ north: 0, sea: false, base: 1100 })])[0]?.crack).toBe(false);
  });

  test('every flash thunders, to the sea or in its cloud', () => {
    const got = all([flash(), flash({ sea: false, seed: 8, north: 3000 })]);
    expect(got).toHaveLength(2);
    const cloud = got.find((e) => e.seed === 8);
    const reach = channelReach(
      flash({ sea: false, seed: 8, north: 3000 }),
      { east: 0, north: 0 },
      R.stretch,
    );
    expect(cloud?.distance).toBeCloseTo(reach.near, 6);
    expect(cloud?.at).toBeCloseTo(10 + reach.near / 343, 6);
    expect(reach.near).toBeGreaterThanOrEqual(600);
    expect(reach.near).toBeLessThanOrEqual(Math.hypot(3000, 600));
    expect(cloud?.length).toBeCloseTo((reach.far - reach.near) / 343, 6);
  });

  test('rolls at most the catalog’s longest', () => {
    const long = { ...R, stretch: 40_000 };
    const [e] = thunderEvents(long, C, input([flash({ sea: false })]), 0, 70);
    expect(e?.length).toBe(C.longest);
  });

  test('is fainter and duller with distance', () => {
    const at = (d: number) => all([flash({ north: d })])[0];
    expect(at(1000)?.level).toBeCloseTo((at(500)?.level ?? 0) / 2, 6);
    expect(at(2000)?.level).toBeCloseTo((at(1000)?.level ?? 0) / 2, 6);
    expect(at(300)?.cutoff).toBeGreaterThan(at(1000)?.cutoff ?? 0);
    expect(at(1000)?.cutoff).toBeGreaterThan(at(3000)?.cutoff ?? 0);
    expect(at(3000)?.cutoff).toBeGreaterThan(at(5500)?.cutoff ?? 0);
  });

  test('two pages hear the same thunder at the same moments', () => {
    const flashes = [flash(), flash({ sea: false, seed: 9, east: -2500, tick: 600 })];
    const one = all(flashes);
    const frames = [];
    for (let k = 0; k < 1400; k++) {
      frames.push(...thunderEvents(R, C, input(flashes), k * 0.05, (k + 1) * 0.05));
    }
    expect(frames).toEqual(one);
    expect(one).toHaveLength(2);
  });
});
