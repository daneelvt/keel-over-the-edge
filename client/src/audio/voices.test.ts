// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { RECORDS, SIZES } from '../predict/layout.gen';
import {
  aeolianTone,
  newTargets,
  RECIPES,
  SOUND_INTERVAL,
  type SoundInput,
  soundInput,
  soundTargets,
  Throttle,
} from './voices';

const input = (v: Partial<SoundInput>): SoundInput => ({
  apparentWind: 0,
  speed: 0,
  luffing: 0,
  time: 0,
  ...v,
});

describe('the voices', () => {
  test('the rigging sings at 0.2 V ÷ 0.01 m', () => {
    expect(aeolianTone(0.2, 5, 0.01)).toBeCloseTo(100, 9);
    for (const v of [2, 5, 10, 20]) {
      const t = soundTargets(RECIPES, input({ apparentWind: v }), newTargets());
      expect(t.rigTone).toBeCloseTo((0.2 * v) / 0.01, 9);
    }
  });

  test('every level is zero at rest in no wind', () => {
    for (const time of [0, 3.7, 100]) {
      const t = soundTargets(RECIPES, input({ time }), newTargets());
      expect(t.windLevel).toBe(0);
      expect(t.rigLevel).toBe(0);
      expect(t.flogLevel).toBe(0);
      expect(t.waterLevel).toBe(0);
      expect(t.hissLevel).toBe(0);
    }
  });

  test('the cloth flogs only while a strip is luffing', () => {
    const quiet = soundTargets(RECIPES, input({ apparentWind: 8, luffing: 0 }), newTargets());
    expect(quiet.flogLevel).toBe(0);
    const one = soundTargets(RECIPES, input({ apparentWind: 8, luffing: 1 }), newTargets());
    const two = soundTargets(RECIPES, input({ apparentWind: 8, luffing: 2 }), newTargets());
    expect(one.flogLevel).toBeGreaterThan(0);
    expect(two.flogLevel).toBeGreaterThan(one.flogLevel);
    // The flap quickens with the wind.
    const strong = soundTargets(RECIPES, input({ apparentWind: 14, luffing: 1 }), newTargets());
    expect(strong.flapRate).toBeGreaterThan(one.flapRate);
  });

  test('wind and water rise with the wind and the speed; the hiss past the hull speed', () => {
    const slow = soundTargets(RECIPES, input({ apparentWind: 3, speed: 1 }), newTargets());
    const fast = soundTargets(RECIPES, input({ apparentWind: 10, speed: 3.5 }), newTargets());
    expect(fast.windLevel).toBeGreaterThan(slow.windLevel);
    expect(fast.windCentre).toBeGreaterThan(slow.windCentre);
    expect(fast.waterLevel).toBeGreaterThan(slow.waterLevel);
    expect(fast.waterCutoff).toBeGreaterThan(slow.waterCutoff);
    expect(slow.hissLevel).toBe(0);
    expect(fast.hissLevel).toBeGreaterThan(0);
  });

  test('reads luffing strips from Out', () => {
    const out = new Float64Array(SIZES.out);
    out[RECORDS.out.footFlow] = 1;
    out[RECORDS.out.headFlow] = 0;
    out[RECORDS.out.apparentWindSpeed] = 6;
    const x = soundInput(out, 2, input({}));
    expect(x.luffing).toBe(1);
    expect(x.apparentWind).toBe(6);
  });

  test('parameters are not set more often than every 50 ms', () => {
    const t = new Throttle(SOUND_INTERVAL);
    let n = 0;
    let last = Number.NEGATIVE_INFINITY;
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 600; i++) {
      const now = i * (1000 / 120);
      if (t.due(now)) {
        n++;
        closest = Math.min(closest, now - last);
        last = now;
      }
    }
    expect(closest).toBeGreaterThanOrEqual(SOUND_INTERVAL);
    expect(n).toBeLessThanOrEqual(5000 / SOUND_INTERVAL);
    expect(n).toBeGreaterThan(50);
  });
});
