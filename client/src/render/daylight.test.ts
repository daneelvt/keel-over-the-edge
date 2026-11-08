// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  DUSK_FLOOR,
  GLOW_MOON_FADE,
  GLOW_SUNSET,
  glowDark,
  LIFTED,
  LIGHT_TABLE,
  type Light,
  type LightValues,
  liftNight,
  luminance,
  mainLight,
  NIGHT_FLOOR,
  newLightValues,
  newMainLight,
  nightFloor,
  readLight,
} from './daylight';

const DEG = Math.PI / 180;

/** What may grow brighter as the sun sinks: the night's own lights. */
const NIGHT_LIGHTS = new Set(['starLimit', 'lanterns', 'moonLight', 'moonDisc']);
/** Not brightness at all: the haze's distances, and the highlight's power. */
const NOT_BRIGHTNESS = new Set([
  'height',
  'hazeNear',
  'hazeFar',
  'broadPower',
  'glow',
  'glowStrength',
]);

describe('the light of the hour', () => {
  test('has every row, in order of the sun’s height, from day to night', () => {
    const heights = LIGHT_TABLE.map((r) => r.height);
    expect(heights).toEqual([...heights].sort((a, b) => b - a));
    expect(new Set(heights).size).toBe(heights.length);
    // Day, low sun, sunset, dusk, late dusk and night.
    for (const h of [10, 3, 0, -6, -12]) {
      expect(heights).toContain(h);
    }
    expect(heights[0]).toBeGreaterThanOrEqual(10);
    const keys = Object.keys(LIGHT_TABLE[0] as Light).sort();
    for (const r of LIGHT_TABLE) {
      expect(Object.keys(r).sort()).toEqual(keys);
    }
  });

  test('nothing is brighter at a lower sun, but the stars, the moon and the lanterns', () => {
    const v = newLightValues();
    const w = newLightValues();
    for (let h = 90; h > -30; h -= 0.25) {
      readLight(h, v);
      readLight(h - 0.25, w);
      for (const [k, a] of Object.entries(v)) {
        if (NIGHT_LIGHTS.has(k) || NOT_BRIGHTNESS.has(k)) {
          continue;
        }
        const b = (w as unknown as Record<string, number | number[]>)[k];
        const before = Array.isArray(a) ? luminance(a) : a;
        const after = Array.isArray(b) ? luminance(b) : (b as number);
        expect(after, `${k} from ${h}° to ${h - 0.25}°`).toBeLessThanOrEqual(before + 1e-12);
      }
      // The horizon toward the sun, its glow included.
      const glowing = (x: typeof v): number =>
        luminance(x.skyHorizon.map((c, i) => c + (x.glow[i] ?? 0) * x.glowStrength));
      expect(glowing(w), `the horizon at ${h}°`).toBeLessThanOrEqual(glowing(v) + 1e-12);
    }
  });

  test('the stars come out brightest first, all by −9°, none by day', () => {
    const v = newLightValues();
    expect(readLight(0, v).starLimit).toBeLessThan(-1.46);
    expect(readLight(-3, v).starLimit).toBeGreaterThan(-1.46);
    // At −4° only stars brighter than magnitude 2 show.
    expect(readLight(-4, v).starLimit).toBeLessThan(2);
    expect(readLight(-9, v).starLimit).toBeGreaterThanOrEqual(5.5);
    expect(readLight(30, v).starLimit).toBeLessThan(-2);
  });

  test('the lanterns come on through the sun’s last degree', () => {
    const v = newLightValues();
    expect(readLight(1, v).lanterns).toBe(0);
    expect(readLight(0.5, v).lanterns).toBeCloseTo(0.5, 9);
    expect(readLight(0, v).lanterns).toBe(1);
    expect(readLight(-40, v).lanterns).toBe(1);
  });

  test('the main light is the sun above the horizon, the moon below it, never both', () => {
    const v = newLightValues();
    const m = newMainLight();
    for (let h = 30; h >= -30; h -= 0.5) {
      readLight(h, v);
      for (const lit of [0, 0.5, 1]) {
        mainLight(v, h * DEG, 40 * DEG, lit, m);
        expect(m.body).toBe(h > 0 ? 'sun' : 'moon');
        if (h > 0) {
          expect(m.strength).toBeGreaterThan(0);
        } else {
          // The moon's light goes with its lit share: none at new moon.
          expect(m.strength).toBeCloseTo(v.moonLight * lit, 12);
        }
      }
    }
    // A moon below the horizon gives no light.
    mainLight(readLight(-20, v), -20 * DEG, -5 * DEG, 1, m);
    expect(m.strength).toBe(0);
  });

  test('a moonless night keeps a floor: the hemisphere’s light, the sea and the sail', () => {
    const v = readLight(-40, newLightValues());
    expect(v.hemiLight).toBeGreaterThan(0.2);
    expect(luminance(v.hemiSky)).toBeGreaterThan(0.3);
    expect(luminance(v.scatter)).toBeGreaterThan(0.05);
    expect(luminance(v.sailGlow)).toBeGreaterThan(0.1);
  });

  test('noon is the look as it was before the day had hours', () => {
    const v = readLight(90, newLightValues());
    expect(v.skyTop).toEqual([0.25, 0.48, 0.78]);
    expect(v.skyHorizon).toEqual([0.78, 0.86, 0.9]);
    expect(v.sunLight).toBe(2.6);
    expect(v.hemiLight).toBe(1.1);
    expect(v.deep).toEqual([0.02, 0.16, 0.25]);
    expect(v.scatter).toEqual([0.07, 0.48, 0.5]);
    expect([v.hazeNear, v.hazeFar]).toEqual([220, 1000]);
  });
});

