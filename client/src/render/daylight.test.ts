// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  LIGHT_TABLE,
  type Light,
  luminance,
  mainLight,
  newLightValues,
  newMainLight,
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
