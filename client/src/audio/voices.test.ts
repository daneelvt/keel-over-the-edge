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
  throughWater: 0,
  seaHeight: 0,
  whitecaps: 0,
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
      expect(t.seaLevel).toBe(0);
    }
  });

  test('nothing breathes: the same wind sounds the same at any time', () => {
    expect(RECIPES.wind.breath.depth).toBe(0);
    const x = input({ apparentWind: 9, speed: 3, throughWater: 3, seaHeight: 0.8, whitecaps: 0.4 });
    const first = soundTargets(RECIPES, { ...x, time: 0 }, newTargets());
    for (const time of [0.7, 2.3, 9.1, 61, 3600.5]) {
      expect(soundTargets(RECIPES, { ...x, time }, newTargets())).toEqual(first);
    }
    // The wind's voice swells with the gust the boat feels, and only with it.
    const gust = soundTargets(RECIPES, { ...x, apparentWind: 12, time: 2.3 }, newTargets());
    expect(gust.windLevel).toBeGreaterThan(first.windLevel);
    expect(gust.windCentre).toBeGreaterThan(first.windCentre);
  });

  test('the sea is silent on flat water and rises with the height of the waves', () => {
    const flat = soundTargets(RECIPES, input({ throughWater: 4, whitecaps: 1 }), newTargets());
    expect(flat.seaLevel).toBe(0);
    let last = soundTargets(RECIPES, input({}), newTargets());
    expect(last.seaLevel).toBe(0);
    for (const seaHeight of [0.2, 0.5, 1, 1.6, 2.2]) {
      const t = soundTargets(RECIPES, input({ seaHeight }), newTargets());
      expect(t.seaLevel).toBeGreaterThan(last.seaLevel);
      expect(t.seaCentre).toBeGreaterThan(last.seaCentre);
      last = t;
    }
    // Past the height of its full level it grows no louder.
    const more = soundTargets(RECIPES, input({ seaHeight: 5 }), newTargets());
    expect(more.seaLevel).toBe(last.seaLevel);
    expect(more.seaCentre).toBeLessThanOrEqual(RECIPES.sea.centre.most);
  });

  test('the sea is louder with the boat’s way through it and with its whitecaps', () => {
    const still = soundTargets(RECIPES, input({ seaHeight: 1 }), newTargets());
    let last = still;
    for (const throughWater of [1, 2, 3, 4.5]) {
      const t = soundTargets(RECIPES, input({ seaHeight: 1, throughWater }), newTargets());
      expect(t.seaLevel).toBeGreaterThan(last.seaLevel);
      last = t;
    }
    // Sailing backward through it is as loud as forward.
    const astern = soundTargets(RECIPES, input({ seaHeight: 1, throughWater: -3 }), newTargets());
    const ahead = soundTargets(RECIPES, input({ seaHeight: 1, throughWater: 3 }), newTargets());
    expect(astern.seaLevel).toBe(ahead.seaLevel);
    const white = soundTargets(RECIPES, input({ seaHeight: 1, whitecaps: 0.7 }), newTargets());
    expect(white.seaLevel).toBeGreaterThan(still.seaLevel);
    expect(white.seaCentre).toBeGreaterThan(still.seaCentre);
    // The shares make up the whole: its most is the recipe's.
    const { sea, whitecaps, speed } = RECIPES.sea.share;
    expect(sea + whitecaps + speed).toBeCloseTo(1, 12);
    const most = soundTargets(
      RECIPES,
      input({ seaHeight: 9, whitecaps: 1, throughWater: 9 }),
      newTargets(),
    );
    expect(most.seaLevel).toBeCloseTo(RECIPES.sea.level.most, 12);
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

  test('reads luffing strips from Out, and the sea under the boat', () => {
    const out = new Float64Array(SIZES.out);
    out[RECORDS.out.footFlow] = 1;
    out[RECORDS.out.headFlow] = 0;
    out[RECORDS.out.apparentWindSpeed] = 6;
    out[RECORDS.out.speedThroughWater] = 2.5;
    const x = soundInput(out, { height: 0.9, whitecaps: 0.3 }, 2, input({}));
    expect(x.luffing).toBe(1);
    expect(x.apparentWind).toBe(6);
    expect(x.throughWater).toBe(2.5);
    expect(x.seaHeight).toBe(0.9);
    expect(x.whitecaps).toBe(0.3);
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