describe('the night’s floor', () => {
  const HEIGHTS = [90, 20, 3, 0.5, 0, -1.5, -3, -4.5, -6, -7, -9, -11, -12, -15, -40, -90];
  const read = (h: number, floor: number): LightValues =>
    liftNight(readLight(h, newLightValues()), floor, newLightValues());

  test('runs from the night’s row to dusk’s, by the night light', () => {
    expect(nightFloor(0)).toBe(NIGHT_FLOOR);
    expect(nightFloor(1)).toBe(DUSK_FLOOR);
    expect(nightFloor(2 / 3)).toBeCloseTo(-6, 9);
    // Out of range, or not a number: held within it.
    expect(nightFloor(-1)).toBe(NIGHT_FLOOR);
    expect(nightFloor(3)).toBe(DUSK_FLOOR);
    expect(nightFloor(Number.NaN)).toBe(NIGHT_FLOOR);
    expect(NIGHT_FLOOR).toBe(LIGHT_TABLE.at(-1)?.height);
  });

  test('at the night’s row changes nothing, at any height', () => {
    for (const h of HEIGHTS) {
      expect(read(h, NIGHT_FLOOR)).toEqual(readLight(h, newLightValues()));
    }
  });

  test('changes nothing above the floor', () => {
    for (const floor of [nightFloor(0.5), nightFloor(2 / 3), DUSK_FLOOR]) {
      for (const h of HEIGHTS.filter((x) => x >= floor)) {
        expect(read(h, floor)).toEqual(readLight(h, newLightValues()));
      }
    }
  });

  test('below it, the scene’s light is the floor’s and the marks of the hour the night’s', () => {
    const floor = nightFloor(2 / 3);
    const at = readLight(floor, newLightValues()) as unknown as Record<string, unknown>;
    for (const h of [-7, -12, -40]) {
      const truth = readLight(h, newLightValues()) as unknown as Record<string, unknown>;
      const lifted = read(h, floor) as unknown as Record<string, unknown>;
      for (const k of Object.keys(truth)) {
        expect(lifted[k], k).toEqual(LIFTED.includes(k as keyof Light) ? at[k] : truth[k]);
      }
    }
    // The marks: the stars, the lanterns, the moon, the glow, the range.
    for (const k of ['starLimit', 'lanterns', 'moonLight', 'moonDisc', 'glowStrength', 'height']) {
      expect(LIFTED).not.toContain(k);
    }
  });

  test('lifts a moonless night: the sea, the sail, the horizon and the hemisphere lighter', () => {
    const night = readLight(-30, newLightValues());
    const lifted = read(-30, nightFloor(2 / 3));
    for (const k of ['deep', 'scatter', 'sailGlow', 'skyHorizon', 'hemiSky'] as const) {
      expect(luminance(lifted[k]), k).toBeGreaterThan(luminance(night[k]));
    }
    expect(lifted.hemiLight).toBeGreaterThan(night.hemiLight);
    // The moon's light is the hour's: no brighter for the floor.
    const moon = (v: LightValues) => mainLight(v, -30 * DEG, 40 * DEG, 1, newMainLight()).strength;
    expect(moon(lifted)).toBe(moon(night));
  });
});

describe('the dark for glowing water', () => {
  const LIMIT = 0.33;
  const night = -20 * DEG;

  test('is none by day, nor with the sun just on the horizon', () => {
    expect(glowDark(30 * DEG, -40 * DEG, 0, LIMIT)).toBe(0);
    expect(glowDark(0.5 * DEG, -40 * DEG, 0, LIMIT)).toBe(0);
    expect(glowDark(0, -40 * DEG, 0, LIMIT)).toBe(0);
  });

  test('is whole on a dark night of a new moon, up or down', () => {
    expect(glowDark(night, -40 * DEG, 0, LIMIT)).toBe(1);
    expect(glowDark(night, 60 * DEG, 0, LIMIT)).toBe(1);
  });

  test('is none under a full moon high', () => {
    expect(glowDark(night, 60 * DEG, 1, LIMIT)).toBe(0);
    expect(glowDark(night, 90 * DEG, 1, LIMIT)).toBe(0);
  });

  test('is whole with a full moon down', () => {
    expect(glowDark(night, -5 * DEG, 1, LIMIT)).toBe(1);
    expect(glowDark(night, 0, 1, LIMIT)).toBe(1);
  });

  test('is whole under a moon whose light is below the limit, and none above it', () => {
    // A full moon 15° up: sin 15° = 0.26, below 0.33 less a tenth of it.
    expect(glowDark(night, 15 * DEG, 1, LIMIT)).toBe(1);
    // A half moon 60° up: 0.5 × 0.87 = 0.43, above.
    expect(glowDark(night, 60 * DEG, 0.5, LIMIT)).toBe(0);
  });

  test('fades in as the sun sinks, without a step', () => {
    let last = 0;
    for (let d = 0; d <= 3; d += 0.05) {
      const g = glowDark(-d * DEG, -40 * DEG, 0, LIMIT);
      expect(g).toBeGreaterThanOrEqual(last);
      expect(g - last).toBeLessThan(0.06);
      last = g;
    }
    expect(glowDark(-GLOW_SUNSET / 2, -40 * DEG, 0, LIMIT)).toBeCloseTo(0.5, 10);
    expect(glowDark(-GLOW_SUNSET, -40 * DEG, 0, LIMIT)).toBe(1);
  });

  test('fades out across the limit’s last tenth as the moon rises', () => {
    const at = (light: number) => glowDark(night, Math.asin(light), 1, LIMIT);
    expect(at(LIMIT * (1 - GLOW_MOON_FADE))).toBe(1);
    expect(at(LIMIT * (1 - GLOW_MOON_FADE / 2))).toBeCloseTo(0.5, 10);
    expect(at(LIMIT)).toBe(0);
    let last = 1;
    for (let k = 0; k <= 60; k++) {
      const g = glowDark(night, (k / 2) * DEG, 1, LIMIT);
      expect(g).toBeLessThanOrEqual(last);
      expect(last - g).toBeLessThan(0.5);
      last = g;
    }
  });

  test('is none for a limit of nothing, and for numbers that are not', () => {
    expect(glowDark(night, -40 * DEG, 0, 0)).toBe(0);
    expect(glowDark(Number.NaN, -40 * DEG, 0, LIMIT)).toBe(0);
    expect(glowDark(night, Number.NaN, 0, LIMIT)).toBe(1);
    expect(glowDark(night, 60 * DEG, Number.NaN, LIMIT)).toBe(0);
  });
});
